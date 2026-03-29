'use strict';

/**
 * Bird Menu — eBird API 2.0 functions via inline keyboard buttons
 *
 * Provides navigable menus for all major eBird API 2.0 endpoints:
 *   🔍 Observations   —  nearby, by region, notable, by species, historic
 *   📌 Hotspots        —  nearby, in region, hotspot info
 *   🔬 Species         —  search, observations, species list, taxonomic forms
 *   📊 Reports         —  regional stats, top 100, recent checklists
 *   🌍 Regions         —  region info, sub-regions, adjacent regions
 *
 * All queries are logged to the "Bird Sightings" Google Sheet (columns A–L).
 * Type /cancel at any time to abort a multi-step flow.
 */

const { EBirdService } = require('../../birdSighting/services/ebirdService');
const sheetsService    = require('../../../database/googleSheets/services/googleSheetsService');
const logger           = require('../../../src/utils/logger');

const ebird = new EBirdService(process.env.EBIRD_API_KEY);

// chatId → { action, data: {}, user, chat }
const sessions = new Map();

/** Clear an active bird-menu session for a chat (called externally when addSighting starts). */
function clearSession(chatId) {
  sessions.delete(chatId);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseCoords(text) {
  const m = (text || '').match(/(-?\d+\.?\d*)\s+(-?\d+\.?\d*)/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function parseDate(text) {
  const s = (text || '').trim().toLowerCase();
  if (s === 'today') {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Singapore',
      day: '2-digit', month: '2-digit', year: 'numeric',
    }).formatToParts(new Date());
    const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return { year: m.year, month: m.month, day: m.day };
  }
  const match = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) return { year: match[3], month: match[2], day: match[1] };
  return null;
}

function isValidRegionCode(code) {
  return /^[A-Za-z0-9-]{2,16}$/.test(code);
}

