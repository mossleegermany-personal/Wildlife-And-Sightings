/**
 * Sightings routes — Bird Sighting Bot
 *
 * All endpoints are POST; params come from the JSON request body.
 *
 * POST /api/v1/sightings/nearby    { lat, lng, dist?, back?, maxResults? }
 * POST /api/v1/sightings/region    { regionCode, back?, maxResults? }
 * POST /api/v1/sightings/notable   { regionCode, back?, maxResults? }
 * POST /api/v1/sightings/species   { regionCode, speciesCode, back? }
 */
const express = require('express');
const router = express.Router();
const controller = require('../controllers/sightingsController');

router.post('/nearby', controller.getNearby);
router.post('/region', controller.getByRegion);
router.post('/notable', controller.getNotable);
router.post('/species', controller.getBySpecies);

module.exports = router;
