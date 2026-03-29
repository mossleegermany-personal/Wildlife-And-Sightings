// ── Telegram Rate Limiting (per user/group, daily reset) ─────────────
const fs = require('fs');
const path = require('path');
const RATE_LIMIT_PATH = path.join(__dirname, 'rateLimitStore.json');
const USER_LIMIT = 14;
const GROUP_LIMIT = 30;

function loadRateLimitStore() {
  try {
    return JSON.parse(fs.readFileSync(RATE_LIMIT_PATH, 'utf8'));
  } catch {
    return { users: {}, groups: {}, lastReset: '' };
  }
}

function saveRateLimitStore(store) {
  fs.writeFileSync(RATE_LIMIT_PATH, JSON.stringify(store, null, 2));
}

function resetIfNeeded(store) {
  const now = new Date();
    const today = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore' }).format(now);
  if (store.lastReset !== today) {
    store.users = {};
    store.groups = {};
    store.lastReset = today;
    saveRateLimitStore(store);
  }
}

function checkAndIncrementRateLimit(userId, groupId) {
  const store = loadRateLimitStore();
  resetIfNeeded(store);
  // User check
  if (userId) {
    store.users[userId] = (store.users[userId] || 0) + 1;
    if (store.users[userId] > USER_LIMIT) {
      saveRateLimitStore(store);
      return { allowed: false, type: 'user', limit: USER_LIMIT };
    }
  }
  // Group check
  if (groupId) {
    store.groups[groupId] = (store.groups[groupId] || 0) + 1;
    if (store.groups[groupId] > GROUP_LIMIT) {
      saveRateLimitStore(store);
      return { allowed: false, type: 'group', limit: GROUP_LIMIT };
    }
  }
  saveRateLimitStore(store);
  return { allowed: true };
}
const ABUNDANCE_DEFINITIONS = {
  VC: 'Very common (VC) - found almost all the time in suitable locations',
  C:  'Common (C) - found most of the time in suitable locations',
  U:  'Uncommon (U) - found some of the time',
  R:  'Rare (R) - found several times a year',
  VR: 'Very rare (VR) - not found every year',
  Ex: 'Extirpated (Ex) - used to be found in Singapore, but not any more',
};

function classifyAbundance({ gbifOccurrence, ebirdSummary }) {
  // Use both GBIF and eBird counts for the location
  const gbifCount = gbifOccurrence?.count || 0;
  const ebirdCount = ebirdSummary?.count || 0;
  const total = gbifCount + ebirdCount;

  // Extirpated: if there are zero records in both
  if (gbifCount === 0 && ebirdCount === 0) {
    return { code: 'Ex', label: ABUNDANCE_DEFINITIONS.Ex };
  }
  // Very common: >100 records
  if (total > 100) {
    return { code: 'VC', label: ABUNDANCE_DEFINITIONS.VC };
  }
  // Common: 51-100
  if (total > 50) {
    return { code: 'C', label: ABUNDANCE_DEFINITIONS.C };
  }
  // Uncommon: 11-50
  if (total > 10) {
    return { code: 'U', label: ABUNDANCE_DEFINITIONS.U };
  }
  // Rare: 2-10
  if (total > 1) {
    return { code: 'R', label: ABUNDANCE_DEFINITIONS.R };
  }
  // Very rare: 1 record
  if (total === 1) {
    return { code: 'VR', label: ABUNDANCE_DEFINITIONS.VR };
  }
  // Fallback
  return { code: 'Ex', label: ABUNDANCE_DEFINITIONS.Ex };
}
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
const { getSpeciesPhoto } = require('../../animalIdentification/services/inaturalistService');
const { getSpeciesCode, getNearbySpeciesObservations, getEBirdSubspecificGroups } = require('../../animalIdentification/services/ebirdService');
const { getGBIFNames, geocodeLocation, checkOccurrencesAtLocation, getGeographicRange, getGlobalOccurrenceCount, getSubspeciesOccurrencesByCountry } = require('../../animalIdentification/services/gbifService');
const { getWikipediaInfo } = require('../../animalIdentification/services/wikipediaService');
const { consumeIdentifyPromptMessage, setIdentifyPromptMessage, hasIdentifyPromptMessage, setSessionStart, getSessionStart, clearSessionStart } = require('../menu/mainMenu');
const sheetsService = require('../../../database/googleSheets/services/googleSheetsService');
//const googleDriveService = require('../../../database/googleDrive/services/googleDriveService');
const logger = require('../../../src/utils/logger');

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// chatId → { buffer, mimeType, location, locationMsgId, imageCapturedAt, visualQuestion }
const pending = new Map();

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