function isValidLocId(id) {
  return /^L\d{1,10}$/.test(id);
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtObservations(list, title) {
  if (!list || list.length === 0) {
    return `<b>${escHtml(title)}</b>\n\n<i>No observations found.</i>`;
  }
  const lines = list.slice(0, 15).map(
    (s, i) =>
      `${i + 1}. <b>${escHtml(s.comName)}</b> (<i>${escHtml(s.sciName)}</i>)\n` +
      `    📍 ${escHtml(s.locName || 'Unknown')}  •  ${escHtml(s.obsDt || '')}`
  );
  const more = list.length > 15 ? `\n\n<i>…and ${list.length - 15} more</i>` : '';
  return `<b>${escHtml(title)}</b>\n\n${lines.join('\n\n')}${more}`;
}

function fmtHotspots(list, title) {
  if (!list || list.length === 0) {
    return `<b>${escHtml(title)}</b>\n\n<i>No hotspots found.</i>`;
  }
  const lines = list.slice(0, 12).map(
    (h, i) =>
      `${i + 1}. <b>${escHtml(h.locName)}</b>  <code>${escHtml(h.locId)}</code>` +
      (h.lat != null ? `\n    📍 ${h.lat}, ${h.lng}` : '')
  );
  const more = list.length > 12 ? `\n\n<i>…and ${list.length - 12} more</i>` : '';
  return `<b>${escHtml(title)}</b>\n\n${lines.join('\n\n')}${more}`;
}

function fmtHotspotInfo(data, title) {
  if (!data) return `<b>${escHtml(title)}</b>\n\n<i>No data found.</i>`;
  const name   = data.name || data.locName || '';
  const locId  = data.locId || '';
  const lat    = data.latitude  ?? data.lat ?? '';
  const lng    = data.longitude ?? data.lng ?? '';
  const region = data.subnational2Code || data.subnational1Code || data.countryCode || '';
  const sppAll = data.numSpeciesAllTime != null ? `\n🦅 Species recorded (all time): <b>${data.numSpeciesAllTime}</b>` : '';
  return (
    `<b>${escHtml(title)}</b>\n\n` +
    `📛 Name: <b>${escHtml(name)}</b>\n` +
    `🆔 ID: <code>${escHtml(locId)}</code>\n` +
    `📍 Coordinates: ${lat}, ${lng}\n` +
    `🗺️ Region: ${escHtml(region)}` +
    sppAll
  );
}

function fmtSpeciesSearch(results, query, title) {
  if (!results || results.length === 0) {
    return `<b>${escHtml(title)}</b>\n\n<i>No species found for "${escHtml(query)}".</i>`;
  }
  const lines = results.slice(0, 15).map(
    (s, i) =>
      `${i + 1}. <b>${escHtml(s.comName)}</b>\n` +
      `    <i>${escHtml(s.sciName)}</i>  –  <code>${escHtml(s.speciesCode)}</code>`
  );
  const more = results.length > 15 ? `\n\n<i>…and ${results.length - 15} more</i>` : '';
  return `<b>${escHtml(title)}</b>\n\n${lines.join('\n\n')}${more}`;
}

function fmtSpeciesList(codes, title) {
  if (!codes || codes.length === 0) {
    return `<b>${escHtml(title)}</b>\n\n<i>No species recorded.</i>`;
  }
  return (
    `<b>${escHtml(title)}</b>\n\n` +
    `🦅 Total species codes ever recorded: <b>${codes.length}</b>\n\n` +
    `<i>Use "Species Observations" to look up sightings for a specific bird.</i>`
  );
}

function fmtTaxForms(forms, title) {
  if (!forms || forms.length === 0) {
    return `<b>${escHtml(title)}</b>\n\n<i>No taxonomic forms found.</i>`;
  }
  const lines = forms.slice(0, 20).map((f, i) => `${i + 1}. <code>${escHtml(f)}</code>`);
  const more = forms.length > 20 ? `\n<i>…and ${forms.length - 20} more</i>` : '';
  return `<b>${escHtml(title)}</b>\n\n${lines.join('\n')}${more}`;
}

function fmtChecklists(list, title) {
  if (!list || list.length === 0) {
    return `<b>${escHtml(title)}</b>\n\n<i>No checklists found.</i>`;
  }
  const lines = list.slice(0, 10).map(
    (c, i) =>
      `${i + 1}. <b>${escHtml(c.locName || 'Unknown location')}</b>\n` +
      `    ${escHtml(c.obsDt || c.creationDt || '')}  by ${escHtml(c.userDisplayName || 'Unknown')}`
  );
  return `<b>${escHtml(title)}</b>\n\n${lines.join('\n\n')}`;
}

function fmtTop100(list, title) {
  if (!list || list.length === 0) {
    return `<b>${escHtml(title)}</b>\n\n<i>No data found.</i>`;
  }
  const lines = list.slice(0, 15).map((u, i) => {
    const count = u.numSpecies != null
      ? `${u.numSpecies} species`
      : `${u.numCompleteChecklists || 0} checklists`;
    return `${i + 1}. <b>${escHtml(u.userDisplayName)}</b> — ${count}`;
  });
  const more = list.length > 15 ? `\n<i>…and ${list.length - 15} more</i>` : '';
  return `<b>${escHtml(title)}</b>\n\n${lines.join('\n')}${more}`;
}

function fmtStats(data, title) {
  if (!data) return `<b>${escHtml(title)}</b>\n\n<i>No data.</i>`;
  return (
    `<b>${escHtml(title)}</b>\n\n` +
    `📋 Checklists submitted: <b>${data.numChecklists || 0}</b>\n` +
    `🦅 Species reported: <b>${data.numSpeciesReported || 0}</b>\n` +
    `👤 Contributors: <b>${data.numContributors || 0}</b>`
  );
}

function fmtRegionInfo(data, title) {
  if (!data) return `<b>${escHtml(title)}</b>\n\n<i>No data.</i>`;
  return `<b>${escHtml(title)}</b>\n\n📛 Name: <b>${escHtml(data.result)}</b>`;
}

function fmtRegionList(list, title) {
  if (!list || list.length === 0) {
    return `<b>${escHtml(title)}</b>\n\n<i>No regions found.</i>`;
  }
  const lines = list.slice(0, 30).map(
    (r, i) => `${i + 1}. <b>${escHtml(r.name)}</b>  <code>${escHtml(r.code)}</code>`
  );
  const more = list.length > 30 ? `\n\n<i>…and ${list.length - 30} more</i>` : '';
  return `<b>${escHtml(title)}</b>\n\n${lines.join('\n')}${more}`;
}

// ── Menu keyboards ────────────────────────────────────────────────────────────

const BACK_BTN = [{ text: '← Back', callback_data: 'bird_back_sightings' }];

const OBS_MENU_OPTS = {
  parse_mode: 'HTML',
  reply_markup: {
    inline_keyboard: [
      [
        { text: '📍 Nearby',               callback_data: 'obs_nearby'          },
        { text: '🗺️ By Region',            callback_data: 'obs_region'          },
      ],
      [
        { text: '⭐ Notable Nearby',        callback_data: 'obs_notable_nearby'  },
        { text: '⭐ Notable by Region',     callback_data: 'obs_notable_region'  },
      ],
      [
        { text: '🦆 By Species',            callback_data: 'obs_species'         },
        { text: '📅 Historic by Date',      callback_data: 'obs_historic'        },
      ],
      [BACK_BTN[0]],
    ],
  },
};

const HOTSPOT_MENU_OPTS = {
  parse_mode: 'HTML',
  reply_markup: {
    inline_keyboard: [
      [
        { text: '📍 Nearby Hotspots',       callback_data: 'hs_nearby'  },
        { text: '🗺️ Hotspots in Region',   callback_data: 'hs_region'  },
      ],
      [
        { text: '🏷️ Hotspot Info',          callback_data: 'hs_info'    },
      ],
      [BACK_BTN[0]],
    ],
  },
};

const SPECIES_MENU_OPTS = {
  parse_mode: 'HTML',
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🔎 Search Species',        callback_data: 'spp_search' },
        { text: '👁️ Species Observations', callback_data: 'spp_obs'    },
      ],
      [
        { text: '📋 Species List',          callback_data: 'spp_list'   },
        { text: '🌿 Taxonomic Forms',       callback_data: 'spp_forms'  },
      ],
      [BACK_BTN[0]],
    ],
  },
};

