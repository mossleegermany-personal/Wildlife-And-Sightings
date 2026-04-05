'use strict';

const { ITEMS_PER_PAGE, LOGS_PER_PAGE } = require('./constants');
const {
  esc, escHtml, fmtObsItem, resolveTimezoneForRegion,
  parseBreedingCode, parseAgeSex, parseMediaFromSubAuxAi,
} = require('./helpers');
const { checklistCommentCache } = require('./state');
const { ebird }                 = require('./services');
const logger                    = require('../../../../src/utils/logger');

// ── Telegram utility ──────────────────────────────────────────────────────────

async function deleteMsg(bot, chatId, messageId) {
  if (!messageId) return;
  try { await bot.deleteMessage(chatId, messageId); } catch { /* ignore */ }
}

// ── Title builders ────────────────────────────────────────────────────────────

function buildTitle(type, displayName) {
  if      (type === 'notable') return `⭐ Notable Sightings in ${esc(displayName)}`;
  else if (type === 'nearby')  return `🐦 Birds Near ${esc(displayName)}`;
  else if (type === 'species') return `🔎 ${esc(displayName)} Sightings`;
  return `🐦 Recent Sightings in ${esc(displayName)}`;
}

function buildTitleHtml(type, displayName) {
  if      (type === 'notable') return `⭐ Notable Sightings in ${escHtml(displayName)}`;
  else if (type === 'nearby')  return `🐦 Birds Near ${escHtml(displayName)}`;
  else if (type === 'species') return `🔎 ${escHtml(displayName)} Sightings`;
  return `🐦 Recent Sightings in ${escHtml(displayName)}`;
}

// ── Paginated observations ────────────────────────────────────────────────────

