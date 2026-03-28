/**
 * Records command — retrieve past identification records for the current user.
 *
 * Shows a paginated LIST of up to 6 entries per page.
 * Each entry is a tappable inline button; tapping sends the saved canvas.
 * Navigation: ⏮ First  ◀ Prev  ▶ Next  ⏭ Last  ✖ Close
 */

const sheetsService = require('../../../database/googleSheets/services/googleSheetsService');
const logger        = require('../../../src/utils/logger');

const SHEET_NAME = 'Animal Identification';
const PAGE_SIZE  = 6;

// chatId → { allRows, rows, page, msgId, isGroup, searchTerm }
const sessions = new Map();

// chatId → { promptMsgId }
const searchPending = new Map();
let cachedBotUsername = null;

async function ensureBotUsername(bot) {
  if (cachedBotUsername) return cachedBotUsername;

  const envUsername = String(
    process.env.TELEGRAM_BOT_USERNAME || process.env.BOT_USERNAME || process.env.TELEGRAM_BOT_NAME || ''
  ).replace(/^@/, '').trim();

  if (envUsername) {
    cachedBotUsername = envUsername;
    return cachedBotUsername;
  }

  try {
    const me = await bot.getMe();
    const resolved = String(me?.username || '').replace(/^@/, '').trim();
    if (resolved) cachedBotUsername = resolved;
  } catch (err) {
    logger.warn('records: unable to resolve bot username for deep links', { error: err.message });
  }

  return cachedBotUsername;
}

/** Fetch all rows for this chat from Sheets, newest first. */
async function fetchUserRows(chatId) {
  const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!id) return [];
  const rows = await sheetsService.getRows(id, `${SHEET_NAME}!A2:K5000`);
  const targetChatId = String(chatId);
  return rows.filter(r => String(r[1] || '').trim() === targetChatId);
}

/** Filter rows by search term (species name or date). */
function filterRows(allRows, term) {
  const q = term.toLowerCase().trim();
  if (!q) return allRows;
  return allRows.filter(r =>
    (r[9] || '').toLowerCase().includes(q) || (r[6] || '').toLowerCase().includes(q)
  );
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeSgTimeLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '—';
  if (/\bSST\b/i.test(raw)) {
    const stripped = raw.replace(/\s*SST\b/ig, '').trim();
    const hhmm = stripped.match(/^(\d{1,2}:\d{2})/);
    return hhmm ? `${hhmm[1]} hrs` : stripped;
  }
  const hhmmMatch = raw.match(/^(\d{1,2}:\d{2})/);
  if (hhmmMatch) return `${hhmmMatch[1]} hrs`;
  return raw;
}

function buildRecordDeepLink(globalIdx) {
  const username = String(cachedBotUsername || '').replace(/^@/, '').trim();
  if (!username) return '';
  return `https://t.me/${username}?start=canvas_0_${globalIdx}`;
}

/** Build list page text. */
function buildPageText(pageRows, page, totalPages, isGroup, searchTerm) {
  let header = `<b>📋 My Records</b>`;
  if (searchTerm) header += `   🔍 <i>${escHtml(searchTerm)}</i>`;
  header += `   <i>Page ${page} of ${totalPages}</i>`;
  let text = header + '\n\n';
  pageRows.forEach((row, i) => {
    const num       = (page - 1) * PAGE_SIZE + i + 1;
    const dateV     = row[6] || '—';
    const timeV     = normalizeSgTimeLabel(row[7] || '—');
    const country   = row[8] || '';
    const species   = row[9] || '—';
    const user      = isGroup ? (row[3] || '') : '';
    const globalIdx = (page - 1) * PAGE_SIZE + i;
    const deepLink = buildRecordDeepLink(globalIdx);
    const speciesText = escHtml(species);
    const linkedSpecies = deepLink
      ? `<a href="${deepLink}">${speciesText}</a>`
      : `<b>${speciesText}</b>`;

    text += `${num}. Species: ${linkedSpecies}`;
    if (user) text += ` · ${escHtml(user)}`;
    text += `\n    Country: ${escHtml(country || '—')}`;
    text += `\n    Date: ${escHtml(dateV)}`;
    text += `\n    Time: ${escHtml(timeV)}\n\n`;
  });
  return text.trim();
}

/** Build list page keyboard: «‹›» nav + search/clear. */
function buildListKeyboard(pageRows, page, totalPages, chatId, searchTerm) {
  const keyboard = [];
  if (searchTerm) {
    keyboard.push([{ text: '❌ Clear Search', callback_data: `rec_clearsearch:${chatId}` }]);
  } else {
    keyboard.push([{ text: '🔍 Search', callback_data: `rec_search:${chatId}` }]);
  }
  // Navigation row is shown below the Search/Clear row.
  keyboard.push([
    { text: '<<', callback_data: `rec_page:${chatId}:1` },
    { text: '<', callback_data: `rec_page:${chatId}:${Math.max(1, page - 1)}` },
    { text: '>', callback_data: `rec_page:${chatId}:${Math.min(totalPages, page + 1)}` },
    { text: '>>', callback_data: `rec_page:${chatId}:${totalPages}` },
  ]);
  return { inline_keyboard: keyboard };
}

