// ── Daily identification limits (per chatId, resets at 00:00 SGT) ─────────────
// Private chats: 15 identifications/day   Group chats: 20 identifications/day
// Count is always read directly from Google Sheets — the actual logged rows are
// the single source of truth. No in-memory counter is maintained.
const PRIVATE_DAILY_LIMIT = 15;
const GROUP_DAILY_LIMIT   = 20;

function getTodaySGT() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore' }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.day}/${map.month}/${map.year}`;
}

async function getTodayCount(chatId) {
  try {
    return await sheetsService.getDailyIdentificationCount(chatId, getTodaySGT());
  } catch {
    return 0; // if sheets is unavailable, allow through (fail open)
  }
}
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Photo handler — identifies any animal photo sent to the chat.
 *
 * Flow:
 *   1. User sends photo → ask for location
 *   2. User gives location (or skips) → run identification
 */

const axios = require('axios');
const sharp = require('sharp');
const exifParser = require('exif-parser');
const geminiService = require('../../animalIdentification/services/geminiService');
const { createResultCanvas } = require('../../animalIdentification/services/imageService');
const { getSpeciesPhoto, getEBirdPhoto } = require('../../animalIdentification/services/inaturalistService');
const { getSpeciesCode, getNearbySpeciesObservations, getEBirdSubspecificGroups, getEBirdSubnationalCode } = require('../../animalIdentification/services/ebirdService');
const { getGBIFNames, geocodeLocation, checkOccurrencesAtLocation, getGeographicRange, getGlobalOccurrenceCount, getSubspeciesOccurrencesByCountry } = require('../../animalIdentification/services/gbifService');
const { getWikipediaInfo } = require('../../animalIdentification/services/wikipediaService');
const {
  classifyLocalStatus,
  classifyAbundance,
  isMonotypic,
  getEpithet,
  getEpithets,
  computeDisplayFields,
} = require('../../animalIdentification/services/enrichmentUtils');
const { consumeIdentifyPromptMessage, setIdentifyPromptMessage, hasIdentifyPromptMessage, setSessionStart, getSessionStart, clearSessionStart, clearIdentifySession } = require('../menu/mainMenu');
const { resolveChannelContext } = require('../utils/chatContext');
const { ebird: ebirdSvc } = require('./birdMenu/services');
const { getTimezoneForRegion, getTzAbbr, parseBreedingCode, parseAgeSex } = require('./birdMenu/helpers');
const sheetsService = require('../../../database/googleSheets/services/googleSheetsService');
//const googleDriveService = require('../../../database/googleDrive/services/googleDriveService');
const logger = require('../../../src/utils/logger');
const { ebird: _ebirdSvcIdentify } = require('./birdMenu/services');

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// chatId → { buffer, mimeType, location, locationMsgId, imageCapturedAt, visualQuestion }
const pending = new Map();

// userId → identification is in progress (pending entry already consumed but not yet done)
// Keeps hasPending() true so birdMenu's fallback doesn't fire while we identify.
const pendingInFlight = new Set();

// userId → { records, location, speciesName } — cached eBird sightings for the last result
const ebirdSightingsCache = new Map();

// userId → last resolved country/location preference (used when user skips location)
const lastLocationByUser = new Map();

// userId → session explicitly ended by tapping "Stop"
const sessionEnded = new Set();

// userId → { chatId, messageId } for the "Session ended." message so it can be deleted on next photo
const sessionEndedMessages = new Map();

function clearEndedSession(userId) {
  if (userId) {
    sessionEnded.delete(userId);
    sessionEndedMessages.delete(userId);
  }
}

function getDefaultLocationForUser(userId) {
  return lastLocationByUser.get(userId) || 'Singapore';
}



function extractImageCapturedAt(buffer) {
  try {
    const parsed = exifParser.create(buffer).parse();
    const exifTs =
      parsed?.tags?.DateTimeOriginal ||
      parsed?.tags?.CreateDate ||
      parsed?.tags?.ModifyDate ||
      null;

    if (!exifTs || Number.isNaN(Number(exifTs))) return null;
    return new Date(Number(exifTs) * 1000).toISOString();
  } catch {
    return null;
  }
}

// Detect if image was taken at night or in low light
function detectNightOrLowLight(buffer) {
  try {
    const parsed = exifParser.create(buffer).parse();
    // Check EXIF for time
    const exifTs =
      parsed?.tags?.DateTimeOriginal ||
      parsed?.tags?.CreateDate ||
      parsed?.tags?.ModifyDate ||
      null;
    let isNight = false;
    if (exifTs && !Number.isNaN(Number(exifTs))) {
      const date = new Date(Number(exifTs) * 1000);
      const hour = date.getHours();
      if (hour < 6 || hour > 18) isNight = true;
    }
    // Check EXIF for ISO and ExposureTime (low light proxy)
    const iso = parsed?.tags?.ISO || 0;
    const exposure = parsed?.tags?.ExposureTime || 0;
    let isLowLight = false;
    if (iso > 800 || exposure > 0.1) isLowLight = true;
    return { isNight, isLowLight };
  } catch {
    return { isNight: false, isLowLight: false };
  }
}

async function downloadTelegramFile(bot, fileId) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
  const imgResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return {
    buffer: Buffer.from(imgResponse.data),
    filePath: fileInfo.file_path || '',
    fileInfo,
  };
}

function detectMimeTypeFromPath(filePath) {
  const ext = (filePath || '').split('.').pop().toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

async function preprocessCompressedImage(inputBuffer) {
  try {
    const meta = await sharp(inputBuffer, { failOn: 'none' }).metadata();
    const longEdge = Math.max(meta.width || 0, meta.height || 0);

    // Always upscale: images < 1280px → 1280px; images ≥ 1280px → 4096px.
    // Never downscale — withoutEnlargement is intentionally NOT set.
    const target = longEdge > 0 && longEdge < 1280 ? 1280 : 4096;

    // After upscaling we apply:
    //   1. Unsharp mask — recovers fine feather/scale/fur detail lost to JPEG compression
    //   2. Mild linear contrast boost — makes thin marks (malar stripe width, barring
    //      density, bare-part colour) more distinct for Gemini's vision model
    // Parameters chosen conservatively so we reveal detail without introducing artefacts.
    return await sharp(inputBuffer, { failOn: 'none' })
      .resize(target, target, { fit: 'inside', kernel: sharp.kernel.lanczos3 })
      // 1. Denoise — median 3×3 removes JPEG blocking/speckle while preserving hard edges
      .median(3)
      // 2. Auto-level — stretches histogram so the darkest pixel → 0 and brightest → 255,
      //    correcting underexposed/overexposed shots so Gemini sees the full tonal range
      .normalise()
      // 3. Unsharp mask — recovers fine feather/scale/fur detail after compression blur
      //    sigma=1.2, m1=1.5, m2=0.5: moderate sharpening with gentle edge handling
      .sharpen({ sigma: 1.2, m1: 1.5, m2: 0.5 })
      // 4. Saturation boost — makes colour field marks (rufous flanks, yellow bill,
      //    iridescent feathers, bare-part colours) more vivid and distinct
      .modulate({ saturation: 1.2 })
      // 5. Mild contrast lift — opens up midtones and makes thin marks (malar stripe,
      //    supercilium, barring) more visible after normalisation
      .linear(1.06, -6)
      .jpeg({ quality: 100, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    logger.warn('Image preprocessing skipped', { error: err.message });
    return inputBuffer;
  }
}

async function requestLocationAndQueue(bot, chatId, payload, user, chat) {
  const locMsg = await bot.sendMessage(
    chatId,
    '📍 <b>Where was this photo taken?</b>\n\nReply with a city or country for better accuracy\n(e.g. <i>Johor, Malaysia</i>, <i>Phuket, Thailand</i>, <i>Bali, Indonesia</i>)\n\nOr tap <b>⏭️ Skip</b> to proceed without a location.',
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '⏭️ Skip', callback_data: 'identify_skip_location' }]],
      },
    }
  );
  const userId = user?.id;
  // Clear any remembered location so each new identification always prompts fresh.
  lastLocationByUser.delete(userId);
  const sessionStart = getSessionStart(userId);
  pending.set(userId, {
    chatId,
    buffer: payload.buffer,
    mimeType: payload.mimeType,
    imageCapturedAt: payload.imageCapturedAt || null,
    isCompressed: payload.isCompressed !== false,
    visualQuestion: payload.visualQuestion || '',
    location: '',
    locationMsgId: locMsg.message_id,
    user,
    inputFileId: payload.inputFileId,
    sessionId: payload.sessionId || sessionStart?.sessionId || '',
    chatType: chat?.type || 'private',
    channelId: payload.channelId || '',
    channelName: payload.channelName || chat?.title || '',
  });
}

function buildSessionSender(chat, user) {
  return (user?.username ? `@${user.username}` : [user?.first_name, user?.last_name].filter(Boolean).join(' '))
    || 'Unknown';
}

