/**
 * Identification routes — Animal Identification Bot
 *
 * POST /api/v1/identify        multipart/form-data (field: image)
 * POST /api/v1/identify/url    JSON body { imageUrl, ... }
 */
const express = require('express');
const router = express.Router();

const { identifyLimiter } = require('../../../src/middleware/rateLimiter');
const upload = require('../../../src/middleware/upload');
const controller = require('../controllers/identificationController');

router.post('/', identifyLimiter, upload.single('image'), controller.identifyFromUpload);
router.post('/url', identifyLimiter, controller.identifyFromUrl);

module.exports = router;
