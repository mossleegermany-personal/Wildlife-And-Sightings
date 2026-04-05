'use strict';

/**
 * birdMenu/handler.js
 *
 * Self-contained leaf file that exports handleBirdCallback, clearSession,
 * and registerBirdMenu. It imports ONLY from sibling sub-files (state, flows,
 * pagination, ui, helpers, location, services, constants, liveUpdates) — never
 * from birdMenu/index.js — so it is completely immune to circular-require issues
 * on Azure where module evaluation order can differ from local.
 *
 * bot.js imports from here directly.
 */

const logger = require('../../../../src/utils/logger');
const { ebird } = require('./services');
const { ITEMS_PER_PAGE } = require('./constants');
const { esc } = require('./helpers');
const { toRegionCode, resolveRegionCode } = require('./location');
const { startLiveUpdate, stopLiveUpdate, getLiveUpdate } = require('./liveUpdates');
const { userStates, observationsCache, lastPrompts } = require('./state');
const {
  deleteMsg,
  sendPaginatedObservations, sendPaginatedLogs,
  sendSummaryMessage, sendForwardableMessage,
} = require('./pagination');
const { sendSightingsCategoryMenu } = require('./ui');
const { MAIN_MENU } = require('../../menu/mainMenu');
const {
  showDateSelection, showSpeciesDateSelection,
  handleDateCallback, handleCustomDateInput,
  handleSightings, handlePlaceSearch,
  fetchAndSendSightings,
  handleNotable,
  fetchAndSendNotable,
  handleMyLogs,
  handleNearby, handleLocationMsg, showNearbyDateSelection, fetchNearbySightings,
  handleHotspots, searchAndShowHotspots,
  handleSpecies, searchSpeciesGlobally,
} = require('./flows');

// ── Lazy-load identify to break the identify → mainMenu → birdMenu cycle ─────
let _identify = null;
function getIdentify() {
  if (!_identify) {
    try {
      _identify = require('../identify');
    } catch (err) {
      logger.warn('[birdMenu/handler] Failed to load identify module', { error: err.message });
      return { clearPending: () => {} };
    }
  }
  return _identify;
}

// ── clearSession ──────────────────────────────────────────────────────────────

function clearSession(chatId) {
  userStates.delete(chatId);
  lastPrompts.delete(chatId);
  ['sightings', 'notable', 'nearby', 'species'].forEach(t =>
    observationsCache.delete(`${t}_${chatId}`)
  );
}

// ── handleBirdCallback ────────────────────────────────────────────────────────