async function ensureActiveSessionRecord(chat, user, channelContext = {}) {
  const chatType = chat?.type || 'private';
  const chatTitle = chat?.title || null;
  const channelId = chatType === 'private' ? '' : String(channelContext.channelId ?? (chat?.id != null ? String(chat.id) : ''));
  const channelName = chatType === 'private' ? '' : String(channelContext.channelName ?? chatTitle ?? '');
  const sender = buildSessionSender(chat, user);
  const startTime = new Date();
  let sessionSn = null;
  let sessionId = '';

  const latest = await sheetsService.getLatestSessionStatus({
    subBot: 'Animal Identification',
    chatId: chat?.id,
    channelId,
    channelName,
    sender,
    chatType,
  });

  if (latest && String(latest.status || '').toLowerCase() === 'active') {
    sessionSn = latest.sn;
    sessionId = latest.sessionId || '';
  } else {
    const started = await sheetsService.logSessionStart({
      subBot: 'Animal Identification',
      chatId: chat?.id,
      channelId,
      channelName,
      chatTitle,
      user,
      chatType,
      startTime,
    });
    sessionSn = started?.sn || null;
    sessionId = started?.sessionId || '';
  }

  return { chatType, chatTitle, sender, startTime, sessionSn, sessionId };
}

async function hasActiveSessionBySheet(chat, user, channelContext = {}) {
  try {
    const latest = await sheetsService.getLatestSessionStatus({
      subBot: 'Animal Identification',
      chatId: chat?.id,
      channelId: (chat?.type || 'private') === 'private' ? '' : String(channelContext.channelId ?? (chat?.id != null ? String(chat.id) : '')),
      channelName: (chat?.type || 'private') === 'private' ? '' : String(channelContext.channelName ?? chat?.title ?? ''),
      sender: buildSessionSender(chat, user),
      chatType: chat?.type || 'private',
    });

    if (!latest) return false;
    return String(latest.status || '').toLowerCase() === 'active';
  } catch {
    // If Sheets is temporarily unavailable, do not block normal bot flow.
    return true;
  }
}

