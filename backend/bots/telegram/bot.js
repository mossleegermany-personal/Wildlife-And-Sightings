/**
 * Telegram Bot — main entry
 *
 * Registers all command handlers and starts polling.
 * Called from bin/www so both the REST API and the bot
 * run in the same process.
 *
 * Uses long-polling (no webhook required for local dev).
 * Switch to webhook in production by setting TELEGRAM_WEBHOOK_URL in .env.
 */

const TelegramBot = require('node-telegram-bot-api');
const logger = require('../../src/utils/logger');

// ── Menu ──────────────────────────────────────────────────────────────────────
const { registerMainMenu } = require('./menu/mainMenu');

// ── Commands ──────────────────────────────────────────────────────────────────
const registerStart    = require('./commands/start');
const registerHelp     = require('./commands/help');
const registerAbout    = require('./commands/about');
const registerSightings = require('./commands/sightings');
const registerHotspots = require('./commands/hotspots');
const registerSpecies  = require('./commands/species');
const registerIdentify = require('./commands/identify');
const registerRecords  = require('./commands/records');

// ─────────────────────────────────────────────────────────────────────────────

function createBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram bot will not start');
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });

  // Register menu callbacks (inline buttons)
  registerMainMenu(bot);

  // Register all command handlers
  registerStart(bot);
  registerHelp(bot);
  registerAbout(bot);
  registerSightings(bot);
  registerHotspots(bot);
  registerSpecies(bot);
  registerIdentify(bot);
  registerRecords(bot);

  // Unknown command fallback — only fires if the command is not in the known list
  const KNOWN_COMMANDS = new Set(['/start', '/help', '/about', '/nearby', '/region', '/notable', '/hotspots', '/search', '/identify_url']);
  bot.onText(/^\/\w+/, (msg) => {
    const cmd = (msg.text || '').split(' ')[0].split('@')[0].toLowerCase();
    if (KNOWN_COMMANDS.has(cmd)) return;
    bot.sendMessage(msg.chat.id, '❓ Unknown command. Type /help to see all available commands.');
  });

  // Polling error handler
  bot.on('polling_error', (err) => {
    logger.error('Telegram polling error', { error: err.message, code: err.code });
  });

  bot.on('error', (err) => {
    logger.error('Telegram bot error', { error: err.message });
  });

  logger.info('Telegram bot started (polling)');
  return bot;
}

module.exports = { createBot };
