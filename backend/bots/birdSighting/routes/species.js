/**
 * Species routes — Bird Sighting Bot
 *
 * All endpoints are POST; params come from the JSON request body.
 *
 * POST /api/v1/species/search        { q, limit? }
 * POST /api/v1/species/observations  { regionCode, speciesName, back? }
 */
const express = require('express');
const router = express.Router();
const controller = require('../controllers/speciesController');

router.post('/search', controller.search);
router.post('/observations', controller.getObservations);

module.exports = router;