module.exports = function registerIdentify(bot) {

  // ── Step 1: receive photo, ask for location ────────────────────────────────
  bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    let loadingMsg = null;

    const fromSessionEnded = sessionEnded.has(userId);
    if (fromSessionEnded) {
      sessionEnded.delete(userId);
      const endedMsg = sessionEndedMessages.get(userId);
      if (endedMsg) {
        await bot.deleteMessage(endedMsg.chatId, endedMsg.messageId).catch(() => {});
        sessionEndedMessages.delete(userId);
      }
    }

    // Forwarded photos are pass-through only — no session, no identification flow.
    // Exception: if the user has an active identification session (e.g. clicked "Identify another"),
    // allow the forwarded image through so it can be identified.
    if ((msg.forward_date || msg.forward_origin || msg.forward_from || msg.forward_from_chat) && !hasIdentifyPromptMessage(chatId)) return;

    try {
      // Check if there's an active identification session (prompt message showing)
      const hasActiveSession = hasIdentifyPromptMessage(chatId);

      const largest = msg.photo.reduce((best, cur) => {
        const bestArea = (best?.width || 0) * (best?.height || 0);
        const curArea = (cur?.width || 0) * (cur?.height || 0);
        return curArea > bestArea ? cur : best;
      }, null);

      const inputFileId = largest?.file_id;
      if (!inputFileId) throw new Error('Invalid Telegram photo payload');

      if (hasActiveSession && !fromSessionEnded) {
        loadingMsg = await bot.sendMessage(chatId, '⏳ Loading photo…').catch(() => null);
      }

      const { buffer: rawBuffer } = await downloadTelegramFile(bot, inputFileId);
      const imageCapturedAt = extractImageCapturedAt(rawBuffer);
      // Telegram compresses photos — upscale to restore detail for Gemini
      const enhanced = await preprocessCompressedImage(rawBuffer);

      const nightLow = detectNightOrLowLight(rawBuffer);

      if (fromSessionEnded) {
        // Session ended: delete image, delete prompt, ignore silently
        await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        const promptMessageId = consumeIdentifyPromptMessage(chatId);
        if (promptMessageId) {
          await bot.deleteMessage(chatId, promptMessageId).catch(() => {});
        }
        return;
      } else if (!hasActiveSession) {
        // No active session — user did not initiate via the menu. Delete the image silently.
        await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        return;
      } else {
        // Prompt is active — user went through the proper flow. Always proceed.
        // Delete the prompt message, keep the photo, and ask for location.
        const promptMessageId = consumeIdentifyPromptMessage(chatId);
        if (promptMessageId) {
          await bot.deleteMessage(chatId, promptMessageId).catch(() => {});
        }

        // ── Daily limit check ──────────────────────────────────────────────
        const isPrivateChat = (msg.chat?.type === 'private');
        const dailyLimit    = isPrivateChat ? PRIVATE_DAILY_LIMIT : GROUP_DAILY_LIMIT;
        const chatTypeLabel = isPrivateChat ? 'private chat' : 'group chat';
        const todayCount    = await getTodayCount(chatId);
        if (todayCount >= dailyLimit) {
          await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
          return bot.sendMessage(chatId,
            `❌ <b>Daily limit reached.</b>\n\nThis ${chatTypeLabel} has used all <b>${dailyLimit}</b> identifications for today.\n\nThe limit resets at <b>00:00 SGT</b>.`,
            { parse_mode: 'HTML' }
          );
        }
        // ──────────────────────────────────────────────────────────────────

        // Use the session already stored in memory when the button was clicked.
        // Calling ensureActiveSessionRecord here can race with the Sheets write from
        // menu_identify_new and create a duplicate session row.
        const channelContext = await resolveChannelContext(bot, msg.chat, msg.sender_chat || null).catch(() => ({
          channelId: msg.chat?.type === 'private' ? '' : String(msg.chat?.id ?? ''),
          channelName: msg.chat?.type === 'private' ? '' : String(msg.chat?.title || ''),
        }));
        const storedSession = getSessionStart(userId);
        let sessionId = storedSession?.sessionId || '';
        if (!sessionId) {
          try {
            const sessionState = await ensureActiveSessionRecord(msg.chat, msg.from, channelContext);
            sessionId = sessionState?.sessionId || '';
          } catch { /* non-blocking */ }
        }

        await bot.deleteMessage(chatId, loadingMsg?.message_id).catch(() => {});
        await requestLocationAndQueue(
          bot,
          chatId,
          {
            buffer: enhanced,
            mimeType: 'image/jpeg',
            inputFileId,
            imageCapturedAt,
            isNight: nightLow.isNight,
            isLowLight: nightLow.isLowLight,
            isCompressed: true,
            visualQuestion: (msg.caption || '').trim(),
            sessionId,
            channelId: channelContext.channelId,
            channelName: channelContext.channelName,
          },
          msg.from,
          msg.chat
        );
      }
    } catch (err) {
      await bot.deleteMessage(chatId, loadingMsg?.message_id).catch(() => {});
      bot.sendMessage(chatId, `❌ Could not process photo: ${escHtml(err.message)}`);
    }
  });

  // Accept image documents (typically uncompressed) as an alternative to photo uploads.
  bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    let loadingMsg = null;
    const fromSessionEnded = sessionEnded.has(userId);
    if (fromSessionEnded) {
      sessionEnded.delete(userId);
      const endedMsg = sessionEndedMessages.get(userId);
      if (endedMsg) {
        await bot.deleteMessage(endedMsg.chatId, endedMsg.messageId).catch(() => {});
        sessionEndedMessages.delete(userId);
      }
    }

    // Forwarded documents are pass-through only — no session, no identification flow.
    // Exception: if the user has an active identification session (e.g. clicked "Identify another"),
    // allow the forwarded image through so it can be identified.
    if ((msg.forward_date || msg.forward_origin || msg.forward_from || msg.forward_from_chat) && !hasIdentifyPromptMessage(chatId)) return;

    try {
      const doc = msg.document;
      const isImage = !!doc && ((doc.mime_type || '').startsWith('image/') || /\.(jpg|jpeg|png|webp)$/i.test(doc.file_name || ''));
      if (!isImage) return;

      // Check if there's an active identification session (prompt message showing)
      const hasActiveSession = hasIdentifyPromptMessage(chatId);

      const inputFileId = doc.file_id;
      if (hasActiveSession && !fromSessionEnded) {
        loadingMsg = await bot.sendMessage(chatId, '⏳ Loading image…').catch(() => null);
      }
      const { buffer, filePath } = await downloadTelegramFile(bot, inputFileId);
      const imageCapturedAt = extractImageCapturedAt(buffer);
      const mimeType = (doc.mime_type || detectMimeTypeFromPath(filePath)).split(';')[0] || 'image/jpeg';

      const nightLow = detectNightOrLowLight(buffer);

      if (fromSessionEnded) {
        // Session ended: delete image, delete prompt, ignore silently
        await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        const promptMessageId = consumeIdentifyPromptMessage(chatId);
        if (promptMessageId) {
          await bot.deleteMessage(chatId, promptMessageId).catch(() => {});
        }
        return;
      } else if (!hasActiveSession) {
        // No active session — user did not initiate via the menu. Delete the image silently.
        await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        return;
      } else {
        // Prompt is active — user went through the proper flow. Always proceed.
        const promptMessageId = consumeIdentifyPromptMessage(chatId);
        if (promptMessageId) {
          await bot.deleteMessage(chatId, promptMessageId).catch(() => {});
        }

        // ── Daily limit check ──────────────────────────────────────────────
        const isPrivateChatDoc = (msg.chat?.type === 'private');
        const dailyLimitDoc    = isPrivateChatDoc ? PRIVATE_DAILY_LIMIT : GROUP_DAILY_LIMIT;
        const chatTypeLabelDoc = isPrivateChatDoc ? 'private chat' : 'group chat';
        const todayCountDoc    = await getTodayCount(chatId);
        if (todayCountDoc >= dailyLimitDoc) {
          await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
          return bot.sendMessage(chatId,
            `❌ <b>Daily limit reached.</b>\n\nThis ${chatTypeLabelDoc} has used all <b>${dailyLimitDoc}</b> identifications for today.\n\nThe limit resets at <b>00:00 SGT</b>.`,
            { parse_mode: 'HTML' }
          );
        }
        // ──────────────────────────────────────────────────────────────────

        // Use the session already stored in memory when the button was clicked.
        const channelContext = await resolveChannelContext(bot, msg.chat, msg.sender_chat || null).catch(() => ({
          channelId: msg.chat?.type === 'private' ? '' : String(msg.chat?.id ?? ''),
          channelName: msg.chat?.type === 'private' ? '' : String(msg.chat?.title || ''),
        }));
        const storedSession = getSessionStart(userId);
        let sessionId = storedSession?.sessionId || '';
        if (!sessionId) {
          try {
            const sessionState = await ensureActiveSessionRecord(msg.chat, msg.from, channelContext);
            sessionId = sessionState?.sessionId || '';
          } catch { /* non-blocking */ }
        }

        await bot.deleteMessage(chatId, loadingMsg?.message_id).catch(() => {});
        await requestLocationAndQueue(
          bot,
          chatId,
          {
            buffer,
            mimeType,
            inputFileId,
            imageCapturedAt,
            isNight: nightLow.isNight,
            isLowLight: nightLow.isLowLight,
            isCompressed: false,
            visualQuestion: (msg.caption || '').trim(),
            sessionId,
            channelId: channelContext.channelId,
            channelName: channelContext.channelName,
          },
          msg.from,
          msg.chat
        );
      }
    } catch (err) {
      await bot.deleteMessage(chatId, loadingMsg?.message_id).catch(() => {});
      const isTooBig = err.message?.includes('file is too big') || err.message?.includes('ETELEGRAM: 400');
      if (isTooBig) {
        bot.sendMessage(chatId,
          '❌ <b>File too large.</b>\n\nTelegram bots can only download files up to <b>20 MB</b>. Please compress your image or send a smaller version.',
          { parse_mode: 'HTML' }
        );
      } else {
        bot.sendMessage(chatId, `❌ Could not process image file: ${escHtml(err.message)}`);
      }
    }
  });

  // ── Step 2: handle location reply (text, shared GPS, or skip) ───────────────
  bot.on('message', async (msg) => {
    const userId = msg.from?.id;

    // Handle eBird jump page input
    const jumpChatId = msg.chat?.id;
    const jumpState = jumpChatId && pending.get(jumpChatId);
    if (jumpState?.awaitingEbirdJump && msg.text) {
      const pageNum = parseInt(msg.text.trim(), 10);
      pending.set(jumpChatId, { ...jumpState, awaitingEbirdJump: false });
      await bot.deleteMessage(jumpChatId, msg.message_id).catch(() => {});
      if (isNaN(pageNum) || pageNum < 1 || pageNum > jumpState.ebirdTotalPages) {
        await bot.sendMessage(jumpChatId, `❌ Invalid page. Enter 1–${jumpState.ebirdTotalPages}.`);
        return;
      }
      const cached = ebirdSightingsCache.get(userId);
      if (!cached) return;
      const { text, keyboard } = await buildSightingsPage(cached.records, pageNum - 1, cached.location, cached.speciesName, cached.regionCode);
      await bot.editMessageText(text, {
        chat_id: jumpChatId, message_id: jumpState.ebirdJumpMsgId,
        parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: keyboard,
      }).catch(() => {});
      return;
    }

    if (!userId || !pending.has(userId)) return;
    if (!msg.text && !msg.location) return;
    if (msg.text && msg.text.startsWith('/')) return;

    const state = pending.get(userId);
    const chatId = state.chatId;
    // Mark in-flight BEFORE removing from pending so hasPending() stays true until
    // identification is complete — prevents birdMenu's fallback from also handling this message.
    pendingInFlight.add(userId);
    pending.delete(userId);
    await bot.deleteMessage(chatId, state.locationMsgId).catch(() => {});
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    let locationValue = '';

    if (msg.location) {
      // User shared GPS location via Telegram location button → reverse geocode to country
      try {
        const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${msg.location.latitude}&lon=${msg.location.longitude}&zoom=3&addressdetails=1`;
        const geoRes = await axios.get(nominatimUrl, { headers: { 'User-Agent': 'WildlifeBot/1.0' } });
        locationValue = geoRes.data?.address?.country || 'Singapore';
      } catch {
        locationValue = 'Singapore';
      }
      lastLocationByUser.set(userId, locationValue);
    } else if (msg.text.trim() === '⏭️ Skip') {
      locationValue = getDefaultLocationForUser(userId);
    } else {
      locationValue = msg.text.trim();
      const resolved = await geocodeLocation(locationValue).catch(() => null);
      if (resolved?.country) {
        lastLocationByUser.set(userId, resolved.country);
      } else if (locationValue) {
        lastLocationByUser.set(userId, locationValue);
      }
    }

    await bot.sendChatAction(chatId, 'upload_photo').catch(() => {});
    try {
      await runIdentification(bot, chatId, state.buffer, state.mimeType, {
        location: locationValue,
        user: state.user,
        inputFileId: state.inputFileId,
        imageCapturedAt: state.imageCapturedAt,
        isCompressed: state.isCompressed !== false,
        visualQuestion: state.visualQuestion,
        sessionId: state.sessionId || '',
        chatType: state.chatType || 'private',
        channelName: state.channelName || '',
      });
    } finally {
      pendingInFlight.delete(userId);
    }
  });

  // ── Continue / Stop callbacks ──────────────────────────────────────────────
  const _continueDedupSet = new Set();
  bot.on('callback_query', async (query) => {
    const { data } = query;
    if (data !== 'identify_continue' && data !== 'identify_stop') return;
    if (_continueDedupSet.has(query.id)) return;
    _continueDedupSet.add(query.id);
    setTimeout(() => _continueDedupSet.delete(query.id), 10_000);
    const chatId = query.message.chat.id;
    bot.answerCallbackQuery(query.id);
    // Remove the Continue/Stop prompt
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});

    if (data === 'identify_continue') {
      clearEndedSession(query.from?.id);

      let sessionState = null;
      try {
        const channelContext = await resolveChannelContext(bot, query.message.chat, query.message?.sender_chat || null).catch(() => ({
          channelId: query.message.chat.type === 'private' ? '' : String(chatId),
          channelName: query.message.chat.type === 'private' ? '' : String(query.message.chat.title || ''),
        }));
        sessionState = await ensureActiveSessionRecord(query.message.chat, query.from, channelContext);
      } catch {
        // Non-blocking: continue flow should still work if Sheets is unavailable.
      }

      const sent = await bot.sendMessage(
        chatId,
        `<b>📷 New Identification</b>\n\nSimply <b>send me a photo</b> and I'll identify the animal in it.`,
        { parse_mode: 'HTML' }
      );
      // Fire-and-forget: ensure taxonomy is warm for the next identification.
      _ebirdSvcIdentify.preloadTaxonomy().catch(() => {});
      setIdentifyPromptMessage(chatId, sent.message_id);
      setSessionStart(
        query.from?.id,
        chatId,
        query.message.chat.title,
        query.message.chat.type,
        sessionState?.sender || buildSessionSender(query.message.chat, query.from),
        sessionState?.sessionSn || null,
        sessionState?.sessionId || '',
        sessionState?.startTime || new Date()
      );
    } else {
      sessionEnded.add(query.from?.id);
      const sentEnd = await bot.sendMessage(
        chatId,
        `👋 <b>Session ended.</b>\n\nSend /start whenever you're ready to continue.`,
        { parse_mode: 'HTML' }
      );
      sessionEndedMessages.set(query.from?.id, { chatId, messageId: sentEnd.message_id });

      // Update end-time/status on the active session row in Sessions sheet.
      const sessionStart = getSessionStart(query.from?.id);
      let sessionSn = sessionStart?.sessionSn || null;

      if (!sessionSn) {
        try {
          const channelContext = await resolveChannelContext(bot, query.message.chat, query.message?.sender_chat || null).catch(() => ({
            channelId: query.message.chat.type === 'private' ? '' : String(chatId),
            channelName: query.message.chat.type === 'private' ? '' : String(query.message.chat.title || sessionStart?.chatTitle || ''),
          }));
          const latest = await sheetsService.getLatestSessionStatus({
            subBot: 'Animal Identification',
            chatId,
            channelId: channelContext.channelId,
            channelName: channelContext.channelName || String(query.message.chat.title || sessionStart?.chatTitle || ''),
            sender: sessionStart?.sender || buildSessionSender(query.message.chat, query.from),
            chatType: query.message.chat.type,
          });
          if (latest && String(latest.status || '').toLowerCase() === 'active') {
            sessionSn = latest.sn;
          }
        } catch {
          // Best-effort fallback only.
        }
      }

      if (sessionSn != null) {
        await sheetsService.updateSessionEnd(sessionSn, new Date(), 'Ended');
      }

      clearSessionStart(query.from?.id);
      clearIdentifySession(query.message.chat.id);
    }
  });

  // ── eBird Sightings — paginated (triggered from photo caption button & page nav) ──
  const SIGHTINGS_PER_PAGE = 6;

  const BREEDING_CODES = {
    // Observed
    F:  'Flyover',
    // Possible
    H:  'In appropriate habitat',
    S:  'Singing bird',
    // Probable
    P:  'Pair in suitable habitat',
    M:  'Multiple (7+) singing birds',
    S7: 'Singing bird present 7+ days',
    T:  'Territorial defence',
    C:  'Courtship, display or copulation',
    N:  'Visiting probable nest site',
    A:  'Agitated behaviour',
    B:  'Wren/woodpecker nest building',
    CN: 'Carrying nesting material',
    PE: 'Physiological evidence',
    // Confirmed
    NB: 'Nest building',
    DD: 'Distraction display',
    UN: 'Used nest',
    ON: 'Occupied nest',
    CF: 'Carrying food',
    FS: 'Carrying fecal sac',
    FY: 'Feeding young',
    FL: 'Recently fledged young',
    NE: 'Nest with eggs',
    NY: 'Nest with young',
    // Fallback
    X:  'Species observed',
  };

  // Cache for checklist data fetched during sightings pagination
  const checklistCache = new Map();

  async function enrichPageRecords(pageRecords) {
    const subIds = [...new Set(pageRecords.filter(r => r.subId && !checklistCache.has(r.subId)).map(r => r.subId))];
    if (subIds.length > 0) {
      await Promise.allSettled(subIds.map(async (subId) => {
        try {
          const checklist = await ebirdSvc.getChecklist(subId);
          const obsMap = new Map();
          if (checklist && Array.isArray(checklist.obs)) {
            for (const entry of checklist.obs) {
              if (entry.speciesCode) {
                obsMap.set(entry.speciesCode, {
                  comments:     entry.comments || null,
                  breedingCode: parseBreedingCode(entry.obsAux),
                  ageSex:       parseAgeSex(entry.obsAux),
                });
              }
            }
          }
          checklistCache.set(subId, { observerName: checklist?.userDisplayName || null, obsMap });
        } catch {
          checklistCache.set(subId, { observerName: null, obsMap: new Map() });
        }
      }));
    }
    for (const r of pageRecords) {
      if (r.subId) {
        const cached = checklistCache.get(r.subId);
        if (cached) {
          if (!r.userDisplayName && cached.observerName) r.userDisplayName = cached.observerName;
          const od = cached.obsMap.get(r.speciesCode);
          if (od) {
            if (!r.comments     && od.comments)     r.comments     = od.comments;
            if (!r.breedingCode && od.breedingCode) r.breedingCode = od.breedingCode;
            if (!r.ageSex       && od.ageSex)       r.ageSex       = od.ageSex;
          }
        }
      }
    }
  }

  async function buildSightingsPage(records, page, location, speciesName, regionCode) {
    // Sort chronologically (oldest first) by observation date
    records.sort((a, b) => (a.obsDt || '').localeCompare(b.obsDt || ''));

    const totalPages = Math.ceil(records.length / SIGHTINGS_PER_PAGE);
    const start = page * SIGHTINGS_PER_PAGE;
    const pageRecords = records.slice(start, start + SIGHTINGS_PER_PAGE);

    await enrichPageRecords(pageRecords);

    const tz     = regionCode ? getTimezoneForRegion(regionCode) : 'UTC';
    const tzAbbr = regionCode ? ` ${getTzAbbr(tz)}` : '';

    const lines = pageRecords.map((r, i) => {
      const [datePart, timePart] = (r.obsDt || '').split(' ');
      const fmtDate = datePart ? datePart.split('-').reverse().join('/') : '';
      const fmtTime = timePart ? `${timePart}${tzAbbr} hrs` : null;
      const cnt          = r.howMany ? `${r.howMany} bird${r.howMany > 1 ? 's' : ''}` : 'Present';
      const checklistUrl = r.subId ? `https://ebird.org/checklist/${r.subId}` : null;
      const locUrl       = r.locId ? `https://ebird.org/hotspot/${r.locId}` : null;
      const locLabel     = escHtml(r.locName || 'Unknown location');
      const locText      = locUrl ? `<a href="${locUrl}">${locLabel}</a>` : `<b>${locLabel}</b>`;
      const mapsUrl      = (r.lat && r.lng) ? `https://www.google.com/maps?q=${r.lat},${r.lng}` : null;
      const coordLabel   = (r.lat && r.lng) ? `${Number(r.lat).toFixed(4)}, ${Number(r.lng).toFixed(4)}` : null;
      const observer     = r.userDisplayName ? escHtml(r.userDisplayName) : null;

      const breedCode = r.breedingCode || null;
      const breedDesc = breedCode ? (BREEDING_CODES[breedCode] || breedCode) : null;

      let entry = `<b>${start + i + 1}. ${locText}</b>\n`;
      entry += `   🔍 Count: <b>${cnt}</b>\n`;
      entry += `   🔬 ${r.ageSex ? escHtml(r.ageSex) : '—'}\n`;
      if (fmtDate) entry += `   📅 ${fmtDate}\n`;
      if (fmtTime) entry += `   🕒 ${fmtTime}\n`;
      if (checklistUrl) entry += `   🔗 <a href="${checklistUrl}">View Checklist</a>\n`;
      if (coordLabel) entry += `   🗺️ <a href="${mapsUrl}">${coordLabel}</a>\n`;
      if (observer) entry += `   👤 ${observer}\n`;
      if (breedCode) entry += `   🐣 ${escHtml(breedCode)} — ${escHtml(breedDesc)}\n`;
      if (r.comments) entry += `   💬 ${escHtml(r.comments)}\n`;
      return entry.trimEnd();
    });

    const header = `🐦 <b>${escHtml(speciesName)} Sightings — ${escHtml(location)}</b>\n` +
      `Page ${page + 1} of ${totalPages} · ${records.length} total\n\n`;
    const text = header + lines.join('\n\n');

    // Pagination row: << < [page/total] > >>
    const isFirst = page === 0;
    const isLast  = page >= totalPages - 1;
    const navRow  = [
      { text: '⏮', callback_data: isFirst ? 'ebird_noop' : 'ebird_page_0' },
      { text: '◀️', callback_data: isFirst ? 'ebird_noop' : `ebird_page_${page - 1}` },
      { text: `${page + 1}/${totalPages}`, callback_data: 'ebird_noop' },
      { text: '▶️', callback_data: isLast  ? 'ebird_noop' : `ebird_page_${page + 1}` },
      { text: '⏭', callback_data: isLast  ? 'ebird_noop' : `ebird_page_${totalPages - 1}` },
    ];

    const buttons = [navRow];
    buttons.push([
      { text: '🔢 Jump to Page', callback_data: 'ebird_jump' },
      { text: '❌ Close', callback_data: 'ebird_close' },
    ]);

    return { text, keyboard: { inline_keyboard: buttons } };
  }

  bot.on('callback_query', async (query) => {
    const { data } = query;
    if (data === 'ebird_noop') { bot.answerCallbackQuery(query.id); return; }

    // Close — delete the sightings message
    if (data === 'ebird_close') {
      const chatId = query.message?.chat?.id;
      const msgId  = query.message?.message_id;
      logger.info('[identify] ebird_close received', { chatId, msgId });
      await bot.answerCallbackQuery(query.id).catch(err => logger.warn('[identify] ebird_close answerCbQuery failed', { error: err?.message }));
      if (chatId && msgId) {
        await bot.deleteMessage(chatId, msgId).catch(err => logger.warn('[identify] ebird_close deleteMessage failed', { chatId, msgId, error: err?.message }));
      }
      return;
    }

    // Jump to page — ask user for page number
    if (data === 'ebird_jump') {
      const userId = query.from?.id;
      const cached = ebirdSightingsCache.get(userId);
      if (!cached) { bot.answerCallbackQuery(query.id); return; }
      const totalPages = Math.ceil(cached.records.length / SIGHTINGS_PER_PAGE);
      bot.answerCallbackQuery(query.id);
      pending.set(query.message.chat.id, {
        ...pending.get(query.message.chat.id),
        awaitingEbirdJump: true,
        ebirdJumpMsgId: query.message.message_id,
        ebirdTotalPages: totalPages,
      });
      await bot.sendMessage(query.message.chat.id, `🔢 Enter a page number (1–${totalPages}):`)
        .catch(() => {});
      return;
    }

    if (!data || !data.startsWith('ebird_page_')) return;

    const page   = parseInt(data.replace('ebird_page_', ''), 10) || 0;
    const userId = query.from?.id;
    bot.answerCallbackQuery(query.id);

    const cached = ebirdSightingsCache.get(userId);
    if (!cached || !cached.records.length) {
      await bot.answerCallbackQuery(query.id, {
        text: 'Sightings session expired. Please send a new photo to see sightings.',
        show_alert: true,
      }).catch(() => {});
      return;
    }

    // First page: send a new message. Subsequent pages: edit the existing one.
    if (page === 0 && query.message.photo) {
      // Button was on the photo — send a new text message for the list
      const loadMsg = await bot.sendMessage(query.message.chat.id, '⏳ Loading sightings…').catch(() => null);
      const { text, keyboard } = await buildSightingsPage(cached.records, page, cached.location, cached.speciesName, cached.regionCode);
      await bot.deleteMessage(query.message.chat.id, loadMsg?.message_id).catch(() => {});
      await bot.sendMessage(query.message.chat.id, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard,
      }).catch(() => {});
    } else {
      const { text, keyboard } = await buildSightingsPage(cached.records, page, cached.location, cached.speciesName, cached.regionCode);
      await bot.editMessageText(text, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard,
      }).catch(async () => {
        // If edit fails (e.g. message too old), send fresh
        await bot.sendMessage(query.message.chat.id, text, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: keyboard,
        }).catch(() => {});
      });
    }
  });

  // ── Skip callback ──────────────────────────────────────────────────────────
  bot.on('callback_query', async (query) => {
    const { data } = query;
    if (data !== 'identify_skip_location') return;
    const userId = query.from?.id;
    bot.answerCallbackQuery(query.id);

    if (!userId || !pending.has(userId)) return;
    const state = pending.get(userId);
    const chatId = state.chatId;
    pending.delete(userId);
    await bot.deleteMessage(chatId, state.locationMsgId).catch(() => {});

    // If Telegram geo pin is present, use its coordinates to get the country only
    let locationValue = '';
    if (query.message && query.message.location) {
      // Telegram location object: { latitude, longitude }
      const loc = query.message.location;
      try {
        // Use Nominatim reverse geocoding to get the country
        const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${loc.latitude}&lon=${loc.longitude}&zoom=3&addressdetails=1`;
        const geoRes = await axios.get(nominatimUrl, { headers: { 'User-Agent': 'WildlifeBot/1.0' } });
        if (geoRes.data && geoRes.data.address && geoRes.data.address.country) {
          locationValue = geoRes.data.address.country;
        } else {
          locationValue = 'Singapore';
        }
      } catch {
        locationValue = 'Singapore';
      }
      lastLocationByUser.set(userId, locationValue);
    } else {
      // User tapped Skip — reuse last selected country/location when available.
      locationValue = getDefaultLocationForUser(userId);
    }

    await runIdentification(bot, chatId, state.buffer, state.mimeType, {
      location: locationValue,
      user: state.user,
      inputFileId: state.inputFileId,
      imageCapturedAt: state.imageCapturedAt,
      isCompressed: state.isCompressed !== false,
      visualQuestion: state.visualQuestion,
      sessionId: state.sessionId || '',
      chatType: state.chatType || 'private',
      channelName: state.channelName || '',
    });
  });

};

module.exports.clearEndedSession = clearEndedSession;
/** Clear a pending location-wait for a user so birdMenu can handle their next message. */
module.exports.clearPending = (userId) => { if (userId) { pending.delete(userId); pendingInFlight.delete(userId); } };
/** Returns true if identify is waiting for a location reply from this user OR is currently processing one. */
module.exports.hasPending = (userId) => userId != null && (pending.has(userId) || pendingInFlight.has(userId));

// ── Run identification ────────────────────────────────────────────────────────

async function runIdentification(bot, chatId, buffer, mimeType, options) {
  // remove_keyboard cleans up the ReplyKeyboard shown during location prompt
  const statusMsg = await bot.sendMessage(chatId, '⏳ Analysing image…', {
    reply_markup: { remove_keyboard: true },
  });

  const setStatus = (text) =>
    bot.editMessageText(text, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }).catch(() => {});

  try {
    // Build Gemini options — map Telegram-specific fields to the identifyAnimal API
    const geminiOptions = {
      location: options.location || '',
      country: options.country || '',
      identifyTarget: options.visualQuestion || options.identifyTarget || '',
      habitat: options.habitat || '',
      additionalNotes: options.additionalNotes || '',
      imageCapturedAt: options.imageCapturedAt || null,
      isCompressed: options.isCompressed !== false,
    };
    const result = await geminiService.identifyAnimal(buffer, mimeType, geminiOptions);

    if (!result.success) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ Identification failed: ${escHtml(result.error)}`);
    }

    const data = result.data;
    // ── Sex/gender debug ──────────────────────────────────────────────────────
    logger.info('[identify] Gemini sex fields', {
      sex: data.sex,
      sexConfidence: data.sexConfidence,
      sexMethod: data.sexMethod,
    });
    // ─────────────────────────────────────────────────────────────────────────
    const tax = data.taxonomy || {};
    const isBird = ['aves', 'bird'].some(k => (tax.class || '').toLowerCase().includes(k));

    const speciesLabel = data.commonName || data.scientificName || 'species';
    // Fire-and-forget — UI update, does not need to block the pipeline.
    setStatus(`🔎 Cross-referencing <b>${escHtml(speciesLabel)}</b> with eBird &amp; GBIF…`);

    // GBIF usage key (used for occurrence queries)
    // Save Gemini's original names before any resolution, so eBird can try them first
    const geminiSciName = data.scientificName;
    const geminiCommonName = data.commonName;

    // Kick off GBIF lookup, geocoding, and iNat photo in parallel — all are independent
    const [_gbifNamesRes, _geoRes, _inatRes] = await Promise.allSettled([
      getGBIFNames(data.scientificName || data.commonName),
      options.location ? geocodeLocation(options.location) : Promise.resolve(null),
      !isBird && (data.scientificName || data.commonName)
        ? getSpeciesPhoto(data.scientificName || data.commonName)
        : Promise.resolve(null),
    ]);
    const gbifNames = _gbifNamesRes.status === 'fulfilled' ? _gbifNamesRes.value : null;
    let _prefetchedCoords = _geoRes.status === 'fulfilled' ? _geoRes.value : null;
    const _prefetchedInat  = _inatRes.status === 'fulfilled' ? _inatRes.value : null;

    // GBIF: resolve synonym → get usageKey for occurrence counts and accepted names for fallback matching
    let gbifUsageKey = null;
    let gbifResolvedSciName = null;
    let gbifResolvedCommonName = null;
    if (gbifNames && gbifNames.found) {
      gbifUsageKey = gbifNames.usageKey;
      gbifResolvedSciName = gbifNames.scientificName || null;
      gbifResolvedCommonName = gbifNames.commonName || null;
    }

    // Non-birds: use GBIF only for cross-reference/occurrence context.
    // Keep Gemini names for user-facing output even when GBIF accepted names differ.
    if (!isBird) {
      if (geminiSciName) data.scientificName = geminiSciName;
      if (geminiCommonName) data.commonName = geminiCommonName;
    }

    // eBird species code (birds only)
    // Priority: Gemini's own name first (eBird/IOC taxonomy is authoritative for birds),
    // then GBIF's accepted name as fallback (handles genuinely outdated Gemini names).
    let ebirdSpeciesCode = null;
    let _ebirdFoundViaSciName = false;
    if (isBird && (geminiSciName || geminiCommonName)) {
      const ebirdCandidates = [
        geminiSciName,
        gbifResolvedSciName,
        geminiCommonName,
        gbifResolvedCommonName,
      ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
      // Run all candidate lookups in parallel — with warm taxonomy cache each is ~1ms.
      // On cold taxonomy, all 4 share the same in-flight download promise.
      const ebirdLookups = await Promise.all(
        ebirdCandidates.map(name => getSpeciesCode(name).catch(() => ({ found: false })))
      );
      for (let _i = 0; _i < ebirdCandidates.length; _i++) {
        const lookup = ebirdLookups[_i];
        if (!lookup.found) continue;
        ebirdSpeciesCode = lookup.speciesCode;
        // Only adopt eBird's display names when the match came from Gemini's own names.
        // If the match came from a GBIF-resolved synonym, keep Gemini's identification.
        const matchedFromGemini = ebirdCandidates[_i] === geminiSciName || ebirdCandidates[_i] === geminiCommonName;
        if (matchedFromGemini) {
          if (lookup.commonName) data.commonName = lookup.commonName;
          if (lookup.scientificName) data.scientificName = lookup.scientificName;
        }
        _ebirdFoundViaSciName = (ebirdCandidates[_i] === gbifResolvedSciName || ebirdCandidates[_i] === geminiSciName);
        break;
      }
      // Fetch eBird Identifiable Sub-specific Groups (ISSF) — done later after locationCoords is resolved
    }

    // Separate species code for sightings count: scientific-name candidates only.
    // If the first loop already found the code via a scientific name, reuse it directly.
    let ebirdSpeciesCodeForSightings = ebirdSpeciesCode;
    if (isBird && !_ebirdFoundViaSciName) {
      const scientificCandidates = [
        gbifResolvedSciName,
        geminiSciName,
      ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
      // Parallel lookups — results already cached from the main loop above.
      const sciLookups = await Promise.all(
        scientificCandidates.map(name => getSpeciesCode(name).catch(() => ({ found: false })))
      );
      for (let _i = 0; _i < scientificCandidates.length; _i++) {
        if (!sciLookups[_i].found) continue;
        ebirdSpeciesCodeForSightings = sciLookups[_i].speciesCode;
        break;
      }
    }

    // iNaturalist slug (non-birds only)
    let inatSlug = null;
    let logCountry = options.location || '';
    let locationCoords = null;
    let speciesRecentRecords = [];
    let speciesSightingsLocation = options.location || '';
    let ebirdRegionForCaption = '';  // subnational or country code for eBird species URL
    if (!isBird && (data.scientificName || data.commonName)) {
      const inatData = _prefetchedInat;
      if (inatData && inatData.taxonSlug) inatSlug = inatData.taxonSlug;
    }

    if (isBird) {
      // Determine country from user's location
      let country = 'Singapore';
      let countryCode = '';
      let countryCoords = null;
      if (options.location) {
        countryCoords = _prefetchedCoords || await geocodeLocation(options.location).catch(() => null);
        _prefetchedCoords = null; // consumed
        if (countryCoords) {
          country = countryCoords.country || (countryCoords.displayName ? countryCoords.displayName.split(',').map(s => s.trim()).pop() : 'Singapore');
          countryCode = (countryCoords.country_code || '').toUpperCase();
        }
      }
      logCountry = country;

      // Build species slug for singaporebirds.com
      let speciesSlug = null;
      if (data.commonName) {
        speciesSlug = String(data.commonName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      } else if (ebirdSpeciesCode) {
        speciesSlug = ebirdSpeciesCode.replace(/_/g, '-');
      } else if (data.scientificName) {
        speciesSlug = String(data.scientificName).toLowerCase().replace(/ /g, '-');
      }

      let sgAbundance = null;
      const isSingapore = countryCode === 'SG' || (!options.location && country.toLowerCase().includes('singapore'));

      // Always fetch GBIF + eBird occurrence for cross-reference (all birds, all locations)
      let gbifOcc = { count: 0 };
      let ebirdLocal = { found: false, count: 0 };
      locationCoords = countryCoords;
      if (options.location) {
        // Fire-and-forget — UI update, does not need to block the pipeline.
        setStatus(`📍 Looking up sightings near <b>${escHtml(options.location)}</b>…`);
        if (!locationCoords) {
          locationCoords = await geocodeLocation(options.location).catch(() => null);
        }
        if (locationCoords) {
          countryCode = (locationCoords.country_code || countryCode || '').toUpperCase();
          country = locationCoords.country || country;
        }
      }

      // Resolve boundary scope: subnational (e.g. JP-20 = Nagano) or country (e.g. JP = Japan).
      // This is used for BOTH local-status classification AND sightings records.
      const resolvedCountryCode = (locationCoords?.country_code || countryCode || '').toUpperCase();
      // Strip common admin suffixes Nominatim appends (e.g. "Nagano Prefecture" → "Nagano")
      const stateName = (locationCoords?.state || '')
        .replace(/\s+(prefecture|province|state|region|district|county|oblast|krai|shire|department)$/i, '')
        .trim();

      // Fast path: Nominatim ISO3166-2-lvl4 → direct eBird subnational code
      let subnationalCode = null;
      if (locationCoords?.isoSubdivision && /^[A-Z]{2}-/.test(locationCoords.isoSubdivision)) {
        subnationalCode = locationCoords.isoSubdivision;
      }

      // Boundary label (may be updated below if slow-path subnationalCode resolves)
      speciesSightingsLocation = subnationalCode
        ? (stateName
            ? `${stateName}, ${locationCoords?.country || country}`
            : (options.location || locationCoords?.country || country || 'Unknown location'))
        : (locationCoords?.country || country || options.location || 'Unknown location');
      ebirdRegionForCaption = subnationalCode || resolvedCountryCode || '';

      // Run all independent I/O in parallel:
      //   1. GBIF occurrence count at location
      //   2. eBird local status (country-level; subnational is used below if resolved)
      //   3. eBird subnational code slow-path lookup (if not already from isoSubdivision)
      //   4. singaporebirds.com scrape for local status + abundance (SG only)
      const _ebirdLocalQuery = subnationalCode
        ? { subnationalCode }
        : resolvedCountryCode
          ? { countryCode: resolvedCountryCode, isCountryOnly: true }
          : locationCoords ? { ...locationCoords } : null;
      const [_gbifOccRes, _ebirdLocalRes, _subCodeRes, _sgRes] = await Promise.allSettled([
        gbifUsageKey && locationCoords
          ? checkOccurrencesAtLocation(gbifUsageKey, locationCoords)
          : Promise.resolve({ count: 0 }),
        ebirdSpeciesCode && locationCoords && _ebirdLocalQuery
          ? getNearbySpeciesObservations(ebirdSpeciesCode, _ebirdLocalQuery)
          : Promise.resolve({ found: false, count: 0 }),
        (!subnationalCode && resolvedCountryCode && stateName && options.location)
          ? getEBirdSubnationalCode(resolvedCountryCode, stateName)
          : Promise.resolve(subnationalCode),
        (isSingapore && speciesSlug)
          ? axios.get(`https://singaporebirds.com/species/${speciesSlug}/`, { headers: { 'User-Agent': 'WildlifeBot/1.0' }, timeout: 5000 }).catch(() => null)
          : Promise.resolve(null),
      ]);

      gbifOcc = (_gbifOccRes.status === 'fulfilled' && _gbifOccRes.value) || { count: 0 };
      ebirdLocal = (_ebirdLocalRes.status === 'fulfilled' && _ebirdLocalRes.value) || { found: false, count: 0 };
      if (_subCodeRes.status === 'fulfilled' && _subCodeRes.value) {
        subnationalCode = _subCodeRes.value;
        // Refine location labels now that subnational code is known
        speciesSightingsLocation = subnationalCode
          ? (stateName
              ? `${stateName}, ${locationCoords?.country || country}`
              : (options.location || locationCoords?.country || country || 'Unknown location'))
          : (locationCoords?.country || country || options.location || 'Unknown location');
        ebirdRegionForCaption = subnationalCode || resolvedCountryCode || '';
      }
      const _sgResp = _sgRes.status === 'fulfilled' ? _sgRes.value : null;
      if (_sgResp?.data) {
        const localStatusMatch = _sgResp.data.match(/Local Status:\s*<[^>]*>\s*([^<]+)/i);
        if (localStatusMatch) data.localStatus = localStatusMatch[1].trim();
        const abundanceMatch = _sgResp.data.match(/Abundance:\s*<[^>]*>\s*([^<]+)/i);
        if (abundanceMatch) sgAbundance = abundanceMatch[1].trim();
      }

      // Run sightings count + ISSF subspecies + GBIF country-subspecies all in parallel.
      // regionCode is needed by ISSF and GBIF regardless of ebirdSpeciesCode.
      // Fall back to 'SG' when isSingapore is true but no location coords were resolved
      // (e.g. user skipped location or geocoding failed) so subspecies lookups still run.
      const regionCode = (locationCoords?.country_code || countryCode || (isSingapore ? 'SG' : '')).toUpperCase();
      logger.info(`[identify] Sightings lookup: code=${ebirdSpeciesCodeForSightings}, subnational=${subnationalCode}, country=${resolvedCountryCode}`);

      // Build the sightings promise.
      // When the species code hasn't changed from the local-status lookup, reuse those
      // records directly to avoid an identical second round-trip to the eBird API.
      let _sightingsPromise;
      if (!ebirdSpeciesCodeForSightings) {
        _sightingsPromise = Promise.resolve(null);
      } else if (ebirdSpeciesCodeForSightings === ebirdSpeciesCode && ebirdLocal?.found) {
        _sightingsPromise = Promise.resolve({ _reuse: true, count: ebirdLocal.count, records: ebirdLocal.records || [] });
      } else if (subnationalCode) {
        _sightingsPromise = getNearbySpeciesObservations(ebirdSpeciesCodeForSightings, { subnationalCode })
          .catch(() => ({ found: false, count: null, records: [] }));
      } else if (resolvedCountryCode) {
        _sightingsPromise = getNearbySpeciesObservations(ebirdSpeciesCodeForSightings, { countryCode: resolvedCountryCode, isCountryOnly: true })
          .catch(() => ({ found: false, count: null, records: [] }));
      } else {
        _sightingsPromise = Promise.resolve(null);
      }

      let speciesCountrySightingsCount = null;
      const [_sightingsRes, _issfRes, _gbifSubspRes] = await Promise.allSettled([
        _sightingsPromise,
        (ebirdSpeciesCode && regionCode)
          ? getEBirdSubspecificGroups(ebirdSpeciesCode, regionCode).catch(() => [])
          : Promise.resolve([]),
        (gbifUsageKey && regionCode && ebirdSpeciesCode)
          ? getSubspeciesOccurrencesByCountry(gbifUsageKey, regionCode).catch(() => [])
          : Promise.resolve([]),
      ]);

      // Unpack sightings result
      const _sData = _sightingsRes.status === 'fulfilled' ? _sightingsRes.value : null;
      if (_sData?._reuse) {
        speciesCountrySightingsCount = _sData.count ?? null;
        speciesRecentRecords = _sData.records;
        logger.info(`[identify] Reused ebirdLocal sightings: count=${speciesCountrySightingsCount}, records=${speciesRecentRecords.length}`);
      } else if (_sData) {
        speciesCountrySightingsCount = _sData?.found ? (_sData.count ?? null) : null;
        speciesRecentRecords = _sData?.records || [];
        logger.info(`[identify] Sightings result: count=${speciesCountrySightingsCount}, records=${speciesRecentRecords.length}`);
      }

      // Unpack ISSF and GBIF subspecies results
      const issfGroups = _issfRes.status === 'fulfilled' ? _issfRes.value : [];
      const gbifSubspInCountry = _gbifSubspRes.status === 'fulfilled' ? _gbifSubspRes.value : [];

      // Process subspecies data (requires ISSF + GBIF results from above)
      if (ebirdSpeciesCode) {
        const geminiSubsp = data.taxonomy?.subspecies;
        const isSkip = v => !v || ['null', 'monotypic', 'unknown', 'none', ''].includes(String(v).toLowerCase().trim());
        // getEpithets handles slash taxa: "ernesti/nesiotes" → ["ernesti", "nesiotes"]
        const getEpithet  = name => name.trim().split(/\s+/).pop().toLowerCase();
        const getEpithets = name => getEpithet(name).split('/').map(p => p.trim()).filter(Boolean);

        // ── Always build the canonical eBird-sourced subspecies list ──────────
        const _noMonotypic = s => !['monotypic', 'null', 'none', ''].includes(String(s || '').toLowerCase().trim()) && !String(s || '').includes('[');
        const ebirdSubspList = issfGroups.filter(_noMonotypic);

        if (ebirdSubspList.length > 0) {
          data.subspecies = ebirdSubspList;
          data.subspeciesByLocation = true;
          data.subspeciesLocation = country || options.location || regionCode || 'eBird';
        }

        // ── If Gemini also identified a subspecies from the image, record it ─
        // This is stored separately so the canvas can flag it as image-confirmed.
        if (!isSkip(geminiSubsp)) {
          const epithet = getEpithet(String(geminiSubsp));
          const issfMatch = issfGroups.find(g => getEpithets(g).includes(epithet));
          if (issfMatch) {
            data.subspeciesFromImage = true;
            data.subspeciesImageMatch = issfMatch; // the specific ISSF group Gemini confirmed
          } else {
            const gbifMatch = gbifSubspInCountry.find(s => getEpithets(s.name).includes(epithet));
            if (gbifMatch) {
              data.subspeciesFromImage = true;
              data.subspeciesImageMatch = gbifMatch.name;
            }
          }
        }
      }

      if (isSingapore) {
        // Abundance: prefer singaporebirds.com, fallback to GBIF+eBird classification
        if (sgAbundance) {
          data.abundance = sgAbundance;
        } else {
          const abundance = classifyAbundance({ gbifOccurrence: gbifOcc, ebirdSummary: ebirdLocal });
          data.abundanceCode = abundance.code;
          data.abundance = abundance.label;
        }
        // Species sightings count within the resolved country boundary.
        if (ebirdSpeciesCode) {
          data.ebirdSightingsCount = speciesCountrySightingsCount;
          data.ebirdSightingsLocation = speciesSightingsLocation;
          // Local Status: prefer singaporebirds.com; fall back to GBIF country count + eBird
          if (!data.localStatus) {
            const classified = classifyLocalStatus({
              gbifOccurrence: gbifOcc,
              ebirdSummary: ebirdLocal,
              migratoryStatus: data.migratoryStatus,
            });
            data.localStatusCode = classified.code;
            data.localStatus = classified.label;
          }
        }
      } else {
        // Non-Singapore: derive local status and abundance from GBIF + eBird
        const classified = classifyLocalStatus({
          gbifOccurrence: gbifOcc,
          ebirdSummary: ebirdLocal,
          migratoryStatus: data.migratoryStatus,
        });
        data.localStatusCode = classified.code;
        data.localStatus = classified.label;
        const abundance = classifyAbundance({ gbifOccurrence: gbifOcc, ebirdSummary: ebirdLocal });
        data.abundanceCode = abundance.code;
        data.abundance = abundance.label;
        // Species sightings count within the resolved country boundary.
        if (ebirdSpeciesCode) {
          data.ebirdSightingsCount = speciesCountrySightingsCount;
          data.ebirdSightingsLocation = speciesSightingsLocation;
        }
      }
    } else {
      // Non-bird: use GBIF for local presence.
      // _prefetchedCoords was already fetched in the first parallel block — reuse it.
      const nonBirdLocationCoords = locationCoords || _prefetchedCoords || null;
      let nonBirdSightingsCount = null;
      let nonBirdSightingsLocation = options.location || '';

      if (gbifUsageKey) {
        // Run local occurrence + global count in parallel; only the relevant result is used.
        const [_localOccRes, _globalCountRes] = await Promise.allSettled([
          nonBirdLocationCoords
            ? checkOccurrencesAtLocation(gbifUsageKey, nonBirdLocationCoords).catch(() => ({ count: 0 }))
            : Promise.resolve(null),
          !nonBirdLocationCoords
            ? getGlobalOccurrenceCount(gbifUsageKey).catch(() => null)
            : Promise.resolve(null),
        ]);

        const occ = _localOccRes.status === 'fulfilled' ? _localOccRes.value : null;
        const globalCount = _globalCountRes.status === 'fulfilled' ? _globalCountRes.value : null;

        if (occ) {
          nonBirdSightingsCount = occ.count || 0;
          nonBirdSightingsLocation = nonBirdLocationCoords.country || nonBirdLocationCoords.displayName || options.location || '';
          const n = occ.count || 0;
          if (n > 50)     data.localStatus = 'Common Locally';
          else if (n > 5) data.localStatus = 'Present Locally';
          else if (n > 0) data.localStatus = 'Rarely Recorded';
          else            data.localStatus = 'Not Recorded Nearby';
          const abundance = classifyAbundance({ gbifOccurrence: occ, ebirdSummary: { count: 0 } });
          data.abundanceCode = abundance.code;
          data.abundance = abundance.label;
        } else if (typeof globalCount === 'number') {
          nonBirdSightingsCount = globalCount;
          nonBirdSightingsLocation = 'Global (GBIF)';
        }
      }

      if (typeof nonBirdSightingsCount === 'number' && nonBirdSightingsCount >= 0) {
        // Reuse existing canvas fields so non-bird results also show sightings count.
        data.ebirdSightingsCount = nonBirdSightingsCount;
        data.ebirdSightingsLocation = nonBirdSightingsLocation || 'GBIF';
      }
    }

    // Fetch reference species photo starting from the identified taxonomy level.
    // identificationLevel: "subspecies" | "species" | "genus" | "family"
    await setStatus('🖼️ Building result…');
    let wikiImageUrl = null;
    const idLevel = (data.identificationLevel || 'species').toLowerCase();
    const atSpeciesOrBelow = idLevel === 'species' || idLevel === 'subspecies';

    if (atSpeciesOrBelow) {
      // Species-level: use primary source (eBird for birds, iNaturalist for others)
      if (isBird) {
        if (ebirdSpeciesCode) {
          const ebirdPhoto = await getEBirdPhoto(ebirdSpeciesCode).catch(() => ({ found: false }));
          if (ebirdPhoto.found) wikiImageUrl = ebirdPhoto.photoUrl;
        }
        if (!wikiImageUrl) {
          const name = data.scientificName || data.commonName;
          if (name) {
            const wikiInfo = await getWikipediaInfo(name).catch(() => null);
            if (wikiInfo?.imageUrl) wikiImageUrl = wikiInfo.imageUrl;
          }
        }
      } else {
        const inatPhoto = await getSpeciesPhoto(data.scientificName || data.commonName).catch(() => ({ found: false }));
        if (inatPhoto?.found) wikiImageUrl = inatPhoto.photoUrl;
        if (!wikiImageUrl) {
          const name = data.scientificName || data.commonName;
          if (name) {
            const wikiInfo = await getWikipediaInfo(name).catch(() => null);
            if (wikiInfo?.imageUrl) wikiImageUrl = wikiInfo.imageUrl;
          }
        }
      }
    }

    // Taxonomy-level fallback — starts from the deepest level Gemini identified to:
    //   genus-level ID  → genus → family → order
    //   family-level ID → family → order
    //   species-level (photo still missing after above) → genus → family → order
    if (!wikiImageUrl) {
      const tx = data.taxonomy || {};
      const allLevels = [
        { level: 'genus',  name: tx.genus },
        { level: 'family', name: tx.family },
        { level: 'order',  name: tx.order },
      ];
      // Find the starting position based on identificationLevel
      const startLevel = idLevel === 'family' ? 'family' : 'genus';
      const startIdx = allLevels.findIndex(l => l.level === startLevel);
      const fallbacks = allLevels.slice(startIdx).map(l => l.name).filter(Boolean);
      for (const taxName of fallbacks) {
        const wikiInfo = await getWikipediaInfo(taxName).catch(() => null);
        if (wikiInfo?.imageUrl) { wikiImageUrl = wikiInfo.imageUrl; break; }
      }
    }

    // Pre-compute display fields so imageService is pure rendering (no logic)
    computeDisplayFields(data);

    const canvas = await createResultCanvas(wikiImageUrl, buffer, data);
    const usedToday   = await getTodayCount(chatId);
    const dailyLimit   = options.chatType === 'group' || options.chatType === 'supergroup' ? GROUP_DAILY_LIMIT : PRIVATE_DAILY_LIMIT;
    const remaining    = Math.max(0, dailyLimit - usedToday);
    const caption      = buildCaption(data, ebirdSpeciesCode, inatSlug, remaining, dailyLimit);

    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

    // Cache eBird sightings records before sending so the button is ready
    const userId = options.user?.id;
    if (userId && speciesRecentRecords.length > 0) {
      ebirdSightingsCache.set(userId, {
        records: speciesRecentRecords,
        location: speciesSightingsLocation,
        speciesName: data.commonName || data.scientificName || 'Species',
        regionCode: ebirdRegionForCaption || '',
      });
    } else if (userId) {
      ebirdSightingsCache.delete(userId);
    }

    const photoKeyboard = speciesRecentRecords.length > 0
      ? { inline_keyboard: [[{ text: '🔍 Sightings', callback_data: 'ebird_page_0' }]] }
      : undefined;

    if (canvas) {
      const sentMsg = await bot.sendPhoto(
        chatId,
        canvas,
        { caption, parse_mode: 'HTML', reply_markup: photoKeyboard },
        { filename: 'identification.jpg', contentType: 'image/jpeg' }
      );
      // Log to Google Sheets — fire-and-forget, never block the response
      const species = data.commonName || data.scientificName || null;
      const photos = sentMsg?.photo;
      const canvasFileId = photos?.[photos.length - 1]?.file_id || null;
      const sessionStart = getSessionStart(options.user?.id);
      const resolvedSessionId = options.sessionId || sessionStart?.sessionId || '';
      sheetsService.logAnimalIdentification({
        user: options.user,
        species,
        canvasFileId,
        location: options.location || '',
        country: logCountry,
        chatId,
        sessionId: resolvedSessionId,
        chatType: options.chatType || 'private',
        channelName: options.channelName || '',
      }).catch(() => {});
    } else {
      await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: photoKeyboard });
    }

    if (options.visualQuestion && data.visualQuestionAnswer) {
      await bot.sendMessage(
        chatId,
        `🧠 <b>Visual Q&A</b>\n<b>Q:</b> ${escHtml(options.visualQuestion)}\n<b>A:</b> ${escHtml(data.visualQuestionAnswer)}`,
        { parse_mode: 'HTML' }
      );
    }

    // Continue / Stop prompt (no sightings button here — it's on the photo)
    await bot.sendMessage(
      chatId,
      '❓ Would you like to identify another animal?',
      { reply_markup: { inline_keyboard: [[
        { text: '✅ Continue', callback_data: 'identify_continue' },
        { text: '🛑 Stop',     callback_data: 'identify_stop'     },
      ]] } }
    );
  } catch (err) {
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, `❌ Something went wrong: ${escHtml(err.message)}`);
  }
}

