'use strict';

/**
 * Bird Menu — thin coordinator.
 *
 * Flows are implemented in birdMenuFlows.js.
 * Pagination / formatting lives in birdMenuPagination.js.
 * Pure helpers are in birdMenuHelpers.js.
 * Location resolution is in birdMenuLocation.js.
 * Shared state (Maps) is in birdMenuState.js.
 * Service singletons are in birdMenuServices.js.
 * Constants are in birdMenuConstants.js.
 */

const logger                 = require('../../../../src/utils/logger');
const { ebird, sheetsService } = require('./services');
const { ITEMS_PER_PAGE }     = require('./constants');
const { esc }                = require('./helpers');
const { toRegionCode }       = require('./location');
const { resolveRegionCode }  = require('./location');
const { startLiveUpdate, stopLiveUpdate, getLiveUpdate } = require('./liveUpdates');

const {
  userStates, observationsCache, lastPrompts, birdSessionMap,
} = require('./state');

const {
  deleteMsg,
  sendPaginatedObservations, sendPaginatedLogs,
  sendSummaryMessage, sendForwardableMessage,
} = require('./pagination');

const {
  showDateSelection, showSpeciesDateSelection,
  handleDateCallback, handleCustomDateInput,
  handleSightings, handlePlaceSearch, showHotspotSelection, fetchAndSendSightings, resendLastPrompt,
  handleNotable, fetchAndSendNotable,
  handleMyLogs,
  handleNearby, handleLocationMsg, showNearbyDateSelection, fetchNearbySightings,
  handleHotspots, searchAndShowHotspots,
  handleSpecies, searchSpeciesGlobally, fetchSpeciesInLocation,

} = require('./flows');

// Lazy-load identify to break the mainMenu → birdMenu → identify → mainMenu cycle
let _identify = null;
function getIdentify() {
  if (!_identify) _identify = require('../identify');
  return _identify;
}

// ── Category menu ─────────────────────────────────────────────────────────────

const SIGHTINGS_CATEGORY_MENU = {
  parse_mode: 'Markdown',
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🐦 eBird',   callback_data: 'bird_sightings' },
        { text: '📓 My Logs', callback_data: 'bird_logs'      },
      ],
      [
        { text: '✅ Done', callback_data: 'done' },
      ],
    ],
  },
};


// ── clearSession ──────────────────────────────────────────────────────────────

function clearSession(chatId) {
  userStates.delete(chatId);
  lastPrompts.delete(chatId);
  ['sightings', 'notable', 'nearby', 'species'].forEach(t =>
    observationsCache.delete(`${t}_${chatId}`)
  );
  // Note: birdSessionMap is intentionally NOT cleared here — session spans the full interaction
}

// ── Bird Sightings session helpers ────────────────────────────────────────────

async function ensureActiveBirdSession(chat, user) {
  const chatId    = chat?.id;
  const chatType  = chat?.type || 'private';
  const chatTitle = chat?.title || null;
  const sender    = (user?.username ? `@${user.username}` : [user?.first_name, user?.last_name].filter(Boolean).join(' '))
    || 'Unknown';

  if (birdSessionMap.has(chatId)) return birdSessionMap.get(chatId);

  try {
    const latest = await sheetsService.getLatestSessionStatus({
      subBot: 'Bird Sightings',
      chatId,
      sender,
      chatType,
    });

    if (latest && String(latest.status || '').toLowerCase() === 'active') {
      const session = { sn: latest.sn, sessionId: latest.sessionId || '' };
      birdSessionMap.set(chatId, session);
      return session;
    }

    const started = await sheetsService.logSessionStart({
      subBot: 'Bird Sightings',
      chatId,
      chatTitle,
      user,
      chatType,
      startTime: new Date(),
    });
    const session = { sn: started?.sn || null, sessionId: started?.sessionId || '' };
    birdSessionMap.set(chatId, session);
    return session;
  } catch (err) {
    logger.warn('[birdMenu] ensureActiveBirdSession failed', { error: err.message });
    return { sn: null, sessionId: '' };
  }
}

function endBirdSession(chatId) {
  const session = birdSessionMap.get(chatId);
  birdSessionMap.delete(chatId);
  if (session?.sn != null) {
    sheetsService.updateSessionEnd(session.sn, new Date(), 'Ended')
      .catch(err => logger.warn('[birdMenu] Failed to end Bird Sightings session', { error: err.message }));
  }
}

// ── registerBirdMenu ──────────────────────────────────────────────────────────