const REPORTS_MENU_OPTS = {
  parse_mode: 'HTML',
  reply_markup: {
    inline_keyboard: [
      [
        { text: '📊 Regional Stats',        callback_data: 'rpt_stats'   },
        { text: '🏆 Top 100',               callback_data: 'rpt_top100'  },
      ],
      [
        { text: '📋 Recent Checklists',     callback_data: 'rpt_lists'   },
      ],
      [BACK_BTN[0]],
    ],
  },
};

const REGIONS_MENU_OPTS = {
  parse_mode: 'HTML',
  reply_markup: {
    inline_keyboard: [
      [
        { text: 'ℹ️ Region Info',           callback_data: 'rgn_info'  },
        { text: '📋 Sub-regions',           callback_data: 'rgn_sub'   },
      ],
      [
        { text: '🔗 Adjacent Regions',      callback_data: 'rgn_adj'   },
      ],
      [BACK_BTN[0]],
    ],
  },
};

const REGION_TYPE_OPTS = {
  parse_mode: 'HTML',
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🌐 Country',       callback_data: 'rgn_sub_type:country'      },
        { text: '🏛️ Subnational 1', callback_data: 'rgn_sub_type:subnational1' },
        { text: '🏙️ Subnational 2', callback_data: 'rgn_sub_type:subnational2' },
      ],
    ],
  },
};

// Exported — used by mainMenu.js for the 🐦 Bird Sightings button
const SIGHTINGS_CATEGORY_MENU = {
  parse_mode: 'HTML',
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🔍 Observations',      callback_data: 'bird_obs'          },
        { text: '📌 Hotspots',          callback_data: 'bird_hotspot'      },
      ],
      [
        { text: '🔬 Species',           callback_data: 'bird_species'      },
        { text: '📊 Reports',           callback_data: 'bird_reports'      },
      ],
      [
        { text: '🌍 Regions',           callback_data: 'bird_regions'      },
        { text: '➕ Add My Sighting',   callback_data: 'menu_addsighting'  },
      ],
    ],
  },
};

// ── Action flow definitions ───────────────────────────────────────────────────

