'use strict';

const { geocodeLocation, reverseGeocodeCountry }  = require('../../../animalIdentification/services/gbifService');
const logger                                     = require('../../../../src/utils/logger');
const {
  esc, escHtml, getTimezoneForRegion, resolveTimezoneForRegion, getTzAbbr, nowInTz, fmtNaiveShort,
  getDatePreset, filterObservationsByDateRange, getPopularLocations,
} = require('./helpers');
const { userStates, observationsCache, lastPrompts, birdSessionMap } = require('./state');
const { resolveRegionCode, bboxRadiusKm }        = require('./location');
const {
  deleteMsg, sendPaginatedObservations, sendPaginatedLogs,
} = require('./pagination');
const { ebird, sheetsService } = require('./services');

// ── Date selection UI ─────────────────────────────────────────────────────────

async function showDateSelection(bot, chatId, regionCode, displayName, type, opts) {
  opts = opts || {};
  const isHotspot = opts.isHotspot || false;

  const message =
    `📅 *Select date range for ${esc(displayName)}:*\n` +
    `Choose a preset or enter a custom date.\n\n` +
    `*Quick Options:*`;

  const buttons = [
    [
      { text: '📅 Today',        callback_data: `date_${type}_today_${regionCode}`        },
      { text: '📅 Yesterday',    callback_data: `date_${type}_yesterday_${regionCode}`    },
    ],
    [
      { text: '📅 Last 3 Days',  callback_data: `date_${type}_last_3_days_${regionCode}`  },
      { text: '📅 Last Week',    callback_data: `date_${type}_last_week_${regionCode}`    },
    ],
    [
      { text: '📅 Last 14 Days', callback_data: `date_${type}_last_14_days_${regionCode}` },
      { text: '📅 Last Month',   callback_data: `date_${type}_last_month_${regionCode}`   },
    ],
    [
      { text: '📆 Custom Date',  callback_data: `date_${type}_custom_${regionCode}`       },
    ],
    [
      { text: '🔄 Try Again', callback_data: 'new_search' },
      { text: '✅ Done', callback_data: 'done' },
    ],
  ];

  const prev = userStates.get(chatId) || {};
  userStates.set(chatId, { ...prev, action: 'date_selection', regionCode, displayName, type, isHotspot });
  lastPrompts.set(chatId, { message, action: 'date_selection', regionCode, displayName, type });
  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

async function showSpeciesDateSelection(bot, chatId, locationInput, species, opts) {
  opts = opts || {};
  const regionCode = opts.regionCode || await resolveRegionCode(locationInput);
  const isHotspot  = opts.isHotspot || false;
  const message =
    `📅 *Select date for ${esc(species.commonName)} in ${esc(locationInput)}:*\n` +
    `Choose a preset or enter a custom date.\n\n` +
    `_All sightings from 00:00 to 23:59 of selected date(s)_`;

  const buttons = [
    [
      { text: '📅 Today',        callback_data: `date_species_today_${regionCode}`        },
      { text: '📅 Yesterday',    callback_data: `date_species_yesterday_${regionCode}`    },
    ],
    [
      { text: '📅 Last 3 Days',  callback_data: `date_species_last_3_days_${regionCode}`  },
      { text: '📅 Last Week',    callback_data: `date_species_last_week_${regionCode}`    },
    ],
    [
      { text: '📅 Last 14 Days', callback_data: `date_species_last_14_days_${regionCode}` },
      { text: '📅 Last Month',   callback_data: `date_species_last_month_${regionCode}`   },
    ],
    [
      { text: '📆 Custom Date',  callback_data: `date_species_custom_${regionCode}`       },
    ],
    [
      { text: '🔄 Try Again', callback_data: 'new_search' },
      { text: '✅ Done', callback_data: 'done' },
    ],
  ];

  const prev = userStates.get(chatId) || {};
  userStates.set(chatId, { ...prev, action: 'date_selection', regionCode, displayName: locationInput, type: 'species', species, isHotspot });
  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

// ── Date callback handler ─────────────────────────────────────────────────────

async function handleDateCallback(bot, chatId, data) {
  const parts = data.split('_');
  const type  = parts[1]; // sightings, notable, species

  let preset, regionCode;
  if (parts[2] === 'custom') {
    preset     = 'custom';
    regionCode = parts.slice(3).join('_');
  } else if (parts[2] === 'last') {
    if (parts[3] === '3' || parts[3] === '14') {
      preset     = `${parts[2]}_${parts[3]}_${parts[4]}`;
      regionCode = parts.slice(5).join('_');
    } else {
      preset     = `${parts[2]}_${parts[3]}`;
      regionCode = parts.slice(4).join('_');
    }
  } else {
    preset     = parts[2];
    regionCode = parts.slice(3).join('_');
  }

  const userState   = userStates.get(chatId) || {};
  const displayName = userState.displayName || regionCode;
  const isHotspot   = userState.isHotspot || false;
  const context     = userState.context || {};

  if (preset === 'custom') {
    userStates.set(chatId, { ...userState, action: 'awaiting_custom_date', regionCode, type });
    await bot.sendMessage(chatId,
      '📆 *Enter a custom date:*\n\n• Single date: `DD/MM/YYYY`\n• Date range: `DD/MM/YYYY to DD/MM/YYYY`',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Pre-resolve timezone for COORD-based regions
  if (regionCode.startsWith('COORD:')) await resolveTimezoneForRegion(regionCode);
  const dateFilter = getDatePreset(preset, regionCode);
  userStates.delete(chatId);

  if (type === 'sightings') {
    await fetchAndSendSightings(bot, chatId, regionCode, displayName, 0, dateFilter, isHotspot, context);
  } else if (type === 'notable') {
    await fetchAndSendNotable(bot, chatId, regionCode, displayName, 0, dateFilter, isHotspot, context);
  } else if (type === 'species') {
    const species = userState.species;
    if (species) {
      await fetchSpeciesInLocation(bot, chatId, displayName, species.commonName, species.code, dateFilter, context, regionCode);
    }
  }
}

// ── Custom date input handler ─────────────────────────────────────────────────

function parseUserDate(str) {
  const m = (str || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return isNaN(d.getTime()) ? null : d;
}

async function handleCustomDateInput(bot, chatId, text, userState) {
  const { regionCode, displayName, type, species, isHotspot = false, context = {} } = userState;
  let startDate, endDate, label;

  const fmt = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  // Pre-resolve timezone for COORD-based regions
  if (regionCode && regionCode.startsWith('COORD:')) await resolveTimezoneForRegion(regionCode);
  const tz       = getTimezoneForRegion(regionCode);
  const tzAbbr   = getTzAbbr(tz);
  const nowLocal = nowInTz(tz);
  const todayLocal = new Date(nowLocal.getFullYear(), nowLocal.getMonth(), nowLocal.getDate());

  if (text.toLowerCase().includes(' to ')) {
    const [startStr, endStr] = text.split(/\s+to\s+/i);
    startDate = parseUserDate(startStr);
    endDate   = parseUserDate(endStr);
    if (!startDate || !endDate) {
      await bot.sendMessage(chatId,
        '❌ Invalid format. Use:\n• `DD/MM/YYYY`\n• `DD/MM/YYYY to DD/MM/YYYY`',
        { parse_mode: 'Markdown' }
      );
      return;
    }
    if (startDate > endDate) [startDate, endDate] = [endDate, startDate];
    label = `${fmt(startDate)} to ${fmt(endDate)}`;
  } else {
    startDate = parseUserDate(text);
    if (!startDate) {
      await bot.sendMessage(chatId, '❌ Invalid date. Use `DD/MM/YYYY`.', { parse_mode: 'Markdown' });
      return;
    }
    endDate = new Date(startDate);
    label   = fmt(startDate);
  }

  startDate.setHours(0, 0, 0, 0);
  const endIsToday = endDate.getFullYear() === todayLocal.getFullYear()
    && endDate.getMonth() === todayLocal.getMonth()
    && endDate.getDate()  === todayLocal.getDate();
  if (endIsToday) {
    endDate = new Date(nowLocal);
    label += ` – ${fmtNaiveShort(endDate)} (${tzAbbr})`;
  } else {
    endDate.setHours(23, 59, 59, 999);
  }

  const thirtyDaysAgo = new Date(todayLocal);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  thirtyDaysAgo.setHours(0, 0, 0, 0);
  if (startDate < thirtyDaysAgo) {
    await bot.sendMessage(chatId,
      `⚠️ eBird API only provides the last 30 days.\nAvailable: ${fmt(thirtyDaysAgo)} to today (${tzAbbr}).`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const backDays   = Math.min(Math.ceil((endDate - startDate) / 86400000) + 1, 30);
  const dateFilter = { startDate, endDate, backDays, label };
  userStates.delete(chatId);

  if (type === 'sightings') {
    await fetchAndSendSightings(bot, chatId, regionCode, displayName, 0, dateFilter, isHotspot, context);
  } else if (type === 'notable') {
    await fetchAndSendNotable(bot, chatId, regionCode, displayName, 0, dateFilter, isHotspot, context);
  } else if (type === 'species' && species) {
    await fetchSpeciesInLocation(bot, chatId, displayName, species.commonName, species.code, dateFilter, context, regionCode);
  } else if (type === 'nearby') {
    const { latitude, longitude, dist } = userState;
    await fetchNearbySightings(bot, chatId, latitude, longitude, dist, context, dateFilter);
  }
}

// ── Sightings flow ────────────────────────────────────────────────────────────

async function handleSightings(bot, chatId, context) {
  userStates.set(chatId, { action: 'awaiting_region_sightings', context: context || {} });
  const msg =
    `📍 *Enter a location to see recent bird sightings:*\n\n` +
    `You can type any location worldwide:\n` +
    `• City or region: \`Tokyo\`, \`Cape Town\`, \`Vancouver\`\n` +
    `• Country: \`Australia\`, \`Brazil\`, \`Kenya\`\n` +
    `• Specific place: \`Botanic Gardens, Singapore\`\n` +
    `• Region code: \`SG\`, \`US-NY\`, \`AU-WA\`` +
    getPopularLocations();
  lastPrompts.set(chatId, { message: msg, action: 'awaiting_region_sightings' });
  const sentSightings = await bot.sendMessage(chatId, msg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Try Again', callback_data: 'new_search' }, { text: '✅ Done', callback_data: 'done' }],
      ],
    },
  });
  const prevSightings = userStates.get(chatId) || {};
  userStates.set(chatId, { ...prevSightings, promptMsgId: sentSightings?.message_id });
}

async function handlePlaceSearch(bot, chatId, input, type, context, species) {
  // For sightings/notable: fetch results immediately with default date (Last 3 Days).
  // For species: still show date picker (species searches are more targeted).
  function defaultFetch(regionCode, displayName, opts) {
    const dateFilter = getDatePreset('last_3_days', regionCode);
    if (type === 'sightings') {
      return fetchAndSendSightings(bot, chatId, regionCode, displayName, 0, dateFilter, opts?.isHotspot || false, context);
    }
    if (type === 'notable') {
      return fetchAndSendNotable(bot, chatId, regionCode, displayName, 0, dateFilter, opts?.isHotspot || false, context);
    }
    // species / fallback — keep date picker
    if (type === 'species' && species) {
      return showSpeciesDateSelection(bot, chatId, displayName, species, { regionCode, isHotspot: opts?.isHotspot });
    }
    return showDateSelection(bot, chatId, regionCode, displayName, type, opts);
  }

  let geo = null;
  try { geo = await geocodeLocation(input); } catch { /* ignore */ }

  if (geo) {
    const prev = userStates.get(chatId) || {};
    userStates.set(chatId, { ...prev, context: context || {}, species });

    // Tier 1: Has ISO subdivision (state/prefecture) → eBird region code
    if (geo.isoSubdivision) {
      return defaultFetch(geo.isoSubdivision, input);
    }

    // Tier 2: Boundary without ISO subdivision
    if (geo.osmClass === 'boundary') {
      const radius = bboxRadiusKm(geo.boundingbox);
      if (radius < 50) {
        // Sub-region (e.g. Pasir Ris) → coordinate search with bbox radius
        const r = Math.max(1, Math.min(50, Math.ceil(radius * 1.5)));
        const coordCode = `COORD:${Number(geo.lat).toFixed(4)},${Number(geo.lng).toFixed(4)},${r}`;
        return defaultFetch(coordCode, input);
      }
      // Large boundary (country-level) → country code
      const regionCode = geo.country_code || 'WORLD';
      return defaultFetch(regionCode, input);
    }

    // Tier 3: Non-boundary (landmark/park) → fall through to hotspot name search
  }

  // ── Hotspot name search ─────────────────────────────────────────────────────
  const parts = input.split(',').map(p => p.trim());
  let placeName, regionInput;
  if (parts.length > 1) {
    placeName   = parts[0];
    regionInput = parts.slice(1).join(',').trim();
  } else {
    placeName   = input.trim();
    regionInput = geo?.country || '';
  }

  if (!placeName || !regionInput) {
    await bot.sendMessage(chatId,
      '❌ Please provide both place and region.\n\n*Format:* `Location, Country`\n*Example:* `Botanic Gardens, Singapore`',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const regionCode = await resolveRegionCode(regionInput);
  const _st = await bot.sendMessage(chatId,
    `🔍 Searching for "*${esc(placeName)}*" in *${esc(regionInput)}*...`,
    { parse_mode: 'Markdown' }
  );

  try {
    const hotspots = await ebird.searchHotspotsByName(regionCode, placeName);
    await deleteMsg(bot, chatId, _st?.message_id);

    if (!Array.isArray(hotspots) || hotspots.length === 0) {
      // Fallback: if we have geocoded coords, do a coordinate-based search instead of giving up
      if (geo && geo.lat != null && geo.lng != null) {
        await deleteMsg(bot, chatId, _st?.message_id);
        const radius = geo.boundingbox ? bboxRadiusKm(geo.boundingbox) : 5;
        const r = Math.max(1, Math.min(50, Math.ceil(radius * 1.5)));
        const coordCode = `COORD:${Number(geo.lat).toFixed(4)},${Number(geo.lng).toFixed(4)},${r}`;
        return defaultFetch(coordCode, input);
      }

      let message = `❌ No locations found matching "*${esc(placeName)}*" in *${esc(regionInput)}*.`;
      message += `\n\n💡 Try the whole region with just \`${esc(regionInput)}\``;
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      await resendLastPrompt(bot, chatId);
      return;
    }

    const prev = userStates.get(chatId) || {};
    userStates.set(chatId, { ...prev, context: context || {}, species });

    if (hotspots.length === 1) {
      return defaultFetch(hotspots[0].locId, hotspots[0].locName, { isHotspot: true });
    } else {
      await showHotspotSelection(bot, chatId, hotspots, type, regionInput, context, species);
    }
  } catch (err) {
    logger.error('Place search error', { error: err.message });
    await deleteMsg(bot, chatId, _st?.message_id);
    await bot.sendMessage(chatId,
      `❌ Error searching for locations. Try \`${esc(regionInput)}\` directly.`,
      { parse_mode: 'Markdown' }
    );
    await resendLastPrompt(bot, chatId);
  }
}

async function showHotspotSelection(bot, chatId, hotspots, type, regionName, context, species) {
  const buttons = hotspots.slice(0, 8).map((h, i) => {
    const sp = h.numSpeciesAllTime ? ` (${h.numSpeciesAllTime} species)` : '';
    return [{ text: `${i + 1}. ${h.locName}${sp}`, callback_data: `hotspot_${type}_${h.locId}` }];
  });
  userStates.set(chatId, {
    action: 'hotspot_selection', hotspots: hotspots.slice(0, 8), type, context: context || {}, species,
  });
  buttons.push([
    { text: '🔄 Try Again', callback_data: 'new_search' },
    { text: '✅ Done', callback_data: 'done' },
  ]);
  await bot.sendMessage(chatId,
    `📍 *Found ${hotspots.length} locations in ${esc(regionName)}:*\n\nSelect a location:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
}

async function resendLastPrompt(bot, chatId) {
  const prompt = lastPrompts.get(chatId);
  if (prompt) {
    await bot.sendMessage(chatId, `\n${prompt.message}`, { parse_mode: 'Markdown' });
    userStates.set(chatId, { action: prompt.action });
  }
}

async function fetchAndSendSightings(bot, chatId, regionCode, originalInput, page, dateFilter, isHotspot, context) {
  page       = page       ?? 0;
  dateFilter = dateFilter ?? null;
  isHotspot  = isHotspot  ?? false;
  context    = context    ?? {};

  const displayName = originalInput || regionCode;
  const cacheKey    = `sightings_${chatId}`;
  let observations, dateLabel = '', _st = null;

  const isCoord = typeof regionCode === 'string' && regionCode.startsWith('COORD:');

  if (page > 0 && observationsCache.has(cacheKey)) {
    const cached = observationsCache.get(cacheKey);
    observations = cached.observations;
    dateLabel    = cached.dateLabel || '';
  } else {
    const backDays      = dateFilter?.backDays || 14;
    dateLabel           = dateFilter?.label || 'Last 14 Days';
    const locationLabel = isHotspot ? '📍 Hotspot' : isCoord ? '📍 Near location' : '🗺️ Region';
    const regionDisplay = isCoord ? '(coordinates)' : regionCode;
    _st = await bot.sendMessage(chatId,
      `🔍 Searching for sightings in *${esc(displayName)}*\n${locationLabel}: ${regionDisplay}\n📅 ${dateLabel}...`,
      { parse_mode: 'Markdown' }
    );
    try {
      if (isCoord) {
        const coordParts = regionCode.slice(6).split(',').map(Number);
        const [lat, lng] = coordParts;
        const dist = coordParts[2] || 25;
        observations = await ebird.getNearbyObservations(lat, lng, dist, backDays, 100);
      } else if (isHotspot) {
        observations = await ebird.getHotspotObservations(regionCode, backDays, 100);
      } else {
        observations = await ebird.getRecentObservations(regionCode, backDays, 100);
      }
      if (dateFilter?.startDate && dateFilter?.endDate) {
        observations = filterObservationsByDateRange(observations, dateFilter.startDate, dateFilter.endDate);
      }
      await deleteMsg(bot, chatId, _st?.message_id);
      observationsCache.set(cacheKey, { observations, displayName, regionCode, type: 'sightings', dateLabel, isHotspot });
    } catch (err) {
      await deleteMsg(bot, chatId, _st?.message_id);
      await bot.sendMessage(chatId, `❌ Could not fetch sightings for *${esc(displayName)}*.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔄 Try Again', callback_data: 'new_search' }, { text: '✅ Done', callback_data: 'done' }]] },
      });
      return;
    }
  }

  if (!observations || observations.length === 0) {
    const isToday = (dateFilter?.backDays === 1);
    const hint = isCoord
      ? `\n\n💡 No sightings found nearby. Try a longer date range or search a wider area.`
      : regionCode.includes('-')
        ? `\n\n💡 eBird may have limited coverage for *${esc(regionCode)}*. Try:\n• A longer date range\n• 🗺️ Hotspots to find active birding spots here\n• 📍 Nearby with a shared location`
        : isToday
          ? `\n\n💡 No sightings logged yet for today. Observers may not have uploaded yet — try *Yesterday* or *Last 3 Days*`
          : `\n\n💡 Try a longer date range or a more specific location`;
    await bot.sendMessage(chatId,
      `❌ No observations found for *${esc(displayName)}* in the selected time range.${hint}`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔄 Try Again', callback_data: 'new_search' }, { text: '✅ Done', callback_data: 'done' }]] },
      }
    );
    return;
  }

  const regionDisplay3 = isCoord ? displayName : regionCode;
  sheetsService.logBirdQuery({
    user: context.user, chat: context.chat,
    sessionId: birdSessionMap.get(chatId)?.sessionId || '',
    command: 'Sightings', searchQuery: displayName, regionCode: regionDisplay3,
    totalSightings: observations.length,
    uniqueSpeciesCount: new Set(observations.map(o => o.speciesCode)).size,
    speciesList: [...new Set(observations.map(o => o.comName))].slice(0, 10).join(', '),
  }).catch(err => logger.warn('Sheets log failed', { error: err.message }));

  await sendPaginatedObservations(bot, chatId, observations, displayName, 'sightings', page, null, regionCode, dateLabel);
}

// ── Notable flow ──────────────────────────────────────────────────────────────

async function handleNotable(bot, chatId, context) {
  userStates.set(chatId, { action: 'awaiting_region_notable', context: context || {} });
  const msg =
    `⭐ *Enter a location to see notable sightings:*\n\n` +
    `Notable sightings include rare species and unusual observations.\n\n` +
    `You can type any location worldwide:\n` +
    `• City or region: \`Tokyo\`, \`Cape Town\`, \`Vancouver\`\n` +
    `• Country: \`Australia\`, \`Brazil\`, \`Kenya\`\n` +
    `• Specific place: \`Botanic Gardens, Singapore\`\n` +
    `• Region code: \`SG\`, \`US-NY\`, \`AU-WA\`` +
    getPopularLocations();
  lastPrompts.set(chatId, { message: msg, action: 'awaiting_region_notable' });
  const sentNotable = await bot.sendMessage(chatId, msg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Try Again', callback_data: 'new_search' }, { text: '✅ Done', callback_data: 'done' }],
      ],
    },
  });
  const prevNotable = userStates.get(chatId) || {};
  userStates.set(chatId, { ...prevNotable, promptMsgId: sentNotable?.message_id });
}

