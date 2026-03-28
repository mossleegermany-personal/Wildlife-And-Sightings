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
    ],
  },
};

// ── Callback handlers ─────────────────────────────────────────────────────────

const CALLBACKS = {
  menu_identify(bot, query) {
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(
      query.message.chat.id,
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
    const chatType = chat.type || 'private';
    const chatTitle = chat.title || null;
    const sender = chatTitle
      || (user?.username ? `@${user.username}` : [user?.first_name, user?.last_name].filter(Boolean).join(' '))
      || 'Unknown';

    const startTime = new Date();
    let sessionSn = null;

    try {
      const latest = await sheetsService.getLatestSessionStatus({
        subBot: 'Animal Identification',
        chatId: chat.id,
        sender,
        chatType,
      });

      if (latest && String(latest.status || '').toLowerCase() === 'active') {
        sessionSn = latest.sn;
        const sessionId = latest.sessionId || '';
        const sent = await bot.sendMessage(
          chat.id,
          `<b>📷 New Identification</b>\n\nSimply <b>send me a photo</b> and I'll identify the animal in it.`,
          { parse_mode: 'HTML' }
        );

        setIdentifyPromptMessage(sent.chat.id, sent.message_id);
        setSessionStart(query.from?.id, chat.id, chatTitle, chatType, sender, sessionSn, sessionId, startTime);
        return;
      } else {
        const started = await sheetsService.logSessionStart({
          subBot: 'Animal Identification',
          chatId: chat.id,
          chatTitle,
          user,
          chatType,
          startTime,
        });
        sessionSn = started?.sn || null;
        const sessionId = started?.sessionId || '';

        const sent = await bot.sendMessage(
          chat.id,
          `<b>📷 New Identification</b>\n\nSimply <b>send me a photo</b> and I'll identify the animal in it.`,
          { parse_mode: 'HTML' }
        );

        setIdentifyPromptMessage(sent.chat.id, sent.message_id);
        setSessionStart(query.from?.id, chat.id, chatTitle, chatType, sender, sessionSn, sessionId, startTime);
        return;
      }
    } catch {
      // Non-blocking: identification flow should continue even if session logging fails.
      sessionSn = null;
    }

    const sent = await bot.sendMessage(
      chat.id,
      `<b>📷 New Identification</b>\n\nSimply <b>send me a photo</b> and I'll identify the animal in it.`,
      { parse_mode: 'HTML' }
    );

    setIdentifyPromptMessage(sent.chat.id, sent.message_id);
    setSessionStart(query.from?.id, chat.id, chatTitle, chatType, sender, sessionSn, '', startTime);
  },

  menu_sightings(bot, query) {
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(
      query.message.chat.id,
      `<b>🐦 Bird Sightings</b>\n\n` +
      `Use these commands to explore bird sightings:\n\n` +
      `/nearby &lt;lat&gt; &lt;lng&gt;\n` +
      `<i>Recent sightings near a GPS coordinate</i>\n\n` +
      `/region &lt;code&gt;\n` +
      `<i>Recent sightings in a region (e.g. US-CA, MY-10)</i>\n\n` +
      `/notable &lt;code&gt;\n` +
      `<i>Rare or notable sightings in a region</i>\n\n` +
      `/hotspots &lt;lat&gt; &lt;lng&gt;\n` +
      `<i>Top birding hotspots near a location</i>\n\n` +
      `/search &lt;name&gt;\n` +
      `<i>Search species by common or scientific name</i>`,
      { parse_mode: 'HTML' }
    );
  },
};

// ── Register callback_query listener ─────────────────────────────────────────

function registerMainMenu(bot) {
  bot.on('callback_query', (query) => {
    const handler = CALLBACKS[query.data];
    if (handler) handler(bot, query);
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
};
