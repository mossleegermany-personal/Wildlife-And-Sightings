/**
 * Multer configuration for in-memory image uploads.
 *
 * Accepts JPEG, PNG, GIF, WebP, HEIC/HEIF images up to 20 MB.
 * The file buffer is passed directly to downstream services (Gemini AI).
 */
const multer = require('multer');

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Accepted: JPEG, PNG, GIF, WebP, HEIC/HEIF.'));
    }
  },
});

module.exports = upload;
