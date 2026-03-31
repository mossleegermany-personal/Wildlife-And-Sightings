'use strict';

/**
 * /addsighting — log a personal bird sighting to Google Sheets.
 *
 * Multi-step conversation:
 *   1. Bird name          (required)
 *   2. Location           (or "skip")
 *   3. Date               (DD/MM/YYYY, "today", or "skip" — defaults to today)
 *   4. Count              (number, or "skip" — defaults to 1)
 *   5. Observation type   (inline keyboard: Traveling / Stationary / Incidental / Historical)
 *   6. Notes              (or "skip" to finish)
 *
 * On completion:
 *   - Sighting is saved to Google Sheets.
 *   - A "Submit to eBird" button is shown to go straight to ebird.org/submit.
 *
 * Type /cancel at any step to abort.
 */

const sheetsService                   = require('../../../database/googleSheets/services/googleSheetsService');
const geminiService                   = require('../../animalIdentification/services/geminiService');
const { verifyWithEBird, EBirdService } = require('../../birdSighting/services/ebirdService');
const { birdSessionMap }              = require('./birdMenu/state');
const axios                           = require('axios');
const sharp                           = require('sharp');
const logger                          = require('../../../src/utils/logger');

const _ebird = new EBirdService(process.env.EBIRD_API_KEY);

// chatId → { step, user, data: { species, location, date, count, obsType, notes } }
const sessions = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function todaySg() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore',
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.day}/${map.month}/${map.year}`;
}

function parseDate(input) {
  const s = input.trim().toLowerCase();
  if (!s || s === 'today') return todaySg();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-');
    return `${d}/${m}/${y}`;
  }
  return s;
}

// ── Photo download + preprocess (mirrors identify.js) ──────────────────────────────────

async function downloadTelegramPhoto(bot, fileId) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
  const resp     = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return {
    buffer:   Buffer.from(resp.data),
    filePath: fileInfo.file_path || '',
  };
}

async function preprocessPhoto(buffer) {
  try {
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    const longEdge = Math.max(meta.width || 0, meta.height || 0);
    const scale = longEdge < 1280 ? Math.min(2, 1280 / longEdge) : 1;
    return await sharp(buffer, { failOn: 'none' })
      .resize(Math.round((meta.width || 1) * scale), Math.round((meta.height || 1) * scale), {
        fit: 'inside', kernel: sharp.kernel.lanczos3, withoutEnlargement: false,
      })
      .normalise()
      .sharpen({ sigma: 1.0, m1: 0.6, m2: 1.2 })
      .jpeg({ quality: 95, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
  } catch {
    return buffer;
  }
}

// ── eBird observation types ───────────────────────────────────────────────────

const OBS_TYPE_LABELS = {
  traveling:  'Traveling',
  stationary: 'Stationary',
  incidental: 'Incidental',
  historical: 'Historical',
};

// ── Keyboard / prompts ────────────────────────────────────────────────────────

const OBS_TYPE_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🚶 Traveling',  callback_data: 'addsighting_type:traveling'  },
        { text: '🧍 Stationary', callback_data: 'addsighting_type:stationary' },
      ],
      [
        { text: '👁 Incidental',  callback_data: 'addsighting_type:incidental' },
        { text: '📜 Historical',  callback_data: 'addsighting_type:historical'  },
      ],
    ],
  },
};

const PROMPTS = {
  species:  '🐦 <b>What bird did you see?</b>\n\n<i>Type the name</i> — or <b>send a photo</b> (camera or gallery) and I\'ll identify it for you.',
  location: '📍 <b>Where did you see it?</b>\n<i>Enter a location name, or "skip"</i>',
  date:     '📅 <b>When did you see it?</b>\n<i>Enter DD/MM/YYYY, "today", or "skip" (defaults to today)</i>',
  count:    '🔢 <b>How many did you see?</b>\n<i>Enter a number, or "skip" for 1</i>',
  obsType:  '🗂 <b>How were you birding?</b>\n<i>Select an observation type</i>',
  notes:    '📝 <b>Any notes?</b>\n<i>Enter any notes, or "skip" to finish</i>',
};

// ── Register handlers ─────────────────────────────────────────────────────────

/** Start the add-sighting flow for a given chat. Called by menu button or /addsighting. */
function startAddSightingSession(bot, chatId, user, chat) {
  // Clear any in-progress bird-menu query for this chat so it can't intercept messages
  try { require('./birdMenu').clearSession(chatId); } catch { /* ignore if not loaded yet */ }
  sessions.set(chatId, { step: 'species', user, chat, data: {} });
  bot.sendMessage(chatId, PROMPTS.species, { parse_mode: 'HTML' });
}

module.exports = function registerAddSighting(bot) {
  // /addsighting — start the flow
  bot.onText(/\/addsighting/, (msg) => {
    startAddSightingSession(bot, msg.chat.id, msg.from, msg.chat);
  });

  // /cancel — abort at any step
  bot.onText(/\/cancel/, (msg) => {
    const chatId = msg.chat.id;
    if (!sessions.has(chatId)) return;
    sessions.delete(chatId);
    bot.sendMessage(chatId, '❌ Sighting entry cancelled.');
  });

  // Inline button: observation type selection  OR  confirm/override identified species
  bot.on('callback_query', async (query) => {
    const { data: cbData, message: cbMsg } = query;
    const chatId  = cbMsg.chat.id;
    const session = sessions.get(chatId);

    // — Observation type
    if (cbData?.startsWith('addsighting_type:')) {
      if (!session || session.step !== 'obsType') return bot.answerCallbackQuery(query.id);
      const type = cbData.split(':')[1];
      if (!OBS_TYPE_LABELS[type]) return bot.answerCallbackQuery(query.id);
      session.data.obsType = type;
      session.step = 'notes';
      bot.answerCallbackQuery(query.id, { text: `✅ ${OBS_TYPE_LABELS[type]} selected` });
      bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: cbMsg.message_id }).catch(() => null);
      return bot.sendMessage(chatId, PROMPTS.notes, { parse_mode: 'HTML' });
    }

    // — Confirm AI-identified species
    if (cbData === 'addsighting_confirm_species') {
      if (!session || session.step !== 'species_confirm') return bot.answerCallbackQuery(query.id);
      bot.answerCallbackQuery(query.id, { text: '✅ Species confirmed' });
      bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: cbMsg.message_id }).catch(() => null);
      session.step = 'location';
      return bot.sendMessage(chatId, PROMPTS.location, { parse_mode: 'HTML' });
    }

    // — Override AI species with own entry
    if (cbData === 'addsighting_override_species') {
      if (!session || session.step !== 'species_confirm') return bot.answerCallbackQuery(query.id);
      bot.answerCallbackQuery(query.id);
      bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: cbMsg.message_id }).catch(() => null);
      session.step = 'species';
      session.data.species = null;
      return bot.sendMessage(chatId, '✏️ <b>Enter the species name:</b>\n<i>Type the common or scientific name</i>', { parse_mode: 'HTML' });
    }
  });

  // Text-based conversation steps + photo handling
  bot.on('message', async (msg) => {
    const chatId  = msg.chat.id;
    const session = sessions.get(chatId);
    if (!session) return;
    if (session.step === 'obsType') return; // waiting for inline button
    if (session.step === 'species_confirm') return; // waiting for inline button

    // ── Photo received at species step ──────────────────────────────────────────────────
    if (session.step === 'species' && msg.photo) {
      const photos  = msg.photo;
      const largest = photos[photos.length - 1]; // highest resolution

      const thinkingMsg = await bot.sendMessage(chatId, '🔍 Identifying the bird in your photo…', { parse_mode: 'HTML' });

      try {
        const { buffer, filePath } = await downloadTelegramPhoto(bot, largest.file_id);
        const processedBuffer = await preprocessPhoto(buffer);
        const mimeType = filePath.endsWith('.png') ? 'image/png' : filePath.endsWith('.webp') ? 'image/webp' : 'image/jpeg';

        const result = await geminiService.identifyAnimal(processedBuffer, mimeType, {
          location: 'Singapore', // default; user can adjust at location step
        });

        bot.deleteMessage(chatId, thinkingMsg.message_id).catch(() => null);

        const commonName = result?.commonName || result?.common_name || null;
        const sciName    = result?.scientificName || result?.scientific_name || null;
        const identified = result?.identified !== false && (commonName || sciName);

        if (!identified) {
          return bot.sendMessage(
            chatId,
            `❌ <b>Could not identify the bird.</b>
