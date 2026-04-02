/**
 * Main Menu
 *
 * Defines the two primary inline keyboard buttons shown on /start,
 * and handles their callback queries.
 *
 * Buttons:
 *   🦎 Identify Animal   → guides the user to send a photo
 *   🐦 Bird Sightings    → shows available sighting commands
 */

// ── Keyboard markup ───────────────────────────────────────────────────────────

// chatId -> messageId for the pending "New Identification" helper prompt
const identifyPromptMessages = new Map();
const sheetsService = require('../../../database/googleSheets/services/googleSheetsService');
const logger = require('../../../src/utils/logger');
const { startAddSightingSession }  = require('../commands/addSighting');
const birdFlows = require('../commands/birdMenu/flows');

// Defined inline — no dependency on any birdMenu file at load time
const SIGHTINGS_CATEGORY_MENU = {
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

// chatId -> { sn, sessionId } — in-memory dedup guard for Animal Identification sessions
const identifySessionMap = new Map();

// userId -> { chatId, chatTitle, chatType, sender, startTime, sessionSn, sessionId } for active sessions
const sessionStartTimes = new Map();

function setSessionStart(userId, chatId, chatTitle, chatType, sender, sessionSn, sessionId, startTime) {
  sessionStartTimes.set(userId, {
    chatId,
    chatTitle: chatTitle || null,
    chatType: chatType || 'private',
    sender: sender || 'Unknown',
    startTime: startTime || new Date(),
    sessionSn: sessionSn || null,
    sessionId: sessionId || '',
  });
}

function getSessionStart(userId) {
  return sessionStartTimes.get(userId);
}

function clearSessionStart(userId) {
  sessionStartTimes.delete(userId);
}

function clearIdentifySession(chatId) {
  identifySessionMap.delete(chatId);
}
function setIdentifyPromptMessage(chatId, messageId) {
  identifyPromptMessages.set(chatId, messageId);
}

function consumeIdentifyPromptMessage(chatId) {
  const messageId = identifyPromptMessages.get(chatId);
  if (!messageId) return null;
  identifyPromptMessages.delete(chatId);
  return messageId;
}

function hasIdentifyPromptMessage(chatId) {
  return identifyPromptMessages.has(chatId);
}

const MAIN_MENU = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🦎 Identify Animal', callback_data: 'menu_identify'  },
        { text: '🐦 Bird Sightings',  callback_data: 'menu_sightings' },
      ],
      [
        { text: '❓ Help', callback_data: 'menu_help' },
      ],
    ],
  },
};

// ── Callback handlers ─────────────────────────────────────────────────────────