// ── Rich detail message (sent after canvas photo) ────────────────────────────

function buildDetailMessage(data, gbifNames, ebirdSpeciesCode) {
  const h = escHtml;
  const skip = v => !v || ['null', 'none', 'unknown', 'n/a', ''].includes(String(v).toLowerCase().trim());
  const lines = [];

  // ── Cross-reference verification ───────────────────────────────────────────
  lines.push('<b>🔍 Cross-Reference Verification</b>');
  if (gbifNames?.found) {
    const gbifSci = gbifNames.scientificName || data.scientificName || '';
    const gbifRank = gbifNames.rank || 'SPECIES';
    lines.push(`✅ <b>GBIF:</b> <i>${h(gbifSci)}</i> (${h(gbifRank)})`);
  } else {
    lines.push('❓ <b>GBIF:</b> Not found');
  }
  const tax = data.taxonomy || {};
  const isBirdDetail = ['aves', 'bird'].some(k => (tax.class || '').toLowerCase().includes(k));
  if (isBirdDetail) {
    if (ebirdSpeciesCode) {
      lines.push(`✅ <b>eBird:</b> ${h(data.commonName || '')} <code>${h(ebirdSpeciesCode)}</code>`);
    } else {
      lines.push('❓ <b>eBird:</b> Not found');
    }
  }

  // ── Taxonomy ──────────────────────────────────────────────────────────────
  const taxParts = [tax.class, tax.order, tax.family].filter(Boolean);
  if (taxParts.length > 0) {
    lines.push('');
    lines.push(`<b>🧬 Taxonomy:</b> ${taxParts.map(h).join(' › ')}`);
  }

  // ── Observation details ───────────────────────────────────────────────────
  const obsLines = [];
  if (!skip(data.viewAngle)) obsLines.push(`📐 <b>View:</b> ${h(data.viewAngle)}`);
  if (!skip(data.migratoryStatus)) obsLines.push(`🌍 <b>Migratory status:</b> ${h(data.migratoryStatus)}`);
  if (!skip(data.breedingPlumage) && String(data.breedingPlumage).toLowerCase() !== 'no')
    obsLines.push(`🪺 <b>Breeding plumage:</b> ${h(data.breedingPlumage)}`);
  if (obsLines.length > 0) { lines.push(''); lines.push(...obsLines); }

  // ── Scene description ─────────────────────────────────────────────────────
  if (!skip(data.sceneDescription)) {
    lines.push('');
    lines.push('<b>🌿 Scene</b>');
    lines.push(h(data.sceneDescription));
  }

  // ── Plumage notes ─────────────────────────────────────────────────────────
  if (!skip(data.plumageNotes)) {
    lines.push('');
    lines.push('<b>🪶 Plumage notes</b>');
    lines.push(h(data.plumageNotes));
  }

  // ── Sexual dimorphism ─────────────────────────────────────────────────────
  if (!skip(data.sexualDimorphism)) {
    lines.push('');
    lines.push('<b>♀♂ Sexual dimorphism</b>');
    lines.push(h(data.sexualDimorphism));
  }

  // ── Identification reasoning ──────────────────────────────────────────────
  if (!skip(data.identificationReasoning)) {
    lines.push('');
    lines.push('<b>📋 Identification reasoning</b>');
    const r = data.identificationReasoning;
    lines.push(h(r.length > 700 ? r.slice(0, 700) + '…' : r));
  }

  // ── Similar species ruled out ─────────────────────────────────────────────
  if (Array.isArray(data.similarSpeciesRuledOut) && data.similarSpeciesRuledOut.length > 0) {
    lines.push('');
    lines.push('<b>❌ Similar species ruled out</b>');
    for (const item of data.similarSpeciesRuledOut) {
      lines.push(`• ${h(String(item))}`);
    }
  }

  return lines.join('\n');
}

