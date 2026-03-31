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

module.exports = { ensureActiveBirdSession, endBirdSession };