async function fetchAndSendNotable(bot, chatId, regionCode, originalInput, page, dateFilter, isHotspot, context) {
  page       = page       ?? 0;
  dateFilter = dateFilter ?? null;
  isHotspot  = isHotspot  ?? false;
  context    = context    ?? {};

  const displayName = originalInput || regionCode;
  const cacheKey    = `notable_${chatId}`;
  let observations, dateLabel = '', _st = null;

  const isCoordN = typeof regionCode === 'string' && regionCode.startsWith('COORD:');

  if (page > 0 && observationsCache.has(cacheKey)) {
    const cached = observationsCache.get(cacheKey);
    observations = cached.observations;
    dateLabel    = cached.dateLabel || '';
  } else {
    const backDays      = dateFilter?.backDays || 14;
    dateLabel           = dateFilter?.label || 'Last 14 Days';
    const locationLabel = isHotspot ? '📍 Hotspot' : isCoordN ? '📍 Near location' : '🗺️ Region';
    const regionDisplayN = isCoordN ? '(coordinates)' : regionCode;
    _st = await bot.sendMessage(chatId,
      `🔍 Searching for notable sightings in *${esc(displayName)}*\n${locationLabel}: ${regionDisplayN}\n📅 ${dateLabel}...`,
      { parse_mode: 'Markdown' }
    );
    try {
      if (isCoordN) {
        const coordParts = regionCode.slice(6).split(',').map(Number);
        const [lat, lng] = coordParts;
        const dist = coordParts[2] || 25;
        observations = await ebird.getNearbyNotableObservations(lat, lng, dist, backDays);
      } else if (isHotspot) {
        observations = await ebird.getHotspotObservations(regionCode, backDays, 100);
      } else {
        observations = await ebird.getNotableObservations(regionCode, backDays, 100);
      }
      if (dateFilter?.startDate && dateFilter?.endDate) {
        observations = filterObservationsByDateRange(observations, dateFilter.startDate, dateFilter.endDate);
      }
      await deleteMsg(bot, chatId, _st?.message_id);
      observationsCache.set(cacheKey, { observations, displayName, regionCode, type: 'notable', dateLabel, isHotspot });
    } catch (err) {
      await deleteMsg(bot, chatId, _st?.message_id);
      await bot.sendMessage(chatId, `❌ Could not fetch notable sightings for *${esc(displayName)}*.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔄 Try Again', callback_data: 'new_search' }, { text: '✅ Done', callback_data: 'done' }]] },
      });
      return;
    }
  }

  if (!observations || observations.length === 0) {
    const isToday = (dateFilter?.backDays === 1);
    const noDataHint = isToday
      ? ` No sightings logged yet for today — try *Yesterday* or *Last 3 Days*`
      : ' Try a longer date range or a different location.';
    await bot.sendMessage(chatId, `❌ No notable observations found for *${esc(displayName)}* in the selected time range.${noDataHint}`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🔄 Try Again', callback_data: 'new_search' }, { text: '✅ Done', callback_data: 'done' }]] },
    });
    return;
  }

  sheetsService.logBirdQuery({
      user: context.user, chat: context.chat,
      sessionId: birdSessionMap.get(chatId)?.sessionId || '',
      command: 'Notable Sightings', searchQuery: displayName, regionCode: isCoordN ? displayName : regionCode,
      totalSightings: observations.length,
      uniqueSpeciesCount: new Set(observations.map(o => o.speciesCode)).size,
      speciesList: [...new Set(observations.map(o => o.comName))].slice(0, 10).join(', '),
    }).catch(err => logger.warn('Sheets log failed', { error: err.message }));

  await sendPaginatedObservations(bot, chatId, observations, displayName, 'notable', page, null, regionCode, dateLabel);
}

// ── My Logs flow ──────────────────────────────────────────────────────────────

async function handleMyLogs(bot, chatId, user) {
  try {
    const loadMsg = await bot.sendMessage(chatId, '⏳ Loading your sightings logs…', { parse_mode: 'Markdown' });
    let sightings;
    try {
      sightings = await sheetsService.getPersonalBirdSightings(user);
    } finally {
      await bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
    }
    if (!Array.isArray(sightings) || sightings.length === 0) {
      await bot.sendMessage(chatId,
        '📓 *My Sightings Logs*\n\nNo personal logs found yet. Use ➕ Add My Sighting to add entries.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    observationsCache.set(`logs_${chatId}`, { sightings });
    await sendPaginatedLogs(bot, chatId, sightings, 0);
  } catch (err) {
    logger.warn('handleMyLogs failed', { error: err.message });
    await bot.sendMessage(chatId,
      '❌ Could not load My Logs. Please try again later.',
      { parse_mode: 'Markdown' }
    );
  }
}

// ── Nearby flow ───────────────────────────────────────────────────────────────

async function handleNearby(bot, chatId) {
  await bot.sendMessage(chatId,
    '📍 *Share your location to find nearby bird sightings!*\n\nAfter sharing, you can choose the search radius.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [[{ text: '📍 Share My Location', request_location: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
        input_field_placeholder: 'Tap the button below to share location',
      },
    }
  );
}

async function handleLocationMsg(bot, chatId, msg, context) {
  const { latitude, longitude } = msg.location;
  const mapsLink = `https://maps.google.com/?q=${latitude},${longitude}`;

  // Reverse-geocode to get country code for timezone resolution (non-blocking)
  let nearbyRegion = null;
  try { nearbyRegion = await reverseGeocodeCountry(latitude, longitude); } catch { /* ignore */ }

  userStates.set(chatId, { action: 'awaiting_nearby_distance', latitude, longitude, nearbyRegion, context: context || {} });
  await bot.sendMessage(chatId,
    `📍 Location received!\n\n*Coordinates:* [${latitude.toFixed(4)}, ${longitude.toFixed(4)}](${mapsLink})\n\n📏 *Choose search radius:*`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '500 m', callback_data: 'nearby_dist_0.5' }, { text: '1 km', callback_data: 'nearby_dist_1' }, { text: '2 km', callback_data: 'nearby_dist_2' }],
          [{ text: '5 km', callback_data: 'nearby_dist_5' }, { text: '10 km', callback_data: 'nearby_dist_10' }, { text: '25 km', callback_data: 'nearby_dist_25' }],
          [{ text: '🔄 Try Again', callback_data: 'new_search' }, { text: '✅ Done', callback_data: 'done' }],
        ],
        remove_keyboard: true,
      },
    }
  );
}

