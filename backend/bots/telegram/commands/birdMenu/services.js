'use strict';

const { EBirdService } = require('../../../birdSighting/services/ebirdService');
const sheetsService    = require('../../../../database/googleSheets/services/googleSheetsService');

// Single shared EBirdService instance — all modules import from here
const ebird = new EBirdService(process.env.EBIRD_API_KEY);

module.exports = { ebird, sheetsService };
