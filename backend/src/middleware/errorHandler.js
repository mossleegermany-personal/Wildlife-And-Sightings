/**
 * Centralised Express error handler.
 *
 * Must be registered AFTER all routes (4-argument middleware).
 * Handles Multer errors, validation errors, and unexpected server errors.
 */
const logger = require('../utils/logger');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Multer file-size / type errors
  if (err.name === 'MulterError') {
    return res.status(400).json({
      success: false,
      error: err.message,
    });
  }

  // File-type validation error thrown by our fileFilter
  if (err.message?.startsWith('Invalid file type')) {
    return res.status(400).json({
      success: false,
      error: err.message,
    });
  }

  logger.error('Unhandled server error', {
    method: req.method,
    url: req.url,
    error: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
}

module.exports = errorHandler;
