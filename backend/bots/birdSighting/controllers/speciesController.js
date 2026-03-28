/**
 * Species Controller — Bird Sighting Bot
 *
 * All params are read from req.body (POST requests).
 */
const { EBirdService } = require('../services/ebirdService');

const ebird = new EBirdService();

function parseBack(body, defaultDays = 7) {
  const b = parseInt(body.back, 10);
  return isNaN(b) || b < 1 || b > 30 ? defaultDays : b;
}

function isValidRegionCode(code) {
  return /^[A-Za-z0-9-]{2,10}$/.test(code);
}

/** POST /api/v1/species/search — Body: { q, limit? } */
exports.search = async (req, res, next) => {
  const query = (req.body.q || '').trim();
  if (!query || query.length < 2) {
    return res.status(400).json({ error: 'q must be at least 2 characters.' });
  }
  if (query.length > 100) {
    return res.status(400).json({ error: 'q is too long (max 100 characters).' });
  }

  let limit = parseInt(req.body.limit, 10);
  if (isNaN(limit) || limit < 1) limit = 10;
  if (limit > 50) limit = 50;

  try {
    const results = await ebird.searchSpeciesByName(query, limit);
    return res.json({ query, count: results.length, results });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/species/observations
 * Body: { regionCode, speciesName, back? }
 * speciesName can be the common or scientific name.
 */
exports.getObservations = async (req, res, next) => {
  const { regionCode, speciesName: rawSpeciesName } = req.body;
  const speciesName = (rawSpeciesName || '').trim();

  if (!regionCode || !isValidRegionCode(regionCode)) {
    return res.status(400).json({ error: 'Valid regionCode is required.' });
  }
  if (!speciesName || speciesName.length < 2 || speciesName.length > 100) {
    return res
      .status(400)
      .json({ error: 'speciesName must be between 2 and 100 characters.' });
  }

  const back = parseBack(req.body);

  try {
    const observations = await ebird.getObservationsBySpeciesName(
      regionCode, speciesName, back
    );
    return res.json({ regionCode, speciesName, count: observations.length, observations });
  } catch (err) {
    next(err);
  }
};
