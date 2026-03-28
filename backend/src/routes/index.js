/**
 * Route aggregator — mounts all sub-routers under /api/v1
 *
 * Bot subfolders:
 *   identification/  — Animal Identification Bot
 *   birdSighting/    — Bird Sighting Bot
 *   googleSheets/    — Google Sheets data integration
 */
const express = require('express');
const router = express.Router();

const identificationRoutes = require('../../bots/animalIdentification/routes');
const birdSightingRoutes = require('../../bots/birdSighting/routes');
const googleSheetsRoutes = require('../../database/googleSheets/routes');

router.use('/identify', identificationRoutes);
router.use('/', birdSightingRoutes);      // mounts /sightings, /hotspots, /species
router.use('/sheets', googleSheetsRoutes);

module.exports = router;
