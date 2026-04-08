/**
 * Rate-limiting middleware factory built on express-rate-limit.
 *
 * Two limiters are exported:
 *  - generalLimiter   — applied to all API routes (default: 60 req/min)
 *  - identifyLimiter  — applied only to /identify endpoints (default: 10 req/min)
 *    because each request triggers an expensive Gemini AI call.
 */
const rateLimit = require('express-rate-limit');

const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const maxGeneral = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '60', 10);
const maxIdentify = parseInt(process.env.IDENTIFY_RATE_LIMIT_MAX || '30', 10);

const generalLimiter = rateLimit({
  windowMs,
  max: maxGeneral,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: `Too many requests. Please wait and try again.`,
  },
});

const identifyLimiter = rateLimit({
  windowMs,
  max: maxIdentify,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: `Too many identification requests. Please wait and try again.`,
  },
});

module.exports = { generalLimiter, identifyLimiter };
