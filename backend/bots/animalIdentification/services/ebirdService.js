/**
 * eBird Service — identification flow helpers
 *
 * Wraps the shared eBird taxonomy cache from birdSighting/services/ebirdService
 * for use in the animal identification pipeline.
 *
 * Provides:
 *  - getSpeciesCode(scientificName) → { found, speciesCode, commonName, sciName }
 *  - buildSpeciesUrl(speciesCode)   → 'https://ebird.org/species/<code>'
 */

const { getEBirdSpeciesCode, getEBirdSpeciesCodeByCommonName, getEBirdSubspecificGroups, toUKSpelling } = require('../../birdSighting/services/ebirdService');
const axios = require('axios');
const logger = require('../../../src/utils/logger');
const EBIRD_BASE = 'https://api.ebird.org/v2';

/**
 * Look up the eBird species code for a given scientific name.
 * Uses the cached eBird taxonomy (loaded at startup).
 *
 * @param {string} scientificName - Binomial e.g. "Ceyx erithaca"
 * @returns {Promise<{found: boolean, speciesCode?: string, commonName?: string, scientificName?: string, speciesUrl?: string}>}
 */
async function getSpeciesCode(nameInput) {
  try {
    // 1. Try exact scientific name match (genus + species)
    const sciResult = await getEBirdSpeciesCode(nameInput);
    if (sciResult.found) {
      return {
        found: true,
        speciesCode: sciResult.speciesCode,
        commonName: sciResult.commonName,
        scientificName: sciResult.scientificName,
        speciesUrl: `https://ebird.org/species/${sciResult.speciesCode}`,
      };
    }

    // 2. Try as common name with US/UK spelling variants
    const comResult = await getEBirdSpeciesCodeByCommonName(nameInput);
    if (comResult.found) {
      return {
        found: true,
        speciesCode: comResult.speciesCode,
        commonName: comResult.commonName,
        scientificName: comResult.scientificName,
        speciesUrl: `https://ebird.org/species/${comResult.speciesCode}`,
      };
    }

    return { found: false };
  } catch (err) {
    logger.warn('eBird species code lookup failed', { name: nameInput, error: err.message });
    return { found: false };
  }
}

/**
 * Build a direct eBird species page URL from a species code.
 *
 * @param {string} speciesCode - e.g. 'oridwa1'
 * @returns {string}
 */
function buildSpeciesUrl(speciesCode) {
  return `https://ebird.org/species/${speciesCode}`;
}

/**
 * Fetch nearby eBird observations for a specific species code.
 *
 * @param {string} speciesCode
 * @param {{lat:number,lng:number}} coords
 * @param {number} [back=30]
 * @returns {Promise<{found:boolean,count:number,recentDates:string[]}>}
 */
/**
 * Fetch eBird observations for a species, using country region if available, else coordinates.
 * @param {string} speciesCode
 * @param {{lat:number,lng:number, countryCode?:string, isCountryOnly?:boolean}} coords
 * @param {number} [back=30]
 * @returns {Promise<{found:boolean,count:number,recentDates:string[]}>}
 */
async function getNearbySpeciesObservations(speciesCode, coords, back = 30) {
  try {
    const token = process.env.EBIRD_API_KEY;
    if (!token || !speciesCode || !coords) {
      return { found: false, count: 0, recentDates: [] };
    }

    // If coords.isCountryOnly and coords.countryCode, use region endpoint
    if (coords.isCountryOnly && coords.countryCode) {
      // eBird expects ISO 2-letter country code, uppercase
      const regionCode = coords.countryCode.toUpperCase();
      const response = await axios.get(`${EBIRD_BASE}/data/obs/${regionCode}/recent/${speciesCode}`, {
        params: {
          back: 30,
          includeProvisional: true,
        },
        headers: { 'X-eBirdApiToken': token },
        timeout: 15000,
      });
      const records = Array.isArray(response.data) ? response.data : [];
      return {
        found: true,
        count: records.length,
        recentDates: records.map((r) => r.obsDt).filter(Boolean).slice(0, 20),
      };
    }

    // Otherwise, use geo endpoint
    const response = await axios.get(`${EBIRD_BASE}/data/obs/geo/recent/${speciesCode}`, {
      params: {
        lat: coords.lat,
        lng: coords.lng,
        dist: 50,
        back: 30,
        includeProvisional: true,
      },
      headers: { 'X-eBirdApiToken': token },
      timeout: 15000,
    });
    const records = Array.isArray(response.data) ? response.data : [];
    return {
      found: true,
      count: records.length,
      recentDates: records.map((r) => r.obsDt).filter(Boolean).slice(0, 20),
    };
  } catch (err) {
    logger.warn('eBird species observations lookup failed', {
      speciesCode,
      error: err.message,
    });
    return { found: false, count: 0, recentDates: [] };
  }
}

module.exports = { getSpeciesCode, buildSpeciesUrl, getNearbySpeciesObservations, getEBirdSubspecificGroups, toUKSpelling };
