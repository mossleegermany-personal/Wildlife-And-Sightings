/**
 * Google Sheets routes
 *
 * All endpoints are POST; params come from the JSON request body.
 *
 * POST /api/v1/sheets/sightings              append a sighting row
 * POST /api/v1/sheets/sightings/list         retrieve sighting rows
 * POST /api/v1/sheets/identifications        append an identification row
 * POST /api/v1/sheets/identifications/list   retrieve identification rows
 * POST /api/v1/sheets/append                 generic row append
 * POST /api/v1/sheets/read                   generic row read
 */
const express = require('express');
const router = express.Router();
const controller = require('../controllers/sheetsController');

router.post('/sightings', controller.appendSighting);
router.post('/sightings/list', controller.getSightings);
router.post('/identifications', controller.appendIdentification);
router.post('/identifications/list', controller.getIdentifications);
router.post('/append', controller.appendRow);
router.post('/read', controller.readRows);

module.exports = router;