const CALLBACKS = {
  async menu_identify(bot, query) {
    bot.answerCallbackQuery(query.id);

    const chat = query.message.chat;
    const user = query.from;
    const chatId = chat.id;
    const chatType = chat.type || 'private';
    const chatTitle = chat.title || null;
    const sender = chatTitle
      || (user?.username ? `@${user.username}` : [user?.first_name, user?.last_name].filter(Boolean).join(' '))
      || 'Unknown';

    // Start session on first entry — in-memory guard prevents duplicate rows
    if (!identifySessionMap.has(chatId)) {
      try {
        const latest = await sheetsService.getLatestSessionStatus({
          subBot: 'Animal Identification',
          chatId,
          sender,
          chatType,
        });
        if (latest && String(latest.status || '').toLowerCase() === 'active') {
          identifySessionMap.set(chatId, { sn: latest.sn, sessionId: latest.sessionId || '' });
        } else {
          const started = await sheetsService.logSessionStart({
            subBot: 'Animal Identification',
            chatId,
            chatTitle,
            user,
            chatType,
            startTime: new Date(),
          });
          identifySessionMap.set(chatId, { sn: started?.sn || null, sessionId: started?.sessionId || '' });
        }
      } catch (err) {
        logger.warn('[mainMenu] identify session init failed', { error: err.message });
        identifySessionMap.set(chatId, { sn: null, sessionId: '' });
      }
    }

    bot.sendMessage(
      chatId,
      `<b>🦎 Identify an Animal</b>\n\nWhat would you like to do?`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📷 New Identification', callback_data: 'menu_identify_new' },
            ],
            [
              { text: '📋 My Records', callback_data: 'menu_records' },
            ],
          ],
        },
      }
    );
  },

  async menu_identify_new(bot, query) {
    bot.answerCallbackQuery(query.id);

    const chat = query.message.chat;
    const user = query.from;
    const chatId = chat.id;
    const chatType = chat.type || 'private';
    const chatTitle = chat.title || null;
    const sender = chatTitle
      || (user?.username ? `@${user.username}` : [user?.first_name, user?.last_name].filter(Boolean).join(' '))
      || 'Unknown';

    // Session was started in menu_identify — just read from memory
    const session = identifySessionMap.get(chatId) || { sn: null, sessionId: '' };

    const sent = await bot.sendMessage(
      chatId,
      `<b>📷 New Identification</b>\n\nSimply <b>send me a photo</b> and I'll identify the animal in it.`,
      { parse_mode: 'HTML' }
    );

    setIdentifyPromptMessage(sent.chat.id, sent.message_id);
    setSessionStart(user?.id, chatId, chatTitle, chatType, sender, session.sn, session.sessionId, new Date());
  },

  async menu_sightings(bot, query) {
    bot.answerCallbackQuery(query.id);
    const chat = query.message.chat;
    const user = query.from;
    // require('../commands/birdMenu/session').ensureActiveBirdSession(chat, user).catch(() => {});
    bot.sendMessage(
      chat.id,
      `<b>🐦 Bird Sightings</b>\n\nChoose a category to explore:`,
      { ...SIGHTINGS_CATEGORY_MENU, parse_mode: 'HTML' }
    );
  },

  async bird_sightings(bot, query) {
    bot.answerCallbackQuery(query.id);
    const chatId = query.message?.chat?.id;
    logger.info('[mainMenu] bird_sightings: sending eBird submenu', { chatId });
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
    try {
      await bot.sendMessage(chatId, '*🐦 eBird Sightings*\n\nChoose a search type:', {
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
              { text: '⬅️ Back',    callback_data: 'bird_back_main'  },
              { text: '✅ Done',    callback_data: 'done'            },
            ],
          ],
        },
      });
      logger.info('[mainMenu] bird_sightings: eBird submenu sent OK', { chatId });
    } catch (err) {
      logger.error('[mainMenu] bird_sightings: sendMessage failed', { chatId, error: err.message });
    }
  },

  async ebird_sightings(bot, query) {
    bot.answerCallbackQuery(query.id);
    const chatId = query.message?.chat?.id;
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
    return birdFlows.handleSightings(bot, chatId, { user: query.from, chat: query.message?.chat });
  },

  async bird_notable(bot, query) {
    bot.answerCallbackQuery(query.id);
    const chatId = query.message?.chat?.id;
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
    return birdFlows.handleNotable(bot, chatId, { user: query.from, chat: query.message?.chat });
  },

  async bird_nearby(bot, query) {
    bot.answerCallbackQuery(query.id);
    const chatId = query.message?.chat?.id;
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
    return birdFlows.handleNearby(bot, chatId);
  },

  async bird_species(bot, query) {
    bot.answerCallbackQuery(query.id);
    const chatId = query.message?.chat?.id;
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
    return birdFlows.handleSpecies(bot, chatId);
  },

  async bird_logs(bot, query) {
    bot.answerCallbackQuery(query.id);
    const chatId = query.message?.chat?.id;
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
    return birdFlows.handleMyLogs(bot, chatId, query.from);
  },

  async bird_back_main(bot, query) {
    bot.answerCallbackQuery(query.id);
    const chatId = query.message?.chat?.id;
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
    return bot.sendMessage(chatId, '🐦 eBird Sightings\n\nChoose a category to explore:', SIGHTINGS_CATEGORY_MENU);
  },

  async bird_back_sightings(bot, query) {
    bot.answerCallbackQuery(query.id);
    const chatId = query.message?.chat?.id;
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
            { text: '⬅️ Back',    callback_data: 'bird_back_main'  },
            { text: '✅ Done',    callback_data: 'done'            },
          ],
        ],
      },
    });
  },

  async done(bot, query) {
    bot.answerCallbackQuery(query.id);
    const chatId = query.message?.chat?.id;
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
    return bot.sendMessage(chatId, '✅ Done! Use the main menu again when ready.', MAIN_MENU);
  },

  menu_addsighting(bot, query) {
    bot.answerCallbackQuery(query.id);
    startAddSightingSession(bot, query.message.chat.id, query.from, query.message.chat);
  },

  menu_help(bot, query) {
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(
      query.message.chat.id,
      `<b>🌿 Wildlife &amp; Sightings Bot — Commands</b>\n\n` +
      `<b>Identification</b>\n` +
      `📸 Send any photo — I'll identify the animal\n` +
      `/identify_url &lt;url&gt; — identify from an image URL\n\n` +
      `<b>Bird Sightings</b>\n` +
      `/nearby &lt;lat&gt; &lt;lng&gt; — recent birds near a location\n` +
      `/region &lt;code&gt; — recent birds in a region (e.g. US-CA)\n` +
      `/notable &lt;code&gt; — notable/rare sightings in a region\n\n` +
      `<b>Hotspots</b>\n` +
      `/hotspots &lt;lat&gt; &lt;lng&gt; — birding hotspots near you\n\n` +
      `<b>Species</b>\n` +
      `/search &lt;name&gt; — search bird species by name\n\n` +
      `<b>General</b>\n` +
      `/start — welcome message\n` +
      `/help — show this message\n` +
      `/about — about this bot`,
      { parse_mode: 'HTML' }
    );
  },
};

