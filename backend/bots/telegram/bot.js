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
const registerSightings    = require('./commands/sightings');
const registerAddSighting  = require('./commands/addSighting');
const { registerBirdMenu } = require('./commands/birdMenu');
const registerHotspots     = require('./commands/hotspots');
const registerSpecies      = require('./commands/species');
const registerIdentify     = require('./commands/identify');
const registerRecords      = require('./commands/records');

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
  const isAzureHost = Boolean(process.env.WEBSITE_HOSTNAME);
  const forceWebhook = String(process.env.TELEGRAM_FORCE_WEBHOOK || '').toLowerCase() === 'true';
  const forcePolling = String(process.env.TELEGRAM_FORCE_POLLING || '').toLowerCase() === 'true';

  let useWebhook = false;
  if (forceWebhook && forcePolling) {
    logger.warn('Both TELEGRAM_FORCE_WEBHOOK and TELEGRAM_FORCE_POLLING are true. Using webhook mode.');
    useWebhook = true;
  } else if (forceWebhook) {
    useWebhook = true;
  } else if (forcePolling) {
    useWebhook = false;
  } else {
    // Default behaviour:
    // - Azure App Service: webhook if URL configured
    // - Localhost/dev: polling
    useWebhook = isAzureHost && Boolean(webhookBaseUrl);
  }

  const bot = new TelegramBot(token, {
    polling: false,
    webHook: { autoOpen: false },
  });

  // answerCallbackQuery is always fire-and-forget — swallow every error.
  // On Azure, queries can be stale (400) or face transient network errors;
  // either way crashing the process for a non-answer is never correct.
  const _answerCbq = bot.answerCallbackQuery.bind(bot);
  bot.answerCallbackQuery = (...args) => _answerCbq(...args).catch(() => {});

  // Register menu callbacks (inline buttons)
  registerMainMenu(bot);

  // Register all command handlers
  registerStart(bot);
  registerHelp(bot);
  registerAbout(bot);
  registerSightings(bot);
  registerAddSighting(bot);
  // Pass addSighting's sessions map so birdMenu never intercepts those messages
  registerBirdMenu(bot, registerAddSighting.sessions);
  registerHotspots(bot);
  registerSpecies(bot);
  registerIdentify(bot);
  registerRecords(bot);

  // Unknown command fallback — only fires if the command is not in the known list
  const KNOWN_COMMANDS = new Set(['/start', '/help', '/about', '/nearby', '/region', '/notable', '/hotspots', '/search', '/identify_url', '/addsighting', '/cancel']);
  bot.onText(/^\/\w+/, (msg) => {
    const cmd = (msg.text || '').split(' ')[0].split('@')[0].toLowerCase();
    if (KNOWN_COMMANDS.has(cmd)) return;
    bot.sendMessage(msg.chat.id, '❓ Unknown command. Type /help to see all available commands.');
  });

  if (useWebhook) {
    if (!app) {
      logger.error('Webhook mode requires an Express app instance. Falling back to polling.');
      bot.deleteWebHook({ drop_pending_updates: false })
        .catch(() => null)
        .finally(() => {
          bot.startPolling()
            .then(() => logger.info('Telegram bot started (polling fallback)'))
            .catch((err) => logger.error('Failed to start Telegram polling fallback', { error: err.message }));
        });
    } else {
      const normalizedPath = webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`;
      const webhookUrl = `${webhookBaseUrl.replace(/\/$/, '')}${normalizedPath}`;

      app.post(normalizedPath, (req, res) => {
        if (webhookSecretToken) {
          const headerToken = req.get('x-telegram-bot-api-secret-token') || '';
          if (headerToken !== webhookSecretToken) {
            logger.warn('[webhook] Rejected update — invalid secret token');
            return res.status(401).json({ error: 'Invalid webhook secret token' });
          }
        }

        const update = req.body;
        const updateType = update.message ? 'message'
          : update.callback_query ? 'callback_query'
          : update.edited_message ? 'edited_message'
          : update.channel_post ? 'channel_post'
          : 'unknown';
        const cbData = update.callback_query?.data;
        const text   = update.message?.text;
        logger.info('[webhook] Update received', {
          updateId: update.update_id,
          type: updateType,
          ...(cbData && { cbData }),
          ...(text   && { text }),
        });

        try {
          bot.processUpdate(update);
        } catch (err) {
          logger.error('[webhook] processUpdate threw', { error: err.message, stack: err.stack });
        }
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

    bot.deleteWebHook({ drop_pending_updates: false })
      .catch(() => null)
      .finally(() => {
        bot.startPolling()
          .then(() => logger.info('Telegram bot started (polling)'))
          .catch((err) => logger.error('Failed to start Telegram polling', { error: err.message }));
      });
  }

  bot.on('error', (err) => {
    logger.error('Telegram bot error', { error: err.message });
  });

  return bot;
}

module.exports = { createBot };
