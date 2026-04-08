/**
 * Sightings Controller — Bird Sighting Bot
 *
 * All params are read from req.body (POST requests).
 */
const { EBirdService } = require('../services/ebirdService');

const ebird = new EBirdService();

// ----- shared param parsers --------------------------------------------------

function parseCoords(body) {
  const lat = parseFloat(body.lat);
  const lng = parseFloat(body.lng);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  return { lat, lng };
}

function parseBack(body, defaultDays = 7) {
  const b = parseInt(body.back, 10);
  return isNaN(b) || b < 1 || b > 30 ? defaultDays : b;
}

function parseMaxResults(body, defaultMax = 100) {
  const m = parseInt(body.maxResults, 10);
  return isNaN(m) || m < 1 || m > 10000 ? defaultMax : m;
}

function parseDist(body, defaultDist = 25) {
  const d = parseInt(body.dist, 10);
  return isNaN(d) || d < 1 || d > 50 ? defaultDist : d;
}

function isValidRegionCode(code) {
  return /^[A-Za-z0-9-]{2,10}$/.test(code);
}

function isValidSpeciesCode(code) {
  return /^[a-z0-9]{3,10}$/.test(code);
}

// ----- handlers --------------------------------------------------------------

/** POST /api/v1/sightings/nearby — Body: { lat, lng, dist?, back?, maxResults? } */
exports.getNearby = async (req, res, next) => {
  const coords = parseCoords(req.body);
  if (!coords) {
    return res
      .status(400)
      .json({ error: 'Valid lat and lng are required in the request body.' });
  }

  const dist = parseDist(req.body);
  const back = parseBack(req.body);
  const maxResults = parseMaxResults(req.body);

  try {
    const observations = await ebird.getNearbyObservations(
      coords.lat, coords.lng, dist, back, maxResults
    );
    return res.json({ count: observations.length, observations });
  } catch (err) {
    next(err);
  }
};

/** POST /api/v1/sightings/region — Body: { regionCode, back?, maxResults? } */
exports.getByRegion = async (req, res, next) => {
  const { regionCode } = req.body;
  if (!regionCode || !isValidRegionCode(regionCode)) {
    return res
      .status(400)
      .json({ error: 'Valid regionCode is required in the request body.' });
  }

  const back = parseBack(req.body);
  const maxResults = parseMaxResults(req.body);

  try {
    const observations = await ebird.getRecentObservations(regionCode, back, maxResults);
    return res.json({ regionCode, count: observations.length, observations });
  } catch (err) {
    next(err);
  }
};

/** POST /api/v1/sightings/notable — Body: { regionCode, back?, maxResults? } */
exports.getNotable = async (req, res, next) => {
  const { regionCode } = req.body;
  if (!regionCode || !isValidRegionCode(regionCode)) {
    return res
      .status(400)
      .json({ error: 'Valid regionCode is required in the request body.' });
  }

  const back = parseBack(req.body);
  const maxResults = parseMaxResults(req.body);

  try {
    const observations = await ebird.getNotableObservations(regionCode, back, maxResults);
    return res.json({ regionCode, count: observations.length, observations });
  } catch (err) {
    next(err);
  }
};

/** POST /api/v1/sightings/species — Body: { regionCode, speciesCode, back? } */
exports.getBySpecies = async (req, res, next) => {
  const { regionCode, speciesCode } = req.body;
  if (!regionCode || !isValidRegionCode(regionCode)) {
    return res.status(400).json({ error: 'Valid regionCode is required.' });
  }
  if (!speciesCode || !isValidSpeciesCode(speciesCode)) {
    return res.status(400).json({ error: 'Valid speciesCode is required (e.g. "baleag").' });
  }

  const back = parseBack(req.body);

  try {
    const observations = await ebird.getSpeciesObservations(regionCode, speciesCode, back);
    // Enrich with ML media (best-effort, in parallel, cap at first 20 obs)
    await Promise.allSettled(
      observations.slice(0, 20)
        .filter(o => o.subId && o.speciesCode)
        .map(async (obs) => {
          const ml = await ebird.getMLMediaForChecklist(obs.speciesCode, obs.subId);
          if (ml) obs.mlMedia = ml;
        })
    );
    return res.json({ regionCode, speciesCode, count: observations.length, observations });
  } catch (err) {
    next(err);
  }
};