// Each action lists the steps its session needs, in order.
// 'lat_lng' expects session.data.lat + session.data.lng
// 'date'    expects session.data.date_parts + session.data.date_display
const ACTION_FLOWS = {
  obs_nearby:         ['lat_lng'],
  obs_region:         ['region_code'],
  obs_notable_nearby: ['lat_lng'],
  obs_notable_region: ['region_code'],
  obs_species:        ['region_code', 'species_name'],
  obs_historic:       ['region_code', 'date'],
  hs_nearby:          ['lat_lng'],
  hs_region:          ['region_code'],
  hs_info:            ['loc_id'],
  spp_search:         ['species_name'],
  spp_obs:            ['region_code', 'species_name'],
  spp_list:           ['region_code'],
  spp_forms:          ['species_code'],
  rpt_stats:          ['region_code', 'date'],
  rpt_top100:         ['region_code', 'date'],
  rpt_lists:          ['region_code'],
  rgn_info:           ['region_code'],
  rgn_sub:            ['region_type', 'region_code'],
  rgn_adj:            ['region_code'],
};

const ACTION_LABELS = {
  obs_nearby:         '📍 Nearby Sightings',
  obs_region:         '🗺️ Sightings by Region',
  obs_notable_nearby: '⭐ Notable Nearby',
  obs_notable_region: '⭐ Notable by Region',
  obs_species:        '🦆 Sightings by Species',
  obs_historic:       '📅 Historic by Date',
  hs_nearby:          '📍 Nearby Hotspots',
  hs_region:          '🗺️ Hotspots in Region',
  hs_info:            '🏷️ Hotspot Info',
  spp_search:         '🔎 Search Species',
  spp_obs:            '👁️ Species Observations',
  spp_list:           '📋 Species List',
  spp_forms:          '🌿 Taxonomic Forms',
  rpt_stats:          '📊 Regional Stats',
  rpt_top100:         '🏆 Top 100',
  rpt_lists:          '📋 Recent Checklists',
  rgn_info:           'ℹ️ Region Info',
  rgn_sub:            '📋 Sub-regions',
  rgn_adj:            '🔗 Adjacent Regions',
};

const STEP_PROMPTS = {
  lat_lng:     '📍 <b>Enter coordinates</b>\n<i>Type: latitude longitude (e.g. 1.3521 103.8198)</i>\nOr <b>share your location</b> using the attachment (📎) button.',
  region_code: '🗺️ <b>Enter a region code</b>\n<i>Examples: SG, US, US-NY, MY-10</i>',
  species_name:'🔎 <b>Enter a species name</b>\n<i>Common or scientific — e.g. "House Sparrow"</i>',
  date:        '📅 <b>Enter a date</b>\n<i>Format: DD/MM/YYYY or "today"</i>',
  loc_id:      '🏷️ <b>Enter the hotspot location ID</b>\n<i>Format: L followed by digits — e.g. L5765808</i>',
  species_code:'🔑 <b>Enter the eBird species code</b>\n<i>e.g. houspa (House Sparrow), mallar3 (Mallard)</i>',
  region_type: null, // handled via inline keyboard
};

// ── Step resolution helpers ───────────────────────────────────────────────────

function isStepDone(step, data) {
  if (step === 'lat_lng')      return data.lat != null && data.lng != null;
  if (step === 'region_code')  return Boolean(data.region_code);
  if (step === 'species_name') return Boolean(data.species_name);
  if (step === 'date')         return Boolean(data.date_parts);
  if (step === 'loc_id')       return Boolean(data.loc_id);
  if (step === 'species_code') return Boolean(data.species_code);
  if (step === 'region_type')  return Boolean(data.region_type);
  return false;
}

function getNextStep(session) {
  const steps = ACTION_FLOWS[session.action] || [];
  for (const s of steps) {
    if (!isStepDone(s, session.data)) return s;
  }
  return null; // all done
}

function sendNextPrompt(bot, chatId, session) {
  const step = getNextStep(session);
  if (!step) {
    sessions.delete(chatId);
    return executeAction(bot, chatId, session);
  }
  if (step === 'region_type') {
    return bot.sendMessage(chatId, '🌍 <b>Select region type:</b>', REGION_TYPE_OPTS);
  }
  const prompt = STEP_PROMPTS[step];
  if (prompt) bot.sendMessage(chatId, prompt, { parse_mode: 'HTML' });
}

