'use strict';

/**
 * /nearby <lat> <lng>  — recent bird sightings near a coordinate
 * /region <code>       — recent birds in a region  (e.g. US-CA)
 * /notable <code>      — notable/rare sightings in a region
 */

const axios = require('axios');

const BASE = process.env.API_BASE_URL || 'http://localhost:3001/api/v1';

function fmtSightings(list) {
  if (!list || list.length === 0) return '<i>No sightings found.</i>';
  return list
    .slice(0, 10)
    .map((s, i) => `${i + 1}. <b>${escHtml(s.comName)}</b> (${escHtml(s.sciName)}) — ${escHtml(s.locName || 'unknown location')}`)
    .join('\n');
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = function registerSightings(bot) {
  // /nearby <lat> <lng>
  bot.onText(/\/nearby\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const lat = parseFloat(match[1]);
    const lng = parseFloat(match[2]);

    bot.sendMessage(chatId, '🔍 Searching nearby sightings…');
    try {
      const { data } = await axios.post(`${BASE}/sightings/nearby`, { lat, lng, maxResults: 10 });
      bot.sendMessage(chatId, `<b>🐦 Nearby Bird Sightings</b>\n\n${fmtSightings(data)}`, { parse_mode: 'HTML' });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.response?.data?.error || err.message}`);
    }
  });

  // /region <code>
  bot.onText(/\/region\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const regionCode = match[1].toUpperCase();

    bot.sendMessage(chatId, `🔍 Searching sightings in <b>${escHtml(regionCode)}</b>…`, { parse_mode: 'HTML' });
    try {
      const { data } = await axios.post(`${BASE}/sightings/region`, { regionCode, maxResults: 10 });
      bot.sendMessage(chatId, `<b>🐦 Recent Sightings — ${escHtml(regionCode)}</b>\n\n${fmtSightings(data)}`, { parse_mode: 'HTML' });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.response?.data?.error || err.message}`);
    }
  });

  // /notable <code>
  bot.onText(/\/notable\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const regionCode = match[1].toUpperCase();

    bot.sendMessage(chatId, `🔍 Searching notable sightings in <b>${escHtml(regionCode)}</b>…`, { parse_mode: 'HTML' });
    try {
      const { data } = await axios.post(`${BASE}/sightings/notable`, { regionCode, maxResults: 10 });
      bot.sendMessage(chatId, `<b>⭐ Notable Sightings — ${escHtml(regionCode)}</b>\n\n${fmtSightings(data)}`, { parse_mode: 'HTML' });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.response?.data?.error || err.message}`);
    }
  });
};
