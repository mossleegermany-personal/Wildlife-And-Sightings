/**
 * Google Sheets Controller
 *
 * Exposes endpoints for logging and retrieving wildlife data from Google Sheets.
 */
const sheetsService = require('../services/googleSheetsService');
const logger = require('../../../src/utils/logger');

/**
 * POST /api/v1/sheets/sightings
 * Append a bird sighting row.
 * Body: { commonName, scientificName, regionCode, location, lat, lng,
 *         observationDate, count, notes, ebirdUrl, spreadsheetId? }
 */
exports.appendSighting = async (req, res, next) => {
  try {
    const result = await sheetsService.appendSighting(req.body, req.body.spreadsheetId);
    return res.json({ success: true, updatedRange: result.updates?.updatedRange });
  } catch (err) {
    logger.error('Failed to append sighting', { error: err.message });
    next(err);
  }
};

/**
 * POST /api/v1/sheets/sightings/list
 * Retrieve sightings rows.
 * Body: { spreadsheetId?, range? }
 */
exports.getSightings = async (req, res, next) => {
  try {
    const rows = await sheetsService.getSightings(req.body.spreadsheetId, req.body.range);
    return res.json({ count: rows.length, rows });
  } catch (err) {
    logger.error('Failed to get sightings', { error: err.message });
    next(err);
  }
};

/**
 * POST /api/v1/sheets/identifications
 * Append an identification result row.
 * Body: { commonName, scientificName, iucnStatus, accuracy, location,
 *         gbifVerified, ebirdVerified, referencePhotoUrl, model, spreadsheetId? }
 */
exports.appendIdentification = async (req, res, next) => {
  try {
    const result = await sheetsService.appendIdentification(
      req.body,
      req.body.spreadsheetId
    );
    return res.json({ success: true, updatedRange: result.updates?.updatedRange });
  } catch (err) {
    logger.error('Failed to append identification', { error: err.message });
    next(err);
  }
};

/**
 * POST /api/v1/sheets/identifications/list
 * Retrieve identification rows.
 * Body: { spreadsheetId?, range? }
 */
exports.getIdentifications = async (req, res, next) => {
  try {
    const rows = await sheetsService.getIdentifications(
      req.body.spreadsheetId,
      req.body.range
    );
    return res.json({ count: rows.length, rows });
  } catch (err) {
    logger.error('Failed to get identifications', { error: err.message });
    next(err);
  }
};

/**
 * POST /api/v1/sheets/append
 * Generic row append.
 * Body: { spreadsheetId, range, values: [] }
 */
exports.appendRow = async (req, res, next) => {
  const { spreadsheetId, range, values } = req.body;

  if (!spreadsheetId || typeof spreadsheetId !== 'string') {
    return res.status(400).json({ error: 'spreadsheetId is required.' });
  }
  if (!range || typeof range !== 'string') {
    return res.status(400).json({ error: 'range is required (e.g. "Sheet1!A:Z").' });
  }
  if (!Array.isArray(values)) {
    return res.status(400).json({ error: 'values must be an array.' });
  }

  try {
    const result = await sheetsService.appendRow(spreadsheetId, range, values);
    return res.json({ success: true, updatedRange: result.updates?.updatedRange });
  } catch (err) {
    logger.error('Failed to append row', { error: err.message });
    next(err);
  }
};

/**
 * POST /api/v1/sheets/read
 * Generic row read.
 * Body: { spreadsheetId, range }
 */
exports.readRows = async (req, res, next) => {
  const { spreadsheetId, range } = req.body;

  if (!spreadsheetId || typeof spreadsheetId !== 'string') {
    return res.status(400).json({ error: 'spreadsheetId is required.' });
  }
  if (!range || typeof range !== 'string') {
    return res.status(400).json({ error: 'range is required (e.g. "Sheet1!A1:Z100").' });
  }

  try {
    const rows = await sheetsService.getRows(spreadsheetId, range);
    return res.json({ count: rows.length, rows });
  } catch (err) {
    logger.error('Failed to read rows', { error: err.message });
    next(err);
  }
};
