/**
 * Bird Sighting Bot — route aggregator
 * Mounts sightings, hotspots, and species sub-routers.
 */
const express = require('express');
const router = express.Router();

const sightingsRoutes = require('./sightings');
const hotspotsRoutes = require('./hotspots');
const speciesRoutes = require('./species');

router.use('/sightings', sightingsRoutes);
router.use('/hotspots', hotspotsRoutes);
router.use('/species', speciesRoutes);

module.exports = router;
