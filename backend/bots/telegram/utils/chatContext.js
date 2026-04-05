'use strict';

const channelContextCache = new Map();

/**
 * Manual channel ID/Name overrides via CHAT_CHANNEL_MAP env var.
 * Format (JSON): { "<chatId>": { "channelId": "<id>", "channelName": "<name>" }, ... }
 * e.g. CHAT_CHANNEL_MAP={"−1001192647169":{"channelId":"-1001234567890","channelName":"Wildlife"}}
 */
function loadChannelMap() {
  const raw = String(process.env.CHAT_CHANNEL_MAP || '').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Resolve the best channel context for Telegram group/supergroup interactions.
 * Priority:
 * 1) CHAT_CHANNEL_MAP env var override (admin-configured, always wins)
 * 2) message sender_chat when it is a real linked channel
 * 3) linked_chat_id from Telegram chat metadata (via bot.getChat)
 * 4) fallback to the group chat itself
 */
async function resolveChannelContext(bot, chat, senderChat = null) {
  const chatType = String(chat?.type || '').toLowerCase();
  if (!chat || chatType === 'private') {
    return { channelId: '', channelName: '' };
  }

  const chatId = chat?.id != null ? String(chat.id) : '';
  const senderChatId = senderChat?.id != null ? String(senderChat.id) : '';
  const cacheKey = `${chatId}:${senderChatId}`;
  if (channelContextCache.has(cacheKey)) {
    return channelContextCache.get(cacheKey);
  }

  // Admin-configured override always wins — avoids relying on Telegram API returning linked_chat_id
  const channelMap = loadChannelMap();
  if (channelMap[chatId]) {
    const override = { channelId: String(channelMap[chatId].channelId || chatId).trim(), channelName: String(channelMap[chatId].channelName || '').trim() };
    channelContextCache.set(cacheKey, override);
    return override;
  }

  let channelId = '';
  let channelName = '';

  if (senderChatId && senderChatId !== chatId) {
    channelId = senderChatId;
    channelName = String(senderChat?.title || senderChat?.username || '').trim();
  }

  let linkedChatId = chat?.linked_chat_id != null ? String(chat.linked_chat_id) : '';

  if (bot?.getChat && chat?.id != null) {
    try {
      const fullChat = await bot.getChat(chat.id);
      if (!linkedChatId && fullChat?.linked_chat_id != null) {
        linkedChatId = String(fullChat.linked_chat_id);
      }
    } catch {
      // Best-effort only.
    }
  }

  if (linkedChatId) {
    channelId = linkedChatId;
    if (bot?.getChat) {
      try {
        const linkedChat = await bot.getChat(linkedChatId);
        channelName = String(linkedChat?.title || linkedChat?.username || channelName || '').trim();
      } catch {
        // Keep fallback name below.
      }
    }
  }

  if (!channelId) {
    channelId = senderChatId || chatId;
  }
  if (!channelName) {
    channelName = String(senderChat?.title || chat?.title || '').trim();
  }

  const result = { channelId, channelName };
  channelContextCache.set(cacheKey, result);
  return result;
}

module.exports = { resolveChannelContext };
