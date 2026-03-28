'use strict';

const { MAIN_MENU }  = require('../menu/mainMenu');
const sheetsService  = require('../../../database/googleSheets/services/googleSheetsService');
const { clearEndedSession } = require('./identify');

const SHEET_NAME = 'Animal Identification';

function getSenderLabel(from, senderChat) {
  if (senderChat) {
    if (senderChat.username) return `@${senderChat.username}`;
    return senderChat.title || 'Unknown Channel';
  }
  if (!from) return 'Unknown';
  if (from.username) return `@${from.username}`;
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Unknown';
}

function getDisplayName(from) {
  return [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim();
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getWelcomeName(from, senderChat) {
  const fullName = getDisplayName(from);
  if (fullName) return fullName;
  if (from?.username) return `@${from.username}`;
  if (senderChat?.title) return senderChat.title;
  return 'there';
}

function getChannelName(chat, from, senderChat) {
  const type = senderChat?.type || chat?.type || '';
  if (type === 'group' || type === 'supergroup' || type === 'channel') {
    const title = String(senderChat?.title || chat?.title || '').trim();
    if (!title) return '';

    const senderUsername = String(senderChat?.username || from?.username || '').trim();
    const senderDisplay = senderChat?.title
      ? String(senderChat.title).trim()
      : [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim();
    const normalizedTitle = title.toLowerCase();
    const normalizedDisplay = senderDisplay.toLowerCase();
    const normalizedUsername = senderUsername.toLowerCase();

    if (
      normalizedTitle &&
      (
        normalizedTitle === normalizedDisplay ||
        normalizedTitle === normalizedUsername ||
        normalizedTitle === `@${normalizedUsername}`
      )
    ) {
      return '';
    }

    return title;
  }
  return '';
}

module.exports = function registerStart(bot) {
  bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
    const param  = (match?.[1] || '').trim();
    const chatId = msg.chat.id;
    clearEndedSession(msg.from?.id);

    const senderChat = msg.sender_chat || null;
    const logChatId = senderChat?.id != null ? senderChat.id : chatId;
    const logChatType = senderChat?.type || msg.chat?.type || 'private';

    // Always log /start into "Telegram Group" sheet.
    sheetsService.logTelegramGroupStart({
      chatId: logChatId,
      chatType: logChatType,
      sender: getSenderLabel(msg.from, senderChat),
      displayName: getDisplayName(msg.from),
      channelName: getChannelName(msg.chat, msg.from, senderChat),
    }).catch(() => {});

    if (param.startsWith('canvas_')) {
      // Delete the /start message immediately so only the photo appears
      await bot.deleteMessage(chatId, msg.message_id).catch(() => {});

      const parts     = param.split('_');
      const globalIdx = parseInt(parts[2], 10);
      if (isNaN(globalIdx)) {
        return bot.sendMessage(chatId, '❌ Could not retrieve that record.');
      }

      try {
        const id   = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
        const all  = await sheetsService.getRows(id, `${SHEET_NAME}!A2:K5000`);
        const targetChatId = String(chatId);
        const rows = all.filter(r => String(r[1] || '').trim() === targetChatId);
        const row    = rows[globalIdx];
        const fileId = (row?.[10] || '').trim();

        if (!fileId) {
          return bot.sendMessage(chatId, '❌ No canvas saved for that record.');
        }
        await bot.sendPhoto(chatId, fileId);
      } catch {
        await bot.sendMessage(chatId, '❌ Failed to retrieve canvas. Please try again.');
      }
      return;
    }

    const name = escHtml(getWelcomeName(msg.from, senderChat));
    bot.sendMessage(
      chatId,
      `👋 Hello, <b>${name}</b>! Welcome to the <b>Wildlife &amp; Sightings Bot</b>.\n\n` +
      `I can help you identify animals and explore bird sightings.\n` +
      `Choose an option below or type /help for all commands.`,
      { parse_mode: 'HTML', ...MAIN_MENU }
    );
  });
};