const LOCAL_STATUS_DEFINITIONS = {
  R:   'Resident',
  RB:  'Resident Breeder',
  WV:  'Winter Visitor',
  PM:  'Passage Migrant',
  MB:  'Migrant Breeder',
  NBV: 'Non-breeding Visitor',
  V:   'Vagrant',
  I:   'Introduced',
  rI:  'Reintroduced',
};

function includesAny(text, words) {
  const normalized = String(text || '').toLowerCase();
  return words.some((w) => normalized.includes(w));
}

function classifyBirdLocalStatus({ gbifOccurrence, ebirdSummary, migratoryStatus }) {
  const occCount = gbifOccurrence?.count || 0;
  const monthsObservedCount = gbifOccurrence?.monthsObservedCount || 0;
  const breedingSignalCount = gbifOccurrence?.breedingSignalCount || 0;
  const establishmentMeans = gbifOccurrence?.establishmentMeans || [];
  const ebirdCount = ebirdSummary?.count || 0;
  const migration = String(migratoryStatus || '').toLowerCase();

  const introSignal = establishmentMeans.some((s) => includesAny(s, ['introduced', 'released', 'escape', 'escaped']));
  if (introSignal) {
    return { code: 'I', label: LOCAL_STATUS_DEFINITIONS.I };
  }

  const reintroSignal = establishmentMeans.some((s) => includesAny(s, ['reintroduced', 're-introduced', 'reintroduction']));
  if (reintroSignal) {
    return { code: 'rI', label: LOCAL_STATUS_DEFINITIONS.rI };
  }

  if (occCount === 0 && ebirdCount === 0) {
    return { code: 'V', label: LOCAL_STATUS_DEFINITIONS.V };
  }

  if (includesAny(migration, ['passage'])) {
    return { code: 'PM', label: LOCAL_STATUS_DEFINITIONS.PM };
  }

  if (includesAny(migration, ['winter visitor', 'wintering', 'wv'])) {
    return { code: 'WV', label: LOCAL_STATUS_DEFINITIONS.WV };
  }

  const hasYearRoundSignal = monthsObservedCount >= 10;
  const hasBreedingSignal = breedingSignalCount > 0 || includesAny(migration, ['breeder', 'breeding']);

  if (hasYearRoundSignal && hasBreedingSignal) {
    return { code: 'RB', label: LOCAL_STATUS_DEFINITIONS.RB };
  }

  if (hasYearRoundSignal && !hasBreedingSignal) {
    return { code: 'R', label: LOCAL_STATUS_DEFINITIONS.R };
  }

  if (hasBreedingSignal && !hasYearRoundSignal) {
    return { code: 'MB', label: LOCAL_STATUS_DEFINITIONS.MB };
  }

  if (occCount > 0 || ebirdCount > 0) {
    return { code: 'NBV', label: LOCAL_STATUS_DEFINITIONS.NBV };
  }

  return { code: 'V', label: LOCAL_STATUS_DEFINITIONS.V };
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
    const img = sharp(inputBuffer, { failOn: 'none' });
    const meta = await img.metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    if (!width || !height) return inputBuffer;

    let targetWidth = width;
    let targetHeight = height;
    const longEdge = Math.max(width, height);

    // Telegram photo uploads are often aggressively compressed; upscale small images.
    if (longEdge < 1280) {
      const scale = Math.min(2, 1280 / longEdge);
      targetWidth = Math.round(width * scale);
      targetHeight = Math.round(height * scale);
    }

    return await sharp(inputBuffer, { failOn: 'none' })
      .resize(targetWidth, targetHeight, { fit: 'inside', kernel: sharp.kernel.lanczos3, withoutEnlargement: false })
      .normalise()
      .sharpen({ sigma: 1.0, m1: 0.6, m2: 1.2 })
      .jpeg({ quality: 95, mozjpeg: true, chromaSubsampling: '4:4:4' })
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
  const sessionStart = getSessionStart(userId);
  pending.set(userId, {
    chatId,
    buffer: payload.buffer,
    mimeType: payload.mimeType,
    imageCapturedAt: payload.imageCapturedAt || null,
    visualQuestion: payload.visualQuestion || '',
    location: '',
    locationMsgId: locMsg.message_id,
    user,
    inputFileId: payload.inputFileId,
    sessionId: payload.sessionId || sessionStart?.sessionId || '',
    chatType: chat?.type || 'private',
    channelName: chat?.title || '',
  });
}