// ── Register callback_query listener ─────────────────────────────────────────

function registerMainMenu(bot, handleBirdCallback) {
  logger.info('[mainMenu] registerMainMenu called', { handleBirdCallbackType: typeof handleBirdCallback });

  let resolvedBirdCallback = handleBirdCallback;
  if (typeof resolvedBirdCallback !== 'function') {
    try {
      const fallback = require('../commands/birdMenu').handleBirdCallback;
      if (typeof fallback === 'function') {
        resolvedBirdCallback = fallback;
        logger.info('[mainMenu] loaded birdMenu.handleBirdCallback lazily as fallback');
      }
    } catch (err) {
      logger.warn('[mainMenu] lazy load of birdMenu.handleBirdCallback failed', { error: err.message });
    }
  }

  bot.on('callback_query', (query) => {
    logger.info('[mainMenu] callback_query event emitted', { cbData: query?.data });
    const handler = CALLBACKS[query.data];
    if (handler) { handler(bot, query); return; }

    let callbackFn = resolvedBirdCallback;
    if (typeof callbackFn !== 'function') {
      try {
        const fallbackFn = require('../commands/birdMenu').handleBirdCallback;
        if (typeof fallbackFn === 'function') {
          callbackFn = fallbackFn;
          logger.info('[mainMenu] found fallback birdMenu.handleBirdCallback at invocation');
        }
      } catch (err) {
        logger.warn('[mainMenu] unable to load fallback birdMenu.handleBirdCallback at invocation', { error: err.message });
      }
    }

    if (typeof callbackFn !== 'function') {
      logger.error('[mainMenu] handleBirdCallback is not a function', {
        handleBirdCallbackType: typeof callbackFn,
        cbData: query?.data,
      });
      bot.answerCallbackQuery(query.id, { text: 'Button not available right now' }).catch(() => {});
      return;
    }

    callbackFn(bot, query);
  });
}

module.exports = {
  MAIN_MENU,
  registerMainMenu,
  consumeIdentifyPromptMessage,
  setIdentifyPromptMessage,
  hasIdentifyPromptMessage,
  setSessionStart,
  getSessionStart,
  clearSessionStart,
  clearIdentifySession,
};
