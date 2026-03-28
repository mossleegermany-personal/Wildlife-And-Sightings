/**
 * /search <name>  — search bird species by name
 */

const axios = require('axios');

const BASE = process.env.API_BASE_URL || 'http://localhost:3001/api/v1';

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = function registerSpecies(bot) {
  bot.onText(/\/search\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const q = match[1].trim();

    bot.sendMessage(chatId, `🔍 Searching species: <i>${escHtml(q)}</i>…`, { parse_mode: 'HTML' });
    try {
      const { data } = await axios.post(`${BASE}/species/search`, { q, limit: 10 });
      if (!data || data.length === 0) {
        return bot.sendMessage(chatId, `<i>No species found for "${escHtml(q)}".</i>`, { parse_mode: 'HTML' });
      }
      const lines = data
        .map((s, i) => `${i + 1}. <b>${escHtml(s.comName)}</b> — <i>${escHtml(s.sciName)}</i>`)
        .join('\n');
      bot.sendMessage(chatId, `<b>🔍 Species Results for "${escHtml(q)}"</b>\n\n${lines}`, { parse_mode: 'HTML' });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${escHtml(err.response?.data?.error || err.message)}`);
    }
  });
};
