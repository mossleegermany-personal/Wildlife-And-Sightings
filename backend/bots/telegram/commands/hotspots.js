'use strict';

/**
 * /hotspots <lat> <lng>  — birding hotspots near a coordinate
 */

const axios = require('axios');

const BASE = process.env.API_BASE_URL || 'http://localhost:3001/api/v1';

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = function registerHotspots(bot) {
  bot.onText(/\/hotspots\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const lat = parseFloat(match[1]);
    const lng = parseFloat(match[2]);

    bot.sendMessage(chatId, '📍 Finding hotspots near you…');
    try {
      const { data } = await axios.post(`${BASE}/hotspots/nearby`, { lat, lng });
      if (!data || data.length === 0) {
        return bot.sendMessage(chatId, '<i>No hotspots found nearby.</i>', { parse_mode: 'HTML' });
      }
      const lines = data
        .slice(0, 10)
        .map((h, i) => `${i + 1}. <b>${escHtml(h.locName)}</b> — ${escHtml(h.lat)}, ${escHtml(h.lng)}`)
        .join('\n');
      bot.sendMessage(chatId, `<b>📍 Nearby Birding Hotspots</b>\n\n${lines}`, { parse_mode: 'HTML' });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.response?.data?.error || err.message}`);
    }
  });
};
