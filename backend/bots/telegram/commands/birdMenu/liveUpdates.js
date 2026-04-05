'use strict';

const { ebird }  = require('./services');
const { escHtml, getTimezoneForRegion, getTzAbbr, resolveTimezoneForRegion } = require('./helpers');
const { BREEDING_CODES } = require('./constants');
const logger      = require('../../../../src/utils/logger');

// ── Storage ───────────────────────────────────────────────────────────────────
// chatId → { type, locationInput, regionCode, species, seenSubIds: Set, timerId }
const liveSubMap = new Map();

const POLL_INTERVAL_MS = 10 * 1000; // 10 seconds — near real-time (eBird data depends on checklist submission by birders)
const BACK_DAYS        = 1;         // eBird API: fetch the last 1 day; we further filter to today only below

// Returns today's date as 'YYYY-MM-DD' in the timezone matching regionCode
function getTodayDateStr(regionCode) {
  const tz = getTimezoneForRegion(regionCode) || 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchLatest(type, regionCode, species) {
  const isCoord = typeof regionCode === 'string' && regionCode.startsWith('COORD:');

  if (type === 'sightings') {
    if (isCoord) {
      const [lat, lng, dist] = regionCode.slice(6).split(',').map(Number);
      return ebird.getNearbyObservations(lat, lng, dist || 25, BACK_DAYS, 200);
    }
    return ebird.getRecentObservations(regionCode, BACK_DAYS, 200);
  }

  if (type === 'notable') {
    if (isCoord) {
      const [lat, lng, dist] = regionCode.slice(6).split(',').map(Number);
      return ebird.getNearbyNotableObservations(lat, lng, dist || 25, BACK_DAYS);
    }
    return ebird.getNotableObservations(regionCode, BACK_DAYS, 200);
  }

  if (type === 'species') {
    if (isCoord) {
      const [lat, lng, dist] = regionCode.slice(6).split(',').map(Number);
      return ebird.getNearbySpeciesObservations(lat, lng, species.code, dist || 25, BACK_DAYS);
    }
    return ebird.getSpeciesObservations(regionCode, species.code, BACK_DAYS);
  }

  return [];
}

function buildAlertMsg(obs, type, regionCode) {
  const typeLabel = type === 'notable' ? '⭐ Notable Sighting Alert'
    : type === 'species' ? '🦆 Species Sighting Alert'
    : '🐦 New Sighting Alert';

  const lat        = obs.lat ?? '';
  const lng        = obs.lng ?? '';
  const mapsUrl    = (lat !== '' && lng !== '') ? `https://www.google.com/maps?q=${lat},${lng}` : null;
  const coordLabel = (lat !== '' && lng !== '') ? `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}` : null;

  const locLabel = escHtml(obs.locName || 'Unknown');
  const locUrl   = obs.locId ? `https://ebird.org/hotspot/${obs.locId}` : null;
  const locText  = locUrl ? `<a href="${locUrl}">${locLabel}</a>` : `<b>${locLabel}</b>`;

  const cnt = obs.howMany ? `${obs.howMany} bird${obs.howMany > 1 ? 's' : ''}` : 'Present';

  const [datePart, timePart] = (obs.obsDt || '').split(' ');
  const fmtD   = datePart ? datePart.split('-').reverse().join('/') : '';
  const tzAbbr = regionCode ? ` ${getTzAbbr(getTimezoneForRegion(regionCode))}` : '';
  const fmtT   = timePart ? `${timePart}${tzAbbr} hrs` : null;

  const breedCode = obs.breedingCode || null;
  const breedDesc = breedCode ? ((BREEDING_CODES && BREEDING_CODES[breedCode]) || breedCode) : null;

  const mediaLines = [];
  if (obs.mlMedia) {
    const { photos, audios, videos } = obs.mlMedia;
    if (photos && photos.length) mediaLines.push(`📷 <a href="${photos[0]}">Photo</a>`);
    if (audios && audios.length) mediaLines.push(`🔊 <a href="${audios[0]}">Audio</a>`);
    if (videos && videos.length) mediaLines.push(`🎥 <a href="${videos[0]}">Video</a>`);
  }

  let msg = `🔔 <b>${typeLabel}</b>\n`;
  msg += `<b>${escHtml(obs.comName || 'Unknown')}</b>`;
  if (obs.sciName) msg += ` <i>(${escHtml(obs.sciName)})</i>`;
  msg += '\n';
  msg += `   📍 ${locText}\n`;
  msg += `   🔍 Count: <b>${cnt}</b>\n`;
  msg += `   🔬 ${obs.ageSex ? escHtml(obs.ageSex) : '—'}\n`;
  if (fmtD)                msg += `   📅 ${fmtD}\n`;
  if (fmtT)                msg += `   🕒 ${fmtT}\n`;
  if (obs.subId)           msg += `   🔗 <a href="https://ebird.org/checklist/${obs.subId}">View Checklist</a>\n`;
  for (const ml of mediaLines) msg += `   ${ml}\n`;
  if (coordLabel && mapsUrl) msg += `   🗺️ <a href="${mapsUrl}">${coordLabel}</a>\n`;
  if (obs.userDisplayName)   msg += `   👤 ${escHtml(obs.userDisplayName)}\n`;
  if (breedCode)             msg += `   🐣 ${escHtml(breedCode)} — ${escHtml(breedDesc)}\n`;
  if (obs.comments)          msg += `   💬 ${escHtml(obs.comments)}\n`;
  return msg;
}

function buildListAlertMsg(newObs, type, regionCode) {
  const typeLabel = type === 'notable' ? '⭐ Notable Sightings Alert'
    : type === 'species' ? '🦆 Species Sightings Alert'
    : '🐦 New Sightings Alert';

  let msg = `🔔 <b>${typeLabel}</b>\n<b>${newObs.length} new sightings</b>\n\n`;

  for (const obs of newObs) {
    const cnt = obs.howMany ? `${obs.howMany} bird${obs.howMany > 1 ? 's' : ''}` : 'Present';
    const locLabel = escHtml(obs.locName || 'Unknown');
    const locUrl   = obs.locId ? `https://ebird.org/hotspot/${obs.locId}` : null;
    const locText  = locUrl ? `<a href="${locUrl}">${locLabel}</a>` : `<b>${locLabel}</b>`;
    const [datePart, timePart] = (obs.obsDt || '').split(' ');
    const fmtD   = datePart ? datePart.split('-').reverse().join('/') : '';
    const tzAbbr = regionCode ? ` ${getTzAbbr(getTimezoneForRegion(regionCode))}` : '';
    const fmtT   = timePart ? `${timePart}${tzAbbr} hrs` : null;
    const checklistUrl = obs.subId ? `https://ebird.org/checklist/${obs.subId}` : null;

    msg += `• <b>${escHtml(obs.comName || 'Unknown')}</b>`;
    if (obs.sciName) msg += ` <i>(${escHtml(obs.sciName)})</i>`;
    msg += `\n`;
    msg += `   📍 ${locText} · 🔍 ${cnt}\n`;
    if (fmtD) msg += `   📅 ${fmtD}${fmtT ? ` · 🕒 ${fmtT}` : ''}\n`;
    if (checklistUrl) msg += `   🔗 <a href="${checklistUrl}">View Checklist</a>\n`;
    msg += '\n';
  }

  return msg.trimEnd();
}

// ── Polling ───────────────────────────────────────────────────────────────────

async function pollAndNotify(bot, chatId) {
  const sub = liveSubMap.get(chatId);
  if (!sub) return;
  try {
    const obs      = await fetchLatest(sub.type, sub.regionCode, sub.species);
    const todayStr = getTodayDateStr(sub.regionCode);
    const newObs   = (obs || []).filter(o =>
      o.subId &&
      !sub.seenSubIds.has(o.subId) &&
      (o.obsDt || '').startsWith(todayStr)
    );
    for (const o of newObs) sub.seenSubIds.add(o.subId);

    if (newObs.length === 0) return;

    const BUTTONS = {
      inline_keyboard: [[{ text: '🔕 Stop', callback_data: 'live_stop' }, { text: '🔄 Change', callback_data: 'live_setup' }]],
    };

    if (newObs.length === 1) {
      // Single new sighting — full detail card
      await bot.sendMessage(chatId, buildAlertMsg(newObs[0], sub.type, sub.regionCode), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: BUTTONS,
      });
    } else {
      // Multiple new sightings — compact grouped list
      await bot.sendMessage(chatId, buildListAlertMsg(newObs, sub.type, sub.regionCode), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: BUTTONS,
      });
    }
  } catch (err) {
    logger.warn(`[liveUpdates] Poll error chatId=${chatId}: ${err.message}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function startLiveUpdate(bot, chatId, type, locationInput, regionCode, species) {
  stopLiveUpdate(chatId); // clear any existing sub first

  // Ensure timezone cache is populated for COORD-based regions (e.g. "Botanic Gardens, Singapore")
  // so getTodayDateStr uses the correct local timezone instead of UTC.
  if (regionCode && regionCode.startsWith('COORD:')) {
    await resolveTimezoneForRegion(regionCode).catch(() => {});
  }

  // Seed seenSubIds with current observations so we only alert on *new* ones
  const seenSubIds = new Set();
  try {
    const initial = await fetchLatest(type, regionCode, species);
    for (const o of (initial || [])) { if (o.subId) seenSubIds.add(o.subId); }
  } catch { /* seed quietly */ }

  const timerId = setInterval(() => pollAndNotify(bot, chatId), POLL_INTERVAL_MS);
  liveSubMap.set(chatId, { type, locationInput, regionCode, species: species || null, seenSubIds, timerId });
  logger.info(`[liveUpdates] Started type=${type} chatId=${chatId} location=${locationInput}`);
}

function stopLiveUpdate(chatId) {
  const sub = liveSubMap.get(chatId);
  if (!sub) return;
  clearInterval(sub.timerId);
  liveSubMap.delete(chatId);
  logger.info(`[liveUpdates] Stopped chatId=${chatId}`);
}

function getLiveUpdate(chatId) {
  return liveSubMap.get(chatId) || null;
}

module.exports = { startLiveUpdate, stopLiveUpdate, getLiveUpdate };
