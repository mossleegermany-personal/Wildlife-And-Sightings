/**
 * Telegram Bot — main entry
 *
 * Registers all command handlers and starts polling.
 * Called from bin/www so both the REST API and the bot
 * run in the same process.
 *
 * Uses long-polling for local dev by default.
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

function createBot(app) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram bot will not start');
    return null;
  }

  const webhookBaseUrl = String(process.env.TELEGRAM_WEBHOOK_URL || '').trim();
  const webhookPath = String(process.env.TELEGRAM_WEBHOOK_PATH || '/telegram/webhook').trim();
  const webhookSecretToken = String(process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN || '').trim();
  const useWebhook = Boolean(webhookBaseUrl);

  const bot = new TelegramBot(token, useWebhook ? { webHook: { autoOpen: false } } : { polling: true });

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

  if (useWebhook) {
    if (!app) {
      logger.error('Webhook mode requires an Express app instance. Falling back to polling.');
    } else {
      const normalizedPath = webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`;
      const webhookUrl = `${webhookBaseUrl.replace(/\/$/, '')}${normalizedPath}`;

      app.post(normalizedPath, (req, res) => {
        if (webhookSecretToken) {
          const headerToken = req.get('x-telegram-bot-api-secret-token') || '';
          if (headerToken !== webhookSecretToken) {
            return res.status(401).json({ error: 'Invalid webhook secret token' });
          }
        }

        bot.processUpdate(req.body);
        return res.sendStatus(200);
      });

      const webhookOptions = webhookSecretToken ? { secret_token: webhookSecretToken } : undefined;
      bot.setWebHook(webhookUrl, webhookOptions)
        .then(() => {
          logger.info('Telegram bot started (webhook)', { webhookUrl, webhookPath: normalizedPath });
        })
        .catch((err) => {
          logger.error('Failed to set Telegram webhook', { error: err.message, webhookUrl });
        });
    }
  } else {
    // Polling error handler
    bot.on('polling_error', (err) => {
      logger.error('Telegram polling error', { error: err.message, code: err.code });
    });

    logger.info('Telegram bot started (polling)');
  }

  bot.on('error', (err) => {
    logger.error('Telegram bot error', { error: err.message });
  });

  return bot;
}

module.exports = { createBot };