${escHtml(result?.qualityIssue || result?.reason || 'Please try a clearer photo or type the species name.')}

✏️ Please <b>type the species name</b> instead:`,
            { parse_mode: 'HTML' }
          );
        }

        // ── eBird verification ──────────────────────────────────────────────
        let ebirdVerified    = false;
        let ebirdSpeciesCode = null;
        let ebirdCommonName  = null;
        let ebirdSciName     = sciName;

        if (sciName) {
          try {
            const ev = await verifyWithEBird(sciName, commonName);
            if (ev?.verified) {
              ebirdVerified    = true;
              ebirdSpeciesCode = ev.speciesCode  || null;
              ebirdCommonName  = ev.commonName   || commonName;
              ebirdSciName     = ev.scientificName || sciName;
            }
          } catch (err) {
            logger.warn('eBird verification failed in addsighting', { error: err.message });
          }
        }

        // Use eBird-official name when available, otherwise fall back to Gemini's name
        const displayCommon = ebirdCommonName || commonName;
        const displaySci    = ebirdSciName    || sciName;
        const ebirdBadge    = ebirdVerified
          ? `\n✅ <i>Verified on eBird</i>` + (ebirdSpeciesCode ? ` (<code>${escHtml(ebirdSpeciesCode)}</code>)` : '')
          : `\n⚠️ <i>Not found in eBird — please confirm the name is correct</i>`;

        const displayName = [
          `<b>${escHtml(displayCommon)}</b>`,
          displaySci ? `<i>(${escHtml(displaySci)})</i>` : null,
        ].filter(Boolean).join(' ');

        session.data.species         = displayCommon || displaySci;
        session.data.ebirdSpeciesCode = ebirdSpeciesCode;
        session.step = 'species_confirm';

        return bot.sendMessage(
          chatId,
          `🐦 <b>Identified:</b> ${displayName}${ebirdBadge}\n\nIs this correct? Tap <b>Confirm</b> to use this species, or <b>Enter my own</b> to type a different name.`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Confirm', callback_data: 'addsighting_confirm_species' },
                { text: '✏️ Enter my own', callback_data: 'addsighting_override_species' },
              ]],
            },
          }
        );
      } catch (err) {
        bot.deleteMessage(chatId, thinkingMsg.message_id).catch(() => null);
        logger.error('Photo identification failed in addsighting', { error: err.message });
        return bot.sendMessage(chatId, '⚠️ Could not identify the bird. Please <b>type the species name</b> instead:', { parse_mode: 'HTML' });
      }
    }

    // Non-photo messages beyond this point require text
    if (!msg.text) return;

    const text = msg.text.trim();
    if (text.startsWith('/')) return;

    const skip        = text.toLowerCase() === 'skip';
    const { step, data } = session;

    if (step === 'species') {
      // Try to find the species in eBird taxonomy (only for meaningful input)
      if (text.length >= 3) {
        const lookupMsg = await bot.sendMessage(chatId, '🔍 Looking up species in eBird…');
        try {
          const matches = await _ebird.searchSpeciesByName(text, 3);
          bot.deleteMessage(chatId, lookupMsg.message_id).catch(() => null);

          if (matches && matches.length > 0) {
            const top = matches[0];
            session.data.species          = top.comName;
            session.data.ebirdSpeciesCode = top.speciesCode;
            session.step = 'species_confirm';

            const altText = matches.length > 1
              ? `\n<i>Other close matches: ${matches.slice(1).map(m => escHtml(m.comName)).join(', ')}</i>`
              : '';

            return bot.sendMessage(
              chatId,
              `🐦 <b>Best eBird match:</b> <b>${escHtml(top.comName)}</b> <i>(${escHtml(top.sciName)})</i>\n` +
              `✅ <i>Verified on eBird</i> (<code>${escHtml(top.speciesCode)}</code>)${altText}\n\n` +
              `Is this the bird you saw?`,
              {
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '✅ Yes, correct',      callback_data: 'addsighting_confirm_species'   },
                    { text: '✏️ Different species', callback_data: 'addsighting_override_species' },
                  ]],
                },
              }
            );
          }
        } catch (err) {
          bot.deleteMessage(chatId, lookupMsg.message_id).catch(() => null);
          logger.warn('eBird species search failed in addsighting', { error: err.message });
        }
      }

      // No eBird match (or query too short) — accept the text as-is
      data.species = text;
      session.step = 'location';
      return bot.sendMessage(chatId, PROMPTS.location, { parse_mode: 'HTML' });
    }

    if (step === 'location') {
      data.location = skip ? '' : text;
      session.step  = 'date';
      return bot.sendMessage(chatId, PROMPTS.date, { parse_mode: 'HTML' });
    }

    if (step === 'date') {
      data.date    = skip ? todaySg() : parseDate(text);
      session.step = 'count';
      return bot.sendMessage(chatId, PROMPTS.count, { parse_mode: 'HTML' });
    }

    if (step === 'count') {
      const n      = parseInt(text, 10);
      data.count   = (skip || isNaN(n) || n < 1) ? 1 : n;
      session.step = 'obsType';
      return bot.sendMessage(chatId, PROMPTS.obsType, { parse_mode: 'HTML', ...OBS_TYPE_KEYBOARD });
    }

    if (step === 'notes') {
      data.notes = skip ? '' : text;
      const { user, chat } = session;
      sessions.delete(chatId);

      const { species, location, date, count, obsType, notes } = data;

      // Save to Google Sheets — Bird Sightings sheet
      try {
        await sheetsService.logBirdSightingCommand({
          user,
          chat,
          sessionId: birdSessionMap.get(chatId)?.sessionId || '',
          species,
          location,
          observationDate: date,
          count,
          obsType: OBS_TYPE_LABELS[obsType] || 'Incidental',
          notes,
        });
      } catch (err) {
        logger.error('Failed to save sighting to Sheets', { error: err.message });
        bot.sendMessage(chatId, '⚠️ Could not save to Google Sheets.');
      }

      // Confirmation + eBird submit button
      await bot.sendMessage(
        chatId,
        `✅ <b>Sighting Saved!</b>\n\n` +
        `🐦 <b>Species:</b> ${escHtml(species)}\n` +
        `📍 <b>Location:</b> ${escHtml(location || '—')}\n` +
        `📅 <b>Date:</b> ${escHtml(date)}\n` +
        `🔢 <b>Count:</b> ${count}\n` +
        `🗂 <b>Type:</b> ${escHtml(OBS_TYPE_LABELS[obsType] || 'Incidental')}\n` +
        `📝 <b>Notes:</b> ${escHtml(notes || '—')}`,
        {
          parse_mode: 'HTML',
        }
      );
    }
  });
};

module.exports.startAddSightingSession = startAddSightingSession;
module.exports.sessions                = sessions; // exposed so birdMenu can check ownership