function fmtDist(dist) {
  return dist < 1 ? `${Math.round(dist * 1000)} m` : `${dist} km`;
}

async function showNearbyDateSelection(bot, chatId, latitude, longitude, dist) {
  const prev = userStates.get(chatId) || {};
  userStates.set(chatId, { ...prev, action: 'awaiting_nearby_date', latitude, longitude, dist });

  const regionCode = prev.nearbyRegion || null;
  const tz         = getTimezoneForRegion(regionCode);
  const tzAbbr     = getTzAbbr(tz);

  const message =
    `📏 *Radius:* ${fmtDist(dist)}\n\n` +
    `📅 *Select date range:* _(${tzAbbr})_`;

  const pfx = `nearby_date_`;
  const buttons = [
    [
      { text: '📅 Today',        callback_data: `${pfx}today` },
      { text: '📅 Yesterday',    callback_data: `${pfx}yesterday` },
    ],
    [
      { text: '📅 Last 3 Days',  callback_data: `${pfx}last_3_days` },
      { text: '📅 Last Week',    callback_data: `${pfx}last_week` },
    ],
    [
      { text: '📅 Last 14 Days', callback_data: `${pfx}last_14_days` },
      { text: '📅 Last Month',   callback_data: `${pfx}last_month` },
    ],
    [
      { text: '📆 Custom Date',  callback_data: `${pfx}custom` },
    ],
    [
      { text: '🔄 Try Again', callback_data: 'new_search' },
      { text: '✅ Done', callback_data: 'done' },
    ],
  ];

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function fetchNearbySightings(bot, chatId, latitude, longitude, dist, context, dateFilter) {
  context = context || {};
  const _st = await bot.sendMessage(chatId, `🔍 Searching for birds within *${fmtDist(dist)}*...`, { parse_mode: 'Markdown' });
  try {
    const backDays = (dateFilter && dateFilter.backDays) || 14;
    let observations = [], hotspots = [];
    try { observations = await ebird.getNearbyObservations(latitude, longitude, dist, backDays, 100) || []; } catch {}
    try { hotspots   = await ebird.getNearbyHotspots(latitude, longitude, dist) || []; } catch {}
    await deleteMsg(bot, chatId, _st?.message_id);

    const nearbyRegion = observations?.[0]?.countryCode || null;

    if (dateFilter && dateFilter.startDate && dateFilter.endDate) {
      observations = filterObservationsByDateRange(observations, dateFilter.startDate, dateFilter.endDate);
    }

    if (observations.length > 0) {
      const dateLabel   = (dateFilter && dateFilter.label) || '';
      const cacheKey    = `nearby_${chatId}`;
      const displayName = `Your Location (${fmtDist(dist)})`;
      observationsCache.set(cacheKey, { observations, displayName, regionCode: nearbyRegion, type: 'nearby', dateLabel });

      sheetsService.logBirdQuery({
          user: context.user, chat: context.chat,
          sessionId: birdSessionMap.get(chatId)?.sessionId || '',
          command: 'Nearby', searchQuery: `Nearby (${fmtDist(dist)})`, regionCode: nearbyRegion,
          totalSightings: observations.length,
          uniqueSpeciesCount: new Set(observations.map(o => o.speciesCode)).size,
          speciesList: [...new Set(observations.map(o => o.comName))].slice(0, 10).join(', '),
        }).catch(err => logger.warn('Sheets log failed', { error: err.message }));

      await sendPaginatedObservations(bot, chatId, observations, displayName, 'nearby', 0, null, nearbyRegion, dateLabel);
    } else {
      await bot.sendMessage(chatId,
        `❌ No bird sightings found within *${fmtDist(dist)}* of your location.\n\nTry a larger search radius.`,
        { parse_mode: 'Markdown' }
      );
    }

    if (Array.isArray(hotspots) && hotspots.length > 0) {
      let msg = '*🗺️ Nearby Birding Hotspots:*\n\n';
      hotspots.slice(0, 5).forEach((spot, i) => {
        msg += `${i + 1}. *${esc(spot.locName)}*\n`;
        if (spot.numSpeciesAllTime) msg += `   🐦 Species recorded: ${spot.numSpeciesAllTime}\n`;
        msg += '\n';
      });
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    logger.error('Nearby sightings error', { error: err.message });
    await deleteMsg(bot, chatId, _st?.message_id);
    await bot.sendMessage(chatId, '❌ Could not fetch nearby sightings. Please try again later.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Try Again', callback_data: 'new_search' }, { text: '✅ Done', callback_data: 'done' }],
        ],
      },
    });
  }
}