function handleBirdCallback(bot, query) {
  if (!bot) {
    logger.error('[birdMenu] handleBirdCallback missing bot instance', { query: query?.data });
    return;
  }
  if (!query || !query.data) {
    logger.error('[birdMenu] handleBirdCallback missing query or data');
    return;
  }
  logger.info('[birdMenu] handleBirdCallback called', { cbData: query.data });
  (async () => {
    try {
      const cbData  = query.data || '';
      const chatId  = query.message?.chat?.id;
      const user    = query.from;
      const chat    = query.message?.chat;
      const context = { user, chat };

      if (!chatId) {
        logger.warn('[birdMenu] callback_query missing message/chat', { cbData });
        return;
      }

      logger.info('[birdMenu] callback_query received', { cbData, chatId });

      const actionHandlers = {
        bird_sightings: async () => {
          bot.answerCallbackQuery(query.id);
          getIdentify().clearPending?.(user?.id);
          clearSession(chatId);
          try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
          return handleSightings(bot, chatId, context);
        },
        bird_notable: async () => {
          bot.answerCallbackQuery(query.id);
          getIdentify().clearPending?.(user?.id);
          clearSession(chatId);
          try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
          return handleNotable(bot, chatId, context);
        },
        bird_nearby: async () => {
          bot.answerCallbackQuery(query.id);
          getIdentify().clearPending?.(user?.id);
          clearSession(chatId);
          try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
          return handleNearby(bot, chatId);
        },
        bird_hotspot: async () => {
          bot.answerCallbackQuery(query.id);
          getIdentify().clearPending?.(user?.id);
          clearSession(chatId);
          try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
          return handleHotspots(bot, chatId);
        },
        bird_species: async () => {
          bot.answerCallbackQuery(query.id);
          getIdentify().clearPending?.(user?.id);
          clearSession(chatId);
          try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
          return handleSpecies(bot, chatId);
        },
        bird_back_sightings: async () => {
          bot.answerCallbackQuery(query.id);
          clearSession(chatId);
          try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
          return sendSightingsCategoryMenu(bot, chatId);
        },
        bird_back_main: async () => {
          bot.answerCallbackQuery(query.id);
          clearSession(chatId);
          try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
          return sendSightingsCategoryMenu(bot, chatId);
        },
        bird_logs: async () => {
          bot.answerCallbackQuery(query.id);
          clearSession(chatId);
          try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
          return handleMyLogs(bot, chatId, user);
        },
        done: async () => {
          bot.answerCallbackQuery(query.id);
          clearSession(chatId);
          userStates.delete(chatId);
          try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
          return bot.sendMessage(chatId, '📋 *Main Menu*', { parse_mode: 'Markdown', ...MAIN_MENU });
        },
      };

      if (actionHandlers[cbData]) {
        return actionHandlers[cbData]();
      }

      // Backwards compatibility for old payload
      if (cbData === 'ebird_sightings') {
        bot.answerCallbackQuery(query.id);
        getIdentify().clearPending?.(user?.id);
        clearSession(chatId);
        try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
        return handleSightings(bot, chatId, context);
      }

      // ── My Logs pagination ──────────────────────────────────────────────
      if (cbData.startsWith('logs_page_')) {
        bot.answerCallbackQuery(query.id);
        const page     = parseInt(cbData.replace('logs_page_', ''), 10);
        const cacheKey = `logs_${chatId}`;
        const cached   = observationsCache.get(cacheKey);
        if (cached) {
          return sendPaginatedLogs(bot, chatId, cached.sightings, page, query.message.message_id);
        }
        return bot.sendMessage(chatId, '❌ No cached logs. Please open My Logs again.');
      }

      if (cbData.startsWith('date_')) {
        bot.answerCallbackQuery(query.id);
        try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
        return handleDateCallback(bot, chatId, cbData);
      }

      // ── Hotspot button ──────────────────────────────────────────────────
      if (cbData.startsWith('hotspot_')) {
        bot.answerCallbackQuery(query.id);
        try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
        const parts = cbData.split('_');
        const type  = parts[1];
        const locId = parts.slice(2).join('_');
        const state = userStates.get(chatId);
        let locName = locId;
        if (state?.hotspots) {
          const found = state.hotspots.find(h => h.locId === locId);
          if (found) locName = found.locName;
        }
        const stateCtx = state?.context || context;
        const prev = userStates.get(chatId) || {};
        userStates.set(chatId, { ...prev, context: stateCtx, species: state?.species });
        if (type === 'species' && state?.species) {
          return showSpeciesDateSelection(bot, chatId, locName, state.species, { regionCode: locId, isHotspot: true });
        }
        // Sightings/notable: load results immediately with default date
        const { getDatePreset } = require('./helpers');
        if (type === 'sightings') {
          return fetchAndSendSightings(bot, chatId, locId, locName, 0, getDatePreset('last_3_days', locId), true, stateCtx);
        }
        if (type === 'notable') {
          return fetchAndSendNotable(bot, chatId, locId, locName, 0, getDatePreset('last_3_days', locId), true, stateCtx);
        }
        return showDateSelection(bot, chatId, locId, locName, type, { isHotspot: true });
      }

      // ── Nearby distance selection ───────────────────────────────────────
      if (cbData.startsWith('nearby_dist_')) {
        bot.answerCallbackQuery(query.id);
        try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
        const dist  = parseFloat(cbData.replace('nearby_dist_', ''));
        const state = userStates.get(chatId);
        if (state && state.action === 'awaiting_nearby_distance') {
          return showNearbyDateSelection(bot, chatId, state.latitude, state.longitude, dist);
        }
        return bot.sendMessage(chatId, '⚠️ Please share your location again using the Nearby button.');
      }

      // ── Nearby date selection ───────────────────────────────────────────
      if (cbData.startsWith('nearby_date_')) {
        bot.answerCallbackQuery(query.id);
        try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
        const state = userStates.get(chatId);
        if (!state || state.action !== 'awaiting_nearby_date') {
          return bot.sendMessage(chatId, '⚠️ Please share your location again using the Nearby button.');
        }
        const preset = cbData.replace('nearby_date_', '');
        if (preset === 'custom') {
          userStates.set(chatId, { ...state, action: 'awaiting_nearby_custom_date' });
          return bot.sendMessage(chatId,
            '📆 *Enter a custom date:*\n\n• Single date: `DD/MM/YYYY`\n• Date range: `DD/MM/YYYY to DD/MM/YYYY`',
            { parse_mode: 'Markdown' }
          );
        }
        const { getDatePreset } = require('./helpers');
        const dateFilter = getDatePreset(preset, state.nearbyRegion);
        userStates.delete(chatId);
        return fetchNearbySightings(bot, chatId, state.latitude, state.longitude, state.dist, state.context || context, dateFilter);
      }

      // ── Pagination ──────────────────────────────────────────────────────
      if (cbData.startsWith('page_') && cbData !== 'page_info') {
        bot.answerCallbackQuery(query.id);
        const parts    = cbData.split('_');
        const type     = parts[1];
        const page     = parseInt(parts[2], 10);
        const cacheKey = `${type}_${chatId}`;
        const cached   = observationsCache.get(cacheKey);
        if (cached) {
          return sendPaginatedObservations(bot, chatId, cached.observations, cached.displayName, type, page, query.message.message_id, cached.regionCode, cached.dateLabel || '');
        }
        return bot.sendMessage(chatId, '❌ No cached results. Please perform a new search.');
      }
      if (cbData === 'page_info') {
        bot.answerCallbackQuery(query.id, { text: 'Page information' });
        return;
      }

      // ── Jump to page ────────────────────────────────────────────────────
      if (cbData.startsWith('jump_')) {
        bot.answerCallbackQuery(query.id);
        try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
        const type     = cbData.split('_')[1];
        const cacheKey = `${type}_${chatId}`;
        const cached   = observationsCache.get(cacheKey);
        if (cached) {
          const totalPages = Math.ceil(cached.observations.length / ITEMS_PER_PAGE);
          userStates.set(chatId, { action: 'awaiting_jump_page', type, totalPages, messageId: query.message.message_id });
          return bot.sendMessage(chatId, `🔢 Enter a page number (1-${totalPages}):`);
        }
        return;
      }

      // ── Summary ─────────────────────────────────────────────────────────
      if (cbData.startsWith('specsummary_')) {
        bot.answerCallbackQuery(query.id);
        const type     = cbData.replace('specsummary_', '');
        const cacheKey = `${type}_${chatId}`;
        const cached   = observationsCache.get(cacheKey);
        if (cached) {
          const _s = await bot.sendMessage(chatId, '📊 *Generating species summary...*', { parse_mode: 'Markdown' });
          await sendSummaryMessage(bot, chatId, cached.observations, cached.displayName, type, cached.regionCode);
          await deleteMsg(bot, chatId, _s?.message_id);
        } else {
          await bot.sendMessage(chatId, '❌ No cached results. Please perform a new search.');
        }
        return;
      }

      // ── Share ────────────────────────────────────────────────────────────
      if (cbData.startsWith('share_')) {
        bot.answerCallbackQuery(query.id);
        const type     = cbData.replace('share_', '');
        const cacheKey = `${type}_${chatId}`;
        const cached   = observationsCache.get(cacheKey);
        if (cached) {
          await bot.sendMessage(chatId,
            '📤 *Share Bird Sightings*\n\nHow would you like to share?\n\nOnce I send the list, you can:\n• Long-press the message → Forward\n• Or tap the forward icon ↗️',
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📋 Generate Shareable List', callback_data: `generate_share_${type}` }],
                  [{ text: '❌ Cancel', callback_data: 'cancel_share' }],
                ],
              },
            }
          );
        } else {
          await bot.sendMessage(chatId, '❌ Unable to share. Please perform a new search.');
        }
        return;
      }

      if (cbData.startsWith('generate_share_')) {
        bot.answerCallbackQuery(query.id);
        const type     = cbData.replace('generate_share_', '');
        const cacheKey = `${type}_${chatId}`;
        const cached   = observationsCache.get(cacheKey);
        if (cached) {
          const _s = await bot.sendMessage(chatId, '📤 *Generating shareable list...*', { parse_mode: 'Markdown' });
          await sendForwardableMessage(bot, chatId, cached.observations, cached.displayName, type, cached.regionCode);
          await deleteMsg(bot, chatId, _s?.message_id);
        } else {
          await bot.sendMessage(chatId, '❌ Unable to share. Please perform a new search.');
        }
        return;
      }

      if (cbData === 'cancel_share') {
        bot.answerCallbackQuery(query.id);
        try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
        await bot.sendMessage(chatId, '✅ Share cancelled.');
        return;
      }

      // ── New search ───────────────────────────────────────────────────────
      if (cbData === 'new_search') {
        bot.answerCallbackQuery(query.id);
        clearSession(chatId);
        try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
        return bot.sendMessage(chatId, '*eBird Search*\n\nChoose a search type:', {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔍 Sightings', callback_data: 'bird_sightings' },
                { text: '⭐ Notable',   callback_data: 'bird_notable'    },
              ],
              [
                { text: '📍 Nearby',   callback_data: 'bird_nearby'     },
                { text: '🦆 Species',  callback_data: 'bird_species'    },
              ],
              [
                { text: '🔔 Live Updates', callback_data: 'bird_live_updates' },
              ],
              [
                { text: '⬅️ Back',    callback_data: 'bird_back_main'  },
                { text: '✅ Done',    callback_data: 'done'            },
              ],
            ],
          },
        });
      }

      // ── Change Date (from results view) ──────────────────────────────────
      if (cbData.startsWith('change_date_')) {
        bot.answerCallbackQuery(query.id);
        try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
        const type = cbData.replace('change_date_', '');
        const cacheKey = type === 'nearby' ? `nearby_${chatId}` : `${type}_${chatId}`;
        const cached = observationsCache.get(cacheKey);
        if (cached) {
          if (type === 'nearby') {
            // Nearby uses its own date selection UI
            const state = userStates.get(chatId) || {};
            const latitude  = state.latitude  || cached.latitude;
            const longitude = state.longitude || cached.longitude;
            const dist      = state.dist      || cached.dist;
            if (latitude != null && longitude != null && dist != null) {
              return showNearbyDateSelection(bot, chatId, latitude, longitude, dist);
            }
            return bot.sendMessage(chatId, '⚠️ Location data expired. Please use 📍 Nearby again.');
          }
          if (type === 'species') {
            const state = userStates.get(chatId) || {};
            const species = state.species || cached.species;
            if (species) {
              return showSpeciesDateSelection(bot, chatId, cached.displayName, species, { regionCode: cached.regionCode, isHotspot: cached.isHotspot });
            }
            return bot.sendMessage(chatId, '⚠️ Species data expired. Please search again.');
          }
          return showDateSelection(bot, chatId, cached.regionCode, cached.displayName, type, { isHotspot: cached.isHotspot });
        }
        return bot.sendMessage(chatId, '❌ Session expired. Please start a new search.', {
          reply_markup: { inline_keyboard: [[{ text: '🔄 New Search', callback_data: 'new_search' }]] },
        });
      }

      // ── Live Updates ──────────────────────────────────────────────────────
      if (cbData === 'bird_live_updates') {
        bot.answerCallbackQuery(query.id);
        try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
        const sub = getLiveUpdate(chatId);
        if (sub) {
          const typeLabel = sub.type === 'notable' ? '⭐ Notable'
            : sub.type === 'species' ? `🦆 ${sub.species?.commonName}`
            : '🔍 Sightings';
          return bot.sendMessage(chatId,
            `🔔 *Live Updates Active*\n\n📡 Tracking: *${esc(typeLabel)}*\n📍 Location: *${esc(sub.locationInput)}*\n\nPolling every 30 seconds for new sightings.`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔕 Stop', callback_data: 'live_stop' }, { text: '🔄 Change', callback_data: 'live_setup' }],
                  [{ text: '⬅️ Back', callback_data: 'menu_ebird' }],
                ],
              },
            }
          );
        }
        return bot.sendMessage(chatId,
          '🔔 *Live Updates*\n\nGet notified when new bird sightings are posted to eBird.\n\n' +
          '• 🔍 *Sightings* — any recent observations in a location\n' +
          '• ⭐ *Notable* — rare or unusual birds only\n' +
          '• 🦆 *Species* — a specific species in a location\n\n' +
          'What would you like to track?',
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔍 Sightings', callback_data: 'live_type_sightings' }, { text: '⭐ Notable', callback_data: 'live_type_notable' }],
                [{ text: '🦆 Species', callback_data: 'live_type_species' }],
                [{ text: '⬅️ Back', callback_data: 'menu_ebird' }],
              ],
            },
          }
        );
      }

      if (cbData === 'live_setup') {
        bot.answerCallbackQuery(query.id);
        try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
        return bot.sendMessage(chatId,
          '🔔 *Live Updates — Choose Type*\n\nWhat would you like to track?',
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔍 Sightings', callback_data: 'live_type_sightings' }, { text: '⭐ Notable', callback_data: 'live_type_notable' }],
                [{ text: '🦆 Species', callback_data: 'live_type_species' }],
                [{ text: '⬅️ Back to eBird', callback_data: 'menu_ebird' }],
              ],
            },
          }
        );
      }

      if (cbData === 'live_type_sightings' || cbData === 'live_type_notable') {
        bot.answerCallbackQuery(query.id);
        try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
        const liveType = cbData === 'live_type_sightings' ? 'sightings' : 'notable';
        userStates.set(chatId, { action: 'awaiting_live_location', liveType });
        const typeWord = liveType === 'notable' ? '⭐ notable' : '🔍';
        return bot.sendMessage(chatId,
          `📍 *Enter a location to track ${typeWord} sightings:*\n\nExamples: \`Singapore\`, \`Botanic Gardens, Singapore\``,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '🔄 Try Again', callback_data: 'menu_ebird' }, { text: '✅ Done', callback_data: 'done' }]],
            },
          }
        );
      }

      if (cbData === 'live_type_species') {
        bot.answerCallbackQuery(query.id);
        try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
        userStates.set(chatId, { action: 'awaiting_live_species' });
        return bot.sendMessage(chatId,
          `🦆 *Enter species and location:*\n\nFormat: \`Species Name, Location\`\n\nExamples:\n• \`House Sparrow, Singapore\`\n• \`Oriental Magpie-Robin, Botanic Gardens, Singapore\``,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '🔄 Try Again', callback_data: 'menu_ebird' }, { text: '✅ Done', callback_data: 'done' }]],
            },
          }
        );
      }

      if (cbData === 'live_stop') {
        bot.answerCallbackQuery(query.id);
        try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
        stopLiveUpdate(chatId);
        return bot.sendMessage(chatId,
          '🔕 *Live Updates stopped.*',
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔔 Start Again', callback_data: 'bird_live_updates' }, { text: '⬅️ Back to eBird', callback_data: 'menu_ebird' }],
                [{ text: '✅ Done', callback_data: 'done' }],
              ],
            },
          }
        );
      }

      // ── Done (standalone fallback) ───────────────────────────────────────
      if (cbData === 'done') {
        bot.answerCallbackQuery(query.id);
        userStates.delete(chatId);
        clearSession(chatId);
        try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
        await bot.sendMessage(chatId, '📋 *Main Menu*', { parse_mode: 'Markdown', ...MAIN_MENU });
        return;
      }

    } catch (err) {
      logger.error('[birdMenu] Unhandled error in callback_query handler', { cbData: query?.data, error: err.message, stack: err.stack });
    }
  })().catch(err => {
    logger.error('[birdMenu] Unhandled error in callback_query handler (outer)', { cbData: query?.data, error: err?.message, stack: err?.stack });
  });
}