// ── Caption with clickable links (shown below the canvas photo) ───────────────

function buildCaption(data, ebirdSpeciesCode, inatSlug, remaining, dailyLimit) {
  const sci = encodeURIComponent(data.scientificName || data.commonName || '');
  const isBird = (data.taxonomy && ['aves', 'bird'].some(k => (data.taxonomy.class || '').toLowerCase().includes(k)));

  const used = dailyLimit - remaining;
  const limitLine = `🔢 Identifications today: ${used} / ${dailyLimit}  (${remaining} remaining)`;

  const links = [];
  if (isBird) {
    if (ebirdSpeciesCode) {
      links.push(`🐦 <a href="https://ebird.org/species/${ebirdSpeciesCode}">eBird</a>`);
      links.push(`🌍 <a href="https://birdsoftheworld.org/bow/species/${ebirdSpeciesCode}">Birds of the World</a>`);
    }
  } else {
    const inatUrl = inatSlug
      ? `https://www.inaturalist.org/taxa/${inatSlug}`
      : `https://www.inaturalist.org/taxa/search?q=${sci}`;
    links.push(`🔬 <a href="${inatUrl}">iNaturalist</a>`);
  }
  links.push(`📖 <a href="https://en.wikipedia.org/wiki/${sci}">Wikipedia</a>`);

  return `${limitLine}\n${links.join('  ·  ')}`;
}
