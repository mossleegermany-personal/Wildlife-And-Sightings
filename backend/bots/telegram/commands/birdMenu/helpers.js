'use strict';

const {
  REGION_TIMEZONE, BREEDING_CODES, AGE_LABELS, SEX_ICONS,
} = require('./constants');
const { reverseGeocodeCountry } = require('../../../animalIdentification/services/gbifService');
const logger                    = require('../../../../src/utils/logger');

// ── Timezone utilities ────────────────────────────────────────────────────────

const coordTzCache = new Map();

function getTimezoneForRegion(regionCode) {
  if (!regionCode || regionCode === 'WORLD') return 'UTC';
  if (regionCode.startsWith('COORD:')) {
    return coordTzCache.get(regionCode) || 'UTC';
  }
  const upper = regionCode.toUpperCase();
  if (REGION_TIMEZONE[upper]) return REGION_TIMEZONE[upper];
  const country = upper.split('-')[0];
  return REGION_TIMEZONE[country] || 'UTC';
}

async function resolveTimezoneForRegion(regionCode) {
  if (!regionCode || regionCode === 'WORLD') return 'UTC';
  if (!regionCode.startsWith('COORD:')) return getTimezoneForRegion(regionCode);
  if (coordTzCache.has(regionCode)) return coordTzCache.get(regionCode);
  try {
    const parts = regionCode.slice(6).split(',').map(Number);
    const [lat, lng] = parts;
    const cc = await reverseGeocodeCountry(lat, lng);
    if (cc && REGION_TIMEZONE[cc]) {
      coordTzCache.set(regionCode, REGION_TIMEZONE[cc]);
      return REGION_TIMEZONE[cc];
    }
  } catch (err) {
    logger.warn('[helpers] resolveTimezoneForRegion failed', { regionCode, error: err.message });
  }
  return 'UTC';
}

function getTzAbbr(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date());
    return parts.find(p => p.type === 'timeZoneName')?.value || tz;
  } catch { return tz; }
}

/**
 * Returns current date/time as a naive Date whose y/m/d/h/m/s values
 * match the given IANA timezone — used for display and comparison against
 * eBird observation timestamps (which are also local-time naive).
 */
function nowInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return new Date(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

function fmtNaiveShort(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const h  = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${h}:${mi} hrs`;
}

// ── Date utilities ────────────────────────────────────────────────────────────

function getDatePreset(preset, regionCode) {
  const tz     = getTimezoneForRegion(regionCode);
  const tzAbbr = getTzAbbr(tz);
  const end    = nowInTz(tz);
  const todayStart = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 0, 0, 0, 0);

  function makeResult(backDays, daysBack) {
    const start = new Date(todayStart);
    start.setDate(start.getDate() - daysBack);
    const label = `${fmtNaiveShort(start)} – ${fmtNaiveShort(end)} (${tzAbbr})`;
    return { backDays, label, startDate: start, endDate: end };
  }

  switch (preset) {
    case 'today':        return makeResult(1,  0);
    case 'yesterday':    return makeResult(2,  1);
    case 'last_3_days':  return makeResult(3,  2);
    case 'last_week':    return makeResult(7,  6);
    case 'last_14_days': return makeResult(14, 13);
    case 'last_month':   return makeResult(30, 29);
    default:             return makeResult(14, 13);
  }
}

function filterObservationsByDateRange(observations, startDate, endDate) {
  if (!startDate || !endDate || !Array.isArray(observations)) return observations;
  return observations.filter(obs => {
    if (!obs.obsDt) return false;
    try {
      const [datePart, timePart]  = obs.obsDt.split(' ');
      const [yr, mo, dy]          = datePart.split('-');
      const [h, m]                = (timePart || '12:00').split(':');
      const obsDate = new Date(+yr, +mo - 1, +dy, +h, +m);
      return obsDate >= startDate && obsDate <= endDate;
    } catch { return false; }
  });
}

// ── Text / formatting helpers ─────────────────────────────────────────────────

function esc(str) {
  return String(str || '').replace(/[*_`[\]]/g, '\\$&');
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(dateStr, regionCode) {
  if (!dateStr) return '';
  const [datePart, timePart] = dateStr.split(' ');
  if (!datePart) return dateStr;
  const [yr, mo, dy] = datePart.split('-');
  const tzAbbr = regionCode ? ` ${getTzAbbr(getTimezoneForRegion(regionCode))}` : '';
  return `${dy}/${mo}/${yr}${timePart ? ' ' + timePart : ''}${tzAbbr}`;
}

// ── Checklist metadata parsers ────────────────────────────────────────────────

/** Breeding code from obsAux array (fieldName: 'breeding_code') */
function parseBreedingCode(obsAux) {
  if (!Array.isArray(obsAux)) return null;
  const entry = obsAux.find(a => a.fieldName === 'breeding_code');
  return entry ? (entry.auxCode || null) : null;
}

/**
 * Extract Macaulay Library catalog IDs from a checklist's subAuxAi array,
 * grouped by speciesCode.
 *
 * Entries look like:
 *   { speciesCode: "faipit1", fieldName: "ml_media_id", auxCode: "652648018" }
 *   or auxCode: "ML652648018" — strips the "ML" prefix either way.
 *
 * Returns Map<speciesCode, { photos: string[], audios: string[], videos: string[] }>
 */