async function sendPaginatedObservations(bot, chatId, observations, displayName, type, page, messageId, regionCode, dateLabel) {
  page      = page      ?? 0;
  messageId = messageId ?? null;
  regionCode = regionCode ?? null;
  dateLabel  = dateLabel  ?? '';

  // Pre-resolve timezone for COORD-based regions (populates cache for sync calls)
  if (regionCode && regionCode.startsWith('COORD:')) await resolveTimezoneForRegion(regionCode);

  if (!observations || observations.length === 0) {
    return bot.sendMessage(chatId, '❌ No observations found for this location.');
  }

  // Sort chronologically (oldest first) by observation date
  observations.sort((a, b) => (a.obsDt || '').localeCompare(b.obsDt || ''));

  const totalPages = Math.ceil(observations.length / ITEMS_PER_PAGE);
  const startIdx   = page * ITEMS_PER_PAGE;
  const endIdx     = Math.min(startIdx + ITEMS_PER_PAGE, observations.length);
  const pageObs    = observations.slice(startIdx, endIdx);

  let title;
  if      (type === 'notable') title = `⭐ Notable Sightings in ${escHtml(displayName)}`;
  else if (type === 'nearby')  title = `🐦 Birds Near ${escHtml(displayName)}`;
  else if (type === 'species') title = `🔎 ${escHtml(displayName)} Sightings`;
  else                          title = `🐦 Recent Sightings in ${escHtml(displayName)}`;

  // ── Enrich page observations with checklist data ──────────────────────────
  const subIdsNeeded = [...new Set(
    pageObs.filter(o => o.subId && !checklistCommentCache.has(o.subId)).map(o => o.subId)
  )];
  if (subIdsNeeded.length > 0) {
    logger.info(`[birdMenu] Fetching checklists for ${subIdsNeeded.length} subId(s): ${subIdsNeeded.join(', ')}`);
    await Promise.allSettled(subIdsNeeded.map(async (subId) => {
      try {
        const checklist = await ebird.getChecklist(subId);

        const { obs: _rawObs, ...clMeta } = checklist || {};
        logger.info(`[birdMenu] ══ CHECKLIST_META ${subId} ══ ${JSON.stringify(clMeta)}`);
        (_rawObs || []).forEach((e, i) =>
          logger.info(`[birdMenu]   OBS[${i}] ${e.speciesCode}: ${JSON.stringify(e)}`)
        );

        const mlMediaMap = parseMediaFromSubAuxAi(checklist?.subAuxAi);
        logger.info(`[birdMenu]   subAuxAi media map: ${JSON.stringify([...mlMediaMap.entries()])}`);

        const obsMap = new Map();
        if (checklist && Array.isArray(checklist.obs)) {
          for (const entry of checklist.obs) {
            if (entry.speciesCode) {
              const breedingCode = parseBreedingCode(entry.obsAux);
              const ageSex       = parseAgeSex(entry.obsAux);
              const mlMedia = mlMediaMap.get(entry.speciesCode)
                           || mlMediaMap.get('__checklist__')
                           || null;
              logger.info(
                `[birdMenu]   PARSED ${entry.speciesCode}` +
                ` breed="${breedingCode || '-'}"` +
                ` ageSex="${ageSex || '-'}"` +
                ` mlMedia=${JSON.stringify(mlMedia)}`
              );
              obsMap.set(entry.speciesCode, {
                comments:     entry.comments  || null,
                breedingCode,
                ageSex,
                mlMedia,
                obsId:        entry.obsId     || null,
              });
            }
          }
        }
        logger.info(`[birdMenu] Checklist ${subId}: ${obsMap.size} obs, observer: ${checklist?.userDisplayName || 'unknown'}`);
        checklistCommentCache.set(subId, { observerName: checklist?.userDisplayName || null, obsMap });
      } catch (err) {
        logger.warn(`[birdMenu] Failed to fetch checklist ${subId}: ${err.message}`);
        checklistCommentCache.set(subId, { observerName: null, obsMap: new Map() });
      }
    }));
  }

  // Attach enriched checklist data to obs objects
  for (const obs of pageObs) {
    if (obs.subId) {
      const cached = checklistCommentCache.get(obs.subId);
      if (cached) {
        if (!obs.userDisplayName && cached.observerName) obs.userDisplayName = cached.observerName;
        const od = cached.obsMap.get(obs.speciesCode);
        if (od) {
          if (!obs.comments     && od.comments)     obs.comments     = od.comments;
          if (!obs.breedingCode && od.breedingCode) obs.breedingCode = od.breedingCode;
          if (!obs.ageSex       && od.ageSex)       obs.ageSex       = od.ageSex;
          if (!obs.mlMedia      && od.mlMedia)      obs.mlMedia      = od.mlMedia;
          if (!obs.obsId        && od.obsId)        obs.obsId        = od.obsId;
        }
        logger.info(
          `[birdMenu] ENRICHED ${obs.speciesCode} (${obs.subId}) →` +
          ` observer="${obs.userDisplayName || '-'}"` +
          ` breed="${obs.breedingCode || '-'}"` +
          ` ageSex="${obs.ageSex || '-'}"` +
          ` mlMedia=${JSON.stringify(obs.mlMedia || null)}` +
          ` obsId="${obs.obsId || '-'}"` +
          ` comment="${obs.comments ? obs.comments.slice(0, 60) : '-'}"`
        );
      }
    }
  }

  // ── Fetch ML media for obs missing it (using taxonCode + checklistId) ─────
  const obsNeedingMedia = pageObs.filter(o => o.subId && o.speciesCode && !o.mlMedia);
  if (obsNeedingMedia.length > 0) {
    logger.info(`[birdMenu] Fetching ML media for ${obsNeedingMedia.length} obs`);
    await Promise.allSettled(obsNeedingMedia.map(async (obs) => {
      const mlMedia = await ebird.getMLMediaForChecklist(obs.speciesCode, obs.subId);
      if (mlMedia) {
        obs.mlMedia = mlMedia;
        logger.info(`[birdMenu] ML media for ${obs.speciesCode} (${obs.subId}): ${JSON.stringify(mlMedia)}`);
        // Update the cache so subsequent page loads don't re-fetch
        const cached = checklistCommentCache.get(obs.subId);
        if (cached) {
          const od = cached.obsMap.get(obs.speciesCode);
          if (od) od.mlMedia = mlMedia;
        }
      }
    }));
  }

  const TELEGRAM_LIMIT = 3900;
  const entryLines = pageObs.map((o, i) => fmtObsItem(o, startIdx + i, regionCode) + '\n');
  const actualEndIdx = startIdx + entryLines.length;

  let message = `<b>${title}</b>\n`;
  if (dateLabel) message += `<i>${escHtml(dateLabel)}</i>\n`;
  message += `📊 Showing ${startIdx + 1}-${actualEndIdx} of ${observations.length}\n\n`;
  for (const line of entryLines) {
    if ((message + line).length > TELEGRAM_LIMIT) break;
    message += line;
  }

  const navRow = [];
  const isFirst = page === 0;
  const isLast  = page >= totalPages - 1;
  navRow.push({ text: '⏮', callback_data: isFirst ? 'page_info' : `page_${type}_0` });
  navRow.push({ text: '◀️', callback_data: isFirst ? 'page_info' : `page_${type}_${page - 1}` });
  navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'page_info' });
  navRow.push({ text: '▶️', callback_data: isLast ? 'page_info' : `page_${type}_${page + 1}` });
  navRow.push({ text: '⏭', callback_data: isLast ? 'page_info' : `page_${type}_${totalPages - 1}` });

  const buttons = [navRow];
  if (type === 'sightings' || type === 'notable' || type === 'nearby' || type === 'species') {
    buttons.push([
      { text: '📅 Change Date', callback_data: `change_date_${type}` },
      { text: '🔢 Jump to Page', callback_data: `jump_${type}` },
    ]);
    buttons.push([
      { text: '🔄 Try Again', callback_data: 'new_search' },
      { text: '✅ Done', callback_data: 'done' },
    ]);
  } else {
    buttons.push([
      { text: '🔢 Jump to Page', callback_data: `jump_${type}` },
      { text: '🔄 Try Again', callback_data: 'new_search' },
      { text: '✅ Done', callback_data: 'done' },
    ]);
  }

  const replyMarkup = { inline_keyboard: buttons };

  if (messageId) {
    try {
      await bot.editMessageText(message, {
        chat_id: chatId, message_id: messageId,
        parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: replyMarkup,
      });
      return;
    } catch { /* fall through to sendMessage */ }
  }
  await bot.sendMessage(chatId, message, {
    parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: replyMarkup,
  });
}

