/**
 * Structured logger using Winston.
 *
 * Log levels: error, warn, info, debug
 * - Production: JSON output for easy parsing by monitoring tools.
 * - Development: coloured, human-readable output.
 *
 * Usage:
 *   const logger = require('../utils/logger');
 *   logger.info('Server started', { port: 3000 });
 *   logger.error('Service failed', { error: err.message });
 */
const { createLogger, format, transports } = require('winston');

const isProduction = !!process.env.WEBSITE_HOSTNAME;

const logger = createLogger({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  defaultMeta: { service: 'wildlife-sightings-backend' },
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true })
  ),
  transports: [
    new transports.Console({
      format: isProduction
        ? format.combine(format.json())
        : format.combine(
            format.colorize(),
            format.printf(({ timestamp, level, message, service, ...meta }) => {
              const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
              return `${timestamp} [${level}] ${message}${extra}`;
            })
          ),
    }),
  ],
});

module.exports = logger;