// ── Execute actions ───────────────────────────────────────────────────────────

function buildSearchQuery(session) {
  const { data } = session;
  if (data.lat != null && data.lng != null && data.region_code && data.species_name)
    return `${data.lat}, ${data.lng} — ${data.species_name}`;
  if (data.lat != null && data.lng != null)
    return `${data.lat}, ${data.lng}`;
  if (data.region_code && data.species_name)
    return `${data.region_code.toUpperCase()} — ${data.species_name}`;
  if (data.region_code && data.date_display)
    return `${data.region_code.toUpperCase()} — ${data.date_display}`;
  if (data.region_code) return data.region_code.toUpperCase();
  if (data.species_name) return data.species_name;
  if (data.species_code) return data.species_code;
  if (data.loc_id)       return data.loc_id;
  return '';
}

async function executeAction(bot, chatId, session) {
  const { action, data, user, chat } = session;
  let resultText       = '';
  let speciesList      = '';
  let totalCount       = 0;
  let uniqueSpecies    = 0;
  const regionCode     = data.region_code || '';

  try {
    switch (action) {

      case 'obs_nearby': {
        const res = await ebird.getNearbyObservations(data.lat, data.lng, 25, 14, 50);
        totalCount    = res.length;
        uniqueSpecies = new Set(res.map(s => s.speciesCode)).size;
        speciesList   = [...new Set(res.map(s => s.comName))].slice(0, 10).join(', ');
        resultText    = fmtObservations(res, `📍 Nearby Sightings (${data.lat}, ${data.lng})`);
        break;
      }

      case 'obs_region': {
        const res = await ebird.getRecentObservations(data.region_code, 14, 50);
        totalCount    = res.length;
        uniqueSpecies = new Set(res.map(s => s.speciesCode)).size;
        speciesList   = [...new Set(res.map(s => s.comName))].slice(0, 10).join(', ');
        resultText    = fmtObservations(res, `🗺️ Recent Sightings — ${data.region_code.toUpperCase()}`);
        break;
      }

      case 'obs_notable_nearby': {
        const res = await ebird.getNearbyNotableObservations(data.lat, data.lng, 25, 14);
        totalCount    = res.length;
        uniqueSpecies = new Set(res.map(s => s.speciesCode)).size;
        speciesList   = [...new Set(res.map(s => s.comName))].slice(0, 10).join(', ');
        resultText    = fmtObservations(res, `⭐ Notable Nearby (${data.lat}, ${data.lng})`);
        break;
      }

      case 'obs_notable_region': {
        const res = await ebird.getNotableObservations(data.region_code, 14, 50);
        totalCount    = res.length;
        uniqueSpecies = new Set(res.map(s => s.speciesCode)).size;
        speciesList   = [...new Set(res.map(s => s.comName))].slice(0, 10).join(', ');
        resultText    = fmtObservations(res, `⭐ Notable Sightings — ${data.region_code.toUpperCase()}`);
        break;
      }

      case 'obs_species': {
        const res = await ebird.getObservationsBySpeciesName(data.region_code, data.species_name, 14);
        if (res.error) {
          return bot.sendMessage(
            chatId,
            `❌ ${escHtml(res.error)}\n\n<i>Try a different species name.</i>`,
            { parse_mode: 'HTML' }
          );
        }
        const obs     = res.observations || [];
        totalCount    = obs.length;
        uniqueSpecies = 1;
        speciesList   = res.species?.commonName || data.species_name;
        resultText    = fmtObservations(
          obs,
          `🦆 ${res.species?.commonName || data.species_name} — ${data.region_code.toUpperCase()}`
        );
        break;
      }

      case 'obs_historic': {
        const { year, month, day } = data.date_parts;
        const res  = await ebird.getHistoricObservations(data.region_code, year, month, day, 50);
        totalCount    = res.length;
        uniqueSpecies = new Set(res.map(s => s.speciesCode)).size;
        speciesList   = [...new Set(res.map(s => s.comName))].slice(0, 10).join(', ');
        resultText    = fmtObservations(
          res,
          `📅 Historic Sightings — ${data.region_code.toUpperCase()} on ${data.date_display}`
        );
        break;
      }

      case 'hs_nearby': {
        const res  = await ebird.getNearbyHotspots(data.lat, data.lng, 25);
        totalCount = res.length;
        resultText = fmtHotspots(res, `📍 Nearby Hotspots (${data.lat}, ${data.lng})`);
        break;
      }

      case 'hs_region': {
        const res  = await ebird.getHotspots(data.region_code);
        totalCount = res.length;
        resultText = fmtHotspots(res, `🗺️ Hotspots in ${data.region_code.toUpperCase()}`);
        break;
      }

      case 'hs_info': {
        const res  = await ebird.getHotspotInfo(data.loc_id);
        totalCount = 1;
        resultText = fmtHotspotInfo(res, `🏷️ Hotspot Info — ${data.loc_id}`);
        break;
      }

      case 'spp_search': {
        const res     = await ebird.searchSpeciesByName(data.species_name, 20);
        totalCount    = res.length;
        uniqueSpecies = res.length;
        speciesList   = res.slice(0, 10).map(s => s.comName).join(', ');
        resultText    = fmtSpeciesSearch(res, data.species_name, `🔎 Species Search — "${data.species_name}"`);
        break;
      }

      case 'spp_obs': {
        const res = await ebird.getObservationsBySpeciesName(data.region_code, data.species_name, 14);
        if (res.error) {
          return bot.sendMessage(
            chatId,
            `❌ ${escHtml(res.error)}\n\n<i>Try a different species name.</i>`,
            { parse_mode: 'HTML' }
          );
        }
        const obs     = res.observations || [];
        totalCount    = obs.length;
        uniqueSpecies = 1;
        speciesList   = res.species?.commonName || data.species_name;
        resultText    = fmtObservations(
          obs,
          `👁️ ${res.species?.commonName || data.species_name} — ${data.region_code.toUpperCase()}`
        );
        break;
      }

      case 'spp_list': {
        const res     = await ebird.getSpeciesList(data.region_code);
        totalCount    = res.length;
        uniqueSpecies = res.length;
        resultText    = fmtSpeciesList(res, `📋 Species List — ${data.region_code.toUpperCase()}`);
        break;
      }

      case 'spp_forms': {
        const res  = await ebird.getTaxonomicForms(data.species_code);
        const list = Array.isArray(res) ? res : [];
        totalCount = list.length;
        resultText = fmtTaxForms(list, `🌿 Taxonomic Forms — ${data.species_code}`);
        break;
      }

      case 'rpt_stats': {
        const { year, month, day } = data.date_parts;
        const res  = await ebird.getRegionalStats(data.region_code, year, month, day);
        totalCount = res?.numChecklists || 0;
        resultText = fmtStats(res, `📊 Regional Stats — ${data.region_code.toUpperCase()} on ${data.date_display}`);
        break;
      }

      case 'rpt_top100': {
        const { year, month, day } = data.date_parts;
        const res  = await ebird.getTop100(data.region_code, year, month, day, 100);
        const list = Array.isArray(res) ? res : [];
        totalCount = list.length;
        resultText = fmtTop100(list, `🏆 Top 100 — ${data.region_code.toUpperCase()} on ${data.date_display}`);
        break;
      }

      case 'rpt_lists': {
        const res  = await ebird.getRecentChecklists(data.region_code, 20);
        const list = Array.isArray(res) ? res : [];
        totalCount = list.length;
        resultText = fmtChecklists(list, `📋 Recent Checklists — ${data.region_code.toUpperCase()}`);
        break;
      }

      case 'rgn_info': {
        const res  = await ebird.getRegionInfo(data.region_code);
        totalCount = 1;
        resultText = fmtRegionInfo(res, `ℹ️ Region Info — ${data.region_code.toUpperCase()}`);
        break;
      }

      case 'rgn_sub': {
        const res  = await ebird.getSubRegions(data.region_type, data.region_code);
        const list = Array.isArray(res) ? res : [];
        totalCount = list.length;
        resultText = fmtRegionList(
          list,
          `📋 Sub-regions of ${data.region_code.toUpperCase()} (${data.region_type})`
        );
        break;
      }

      case 'rgn_adj': {
        const res  = await ebird.getAdjacentRegions(data.region_code);
        const list = Array.isArray(res) ? res : [];
        totalCount = list.length;
        resultText = fmtRegionList(list, `🔗 Adjacent Regions — ${data.region_code.toUpperCase()}`);
        break;
      }

      default:
        return;
    }
  } catch (err) {
    logger.error('Bird menu action failed', { action, error: err.message });
    const apiMsg =
      err.response?.data?.errors?.[0]?.message ||
      err.response?.data?.title ||
      err.message;
    return bot.sendMessage(
      chatId,
      `❌ eBird API error: ${escHtml(apiMsg)}`,
      { parse_mode: 'HTML' }
    );
  }

  // Telegram message max: 4096 chars
  if (resultText.length > 4000) {
    resultText = resultText.slice(0, 4000) + '\n\n<i>…truncated</i>';
  }

  await bot.sendMessage(chatId, resultText, { parse_mode: 'HTML' });

  // Log to Google Sheets (non-blocking)
  sheetsService.logBirdQuery({
    user,
    chat,
    command:           ACTION_LABELS[action] || action,
    searchQuery:       buildSearchQuery(session),
    regionCode,
    totalSightings:    totalCount,
    uniqueSpeciesCount: uniqueSpecies,
    speciesList,
  }).catch(err => logger.warn('Failed to log bird query', { action, error: err.message }));
}