// ── Log entry formatter ───────────────────────────────────────────────────────

function fmtLogEntry(entry, index) {
  let s = `${index + 1}. *${esc(entry.species || 'Unknown')}*\n`;
  if (entry.location)        s += `📍 ${esc(entry.location)}\n`;
  if (entry.observationDate) s += `📅 ${esc(entry.observationDate)}\n`;
  if (entry.count && entry.count !== '1') s += `🔢 Count: ${esc(entry.count)}\n`;
  if (entry.obsType)         s += `🗂️ ${esc(entry.obsType)}\n`;
  if (entry.notes)           s += `📝 ${esc(entry.notes)}\n`;
  return s;
}

// ── Paginated personal logs ───────────────────────────────────────────────────

async function sendPaginatedLogs(bot, chatId, sightings, page, messageId) {
  page      = page      ?? 0;
  messageId = messageId ?? null;

  const total      = sightings.length;
  const totalPages = Math.ceil(total / LOGS_PER_PAGE);
  const startIdx   = page * LOGS_PER_PAGE;
  const endIdx     = Math.min(startIdx + LOGS_PER_PAGE, total);
  const pageSightings = sightings.slice(startIdx, endIdx);

  let message = `*📓 My Sightings Logs*\n`;
  message += `━━━━━━━━━━━━━━━━━━━━\n`;
  message += `📊 Showing ${startIdx + 1}-${endIdx} of ${total}\n`;
  message += `📄 Page ${page + 1} of ${totalPages}\n\n`;
  for (let i = 0; i < pageSightings.length; i++) {
    message += fmtLogEntry(pageSightings[i], startIdx + i) + '\n';
  }

  const navRow = [];
  const isFirst = page === 0;
  const isLast  = page >= totalPages - 1;
  navRow.push({ text: '⏮', callback_data: isFirst ? 'page_info' : `logs_page_0` });
  navRow.push({ text: '◀️', callback_data: isFirst ? 'page_info' : `logs_page_${page - 1}` });
  navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'page_info' });
  navRow.push({ text: '▶️', callback_data: isLast ? 'page_info' : `logs_page_${page + 1}` });
  navRow.push({ text: '⏭', callback_data: isLast ? 'page_info' : `logs_page_${totalPages - 1}` });

  const buttons = [navRow];
  buttons.push([
    { text: '� Try Again', callback_data: 'new_search' },
    { text: '✅ Done', callback_data: 'done' },
  ]);
  const opts = { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: { inline_keyboard: buttons } };

  if (messageId) {
    try {
      await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, ...opts });
      return;
    } catch { /* fall through */ }
  }
  await bot.sendMessage(chatId, message, opts);
}