function buildSessionSender(chat, user) {
  return chat?.title
    || (user?.username ? `@${user.username}` : [user?.first_name, user?.last_name].filter(Boolean).join(' '))
    || 'Unknown';
}

async function ensureActiveSessionRecord(chat, user) {
  const chatType = chat?.type || 'private';
  const chatTitle = chat?.title || null;
  const sender = buildSessionSender(chat, user);
  const startTime = new Date();
  let sessionSn = null;
  let sessionId = '';

  const latest = await sheetsService.getLatestSessionStatus({
    subBot: 'Animal Identification',
    chatId: chat?.id,
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

async function hasActiveSessionBySheet(chat, user) {
  try {
    const latest = await sheetsService.getLatestSessionStatus({
      subBot: 'Animal Identification',
      chatId: chat?.id,
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
    const groupId = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup' ? chatId : null;
    // const rate = checkAndIncrementRateLimit(userId, groupId);
    // if (!rate.allowed) {
    //   const who = rate.type === 'user' ? 'user' : 'group';
    //   const limit = rate.limit;
    //   return bot.sendMessage(chatId, `❌ Daily ${who} identification limit reached (${limit} per day, resets at 00:00).`);
    // }

    const fromSessionEnded = sessionEnded.has(userId);
    if (fromSessionEnded) {
      sessionEnded.delete(userId);
      const endedMsg = sessionEndedMessages.get(userId);
      if (endedMsg) {
        await bot.deleteMessage(endedMsg.chatId, endedMsg.messageId).catch(() => {});
        sessionEndedMessages.delete(userId);
      }
    }

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

      const { buffer } = await downloadTelegramFile(bot, inputFileId);
      const imageCapturedAt = extractImageCapturedAt(buffer);
      const enhanced = await preprocessCompressedImage(buffer);

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
        // No active session: in private chat, continue and ask for location.
        // In groups, keep existing guard behavior to avoid accidental spam.
        const chatType = msg.chat?.type;
        const isGroupChat = chatType === 'group' || chatType === 'supergroup';
        if (!isGroupChat) {
          let sessionState = null;
          try {
            sessionState = await ensureActiveSessionRecord(msg.chat, msg.from);
          } catch {
            // Non-blocking: still continue with identification flow.
          }

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
              visualQuestion: (msg.caption || '').trim(),
              sessionId: sessionState?.sessionId || '',
            },
            msg.from,
            msg.chat
          );
          return;
        }

        return;
      } else {
        const activeBySheet = await hasActiveSessionBySheet(msg.chat, msg.from);
        if (!activeBySheet) {
          await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
          const promptMessageId = consumeIdentifyPromptMessage(chatId);
          if (promptMessageId) {
            await bot.deleteMessage(chatId, promptMessageId).catch(() => {});
          }
          clearSessionStart(userId);
          return;
        }

        // Active session: delete prompt, keep image, ask for location
        const promptMessageId = consumeIdentifyPromptMessage(chatId);
        if (promptMessageId) {
          await bot.deleteMessage(chatId, promptMessageId).catch(() => {});
        }
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
            visualQuestion: (msg.caption || '').trim(),
          },
          msg.from,
          msg.chat
        );
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ Could not process photo: ${escHtml(err.message)}`);
    }
  });

  // Accept image documents (typically uncompressed) as an alternative to photo uploads.
  bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const groupId = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup' ? chatId : null;
    // const rate = checkAndIncrementRateLimit(userId, groupId);
    // if (!rate.allowed) {
    //   const who = rate.type === 'user' ? 'user' : 'group';
    //   const limit = rate.limit;
    //   return bot.sendMessage(chatId, `❌ Daily ${who} identification limit reached (${limit} per day, resets at 00:00).`);
    // }
    const fromSessionEnded = sessionEnded.has(userId);
    if (fromSessionEnded) {
      sessionEnded.delete(userId);
      const endedMsg = sessionEndedMessages.get(userId);
      if (endedMsg) {
        await bot.deleteMessage(endedMsg.chatId, endedMsg.messageId).catch(() => {});
        sessionEndedMessages.delete(userId);
      }
    }

    try {
      const doc = msg.document;
      const isImage = !!doc && ((doc.mime_type || '').startsWith('image/') || /\.(jpg|jpeg|png|webp)$/i.test(doc.file_name || ''));
      if (!isImage) return;

      // Check if there's an active identification session (prompt message showing)
      const hasActiveSession = hasIdentifyPromptMessage(chatId);

      const inputFileId = doc.file_id;
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
        // No active session: in private chat, continue and ask for location.
        // In groups, keep existing guard behavior to avoid accidental spam.
        const chatType = msg.chat?.type;
        const isGroupChat = chatType === 'group' || chatType === 'supergroup';
        if (!isGroupChat) {
          let sessionState = null;
          try {
            sessionState = await ensureActiveSessionRecord(msg.chat, msg.from);
          } catch {
            // Non-blocking: still continue with identification flow.
          }

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
              visualQuestion: (msg.caption || '').trim(),
              sessionId: sessionState?.sessionId || '',
            },
            msg.from,
            msg.chat
          );
          return;
        }

        return;
      } else {
        const activeBySheet = await hasActiveSessionBySheet(msg.chat, msg.from);
        if (!activeBySheet) {
          await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
          const promptMessageId = consumeIdentifyPromptMessage(chatId);
          if (promptMessageId) {
            await bot.deleteMessage(chatId, promptMessageId).catch(() => {});
          }
          clearSessionStart(userId);
          return;
        }

        // Active session: delete prompt, keep image, ask for location
        const promptMessageId = consumeIdentifyPromptMessage(chatId);
        if (promptMessageId) {
          await bot.deleteMessage(chatId, promptMessageId).catch(() => {});
        }
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
            visualQuestion: (msg.caption || '').trim(),
          },
          msg.from,
          msg.chat
        );
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ Could not process image file: ${escHtml(err.message)}`);
    }
  });

  // ── Step 2: handle location reply (text, shared GPS, or skip) ───────────────
  bot.on('message', async (msg) => {
    const userId = msg.from?.id;
    if (!userId || !pending.has(userId)) return;
    if (!msg.text && !msg.location) return;
    if (msg.text && msg.text.startsWith('/')) return;

    const state = pending.get(userId);
    const chatId = state.chatId;
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
    await runIdentification(bot, chatId, state.buffer, state.mimeType, {
      location: locationValue,
      user: state.user,
      inputFileId: state.inputFileId,
      imageCapturedAt: state.imageCapturedAt,
      visualQuestion: state.visualQuestion,
      sessionId: state.sessionId || '',
      chatType: state.chatType || 'private',
      channelName: state.channelName || '',
    });
  });

  // ── Continue / Stop callbacks ──────────────────────────────────────────────
  bot.on('callback_query', async (query) => {
    const { data } = query;
    if (data !== 'identify_continue' && data !== 'identify_stop') return;
    const chatId = query.message.chat.id;
    bot.answerCallbackQuery(query.id);
    // Remove the Continue/Stop prompt
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});

    if (data === 'identify_continue') {
      clearEndedSession(query.from?.id);

      let sessionState = null;
      try {
        sessionState = await ensureActiveSessionRecord(query.message.chat, query.from);
      } catch {
        // Non-blocking: continue flow should still work if Sheets is unavailable.
      }

      const sent = await bot.sendMessage(
        chatId,
        `<b>📷 New Identification</b>\n\nSimply <b>send me a photo</b> and I'll identify the animal in it.`,
        { parse_mode: 'HTML' }
      );
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
          const latest = await sheetsService.getLatestSessionStatus({
            subBot: 'Animal Identification',
            chatId,
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
      visualQuestion: state.visualQuestion,
      sessionId: state.sessionId || '',
      chatType: state.chatType || 'private',
      channelName: state.channelName || '',
    });
  });

};