function parseMediaFromSubAuxAi(subAuxAi) {
  const result = new Map();
  if (!Array.isArray(subAuxAi)) return result;
  for (const a of subAuxAi) {
    if (!a.auxCode) continue;
    const fn      = (a.fieldName || '').toLowerCase();
    const rawCode = String(a.auxCode);
    if (fn.includes('nocturnal') || fn.includes('age_sex') || fn.includes('breeding')) continue;
    const mlId = rawCode.replace(/^ML/i, '');
    if (!/^\d+$/.test(mlId)) continue;
    const key = a.speciesCode || '__checklist__';
    if (!result.has(key)) result.set(key, { photos: [], audios: [], videos: [] });
    const bucket = result.get(key);
    if      (fn.includes('audio') || fn.includes('sound')) bucket.audios.push(mlId);
    else if (fn.includes('video'))                          bucket.videos.push(mlId);
    else                                                    bucket.photos.push(mlId);
  }
  return result;
}

/**
 * Age & sex summary from obsAux entries (fieldName: 'age_sex').
 * auxCode format: "adult|m", "juvenile|f", "immature|u", etc.
 * value: count as string (e.g. "1")
 */
function parseAgeSex(obsAux) {
  if (!Array.isArray(obsAux)) return null;
  const entries = obsAux.filter(a => a.fieldName === 'age_sex');
  if (!entries.length) return null;
  const parts = entries.map(e => {
    const [age, sex] = (e.auxCode || '').split('|');
    const count  = e.value ? parseInt(e.value, 10) : NaN;
    const ageStr = AGE_LABELS[age] || age || '?';
    const sexStr = (sex !== undefined && SEX_ICONS[sex] !== undefined) ? SEX_ICONS[sex] : (sex ? `(${sex})` : '');
    const cntStr = !isNaN(count) ? ` ×${count}` : '';
    return `${ageStr}${sexStr}${cntStr}`;
  });
  return parts.join(', ') || null;
}

// ── Observation card formatter ────────────────────────────────────────────────

function fmtObsItem(obs, index, regionCode) {
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
  const breedDesc = breedCode ? (BREEDING_CODES[breedCode] || breedCode) : null;

  // Direct CDN links — the mediaUrl from ML API opens the raw file in browser, no ML website
  const mediaLines = [];
  if (obs.mlMedia) {
    const { photos, audios, videos } = obs.mlMedia;
    if (photos.length) mediaLines.push(`📷 <a href="${photos[0]}">Photo</a>`);
    if (audios.length) mediaLines.push(`🔊 <a href="${audios[0]}">Audio</a>`);
    if (videos.length) mediaLines.push(`🎬 <a href="${videos[0]}">Video</a>`);
  }

  let s  = `<b>${index + 1}. ${escHtml(obs.comName || 'Unknown')}</b>\n`;
  s     += `   📍 ${locText}\n`;
  s     += `   🔍 Count: <b>${cnt}</b>\n`;
  s     += `   🔬 ${obs.ageSex ? escHtml(obs.ageSex) : '—'}\n`;
  if (fmtD)                s += `   📅 ${fmtD}\n`;
  if (fmtT)                s += `   🕒 ${fmtT}\n`;
  if (obs.subId)           s += `   🔗 <a href="https://ebird.org/checklist/${obs.subId}">View Checklist</a>\n`;
  for (const ml of mediaLines) s += `   ${ml}\n`;
  if (coordLabel && mapsUrl) s += `   🗺️ <a href="${mapsUrl}">${coordLabel}</a>\n`;
  if (obs.userDisplayName)   s += `   👤 ${escHtml(obs.userDisplayName)}\n`;
  if (breedCode)             s += `   🐣 ${escHtml(breedCode)} — ${escHtml(breedDesc)}\n`;
  if (obs.comments)          s += `   💬 ${escHtml(obs.comments)}\n`;
  return s;
}

// ── Location helpers ──────────────────────────────────────────────────────────

function getPopularLocations() {
  return '\n\n*Popular Locations:*\n' +
    '🇸🇬 Singapore → `SG`\n' +
    '🇲🇾 Malaysia → `MY`\n' +
    '🇯🇵 Japan → `JP`\n' +
    '🇺🇸 USA → `US`\n' +
    '🇬🇧 UK → `GB`\n' +
    '🇦🇺 Australia → `AU`\n' +
    '🇿🇦 South Africa → `ZA`\n' +
    '🇧🇷 Brazil → `BR`\n' +
    '🇮🇳 India → `IN`\n' +
    '🇨🇦 Canada → `CA`';
}

module.exports = {
  getTimezoneForRegion, resolveTimezoneForRegion, getTzAbbr, nowInTz, fmtNaiveShort,
  getDatePreset, filterObservationsByDateRange,
  esc, escHtml, fmtDate,
  parseBreedingCode, parseAgeSex, parseMediaFromSubAuxAi,
  fmtObsItem, getPopularLocations,
};