// ── Hotspots flow ─────────────────────────────────────────────────────────────

async function handleHotspots(bot, chatId) {
  userStates.set(chatId, { action: 'awaiting_region_hotspots' });
  const sentHotspots = await bot.sendMessage(chatId,
    '🗺️ *Enter a location to find birding hotspots:*\n\n' +
    'You can type any location worldwide:\n' +
    '• City or region: `Tokyo`, `Cape Town`, `Vancouver`\n' +
    '• Country: `Singapore`, `Malaysia`, `Australia`\n' +
    '• Specific place: `Botanic Gardens, Singapore`\n' +
    '• Region code: `SG`, `US-CA`, `AU-WA`\n\n' +
    '💡 Use hotspot names you find here to search sightings!',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Try Again', callback_data: 'new_search' }, { text: '✅ Done', callback_data: 'done' }],
        ],
      },
    }
  );
  const prevHotspots = userStates.get(chatId) || {};
  userStates.set(chatId, { ...prevHotspots, promptMsgId: sentHotspots?.message_id });
}

async function searchAndShowHotspots(bot, chatId, userInput) {
  const _st = await bot.sendMessage(chatId,
    `🔍 Finding birding hotspots in *${esc(userInput)}*...`,
    { parse_mode: 'Markdown' }
  );
  try {
    // Resolve to region code (may return COORD: for specific places)
    const regionCode = await resolveRegionCode(userInput);
    const isCoord = typeof regionCode === 'string' && regionCode.startsWith('COORD:');

    let hotspots;
    if (isCoord) {
      // Specific location → find nearby hotspots by coordinates
      const coordParts = regionCode.slice(6).split(',').map(Number);
      const [lat, lng] = coordParts;
      const dist = coordParts[2] || 25;
      hotspots = await ebird.getNearbyHotspots(lat, lng, dist);
    } else {
      // Region code → popular hotspots in that region
      hotspots = await ebird.getPopularHotspots(regionCode, 15);
    }
    await deleteMsg(bot, chatId, _st?.message_id);

    if (!Array.isArray(hotspots) || hotspots.length === 0) {
      await bot.sendMessage(chatId, `❌ No hotspots found for *${esc(userInput)}*.`, { parse_mode: 'Markdown' });
      return;
    }

    // Sort by species count (descending)
    hotspots.sort((a, b) => (b.numSpeciesAllTime || 0) - (a.numSpeciesAllTime || 0));

    const titleLabel = isCoord ? `Near ${esc(userInput)}` : `In ${esc(userInput)}`;
    let message = `*🗺️ Birding Hotspots ${titleLabel}*\n`;
    message += '━━━━━━━━━━━━━━━━━━━━\n';
    message += `_Sorted by number of species recorded_\n\n`;
    hotspots.slice(0, 10).forEach((spot, i) => {
      message += `${i + 1}. *${esc(spot.locName)}*\n`;
      if (spot.numSpeciesAllTime) message += `   🐦 ${spot.numSpeciesAllTime} species recorded\n`;
      message += '\n';
    });

    const buttons = hotspots.slice(0, 5).map(spot => [{
      text: `📍 ${spot.locName.substring(0, 35)}${spot.locName.length > 35 ? '...' : ''}`,
      callback_data: `hotspot_sightings_${spot.locId}`,
    }]);

    userStates.set(chatId, {
      action: 'hotspot_selection', hotspots: hotspots.slice(0, 5), type: 'sightings',
    });

    buttons.push([
      { text: '🔄 Try Again', callback_data: 'new_search' },
      { text: '✅ Done', callback_data: 'done' },
    ]);
    await bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons },
    });
  } catch (err) {
    await deleteMsg(bot, chatId, _st?.message_id);
    await bot.sendMessage(chatId, `❌ Could not fetch hotspots for *${esc(userInput)}*.`, { parse_mode: 'Markdown' });
  }
}

