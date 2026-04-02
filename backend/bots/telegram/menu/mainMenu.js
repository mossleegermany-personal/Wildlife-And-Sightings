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
const { sendSightingsCategoryMenu, sendEbirdSubmenu } = require('../commands/birdMenu/ui');


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
    const chatId = query.message.chat.id;
    return sendSightingsCategoryMenu(bot, chatId);
  },

  // bird_sightings callback is handled in birdMenu.handleBirdCallback for universal behavior
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



  async done(bot, query) {
    bot.answerCallbackQuery(query.id);
    const chatId = query.message?.chat?.id;
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch { /* ignore */ }
    return bot.sendMessage(chatId, '✅ Done! Use the main menu again when ready.', { reply_markup: MAIN_MENU.reply_markup });
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
  logger.info('[mainMenu] registerMainMenu called');

  bot.on('callback_query', (query) => {
    logger.info('[mainMenu] callback_query event emitted', { cbData: query?.data });

    const handler = CALLBACKS[query.data];
    if (handler) {
      handler(bot, query);
      return;
    }

    handleBirdCallback(bot, query);
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
