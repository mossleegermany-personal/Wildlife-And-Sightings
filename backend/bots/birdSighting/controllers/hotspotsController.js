/**
 * Hotspots Controller — Bird Sighting Bot
 *
 * All params are read from req.body (POST requests).
 */
const { EBirdService } = require('../services/ebirdService');

const ebird = new EBirdService();

function parseCoords(body) {
  const lat = parseFloat(body.lat);
  const lng = parseFloat(body.lng);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  return { lat, lng };
}

function parseDist(body, defaultDist = 25) {
  const d = parseInt(body.dist, 10);
  return isNaN(d) || d < 1 || d > 50 ? defaultDist : d;
}

function parseBack(body, defaultDays = 7) {
  const b = parseInt(body.back, 10);
  return isNaN(b) || b < 1 || b > 30 ? defaultDays : b;
}

function parseMaxResults(body, defaultMax = 100) {
  const m = parseInt(body.maxResults, 10);
  return isNaN(m) || m < 1 || m > 10000 ? defaultMax : m;
}

function isValidRegionCode(code) {
  return /^[A-Za-z0-9-]{2,10}$/.test(code);
}

/** eBird location IDs follow the pattern L<digits>, e.g. L12345678 */
function isValidLocId(id) {
  return /^L\d{1,10}$/.test(id);
}

/** POST /api/v1/hotspots/nearby — Body: { lat, lng, dist? } */
exports.getNearby = async (req, res, next) => {
  const coords = parseCoords(req.body);
  if (!coords) {
    return res
      .status(400)
      .json({ error: 'Valid lat and lng are required in the request body.' });
  }

  const dist = parseDist(req.body);

  try {
    const hotspots = await ebird.getNearbyHotspots(coords.lat, coords.lng, dist);
    return res.json({ count: hotspots.length, hotspots });
  } catch (err) {
    next(err);
  }
};

/** POST /api/v1/hotspots/region — Body: { regionCode } */
exports.getByRegion = async (req, res, next) => {
  const { regionCode } = req.body;
  if (!regionCode || !isValidRegionCode(regionCode)) {
    return res
      .status(400)
      .json({ error: 'Valid regionCode is required in the request body.' });
  }

  try {
    const hotspots = await ebird.getHotspots(regionCode);
    return res.json({ regionCode, count: hotspots.length, hotspots });
  } catch (err) {
    next(err);
  }
};

/** POST /api/v1/hotspots/observations — Body: { locId, back?, maxResults? } */
exports.getObservations = async (req, res, next) => {
  const { locId } = req.body;
  if (!locId || !isValidLocId(locId)) {
    return res
      .status(400)
      .json({ error: 'Valid locId is required (e.g. "L12345").' });
  }

  const back = parseBack(req.body);
  const maxResults = parseMaxResults(req.body);

  try {
    const observations = await ebird.getHotspotObservations(locId, back, maxResults);
    return res.json({ locId, count: observations.length, observations });
  } catch (err) {
    next(err);
  }
};
