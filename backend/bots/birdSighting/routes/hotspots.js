/**
 * Hotspots routes — Bird Sighting Bot
 *
 * All endpoints are POST; params come from the JSON request body.
 *
 * POST /api/v1/hotspots/nearby        { lat, lng, dist? }
 * POST /api/v1/hotspots/region        { regionCode }
 * POST /api/v1/hotspots/observations  { locId, back?, maxResults? }
 */
const express = require('express');
const router = express.Router();
const controller = require('../controllers/hotspotsController');

router.post('/nearby', controller.getNearby);
router.post('/region', controller.getByRegion);
router.post('/observations', controller.getObservations);

module.exports = router;