module.exports.clearEndedSession = clearEndedSession;

// ── Run identification ────────────────────────────────────────────────────────

async function runIdentification(bot, chatId, buffer, mimeType, options) {
  // remove_keyboard cleans up the ReplyKeyboard shown during location prompt
  const statusMsg = await bot.sendMessage(chatId, '🔍 Analysing image…', {
    reply_markup: { remove_keyboard: true },
  });

  const setStatus = (text) =>
    bot.editMessageText(text, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }).catch(() => {});

  try {
    const result = await geminiService.identifyAnimal(buffer, mimeType, options);

    if (!result.success) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ Identification failed: ${escHtml(result.error)}`);
    }

    const data = result.data;
    const tax = data.taxonomy || {};
    const isBird = ['aves', 'bird'].some(k => (tax.class || '').toLowerCase().includes(k));

    const speciesLabel = data.commonName || data.scientificName || 'species';
    await setStatus(`🔎 Cross-referencing <b>${escHtml(speciesLabel)}</b> with eBird &amp; GBIF…`);

    // GBIF usage key (used for occurrence queries)
    // Save Gemini's original names before any resolution, so eBird can try them first
    const geminiSciName = data.scientificName;
    const geminiCommonName = data.commonName;

    // GBIF: resolve synonym → get usageKey for occurrence counts and accepted names for fallback matching
    let gbifUsageKey = null;
    let gbifResolvedSciName = null;
    let gbifResolvedCommonName = null;
    const gbifNames = await getGBIFNames(data.scientificName || data.commonName).catch(() => null);
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
    // Priority: GBIF accepted names first, then Gemini names.
    let ebirdSpeciesCode = null;
    if (isBird && (geminiSciName || geminiCommonName)) {
      const ebirdCandidates = [
        gbifResolvedSciName,
        geminiSciName,
        gbifResolvedCommonName,
        geminiCommonName,
      ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
      for (const candidateName of ebirdCandidates) {
        const lookup = await getSpeciesCode(candidateName).catch(() => ({ found: false }));
        if (!lookup.found) continue;
        ebirdSpeciesCode = lookup.speciesCode;
        // eBird is the authoritative source — use its names for canvas + Wikipedia
        if (lookup.commonName) data.commonName = lookup.commonName;
        if (lookup.scientificName) data.scientificName = lookup.scientificName;
        break;
      }
      // Fetch eBird Identifiable Sub-specific Groups (ISSF) — done later after locationCoords is resolved
    }

    // Separate species code for sightings count: scientific-name candidates only.
    let ebirdSpeciesCodeForSightings = ebirdSpeciesCode;
    if (isBird) {
      const scientificCandidates = [
        gbifResolvedSciName,
        geminiSciName,
        data.scientificName,
      ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

      for (const candidateName of scientificCandidates) {
        const lookup = await getSpeciesCode(candidateName).catch(() => ({ found: false }));
        if (!lookup.found) continue;
        ebirdSpeciesCodeForSightings = lookup.speciesCode;
        break;
      }
    }

    // iNaturalist slug (non-birds only)
    let inatSlug = null;
    let logCountry = options.location || '';
    let locationCoords = null;
    if (!isBird && (data.scientificName || data.commonName)) {
      const inatData = await getSpeciesPhoto(data.scientificName || data.commonName).catch(() => null);
      if (inatData && inatData.taxonSlug) inatSlug = inatData.taxonSlug;
    }

    if (isBird) {
      // Determine country from user's location
      let country = 'Singapore';
      let countryCode = '';
      let countryCoords = null;
      if (options.location) {
        countryCoords = await geocodeLocation(options.location).catch(() => null);
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
      if (speciesSlug) {
        try {
          const sgUrl = `https://singaporebirds.com/species/${speciesSlug}/`;
          const resp = await axios.get(sgUrl, { headers: { 'User-Agent': 'WildlifeBot/1.0' } });
          if (resp.data) {
            const localStatusMatch = resp.data.match(/Local Status:\s*<[^>]*>\s*([^<]+)/i);
            if (localStatusMatch) data.localStatus = localStatusMatch[1].trim();
            const abundanceMatch = resp.data.match(/Abundance:\s*<[^>]*>\s*([^<]+)/i);
            if (abundanceMatch) sgAbundance = abundanceMatch[1].trim();
          }
        } catch {
          // fallback to GBIF/eBird logic below
        }
      }

      // Always fetch GBIF + eBird occurrence for cross-reference (all birds, all locations)
      let gbifOcc = { count: 0 };
      let ebirdLocal = { found: false, count: 0 };
      locationCoords = countryCoords;
      if (options.location) {
        await setStatus(`📍 Looking up sightings near <b>${escHtml(options.location)}</b>…`);
        if (!locationCoords) {
          locationCoords = await geocodeLocation(options.location).catch(() => null);
        }
        if (locationCoords) {
          if (gbifUsageKey) {
            gbifOcc = await checkOccurrencesAtLocation(gbifUsageKey, locationCoords).catch(() => ({ count: 0 }));
          }
          if (ebirdSpeciesCode) {
            ebirdLocal = await getNearbySpeciesObservations(ebirdSpeciesCode, { ...locationCoords }).catch(() => ({ found: false, count: 0 }));
          }
          countryCode = (locationCoords.country_code || countryCode || '').toUpperCase();
          country = locationCoords.country || country;
        }
      }

      // No. of Sightings is species + country only (independent of subspecies checks).
      let speciesCountrySightingsCount = 0;
      const speciesSightingsLocation = locationCoords?.country || country || options.location || 'Unknown location';
      if (ebirdSpeciesCodeForSightings) {
        const resolvedCountryCode = (locationCoords?.country_code || countryCode || '').toUpperCase();
        if (resolvedCountryCode) {
          const ebirdCountry = await getNearbySpeciesObservations(
            ebirdSpeciesCodeForSightings,
            { countryCode: resolvedCountryCode, isCountryOnly: true }
          ).catch(() => ({ found: false, count: 0 }));
          speciesCountrySightingsCount = ebirdCountry?.count || 0;
        }
      }

      // Fetch ISSF subspecies from eBird and GBIF country occurrences in parallel
      if (ebirdSpeciesCode) {
        const regionCode = (locationCoords?.country_code || countryCode || '').toUpperCase();
        const [issfGroups, gbifSubspInCountry] = await Promise.all([
          regionCode ? getEBirdSubspecificGroups(ebirdSpeciesCode, regionCode).catch(() => []) : Promise.resolve([]),
          (gbifUsageKey && regionCode) ? getSubspeciesOccurrencesByCountry(gbifUsageKey, regionCode).catch(() => []) : Promise.resolve([]),
        ]);
        const geminiSubsp = data.taxonomy?.subspecies;
        const isSkip = v => !v || ['null', 'monotypic', 'unknown', 'none', ''].includes(String(v).toLowerCase().trim());
        const getEpithet = name => name.trim().split(/\s+/).pop().toLowerCase();

        if (!isSkip(geminiSubsp)) {
          // Gemini identified a subspecies — validate it against eBird ISSF then GBIF
          const epithet = getEpithet(String(geminiSubsp));
          const issfMatch = issfGroups.find(g => getEpithet(g) === epithet);
          if (issfMatch) {
            data.subspecies = [issfMatch];
            data.subspeciesFromImage = true;
          } else {
            const gbifMatch = gbifSubspInCountry.find(s => getEpithet(s.name) === epithet);
            if (gbifMatch) {
              data.subspecies = [gbifMatch.name];
              data.subspeciesFromImage = true;
            }
            // If no match in either list, don't show subspecies section
          }
        } else {
          // Gemini couldn't ID subspecies — derive from eBird ISSF + GBIF location records
          const locationSubsp = [];
          if (gbifSubspInCountry.length > 0 && issfGroups.length > 0) {
            // Show ISSF groups that are confirmed by GBIF country occurrences (intersection)
            for (const gbifSub of gbifSubspInCountry) {
              const epithet = getEpithet(gbifSub.name);
              const issfMatch = issfGroups.find(g => getEpithet(g) === epithet);
              if (issfMatch) locationSubsp.push(issfMatch);
            }
            // No intersection — fall back to GBIF-only results sorted by occurrence count
            if (locationSubsp.length === 0) {
              gbifSubspInCountry.sort((a, b) => b.count - a.count).forEach(s => locationSubsp.push(s.name));
            }
          } else if (gbifSubspInCountry.length > 0) {
            // No ISSF data — show GBIF results sorted by count
            gbifSubspInCountry.sort((a, b) => b.count - a.count).forEach(s => locationSubsp.push(s.name));
          } else if (issfGroups.length === 1) {
            // Single ISSF subspecies for the region — safe to show
            locationSubsp.push(issfGroups[0]);
          }
          if (locationSubsp.length > 0) {
            data.subspecies = locationSubsp;
            data.subspeciesByLocation = true;
            data.subspeciesLocation = country || options.location || 'location';
          }
        }
      }

      if (country.toLowerCase() === 'singapore') {
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
            const classified = classifyBirdLocalStatus({
              gbifOccurrence: { count: gbifOcc.count || 0, monthsObservedCount: gbifOcc.monthsObservedCount || 0, breedingSignalCount: gbifOcc.breedingSignalCount || 0, establishmentMeans: gbifOcc.establishmentMeans || [] },
              ebirdSummary: ebirdLocal,
              migratoryStatus: data.migratoryStatus,
            });
            data.localStatusCode = classified.code;
            data.localStatus = classified.label;
          }
        }
      } else {
        // Non-Singapore: derive local status and abundance from GBIF + eBird
        const classified = classifyBirdLocalStatus({
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
      // Non-bird: use GBIF for local presence
      let nonBirdLocationCoords = locationCoords;
      let nonBirdSightingsCount = null;
      let nonBirdSightingsLocation = options.location || '';
      if (gbifUsageKey && options.location && !nonBirdLocationCoords) {
        nonBirdLocationCoords = await geocodeLocation(options.location).catch(() => null);
      }

      if (gbifUsageKey && nonBirdLocationCoords) {
        const occ = await checkOccurrencesAtLocation(gbifUsageKey, nonBirdLocationCoords).catch(() => ({ count: 0 }));
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
      } else if (gbifUsageKey) {
        const globalCount = await getGlobalOccurrenceCount(gbifUsageKey).catch(() => null);
        if (typeof globalCount === 'number') {
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

    // Fetch Wikipedia image to use as the reference species photo in the canvas
    await setStatus('🖼️ Building result…');
    let wikiImageUrl = null;
    const wikiLookupName = data.scientificName || data.commonName;
    if (wikiLookupName) {
      const wikiInfo = await getWikipediaInfo(wikiLookupName).catch(() => null);
      if (wikiInfo && wikiInfo.imageUrl) wikiImageUrl = wikiInfo.imageUrl;
    }

    const canvas = await createResultCanvas(wikiImageUrl, buffer, data);
    const caption = buildCaption(data, ebirdSpeciesCode, inatSlug);

    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

    if (canvas) {
      const sentMsg = await bot.sendPhoto(
        chatId,
        canvas,
        { caption, parse_mode: 'HTML' },
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
        country: logCountry,
        chatId,
        sessionId: resolvedSessionId,
        chatType: options.chatType || 'private',
        channelName: options.channelName || '',
      }).catch(() => {});
    } else {
      await bot.sendMessage(chatId, caption, { parse_mode: 'HTML' });
    }

    if (options.visualQuestion && data.visualQuestionAnswer) {
      await bot.sendMessage(
        chatId,
        `🧠 <b>Visual Q&A</b>\n<b>Q:</b> ${escHtml(options.visualQuestion)}\n<b>A:</b> ${escHtml(data.visualQuestionAnswer)}`,
        { parse_mode: 'HTML' }
      );
    }

    // Prompt user to continue or stop
    await bot.sendMessage(
      chatId,
      '❓ Would you like to identify another animal?',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Continue', callback_data: 'identify_continue' },
            { text: '🛑 Stop',     callback_data: 'identify_stop'     },
          ]],
        },
      }
    );
  } catch (err) {
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, `❌ Something went wrong: ${escHtml(err.message)}`);
  }
}

// ── Caption with clickable links (shown below the canvas photo) ───────────────

function buildCaption(data, ebirdSpeciesCode, inatSlug) {
  const sci = encodeURIComponent(data.scientificName || data.commonName || '');
  const isBird = (data.taxonomy && ['aves', 'bird'].some(k => (data.taxonomy.class || '').toLowerCase().includes(k)));
  const links = [];
  if (isBird) {
    if (ebirdSpeciesCode) links.push(`🐦 <a href="https://ebird.org/species/${ebirdSpeciesCode}">eBird</a>`);
  } else {
    const inatUrl = inatSlug
      ? `https://www.inaturalist.org/taxa/${inatSlug}`
      : `https://www.inaturalist.org/taxa/search?q=${sci}`;
    links.push(`🔬 <a href="${inatUrl}">iNaturalist</a>`);
  }
  links.push(`📖 <a href="https://en.wikipedia.org/wiki/${sci}">Wikipedia</a>`);
  return links.join('  ·  ');
}
