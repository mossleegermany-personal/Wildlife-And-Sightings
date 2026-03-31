'use strict';

const { LOCATION_TO_CODE } = require('./constants');
const { geocodeLocation }  = require('../../../animalIdentification/services/gbifService');
const logger               = require('../../../../src/utils/logger');

/**
 * Haversine-based radius (km) of a Nominatim bounding box [south, north, west, east].
 * Returns half the longer span so the center-point search covers the full bbox.
 */
function bboxRadiusKm(bb) {
  if (!bb || bb.length < 4) return 25;
  const [south, north, west, east] = bb;
  const R = 6371, toRad = d => d * Math.PI / 180;
  function hav(lat1, lng1, lat2, lng2) {
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return Math.max(hav(south, west, north, west), hav(south, west, south, east)) / 2;
}

function toRegionCode(input) {
  if (!input) return 'WORLD';
  const cleaned = input.trim();
  if (/^[A-Z]{1,3}(-[A-Z0-9]{1,4}){0,2}$/i.test(cleaned) && cleaned.length <= 10) {
    return cleaned.toUpperCase();
  }
  const lower = cleaned.toLowerCase();
  for (const [name, code] of Object.entries(LOCATION_TO_CODE)) {
    if (lower === name || lower.includes(name) || name.includes(lower)) {
      return code;
    }
  }
  return cleaned.toUpperCase();
}

/**
 * Async version of toRegionCode that falls back to Nominatim geocoding.
 * Resolves city/prefecture/state names to eBird ISO 3166-2 subdivision or country codes.
 */
async function resolveRegionCode(input) {
  if (!input) return 'WORLD';
  const cleaned = input.trim();
  if (/^[A-Z]{1,3}(-[A-Z0-9]{1,4}){0,2}$/i.test(cleaned) && cleaned.length <= 10) {
    return cleaned.toUpperCase();
  }
  const lower = cleaned.toLowerCase();
  for (const [name, code] of Object.entries(LOCATION_TO_CODE)) {
    if (lower === name || lower.includes(name) || name.includes(lower)) return code;
  }
  try {
    const geo = await geocodeLocation(cleaned);
    if (geo) {
      // Tier 1: Has ISO subdivision (state/prefecture) → eBird region code
      if (geo.isoSubdivision) return geo.isoSubdivision;

      if (geo.osmClass === 'boundary') {
        const radius = bboxRadiusKm(geo.boundingbox);
        if (radius < 50) {
          // Tier 2: Sub-region (e.g. Pasir Ris) → coordinate search with bbox radius
          const r = Math.max(1, Math.min(50, Math.ceil(radius * 1.5)));
          return `COORD:${Number(geo.lat).toFixed(4)},${Number(geo.lng).toFixed(4)},${r}`;
        }
        // Large boundary (country-level) → country code
        return geo.country_code || 'WORLD';
      }

      if (geo.lat != null && geo.lng != null) {
        // Non-boundary (landmark) → coordinate with bbox-derived radius
        const radius = geo.boundingbox ? bboxRadiusKm(geo.boundingbox) : 5;
        const r = Math.max(1, Math.min(50, Math.ceil(radius * 1.5)));
        return `COORD:${Number(geo.lat).toFixed(4)},${Number(geo.lng).toFixed(4)},${r}`;
      }
      return geo.country_code || 'WORLD';
    }
  } catch (err) {
    logger.warn('[birdMenu] resolveRegionCode geocode failed', { input, error: err.message });
  }
  return 'WORLD';
}

module.exports = { toRegionCode, resolveRegionCode, bboxRadiusKm };