// ── registerBirdMenu ──────────────────────────────────────────────────────────

function registerBirdMenu(bot, addSightingSessions) {
  addSightingSessions = addSightingSessions ?? null;
  logger.info('[birdMenu] registerBirdMenu called');

  bot.on('message', (msg) => {
    (async () => {
      try {
        const chatId = msg.chat.id;

        // addSighting has priority
        if (addSightingSessions && addSightingSessions.has(chatId)) return;

        // Handle direct GPS location share (Nearby flow)
        if (msg.location) {
          logger.info('[birdMenu] message location received', { chatId });
          return handleLocationMsg(bot, chatId, msg, { user: msg.from, chat: msg.chat });
        }

        const state = userStates.get(chatId);
        const text = (msg.text || '').trim();

        if (!text) return;

        // Ignore all bot commands — let their own handlers deal with them
        if (text.startsWith('/')) return;

        // If identify.js is waiting for a location reply from this user, don't intercept it
        if (getIdentify().hasPending?.(msg.from?.id)) return;

        if (!state) {
          logger.info('[birdMenu] universal fallback text location', { chatId, text });
          userStates.set(chatId, { action: 'awaiting_region_sightings', context: { user: msg.from, chat: msg.chat } });
          return handlePlaceSearch(bot, chatId, text, 'sightings', { user: msg.from, chat: msg.chat });
        }

        if (state.action === 'awaiting_region_sightings' || state.action === 'awaiting_region_notable' || state.action === 'awaiting_species_location') {
          logger.info('[birdMenu] state-driven text location input', { chatId, state: state.action, text });
        }

        const action = state.action;
        const context = state.context || { user: msg.from, chat: msg.chat };

        if (action === 'awaiting_region_sightings') {
          userStates.delete(chatId);
          const cleaned = text.trim();
          const isCode = /^[A-Z]{1,3}(-[A-Z0-9]{1,4}){0,2}$/i.test(cleaned) && cleaned.length <= 10;
          const quick  = toRegionCode(text);
          const isKnown = isCode || quick !== cleaned.toUpperCase();
          if (!text.includes(',') && isKnown) {
            userStates.set(chatId, { context });
            await showDateSelection(bot, chatId, isCode ? cleaned.toUpperCase() : quick, text, 'sightings');
          } else {
            await handlePlaceSearch(bot, chatId, text, 'sightings', context);
          }
          return;
        }

        if (!action && text) {
          userStates.set(chatId, { action: 'awaiting_region_sightings', context });
          await handlePlaceSearch(bot, chatId, text, 'sightings', context);
          return;
        }

        if (action === 'awaiting_region_notable') {
          userStates.delete(chatId);
          const cleaned = text.trim();
          const isCode = /^[A-Z]{1,3}(-[A-Z0-9]{1,4}){0,2}$/i.test(cleaned) && cleaned.length <= 10;
          const quick  = toRegionCode(text);
          const isKnown = isCode || quick !== cleaned.toUpperCase();
          if (!text.includes(',') && isKnown) {
            userStates.set(chatId, { context });
            await showDateSelection(bot, chatId, isCode ? cleaned.toUpperCase() : quick, text, 'notable');
          } else {
            await handlePlaceSearch(bot, chatId, text, 'notable', context);
          }
          return;
        }

        if (action === 'awaiting_region_hotspots') {
          userStates.delete(chatId);
          await searchAndShowHotspots(bot, chatId, text);
          return;
        }

        if (action === 'awaiting_species_name') {
          if (text.includes(',')) {
            const parts    = text.split(',').map(p => p.trim());
            const locInput = parts[0];
            const sppInput = parts.slice(1).join(',').trim();
            userStates.delete(chatId);
            if (!sppInput || !locInput) {
              await bot.sendMessage(chatId,
                '❌ Please provide both a location and species name.\n\n*Format:* `location, species name`\n*Example:* `Singapore, House Sparrow`',
                { parse_mode: 'Markdown' }
              );
              return;
            }
            const matches = await ebird.searchSpeciesByName(sppInput).catch(() => []);
            if (!matches || matches.length === 0) {
              await bot.sendMessage(chatId,
                `❌ Species "*${esc(sppInput)}*" not found.\n\n💡 Try the exact name as it appears in eBird.`,
                { parse_mode: 'Markdown' }
              );
              return;
            }
            const sp = matches[0];
            const spObj = { code: sp.speciesCode, commonName: sp.comName, scientificName: sp.sciName };
            userStates.set(chatId, { context });
            await handlePlaceSearch(bot, chatId, locInput, 'species', context, spObj);
          } else {
            userStates.delete(chatId);
            await searchSpeciesGlobally(bot, chatId, text);
          }
          return;
        }

        if (action === 'awaiting_species_location') {
          userStates.delete(chatId);
          userStates.set(chatId, { context });
          await handlePlaceSearch(bot, chatId, text, 'species', context, state.species);
          return;
        }

        if (action === 'awaiting_jump_page') {
          userStates.delete(chatId);
          const pageNum = parseInt(text, 10);
          if (isNaN(pageNum) || pageNum < 1 || pageNum > state.totalPages) {
            await bot.sendMessage(chatId, `❌ Invalid page number. Enter a number between 1 and ${state.totalPages}.`);
            return;
          }
          const cacheKey = `${state.type}_${chatId}`;
          const cached   = observationsCache.get(cacheKey);
          if (cached) {
            await sendPaginatedObservations(bot, chatId, cached.observations, cached.displayName, state.type, pageNum - 1, null, cached.regionCode, cached.dateLabel || '');
          }
          return;
        }

        if (action === 'awaiting_custom_date') {
          await handleCustomDateInput(bot, chatId, text, state);
          return;
        }

        if (action === 'awaiting_nearby_custom_date') {
          await handleCustomDateInput(bot, chatId, text, { ...state, type: 'nearby', regionCode: 'WORLD' });
          return;
        }

        // ── Live Update: location input (sightings / notable) ──────────────
        if (action === 'awaiting_live_location') {
          userStates.delete(chatId);
          const { liveType } = state;
          const _st = await bot.sendMessage(chatId, `🔍 Setting up live updates for *${esc(text)}*...`, { parse_mode: 'Markdown' });
          try {
            const regionCode = await resolveRegionCode(text);
            await startLiveUpdate(bot, chatId, liveType, text, regionCode, null);
            await deleteMsg(bot, chatId, _st?.message_id);
            const typeLabel = liveType === 'notable' ? '⭐ Notable' : '🔍 Sightings';
            await bot.sendMessage(chatId,
              `✅ *Live Updates Active!*\n\n📡 Tracking: *${typeLabel}*\n📍 Location: *${esc(text)}*\n\nYou'll be notified of new sightings every 10 seconds.`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🔕 Stop', callback_data: 'live_stop' }, { text: '🔄 Change', callback_data: 'live_setup' }],
                    [{ text: '⬅️ Back to eBird', callback_data: 'menu_ebird' }, { text: '✅ Done', callback_data: 'done' }],
                  ],
                },
              }
            );
          } catch (err) {
            await deleteMsg(bot, chatId, _st?.message_id);
            await bot.sendMessage(chatId, `❌ Could not set up live updates for *${esc(text)}*. Please try again.`, { parse_mode: 'Markdown' });
          }
          return;
        }

        // ── Live Update: species + location input ──────────────────────────
        if (action === 'awaiting_live_species') {
          const commaIdx = text.indexOf(',');
          if (commaIdx === -1) {
            await bot.sendMessage(chatId,
              '❌ Please use the format: `Species Name, Location`\nExample: `House Sparrow, Singapore`',
              { parse_mode: 'Markdown' }
            );
            return;
          }
          userStates.delete(chatId);
          const speciesInput  = text.slice(0, commaIdx).trim();
          const locationInput = text.slice(commaIdx + 1).trim();
          const _st = await bot.sendMessage(chatId,
            `🔍 Setting up live updates for *${esc(speciesInput)}* in *${esc(locationInput)}*...`,
            { parse_mode: 'Markdown' }
          );
          try {
            const matches = await ebird.searchSpeciesByName(speciesInput).catch(() => []);
            if (!matches || matches.length === 0) {
              await deleteMsg(bot, chatId, _st?.message_id);
              await bot.sendMessage(chatId,
                `❌ Species "*${esc(speciesInput)}*" not found.\n\n💡 Try the exact name as it appears in eBird.`,
                { parse_mode: 'Markdown' }
              );
              userStates.set(chatId, { action: 'awaiting_live_species' });
              return;
            }
            const sp       = matches[0];
            const species  = { code: sp.speciesCode, commonName: sp.comName, scientificName: sp.sciName };
            const regionCode = await resolveRegionCode(locationInput);
            await startLiveUpdate(bot, chatId, 'species', locationInput, regionCode, species);
            await deleteMsg(bot, chatId, _st?.message_id);
            await bot.sendMessage(chatId,
              `✅ *Live Updates Active!*\n\n📡 Tracking: *🦆 ${esc(sp.comName)}*\n📍 Location: *${esc(locationInput)}*\n\nYou'll be notified of new sightings every 10 seconds.`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🔕 Stop', callback_data: 'live_stop' }, { text: '🔄 Change', callback_data: 'live_setup' }],
                    [{ text: '⬅️ Back to eBird', callback_data: 'menu_ebird' }, { text: '✅ Done', callback_data: 'done' }],
                  ],
                },
              }
            );
          } catch (err) {
            await deleteMsg(bot, chatId, _st?.message_id);
            await bot.sendMessage(chatId, '❌ Could not set up live updates. Please try again.', { parse_mode: 'Markdown' });
          }
          return;
        }

      } catch (err) {
        logger.error('[birdMenu] Unhandled error in message handler', { action: userStates.get(msg?.chat?.id)?.action, error: err.message });
      }
    })().catch(err => {
      logger.error('[birdMenu] Unhandled error in message handler (outer)', { error: err?.message, stack: err?.stack });
    });
  });
}

module.exports = { handleBirdCallback, clearSession, registerBirdMenu };