function registerBirdMenu(bot, addSightingSessions) {
  addSightingSessions = addSightingSessions ?? null;

  // ── Callback query handler ────────────────────────────────────────────────
  bot.on('callback_query', async (query) => {
    const cbData  = query.data || '';
    const chatId  = query.message.chat.id;
    const user    = query.from;
    const chat    = query.message.chat;
    const context = { user, chat };

    // ── Category navigation ───────────────────────────────────────────────
    if (cbData === 'bird_sightings') {
      bot.answerCallbackQuery(query.id);
      getIdentify().clearPending?.(user?.id);
      clearSession(chatId);
      ensureActiveBirdSession(chat, user).catch(err => logger.warn('[birdMenu] session init failed', { error: err.message }));
      try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
      return bot.sendMessage(chatId, '*🐦 eBird Sightings*\n\nChoose a search type:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔍 Sightings', callback_data: 'ebird_sightings' },
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
    if (cbData === 'ebird_sightings') {
      bot.answerCallbackQuery(query.id);
      try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
      getIdentify().clearPending?.(user?.id);
      clearSession(chatId);
      ensureActiveBirdSession(chat, user).catch(err => logger.warn('[birdMenu] session init failed', { error: err.message }));
      return handleSightings(bot, chatId, context);
    }
    if (cbData === 'bird_notable') {
      bot.answerCallbackQuery(query.id);
      try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
      getIdentify().clearPending?.(user?.id);
      clearSession(chatId);
      ensureActiveBirdSession(chat, user).catch(err => logger.warn('[birdMenu] session init failed', { error: err.message }));
      return handleNotable(bot, chatId, context);
    }
    if (cbData === 'bird_nearby') {
      bot.answerCallbackQuery(query.id);
      try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
      getIdentify().clearPending?.(user?.id);
      clearSession(chatId);
      ensureActiveBirdSession(chat, user).catch(err => logger.warn('[birdMenu] session init failed', { error: err.message }));
      return handleNearby(bot, chatId);
    }
    if (cbData === 'bird_hotspot') {
      bot.answerCallbackQuery(query.id);
      try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
      getIdentify().clearPending?.(user?.id);
      clearSession(chatId);
      ensureActiveBirdSession(chat, user).catch(err => logger.warn('[birdMenu] session init failed', { error: err.message }));
      return handleHotspots(bot, chatId);
    }
    if (cbData === 'bird_species') {
      bot.answerCallbackQuery(query.id);
      try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
      getIdentify().clearPending?.(user?.id);
      clearSession(chatId);
      ensureActiveBirdSession(chat, user).catch(err => logger.warn('[birdMenu] session init failed', { error: err.message }));
      return handleSpecies(bot, chatId);
    }

    if (cbData === 'bird_back_sightings') {
      bot.answerCallbackQuery(query.id);
      try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
      clearSession(chatId);
      return bot.sendMessage(chatId, '*🐦 Bird Sightings*\n\nChoose a category to explore:', SIGHTINGS_CATEGORY_MENU);
    }
    if (cbData === 'bird_back_main') {
      bot.answerCallbackQuery(query.id);
      try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
      clearSession(chatId);
      return bot.sendMessage(chatId, '*🐦 Bird Sightings*\n\nChoose a category to explore:', SIGHTINGS_CATEGORY_MENU);
    }
    if (cbData === 'bird_logs') {
      bot.answerCallbackQuery(query.id);
      try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
      clearSession(chatId);
      ensureActiveBirdSession(chat, user).catch(err => logger.warn('[birdMenu] session init failed', { error: err.message }));
      return handleMyLogs(bot, chatId, user);
    }

    // ── My Logs pagination ────────────────────────────────────────────────
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

    // ── Hotspot button (from hotspot list or place search) ────────────────
    if (cbData.startsWith('hotspot_')) {
      bot.answerCallbackQuery(query.id);
      try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
      const parts = cbData.split('_');
      const type  = parts[1];
      const locId = parts.slice(2).join('_');
      // Resolve display name from stored state
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
      return showDateSelection(bot, chatId, locId, locName, type, { isHotspot: true });
    }

    // ── Nearby distance selection ─────────────────────────────────────────
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

    // ── Nearby date selection ─────────────────────────────────────────────
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

    // ── Pagination ────────────────────────────────────────────────────────
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

    // ── Jump to page ──────────────────────────────────────────────────────
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

    // ── Summary ───────────────────────────────────────────────────────────
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

    // ── Share ─────────────────────────────────────────────────────────────
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

    // ── New search — go straight back to eBird Sightings submenu ─────────
    if (cbData === 'new_search') {
      bot.answerCallbackQuery(query.id);
      clearSession(chatId);
      ensureActiveBirdSession(chat, user).catch(err => logger.warn('[birdMenu] session init failed', { error: err.message }));
      try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
      return bot.sendMessage(chatId, '*🐦 eBird Sightings*\n\nChoose a search type:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔍 Sightings', callback_data: 'ebird_sightings' },
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

    // ── Live Updates (coming soon) ────────────────────────────────────────
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
                [{ text: '🔙 Back', callback_data: 'bird_sightings' }],
              ],
            },
          }
        );
      }
      return bot.sendMessage(chatId,
        '🔔 *Live Updates*\n\nGet notified when new bird sightings are posted to eBird.\n\nWhat would you like to track?',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔍 Sightings', callback_data: 'live_type_sightings' }, { text: '⭐ Notable', callback_data: 'live_type_notable' }],
              [{ text: '🦆 Species', callback_data: 'live_type_species' }],
              [{ text: '🔙 Back', callback_data: 'bird_sightings' }],
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
            inline_keyboard: [[{ text: '🔄 Try Again', callback_data: 'new_search' }, { text: '✅ Done', callback_data: 'done' }]],
          },
        }
      );
    }

    if (cbData === 'live_type_species') {
      bot.answerCallbackQuery(query.id);
      try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore ok*/ }
      userStates.set(chatId, { action: 'awaiting_live_species' });
      return bot.sendMessage(chatId,
        `🦆 *Enter species and location:*\n\nFormat: \`Species Name, Location\`\n\nExamples:\n• \`House Sparrow, Singapore\`\n• \`Oriental Magpie-Robin, Botanic Gardens, Singapore\``,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🔄 Try Again', callback_data: 'new_search' }, { text: '✅ Done', callback_data: 'done' }]],
          },
        }
      );
    }

    if (cbData === 'live_stop') {
      bot.answerCallbackQuery(query.id);
      try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
      stopLiveUpdate(chatId);
      return bot.sendMessage(chatId,
        '🔕 *Live Updates stopped.*\n\nUse 🔔 Live Updates to start again.',
        { parse_mode: 'Markdown' }
      );
    }

    // ── Done ──────────────────────────────────────────────────────────────
    if (cbData === 'done') {
      bot.answerCallbackQuery(query.id);
      userStates.delete(chatId);
      clearSession(chatId);
      endBirdSession(chatId);
      try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
      const liveStillActive = !!getLiveUpdate(chatId);
      const doneMsg = liveStillActive
        ? '✅ Session ended. Use /start to begin again.\n\n🔔 Live Updates are still running in the background.'
        : '✅ Session ended. Use /start to begin again.';
      await bot.sendMessage(chatId, doneMsg);
      return;
    }
  });

  // ── Message handler ───────────────────────────────────────────────────────
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;

    // addSighting has priority
    if (addSightingSessions && addSightingSessions.has(chatId)) return;

    // Handle GPS location share (Nearby flow)
    if (msg.location) {
      return handleLocationMsg(bot, chatId, msg, { user: msg.from, chat: msg.chat });
    }

    const state = userStates.get(chatId);
    if (!state) return;

    // Skip commands
    if (msg.text && msg.text.startsWith('/')) return;

    const text = (msg.text || '').trim();
    if (!text) return;

    const { action } = state;
    const context = state.context || { user: msg.from, chat: msg.chat };

    // ── Sightings region input ──────────────────────────────────────────
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

    // ── Notable region input ────────────────────────────────────────────
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

    // ── Hotspots region input ───────────────────────────────────────────
    if (action === 'awaiting_region_hotspots') {
      userStates.delete(chatId);
      await searchAndShowHotspots(bot, chatId, text);
      return;
    }

    // ── Species name input ──────────────────────────────────────────────
    if (action === 'awaiting_species_name') {
      if (text.includes(',')) {
        // Format: location, species
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

    // ── Species location input ──────────────────────────────────────────
    if (action === 'awaiting_species_location') {
      userStates.delete(chatId);
      userStates.set(chatId, { context });
      await handlePlaceSearch(bot, chatId, text, 'species', context, state.species);
      return;
    }

    // ── Jump-to-page input ──────────────────────────────────────────────
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

    // ── Custom date input ───────────────────────────────────────────────
    if (action === 'awaiting_custom_date') {
      await handleCustomDateInput(bot, chatId, text, state);
      return;
    }

    // ── Nearby custom date input ────────────────────────────────────────
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
          `✅ *Live Updates Active!*\n\n📡 Tracking: *${typeLabel}*\n📍 Location: *${esc(text)}*\n\nYou'll be notified of new sightings every 30 seconds.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔕 Stop', callback_data: 'live_stop' }, { text: '🔄 Change', callback_data: 'live_setup' }],
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

    // ── Live Update: species + location input ───────────────────────────
    if (action === 'awaiting_live_species') {
      const commaIdx = text.indexOf(',');
      if (commaIdx === -1) {
        await bot.sendMessage(chatId,
          '❌ Please use the format: `Species Name, Location`\nExample: `House Sparrow, Singapore`',
          { parse_mode: 'Markdown' }
        );
        return; // keep state so user can retry
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
          `✅ *Live Updates Active!*\n\n📡 Tracking: *🦆 ${esc(sp.comName)}*\n📍 Location: *${esc(locationInput)}*\n\nYou'll be notified of new sightings every 30 seconds.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔕 Stop', callback_data: 'live_stop' }, { text: '🔄 Change', callback_data: 'live_setup' }],
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
  });
}

module.exports = { registerBirdMenu, SIGHTINGS_CATEGORY_MENU, clearSession, ensureActiveBirdSession };