/** Send or edit the list page. */
async function showPage(bot, chatId, page, editMsgId = null) {
  const session = sessions.get(chatId);
  if (!session) return;
  const { rows, isGroup, searchTerm } = session;

  if (rows.length === 0) {
    const noText   = searchTerm
      ? `🔍 No records match <i>${searchTerm}</i>.`
      : '📋 <b>No records found.</b>\n\nSend me a photo to start identifying animals!';
    const noMarkup = searchTerm
      ? { inline_keyboard: [[{ text: '❌ Clear Search', callback_data: `rec_clearsearch:${chatId}` }]] }
      : undefined;
    if (editMsgId) {
      await bot.editMessageText(noText, {
        chat_id: chatId, message_id: editMsgId, parse_mode: 'HTML',
        ...(noMarkup ? { reply_markup: noMarkup } : {}),
      }).catch(() => {});
    } else {
      await bot.sendMessage(chatId, noText, {
        parse_mode: 'HTML', disable_web_page_preview: true, ...(noMarkup ? { reply_markup: noMarkup } : {}),
      });
    }
    if (!searchTerm) sessions.delete(chatId);
    return;
  }

  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  page = Math.max(1, Math.min(page, totalPages));
  session.page = page;

  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const text     = buildPageText(pageRows, page, totalPages, isGroup, searchTerm);
  const markup   = buildListKeyboard(pageRows, page, totalPages, chatId, searchTerm);

  try {
    if (editMsgId) {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: editMsgId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(markup ? { reply_markup: markup } : {}),
      }).catch(() => {});
    } else {
      const sent = await bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(markup ? { reply_markup: markup } : {}),
      });
      session.msgId = sent.message_id;
    }
  } catch (err) {
    logger.warn('records: showPage error', { error: err.message });
  }
}

module.exports = function registerRecords(bot) {
  bot.on('callback_query', async (query) => {
    const { data } = query;

    // ── Open records list ────────────────────────────────────────────────
    if (data === 'menu_records') {
      bot.answerCallbackQuery(query.id);
      const chatId    = query.message.chat.id;
      const loadMsg = await bot.sendMessage(chatId, '⏳ Loading your records…');
      try {
        await ensureBotUsername(bot);
        const allRows = await fetchUserRows(chatId);
        const isGroup = ['group', 'supergroup'].includes(query.message.chat.type);
        sessions.set(chatId, { allRows, rows: allRows, page: 1, msgId: null, isGroup, searchTerm: '' });
        await bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
        await showPage(bot, chatId, 1);
      } catch (err) {
        await bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, `❌ Could not load records: ${err.message}`);
        logger.error('records: fetch error', { error: err.message });
      }
      return;
    }

    // ── Tap list entry → directly retrieve canvas ────────────────────────
    if (data.startsWith('rec_detail:')) {
      const parts     = data.split(':');
      const chatId    = parseInt(parts[1]);
      const globalIdx = parseInt(parts[2]);
      const session   = sessions.get(chatId);
      const row       = session?.rows[globalIdx];
      const fileId    = (row?.[10] || '').trim();

      if (!fileId) {
        return bot.answerCallbackQuery(query.id, { text: 'No saved result for this record.', show_alert: true });
      }

      bot.answerCallbackQuery(query.id);
      const retrieveMsg = await bot.sendMessage(chatId, '⏳ Retrieving result…');
      await bot.sendPhoto(chatId, fileId).catch(async () => {
        await bot.sendMessage(chatId, '⚠️ Could not retrieve this result image.');
      });
      await bot.deleteMessage(chatId, retrieveMsg.message_id).catch(() => {});
      return;
    }

    // ── 🔍 Search ────────────────────────────────────────────────────────
    if (data.startsWith('rec_search:')) {
      const chatId  = parseInt(data.split(':')[1]);
      const session = sessions.get(chatId);
      if (!session) return bot.answerCallbackQuery(query.id);
      bot.answerCallbackQuery(query.id);
      const prompt = await bot.sendMessage(
        chatId,
        '🔍 <b>Search Records</b>\n\nType a species name (or part of it) to filter:',
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '✖ Cancel', callback_data: `rec_cancelsearch:${chatId}` }]] },
        }
      );
      searchPending.set(chatId, { promptMsgId: prompt.message_id });
      return;
    }

    // ── Cancel search ────────────────────────────────────────────────────
    if (data.startsWith('rec_cancelsearch:')) {
      const chatId  = parseInt(data.split(':')[1]);
      bot.answerCallbackQuery(query.id);
      const pending = searchPending.get(chatId);
      if (pending) {
        await bot.deleteMessage(chatId, pending.promptMsgId).catch(() => {});
        searchPending.delete(chatId);
      }
      return;
    }

    // ── ❌ Clear search ───────────────────────────────────────────────────
    if (data.startsWith('rec_clearsearch:')) {
      const chatId  = parseInt(data.split(':')[1]);
      const session = sessions.get(chatId);
      if (!session) return bot.answerCallbackQuery(query.id);
      bot.answerCallbackQuery(query.id);
      session.rows       = session.allRows;
      session.searchTerm = '';
      session.page       = 1;
      await showPage(bot, chatId, 1, session.msgId);
      return;
    }

    // ── Page navigation ──────────────────────────────────────────────────
    if (data.startsWith('rec_page:')) {
      const parts  = data.split(':');
      const chatId = parseInt(parts[1]);
      const page   = parseInt(parts[2]);
      bot.answerCallbackQuery(query.id);
      const session = sessions.get(chatId);
      if (!session) return;
      await showPage(bot, chatId, page, session.msgId);
      return;
    }
  });

  // ── Intercept search term ─────────────────────────────────────────────
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.text || !searchPending.has(chatId)) return;
    const { promptMsgId } = searchPending.get(chatId);
    searchPending.delete(chatId);
    await bot.deleteMessage(chatId, promptMsgId).catch(() => {});
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    const session = sessions.get(chatId);
    if (!session) return;
    const term = msg.text.trim();
    if (/^(all|clear|reset)$/i.test(term)) {
      session.rows = session.allRows;
      session.searchTerm = '';
    } else {
      session.rows = filterRows(session.allRows, term);
      session.searchTerm = term;
    }
    session.page       = 1;
    await showPage(bot, chatId, 1, session.msgId);
  });
};