// ── Register bird menu handlers ───────────────────────────────────────────────

/**
 * @param {import('node-telegram-bot-api')} bot
 * @param {Map} [addSightingSessions] - the sessions Map from addSighting.js so we
 *   never process messages when that flow owns the chat.
 */
function registerBirdMenu(bot, addSightingSessions = null) {

  // ── Callback query handler ──────────────────────────────────────────────────
  bot.on('callback_query', async (query) => {
    const cbData = query.data || '';
    const chatId = query.message.chat.id;
    const user   = query.from;
    const chat   = query.message.chat;

    // Category menus
    if (cbData === 'bird_obs') {
      bot.answerCallbackQuery(query.id);
      return bot.sendMessage(chatId, '<b>🔍 Observations</b>\n\nChoose an observation query:', OBS_MENU_OPTS);
    }
    if (cbData === 'bird_hotspot') {
      bot.answerCallbackQuery(query.id);
      return bot.sendMessage(chatId, '<b>📌 Hotspots</b>\n\nChoose a hotspot query:', HOTSPOT_MENU_OPTS);
    }
    if (cbData === 'bird_species') {
      bot.answerCallbackQuery(query.id);
      return bot.sendMessage(chatId, '<b>🔬 Species & Taxonomy</b>\n\nChoose a query:', SPECIES_MENU_OPTS);
    }
    if (cbData === 'bird_reports') {
      bot.answerCallbackQuery(query.id);
      return bot.sendMessage(chatId, '<b>📊 Reports & Stats</b>\n\nChoose a report:', REPORTS_MENU_OPTS);
    }
    if (cbData === 'bird_regions') {
      bot.answerCallbackQuery(query.id);
      return bot.sendMessage(chatId, '<b>🌍 Regions</b>\n\nChoose a region query:', REGIONS_MENU_OPTS);
    }
    if (cbData === 'bird_back_sightings') {
      bot.answerCallbackQuery(query.id);
      sessions.delete(chatId); // abandon any in-progress query when going back
      return bot.sendMessage(chatId, '<b>🐦 Bird Sightings</b>\n\nChoose a category:', SIGHTINGS_CATEGORY_MENU);
    }

    // Action starts
    if (ACTION_LABELS[cbData]) {
      // Don't start a bird-menu query if addSighting already owns this chat
      if (addSightingSessions && addSightingSessions.has(chatId)) {
        bot.answerCallbackQuery(query.id, { text: 'Finish or /cancel your sighting first.' });
        return;
      }
      bot.answerCallbackQuery(query.id);
      const session = { action: cbData, data: {}, user, chat };
      sessions.set(chatId, session);
      bot.sendMessage(
        chatId,
        `<b>${escHtml(ACTION_LABELS[cbData])}</b>\n\n<i>Type /cancel at any time to abort.</i>`,
        { parse_mode: 'HTML' }
      );
      return sendNextPrompt(bot, chatId, session);
    }

    // Region type selection for rgn_sub
    if (cbData.startsWith('rgn_sub_type:')) {
      const session = sessions.get(chatId);
      if (!session || session.action !== 'rgn_sub') return bot.answerCallbackQuery(query.id);
      const regionType = cbData.split(':')[1];
      session.data.region_type = regionType;
      bot.answerCallbackQuery(query.id, { text: `✅ ${regionType} selected` });
      bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: chatId, message_id: query.message.message_id }
      ).catch(() => null);
      return sendNextPrompt(bot, chatId, session);
    }
  });

  // ── /cancel clears a bird session ──────────────────────────────────────────
  bot.onText(/\/cancel/, (msg) => {
    const chatId = msg.chat.id;
    if (!sessions.has(chatId)) return;
    sessions.delete(chatId);
    bot.sendMessage(chatId, '❌ Query cancelled.');
  });

  // ── Message handler — collect user inputs ──────────────────────────────────
  bot.on('message', async (msg) => {
    const chatId  = msg.chat.id;
    const session = sessions.get(chatId);
    if (!session) return;

    // addSighting owns this chat — do not intercept its messages
    if (addSightingSessions && addSightingSessions.has(chatId)) return;

    // Ignore commands — let command handlers deal with them
    if (msg.text && msg.text.startsWith('/')) return;

    const step = getNextStep(session);
    if (!step) return;

    // Location shared via Telegram
    if (msg.location && step === 'lat_lng') {
      session.data.lat = msg.location.latitude;
      session.data.lng = msg.location.longitude;
      return sendNextPrompt(bot, chatId, session);
    }

    const text = (msg.text || '').trim();

    if (step === 'lat_lng') {
      const coords = parseCoords(text);
      if (!coords) {
        return bot.sendMessage(
          chatId,
          '⚠️ Invalid coordinates. Enter latitude and longitude separated by a space. Example: <code>1.3521 103.8198</code>',
          { parse_mode: 'HTML' }
        );
      }
      session.data.lat = coords.lat;
      session.data.lng = coords.lng;
      return sendNextPrompt(bot, chatId, session);
    }

    if (step === 'region_code') {
      if (!isValidRegionCode(text)) {
        return bot.sendMessage(
          chatId,
          '⚠️ Invalid region code. Try something like <code>SG</code>, <code>US</code>, or <code>US-NY</code>.',
          { parse_mode: 'HTML' }
        );
      }
      session.data.region_code = text.toUpperCase();
      return sendNextPrompt(bot, chatId, session);
    }

    if (step === 'species_name') {
      if (!text || text.length < 2) {
        return bot.sendMessage(chatId, '⚠️ Please enter at least 2 characters.');
      }
      session.data.species_name = text;
      return sendNextPrompt(bot, chatId, session);
    }

    if (step === 'date') {
      const parsed = parseDate(text);
      if (!parsed) {
        return bot.sendMessage(chatId, '⚠️ Invalid date. Enter DD/MM/YYYY or "today".');
      }
      session.data.date_parts   = parsed;
      session.data.date_display = `${parsed.day}/${parsed.month}/${parsed.year}`;
      return sendNextPrompt(bot, chatId, session);
    }

    if (step === 'loc_id') {
      if (!isValidLocId(text)) {
        return bot.sendMessage(
          chatId,
          '⚠️ Invalid location ID. Format: <code>L</code> followed by digits (e.g. <code>L5765808</code>).',
          { parse_mode: 'HTML' }
        );
      }
      session.data.loc_id = text;
      return sendNextPrompt(bot, chatId, session);
    }

    if (step === 'species_code') {
      if (!text || text.length < 2 || text.length > 20 || !/^[a-zA-Z0-9]+$/.test(text)) {
        return bot.sendMessage(
          chatId,
          '⚠️ Enter a valid eBird species code (letters/digits only, e.g. <code>houspa</code>).',
          { parse_mode: 'HTML' }
        );
      }
      session.data.species_code = text.toLowerCase();
      return sendNextPrompt(bot, chatId, session);
    }
  });
}

module.exports = { registerBirdMenu, SIGHTINGS_CATEGORY_MENU, clearSession };