// ── Summary message ───────────────────────────────────────────────────────────

async function sendSummaryMessage(bot, chatId, observations, displayName, type, regionCode) {
  const title      = buildTitle(type, displayName);
  const speciesMap = new Map();

  for (const obs of observations) {
    const key = obs.speciesCode || obs.comName;
    if (!speciesMap.has(key)) {
      speciesMap.set(key, { comName: obs.comName, count: 0, locations: new Map() });
    }
    const entry = speciesMap.get(key);
    entry.count += obs.howMany || 1;
    const loc = obs.locName || 'Unknown';
    if (!entry.locations.has(loc)) entry.locations.set(loc, { count: 0, dates: new Map() });
    const locEntry = entry.locations.get(loc);
    locEntry.count += obs.howMany || 1;
    if (obs.obsDt) {
      const [datePart, timePart] = obs.obsDt.split(' ');
      const [yr, mo, dy] = (datePart || '').split('-');
      const dateKey = `${dy}/${mo}/${yr}`;
      if (!locEntry.dates.has(dateKey)) locEntry.dates.set(dateKey, new Set());
      if (timePart) locEntry.dates.get(dateKey).add(timePart);
    }
  }

  let msg = `*${title}*\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🦅 ${speciesMap.size} species from ${observations.length} sightings\n\n`;
  let idx = 1;
  for (const [, sp] of speciesMap) {
    msg += `${idx}. *${esc(sp.comName)}* \\(x${sp.count}\\)\n`;
    for (const [loc, info] of sp.locations) {
      msg += `    📍 ${esc(loc)} \\(x${info.count}\\)\n`;
      for (const [dateKey, times] of info.dates) {
        const sorted = [...times].sort();
        msg += `    📅 ${dateKey}${sorted.length ? ' ' + sorted.join(', ') : ''}\n`;
      }
    }
    msg += '\n';
    idx++;
    if (msg.length > 3800) { msg += '\n_…truncated_'; break; }
  }

  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
}

// ── Forwardable message ───────────────────────────────────────────────────────

async function sendForwardableMessage(bot, chatId, observations, displayName, type, regionCode) {
  const title   = buildTitleHtml(type, displayName);
  let header    = `📋 <b>Full Sightings List</b>\n<b>${title}</b>\n📊 Total: ${observations.length} sightings\n\n`;
  const allLines = observations.map((obs, i) => fmtObsItem(obs, i, regionCode));
  const MAX      = 4000;
  let current    = header;
  let part       = 1;
  const messages = [];

  for (const line of allLines) {
    if (current.length + line.length + 2 > MAX) {
      messages.push(current);
      part++;
      current = `📋 <b>Full Sightings List (Part ${part})</b>\n\n`;
    }
    current += line + '\n';
  }
  messages.push(current);

  for (const m of messages) {
    await bot.sendMessage(chatId, m, { parse_mode: 'HTML', disable_web_page_preview: true });
  }
}

module.exports = {
  deleteMsg,
  buildTitle, buildTitleHtml,
  sendPaginatedObservations,
  fmtLogEntry, sendPaginatedLogs,
  sendSummaryMessage, sendForwardableMessage,
};
