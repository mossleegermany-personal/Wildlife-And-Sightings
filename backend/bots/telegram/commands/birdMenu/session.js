'use strict';

/**
 * Bird Sightings session helpers.
 *
 * Extracted into a standalone leaf module so that mainMenu.js can import
 * ensureActiveBirdSession / endBirdSession without pulling in birdMenu/index.js
 * and risking a circular-dependency partial-initialisation on Azure.
 *
 * No dependency on birdMenu/index.js — safe to require from anywhere.
 */

const { birdSessionMap } = require('./state');
const sheetsService      = require('../../../../database/googleSheets/services/googleSheetsService');
const logger             = require('../../../../src/utils/logger');

function getBirdSessionKey(chatOrId, opts = {}) {
  const chatId = typeof chatOrId === 'object' ? chatOrId?.id : chatOrId;
  const chatType = (typeof chatOrId === 'object' ? chatOrId?.type : opts.chatType) || 'private';
  const fallbackChannelId = chatType === 'private' ? '' : (chatId != null ? String(chatId) : '');
  const channelId = opts.channelId != null ? String(opts.channelId) : fallbackChannelId;
  const base = chatId != null ? String(chatId) : '';
  return `${base}:${channelId || base}`;
}

function getBirdSession(chatOrId, opts = {}) {
  return birdSessionMap.get(getBirdSessionKey(chatOrId, opts)) || null;
}

async function ensureActiveBirdSession(chat, user, opts = {}) {
  const chatId    = chat?.id;
  const chatType  = chat?.type || 'private';
  const chatTitle = chat?.title || null;
  const channelId = chatType === 'private' ? '' : String(opts.channelId ?? chatId ?? '');
  const channelName = chatType === 'private' ? '' : String(opts.channelName || chatTitle || '');
  const sender    = (user?.username ? `@${user.username}` : [user?.first_name, user?.last_name].filter(Boolean).join(' '))
    || 'Unknown';
  const sessionKey = getBirdSessionKey(chat, { channelId, chatType });

  if (birdSessionMap.has(sessionKey)) return birdSessionMap.get(sessionKey);

  try {
    const latest = await sheetsService.getLatestSessionStatus({
      subBot: 'Bird Sightings',
      chatId,
      channelId,
      channelName,
      sender,
      chatType,
    });

    if (latest && String(latest.status || '').toLowerCase() === 'active') {
      const session = { sn: latest.sn, sessionId: latest.sessionId || '' };
      birdSessionMap.set(sessionKey, session);
      return session;
    }

    const started = await sheetsService.logSessionStart({
      subBot: 'Bird Sightings',
      chatId,
      channelId,
      channelName,
      chatTitle,
      user,
      chatType,
      startTime: new Date(),
    });
    const session = { sn: started?.sn || null, sessionId: started?.sessionId || '' };
    birdSessionMap.set(sessionKey, session);
    return session;
  } catch (err) {
    logger.warn('[birdMenu] ensureActiveBirdSession failed', { error: err.message });
    return { sn: null, sessionId: '' };
  }
}

function endBirdSession(chatOrId, opts = {}) {
  const sessionKey = getBirdSessionKey(chatOrId, opts);
  const session = birdSessionMap.get(sessionKey);
  birdSessionMap.delete(sessionKey);
  if (session?.sn != null) {
    sheetsService.updateSessionEnd(session.sn, new Date(), 'Ended')
      .catch(err => logger.warn('[birdMenu] Failed to end Bird Sightings session', { error: err.message }));
  }
}

module.exports = { ensureActiveBirdSession, endBirdSession, getBirdSession, getBirdSessionKey };