// ── Species flow ──────────────────────────────────────────────────────────────

async function handleSpecies(bot, chatId) {
  userStates.set(chatId, { action: 'awaiting_species_name' });
  const sentSpecies = await bot.sendMessage(chatId,
    `🦆 *Search by Species Name*\n\n` +
    `Enter the species name you want to find:\n\n` +
    `*Examples:*\n` +
    `• \`House Sparrow\`\n` +
    `• \`Common Myna\`\n` +
    `• \`Oriental Magpie-Robin\`\n` +
    `• \`American Robin\`\n\n` +
    `💡 Use the full species name as it appears in eBird.\n` +
    `After finding the species, you can narrow down by location.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Try Again', callback_data: 'new_search' }, { text: '✅ Done', callback_data: 'done' }],
        ],
      },
    }
  );
  const prevSpecies = userStates.get(chatId) || {};
  userStates.set(chatId, { ...prevSpecies, promptMsgId: sentSpecies?.message_id });
}

async function searchSpeciesGlobally(bot, chatId, speciesName) {
  const _st = await bot.sendMessage(chatId,
    `🔍 Searching for *${esc(speciesName)}* in eBird database...`,
    { parse_mode: 'Markdown' }
  );
  try {
    const matches = await ebird.searchSpeciesByName(speciesName);
    await deleteMsg(bot, chatId, _st?.message_id);

    if (!matches || matches.length === 0) {
      await bot.sendMessage(chatId,
        `❌ Species "*${esc(speciesName)}*" not found.\n\n💡 Try the exact name as it appears in eBird:\n• "House Sparrow"\n• "Common Myna"\n• "Oriental Magpie-Robin"`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const species = matches[0];
    userStates.set(chatId, {
      action: 'awaiting_species_location',
      species: { code: species.speciesCode, commonName: species.comName, scientificName: species.sciName },
    });

    let message = `✅ *Found: ${esc(species.comName)}*\n🔬 _${esc(species.sciName)}_\n📋 Species Code: \`${species.speciesCode}\`\n\n`;
    if (matches.length > 1) {
      message += '*Similar species:*\n';
      matches.slice(1, 5).forEach(m => { message += `• ${esc(m.comName)}\n`; });
      message += '\n';
    }
    message +=
      `📍 *Where would you like to search for ${esc(species.comName)}?*\n\n` +
      `*Examples:*\n` +
      `• \`Singapore\`\n` +
      `• \`Botanic Gardens, Singapore\`\n` +
      `• \`Central Park, New York\`\n` +
      `• \`California\`\n` +
      `• \`Malaysia\`\n\n` +
      `💡 You can enter a country, region, or specific location.`;
    const sentSpeciesLoc = await bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Try Again', callback_data: 'new_search' }, { text: '✅ Done', callback_data: 'done' }],
        ],
      },
    });
    const prevSpeciesLoc = userStates.get(chatId) || {};
    userStates.set(chatId, { ...prevSpeciesLoc, promptMsgId: sentSpeciesLoc?.message_id });
  } catch (err) {
    logger.error('Species search error', { error: err.message });
    await deleteMsg(bot, chatId, _st?.message_id);
    await bot.sendMessage(chatId, '❌ Error searching for species. Please try again.', { parse_mode: 'Markdown' });
  }
}

async function fetchSpeciesInLocation(bot, chatId, locationInput, speciesName, speciesCode, dateFilter, context, resolvedRegion) {
  speciesCode    = speciesCode    ?? null;
  dateFilter     = dateFilter     ?? null;
  context        = context        ?? {};
  resolvedRegion = resolvedRegion ?? null;

  const regionCode = resolvedRegion || await resolveRegionCode(locationInput);
  const isCoordS   = typeof regionCode === 'string' && regionCode.startsWith('COORD:');
  const backDays   = dateFilter?.backDays || 14;
  const dateLabel  = dateFilter?.label || 'Last 14 Days';
  const _st = await bot.sendMessage(chatId,
    `🔍 Searching for *${esc(speciesName)}* in *${esc(locationInput)}*\n📅 ${dateLabel}...`,
    { parse_mode: 'Markdown' }
  );
  try {
    let species, observations;
    if (speciesCode) {
      if (isCoordS) {
        const coordParts = regionCode.slice(6).split(',').map(Number);
        const [lat, lng] = coordParts;
        const dist = coordParts[2] || 25;
        observations = await ebird.getNearbySpeciesObservations(lat, lng, speciesCode, dist, backDays);
        species = { commonName: speciesName, code: speciesCode };
      } else {
        observations = await ebird.getSpeciesObservations(regionCode, speciesCode, backDays);
        species = { commonName: speciesName, code: speciesCode };
      }
    } else {
      if (isCoordS) {
        const coordParts = regionCode.slice(6).split(',').map(Number);
        const [lat, lng] = coordParts;
        const dist = coordParts[2] || 25;
        const matches = await ebird.searchSpeciesByName(speciesName, 10).catch(() => []);
        if (!matches || matches.length === 0) {
          await deleteMsg(bot, chatId, _st?.message_id);
          await bot.sendMessage(chatId, `❌ Species "*${esc(speciesName)}*" not found in eBird database.`, { parse_mode: 'Markdown' });
          return;
        }
        species = { commonName: matches[0].comName, code: matches[0].speciesCode, scientificName: matches[0].sciName };
        observations = await ebird.getNearbySpeciesObservations(lat, lng, species.code, dist, backDays);
      } else {
        const result = await ebird.getObservationsBySpeciesName(regionCode, speciesName, backDays);
        if (!result.species) {
          await deleteMsg(bot, chatId, _st?.message_id);
          await bot.sendMessage(chatId,
            `❌ Species "*${esc(speciesName)}*" not found in eBird database.`,
            { parse_mode: 'Markdown' }
          );
          return;
        }
        species      = result.species;
        observations = result.observations;
      }
    }

    if (dateFilter?.startDate && dateFilter?.endDate) {
      observations = filterObservationsByDateRange(observations, dateFilter.startDate, dateFilter.endDate);
    }

    if (!observations || observations.length === 0) {
      await deleteMsg(bot, chatId, _st?.message_id);
      await bot.sendMessage(chatId,
        `❌ No recent sightings of *${esc(species.commonName)}* in *${esc(locationInput)}*.\n\n💡 Try a broader location or different time period.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    await deleteMsg(bot, chatId, _st?.message_id);
    const cacheKey    = `species_${chatId}`;
    const displayName = `${species.commonName} in ${locationInput} (${dateLabel})`;
    observationsCache.set(cacheKey, { observations, displayName, regionCode, type: 'species', dateLabel });

    sheetsService.logBirdQuery({
      user: context.user, chat: context.chat,
      sessionId: birdSessionMap.get(chatId)?.sessionId || '',
      command: 'Species', searchQuery: `${species.commonName} in ${locationInput}`, regionCode: isCoordS ? locationInput : regionCode,
      totalSightings: observations.length, uniqueSpeciesCount: 1,
      speciesList: species.commonName,
    }).catch(err => logger.warn('Sheets log failed', { error: err.message }));

    await sendPaginatedObservations(bot, chatId, observations, displayName, 'species', 0, null, regionCode);
  } catch (err) {
    logger.error('Species location search error', { error: err.message });
    await deleteMsg(bot, chatId, _st?.message_id);
    await bot.sendMessage(chatId,
      `❌ Could not search for species in *${esc(locationInput)}*.\n\nPlease check the location name and try again.`,
      { parse_mode: 'Markdown' }
    );
  }
}

// ── Regions info ──────────────────────────────────────────────────────────────

async function handleRegions(bot, chatId) {
  await bot.sendMessage(chatId,
    `*🌍 Understanding Region Codes*\n\n` +
    `Region codes specify geographic areas for bird sightings.\n\n` +
    `*Format:*\n` +
    `• Country: \`XX\` \\(2-letter ISO code\\)\n` +
    `• State/Province: \`XX-YY\`\n` +
    `• County/District: \`XX-YY-ZZZ\`\n\n` +
    `*Examples:*\n\n` +
    `🇸🇬 *Singapore:* \`SG\`\n` +
    `🇲🇾 *Malaysia:* \`MY\`\n` +
    `🇯🇵 *Japan:* \`JP\`\n` +
    `🇬🇧 *UK:* \`GB\`\n\n` +
    `🇺🇸 *United States:*\n` +
    `• \`US\` — All of United States\n` +
    `• \`US-CA\` — California\n` +
    `• \`US-NY\` — New York\n` +
    `• \`US-FL\` — Florida\n` +
    `• \`US-TX\` — Texas\n\n` +
    `💡 *Tip:* You can just type the country name \\(e.g. "Singapore"\\) and the bot will convert it automatically\\!`,
    { parse_mode: 'Markdown' }
  );
}

module.exports.showDateSelection = showDateSelection;
module.exports.showSpeciesDateSelection = showSpeciesDateSelection;
module.exports.handleDateCallback = handleDateCallback;
module.exports.parseUserDate = parseUserDate;
module.exports.handleCustomDateInput = handleCustomDateInput;
module.exports.handleSightings = handleSightings;
module.exports.handlePlaceSearch = handlePlaceSearch;
module.exports.showHotspotSelection = showHotspotSelection;
module.exports.fetchAndSendSightings = fetchAndSendSightings;
module.exports.resendLastPrompt = resendLastPrompt;
module.exports.handleNotable = handleNotable;
module.exports.fetchAndSendNotable = fetchAndSendNotable;
module.exports.handleMyLogs = handleMyLogs;
module.exports.handleNearby = handleNearby;
module.exports.handleLocationMsg = handleLocationMsg;
module.exports.showNearbyDateSelection = showNearbyDateSelection;
module.exports.fetchNearbySightings = fetchNearbySightings;
module.exports.handleHotspots = handleHotspots;
module.exports.searchAndShowHotspots = searchAndShowHotspots;
module.exports.handleSpecies = handleSpecies;
module.exports.searchSpeciesGlobally = searchSpeciesGlobally;
module.exports.fetchSpeciesInLocation = fetchSpeciesInLocation;

