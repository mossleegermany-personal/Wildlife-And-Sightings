/**
 * eBird Service — merged from both bots.
 *
 * Provides two groups of functionality:
 *
 * 1. DATA FETCHING (from Bird-Sighting-Bot)
 *    Used by the REST routes to serve bird sighting data.
 *    Exported as an EBirdService class.
 *
 * 2. TAXONOMY VERIFICATION (from Animal-Identification-Bot)
 *    Used by the Identification flow to verify Gemini's result and build links.
 *    Exported as standalone functions: getEBirdSpeciesCode, verifyWithEBird.
 *
 * Both groups share a single taxonomy cache to avoid redundant downloads.
 */
const axios = require('axios');
const logger = require('../../../src/utils/logger');

const EBIRD_BASE = 'https://api.ebird.org/v2';

// ─── Shared taxonomy cache ────────────────────────────────────────────────────
let _taxonomyCache = null;
let _cacheTimestamp = 0;
let _issfCache = null;
let _issfTimestamp = 0;
const _regionalSppCache = new Map(); // regionCode → { codes: Set, ts: number }
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

async function _loadTaxonomy(apiKey) {
  const now = Date.now();
  if (_taxonomyCache && now - _cacheTimestamp < CACHE_TTL) {
    return _taxonomyCache;
  }

  logger.info('Downloading eBird taxonomy...');
  const response = await axios.get(`${EBIRD_BASE}/ref/taxonomy/ebird`, {
    params: { fmt: 'json', cat: 'species' },
    headers: { 'X-eBirdApiToken': apiKey },
    timeout: 30000,
  });

  _taxonomyCache = response.data;
  _cacheTimestamp = now;
  logger.info('eBird taxonomy cached', { species: _taxonomyCache.length });
  return _taxonomyCache;
}

async function _loadIssfTaxonomy(apiKey) {
  const now = Date.now();
  if (_issfCache && now - _issfTimestamp < CACHE_TTL) return _issfCache;
  const response = await axios.get(`${EBIRD_BASE}/ref/taxonomy/ebird`, {
    params: { fmt: 'json', cat: 'issf' },
    headers: { 'X-eBirdApiToken': apiKey },
    timeout: 30000,
  });
  _issfCache = response.data;
  _issfTimestamp = now;
  return _issfCache;
}

/**
 * Fetch the list of species codes (including ISSF) reported in a region, with caching.
 * Uses GET /v2/product/spplist/{regionCode}
 */
async function _loadRegionalSpeciesList(regionCode, apiKey) {
  const key = regionCode.toUpperCase();
  const cached = _regionalSppCache.get(key);
  const now = Date.now();
  if (cached && now - cached.ts < CACHE_TTL) return cached.codes;
  try {
    const response = await axios.get(`${EBIRD_BASE}/product/spplist/${key}`, {
      headers: { 'X-eBirdApiToken': apiKey },
      timeout: 15000,
    });
    const codes = new Set(Array.isArray(response.data) ? response.data : []);
    _regionalSppCache.set(key, { codes, ts: now });
    return codes;
  } catch (err) {
    logger.warn('eBird regional species list fetch failed', { regionCode: key, error: err.message });
    return null; // null = unknown, caller should not filter
  }
}

/**
 * Get eBird Identifiable Sub-specific Groups (ISSF) ever spotted in a region.
 *
 * eBird's /product/spplist returns every species + subspecies code that has ever
 * been recorded (spotted) in the region — residents, migrants, winter visitors,
 * passage migrants, and rarities are all included.
 *
 * If regionCode is supplied, only ISSF groups with an observation record in that
 * country are returned; all groups are returned when regionCode is omitted.
 *
 * @param {string} speciesCode - parent species code e.g. 'perfal'
 * @param {string} [regionCode] - ISO 2-letter country code e.g. 'SG'
 * @returns {Promise<string[]>} - array of trinomial sciNames filtered to sightings in region
 */
async function getEBirdSubspecificGroups(speciesCode, regionCode) {
  if (!speciesCode) return [];
  try {
    const issf = await _loadIssfTaxonomy(process.env.EBIRD_API_KEY);
    const allGroups = issf.filter(t => t.reportAs === speciesCode);
    logger.debug('ISSF groups for species', { speciesCode, total: allGroups.length, regionCode });
    if (allGroups.length === 0) return [];

    if (regionCode) {
      const regional = await _loadRegionalSpeciesList(regionCode, process.env.EBIRD_API_KEY);
      if (regional && regional.size > 0) {
        const filtered = allGroups.filter(t => regional.has(t.speciesCode));
        logger.debug('ISSF groups after regional filter', { filtered: filtered.length, regionCode });
        // Only use filtered list if it actually contains results — otherwise show all
        if (filtered.length > 0) {
          return filtered.map(t => t.sciName).filter(Boolean);
        }
      }
    }
    // Fallback: return all ISSF groups for this species
    return allGroups.map(t => t.sciName).filter(Boolean);
  } catch (err) {
    logger.warn('eBird ISSF lookup failed', { speciesCode, error: err.message });
    return [];
  }
}

// ─── EBirdService class (data fetching) ───────────────────────────────────────
class EBirdService {
  /**
   * @param {string} apiKey - eBird API key
   */
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.client = axios.create({
      baseURL: EBIRD_BASE,
      headers: { 'X-eBirdApiToken': apiKey },
      timeout: 15000,
    });
  }

  /** Preload taxonomy cache at startup so the first search is instant. */
  async preloadTaxonomy() {
    try {
      await _loadTaxonomy(this.apiKey);
    } catch (err) {
      logger.warn('Failed to preload taxonomy (will fetch on first search)', {
        error: err.message,
      });
    }
  }

  /** @returns {Promise<Array>} Full species taxonomy array */
  async getTaxonomy() {
    return _loadTaxonomy(this.apiKey);
  }

  /**
   * Recent bird observations in a region.
   *
   * @param {string} regionCode - e.g. 'US', 'US-NY', 'US-NY-109'
   * @param {number} [back=14]  - Days back (1–30)
   * @param {number} [maxResults=20]
   */
  async getRecentObservations(regionCode, back = 14, maxResults = 20) {
    const clean = regionCode.trim().toUpperCase();
    logger.debug('Fetching observations', { region: clean });
    const response = await this.client.get(`/data/obs/${clean}/recent`, {
      params: { back, maxResults, detail: 'full' },
    });
    return response.data;
  }

  /**
   * Notable (rare) observations in a region.
   *
   * @param {string} regionCode
   * @param {number} [back=14]
   * @param {number} [maxResults=20]
   */
  async getNotableObservations(regionCode, back = 14, maxResults = 20) {
    const response = await this.client.get(
      `/data/obs/${regionCode.trim().toUpperCase()}/recent/notable`,
      { params: { back, maxResults, detail: 'full' } }
    );
    return response.data;
  }

  /**
   * Observations of a specific species in a region.
   *
   * @param {string} regionCode
   * @param {string} speciesCode - eBird species code (e.g. 'cangoo')
   * @param {number} [back=14]
   */
  async getSpeciesObservations(regionCode, speciesCode, back = 14) {
    const response = await this.client.get(
      `/data/obs/${regionCode.trim().toUpperCase()}/recent/${speciesCode}`,
      { params: { back, detail: 'full' } }
    );
    return response.data;
  }

  /**
   * Nearby observations based on GPS coordinates.
   *
   * @param {number} lat
   * @param {number} lng
   * @param {number} [dist=25]       - km (max 50)
   * @param {number} [back=14]
   * @param {number} [maxResults=20]
   */
  async getNearbyObservations(lat, lng, dist = 25, back = 14, maxResults = 20) {
    const response = await this.client.get('/data/obs/geo/recent', {
      params: { lat, lng, dist, back, maxResults, detail: 'full' },
    });
    return response.data;
  }

  /**
   * Nearby observations of a specific species based on GPS coordinates.
   *
   * @param {number} lat
   * @param {number} lng
   * @param {string} speciesCode
   * @param {number} [dist=25]
   * @param {number} [back=14]
   */
  async getNearbySpeciesObservations(lat, lng, speciesCode, dist = 25, back = 14) {
    const response = await this.client.get(`/data/obs/geo/recent/${speciesCode}`, {
      params: { lat, lng, dist, back, detail: 'full' },
    });
    return response.data;
  }

  /**
   * Full checklist details including per-species comments.
   *
   * @param {string} subId  - eBird submission ID e.g. "S312315508"
   * @returns {Promise<Object>} checklist object with `obs` array
   */
  async getChecklist(subId) {
    const response = await this.client.get(`/product/checklist/view/${subId}`);
    return response.data;
  }

  /**
   * Fetch Macaulay Library assets for a specific eBird observation ID.
   * Uses the public ML catalog search API (no auth required).
   * Returns { photos: string[], audios: string[], videos: string[] } or null.
   *
   * @param {string} obsId  - e.g. "OBS4235835476"
   */
  async getMLMediaForChecklist(speciesCode, subId) {
    try {
      const response = await axios.get('https://search.macaulaylibrary.org/api/v1/search', {
        params: { taxonCode: speciesCode, count: 100 },
        timeout: 5000,
      });
      const content = response.data?.results?.content;
      if (!Array.isArray(content)) return null;
      // Filter to only assets explicitly linked to this checklist
      const mine = content.filter(a => a.eBirdChecklistId === subId);
      if (mine.length === 0) return null;
      const result = { photos: [], audios: [], videos: [] };
      for (const asset of mine) {
        const type = (asset.mediaType || '').toLowerCase();
        // Photos: CDN mediaUrl opens as a plain image inline
        // Audio/Video: specimenUrl opens the ML asset page with its player (CDN URLs trigger a download in Telegram)
        if (type === 'audio' || type === 'sound') {
          const url = asset.specimenUrl || '';
          if (url) result.audios.push(url);
        } else if (type === 'video') {
          const url = asset.specimenUrl || '';
          if (url) result.videos.push(url);
        } else {
          const url = asset.mediaUrl || asset.largeUrl || '';
          if (url) result.photos.push(url);
        }
      }
      if (!result.photos.length && !result.audios.length && !result.videos.length) return null;
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Nearby notable observations.
   *
   * @param {number} lat
   * @param {number} lng
   * @param {number} [dist=25]
   * @param {number} [back=14]
   */
  async getNearbyNotableObservations(lat, lng, dist = 25, back = 14) {
    const response = await this.client.get('/data/obs/geo/recent/notable', {
      params: { lat, lng, dist, back, detail: 'full' },
    });
    return response.data;
  }

  /**
   * Hotspots in a region.
   *
   * @param {string} regionCode
   */
  async getHotspots(regionCode) {
    const response = await this.client.get(
      `/ref/hotspot/${regionCode.trim().toUpperCase()}`
    );
    return response.data;
  }

  /**
   * Nearby hotspots based on GPS coordinates.
   *
   * @param {number} lat
   * @param {number} lng
   * @param {number} [dist=25]
   */
  async getNearbyHotspots(lat, lng, dist = 25) {
    const response = await this.client.get('/ref/hotspot/geo', {
      params: { lat, lng, dist },
    });
    return response.data;
  }

  /**
   * Observations at a specific hotspot location.
   *
   * @param {string} locId      - eBird location ID (e.g. 'L123456')
   * @param {number} [back=14]
   * @param {number} [maxResults=100]
   */
  async getHotspotObservations(locId, back = 14, maxResults = 100) {
    const response = await this.client.get(`/data/obs/${locId}/recent`, {
      params: { back, maxResults, detail: 'full' },
    });
    return response.data;
  }

  /**
   * Search species by common or scientific name (uses cached taxonomy).
   *
   * @param {string} query
   * @param {number} [limit=10]
   * @returns {Promise<Array>}
   */
  async searchSpeciesByName(query, limit = 10) {
    const taxonomy = await this.getTaxonomy();
    const q = query.toLowerCase().trim();

    const matches = taxonomy.filter((s) => {
      const com = (s.comName || '').toLowerCase();
      const sci = (s.sciName || '').toLowerCase();
      return com.includes(q) || sci.includes(q);
    });

    matches.sort((a, b) => {
      const aS = a.comName.toLowerCase().startsWith(q);
      const bS = b.comName.toLowerCase().startsWith(q);
      if (aS && !bS) return -1;
      if (!aS && bS) return 1;
      return a.comName.localeCompare(b.comName);
    });

    return matches.slice(0, limit);
  }

  /**
   * Observations for a species searched by its common or scientific name.
   * Resolves the name → species code first via the taxonomy.
   *
   * @param {string} regionCode
   * @param {string} speciesName
   * @param {number} [back=14]
   */
  async getObservationsBySpeciesName(regionCode, speciesName, back = 14) {
    const matches = await this.searchSpeciesByName(speciesName, 10);
    if (!matches || matches.length === 0) {
      return { species: null, observations: [], error: 'Species not found' };
    }

    const species = matches[0];
    const observations = await this.getSpeciesObservations(
      regionCode,
      species.speciesCode,
      back
    );

    return {
      species: {
        code: species.speciesCode,
        commonName: species.comName,
        scientificName: species.sciName,
      },
      observations,
      alternatives: matches.slice(1, 5),
    };
  }

  /**
   * Historic observations on a date in a region.
   *
   * @param {string} regionCode
   * @param {string|number} year
   * @param {string|number} month
   * @param {string|number} day
   * @param {number} [maxResults=50]
   */
  async getHistoricObservations(regionCode, year, month, day, maxResults = 50) {
    const response = await this.client.get(
      `/data/obs/${regionCode.trim().toUpperCase()}/historic/${year}/${month}/${day}`,
      { params: { maxResults } }
    );
    return response.data;
  }

  /**
   * Species list (codes) ever recorded in a region.
   *
   * @param {string} regionCode
   * @returns {Promise<string[]>} array of species codes
   */
  async getSpeciesList(regionCode) {
    const response = await this.client.get(
      `/product/spplist/${regionCode.trim().toUpperCase()}`
    );
    return Array.isArray(response.data) ? response.data : [];
  }

  /**
   * Recent checklists feed for a region.
   *
   * @param {string} regionCode
   * @param {number} [maxResults=10]
   */
  async getRecentChecklists(regionCode, maxResults = 10) {
    const response = await this.client.get(
      `/product/lists/${regionCode.trim().toUpperCase()}`,
      { params: { maxResults } }
    );
    return response.data;
  }

  /**
   * Regional statistics on a date.
   *
   * @param {string} regionCode
   * @param {string|number} year
   * @param {string|number} month
   * @param {string|number} day
   */
  async getRegionalStats(regionCode, year, month, day) {
    const response = await this.client.get(
      `/product/stats/${regionCode.trim().toUpperCase()}/${year}/${month}/${day}`
    );
    return response.data;
  }

  /**
   * Top 100 eBird contributors in a region on a date.
   *
   * @param {string} regionCode
   * @param {string|number} year
   * @param {string|number} month
   * @param {string|number} day
   * @param {number} [maxResults=100]
   */
  async getTop100(regionCode, year, month, day, maxResults = 100) {
    const response = await this.client.get(
      `/product/top100/${regionCode.trim().toUpperCase()}/${year}/${month}/${day}`,
      { params: { maxResults } }
    );
    return response.data;
  }

  /**
   * Information about a hotspot location.
   *
   * @param {string} locId - e.g. 'L5765808'
   */
  async getHotspotInfo(locId) {
    const response = await this.client.get(`/ref/hotspot/info/${locId}`);
    return response.data;
  }

  /**
   * Taxonomic forms (subspecies codes) for a species.
   *
   * @param {string} speciesCode - e.g. 'houspa'
   */
  async getTaxonomicForms(speciesCode) {
    const response = await this.client.get(`/ref/taxon/forms/${speciesCode}`);
    return response.data;
  }

  /**
   * Region info (name and bounds).
   *
   * @param {string} regionCode
   */
  async getRegionInfo(regionCode) {
    const response = await this.client.get(
      `/ref/region/info/${regionCode.trim().toUpperCase()}`
    );
    return response.data;
  }

  /**
   * List of sub-regions within a parent region.
   *
   * @param {string} regionType - 'country', 'subnational1', or 'subnational2'
   * @param {string} parentRegionCode - e.g. 'US', 'US-NY'
   */
  async getSubRegions(regionType, parentRegionCode) {
    const response = await this.client.get(
      `/ref/region/list/${regionType}/${parentRegionCode.trim().toUpperCase()}`
    );
    return response.data;
  }

  /**
   * Regions that share a border with the given region.
   *
   * @param {string} regionCode
   */
  async getAdjacentRegions(regionCode) {
    const response = await this.client.get(
      `/ref/adjacent/${regionCode.trim().toUpperCase()}`
    );
    return response.data;
  }

  /**
   * Search hotspots by name within a region (fuzzy matching).
   *
   * @param {string} regionCode
   * @param {string} searchQuery
   * @param {number} [maxResults=10]
   */
  async searchHotspotsByName(regionCode, searchQuery, maxResults = 10) {
    const hotspots = await this.getHotspots(regionCode);
    if (!Array.isArray(hotspots) || hotspots.length === 0) return [];
    const query = searchQuery.toLowerCase();
    const queryWords = query.split(/\s+/);
    const matches = hotspots.filter(spot => {
      const name = (spot.locName || '').toLowerCase();
      return queryWords.some(w => name.includes(w)) || name.includes(query);
    });
    matches.sort((a, b) => (b.numSpeciesAllTime || 0) - (a.numSpeciesAllTime || 0));
    return matches.slice(0, maxResults);
  }

  /**
   * Popular hotspots in a region sorted by species count.
   *
   * @param {string} regionCode
   * @param {number} [limit=10]
   */
  async getPopularHotspots(regionCode, limit = 10) {
    const hotspots = await this.getHotspots(regionCode);
    if (!Array.isArray(hotspots) || hotspots.length === 0) return [];
    return hotspots
      .sort((a, b) => (b.numSpeciesAllTime || 0) - (a.numSpeciesAllTime || 0))
      .slice(0, limit);
  }

  /**
   * Remove duplicate observations (same species + location + date).
   *
   * @param {Array} observations
   * @returns {Array}
   */
  deduplicateObservations(observations) {
    if (!observations || observations.length === 0) return [];
    const seen = new Set();
    return observations.filter((obs) => {
      const key = `${obs.speciesCode || obs.comName}-${obs.locId || obs.locName}-${obs.obsDt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

// ─── Standalone verification helpers (used by Identification flow) ────────────

/**
 * Look up an eBird species code by scientific name.
 *
 * @param {string} scientificName
 * @returns {Promise<{found: boolean, speciesCode?: string, commonName?: string, scientificName?: string}>}
 */
async function getEBirdSpeciesCode(scientificName) {
  try {
    const nameParts = scientificName.split(' ');
    const genus = nameParts[0].toLowerCase();
    const species = (nameParts[1] || '').toLowerCase();
    const displayName = `${nameParts[0]} ${nameParts[1] || ''}`.trim();

    logger.debug(`Looking up eBird species code for "${displayName}"`);
    const taxonomy = await _loadTaxonomy(process.env.EBIRD_API_KEY);
    if (!taxonomy) return { found: false };

    for (const bird of taxonomy) {
      const parts = (bird.sciName || '').toLowerCase().split(' ');
      if (parts[0] === genus && (parts[1] || '') === species) {
        return {
          found: true,
          speciesCode: bird.speciesCode,
          commonName: toUKSpelling(bird.comName),
          scientificName: bird.sciName,
        };
      }
    }

    return { found: false };
  } catch (err) {
    logger.error('eBird species code lookup failed', { error: err.message });
    return { found: false };
  }
}

/**
 * Convert eBird US English common name to UK English spelling.
 * eBird always uses US English; this normalises display names to UK English.
 */
function toUKSpelling(name) {
  if (!name) return name;
  return name
    .replace(/\bGray\b/g, 'Grey')
    .replace(/\bgray\b/g, 'grey')
    .replace(/\bSulfur\b/g, 'Sulphur')
    .replace(/\bsulfur\b/g, 'sulphur')
    .replace(/\bColor\b/g, 'Colour')
    .replace(/\bcolor\b/g, 'colour');
}

/**
 * Generate US and UK spelling variants of a common bird name.
 * eBird uses US English, so UK-spelled names from Gemini need conversion.
 */
function _usUkVariants(name) {
  // Normalize: lowercase, replace hyphens with spaces, strip non-alpha
  const normalize = s => s.toLowerCase().replace(/-/g, ' ').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  const base = normalize(name || '');
  const variants = new Set([base]);
  // grey ↔ gray
  if (base.includes('grey')) variants.add(base.replace(/grey/g, 'gray'));
  if (base.includes('gray')) variants.add(base.replace(/gray/g, 'grey'));
  // sulphur ↔ sulfur
  if (base.includes('sulphur')) variants.add(base.replace(/sulphur/g, 'sulfur'));
  if (base.includes('sulfur')) variants.add(base.replace(/sulfur/g, 'sulphur'));
  // colour ↔ color
  if (base.includes('colour')) variants.add(base.replace(/colour/g, 'color'));
  if (base.includes('color')) variants.add(base.replace(/color/g, 'colour'));
  // behaviour ↔ behavior
  if (base.includes('behaviour')) variants.add(base.replace(/behaviour/g, 'behavior'));
  if (base.includes('behavior')) variants.add(base.replace(/behavior/g, 'behaviour'));
  // maneuver ↔ manoeuvre
  if (base.includes('manoeuvre')) variants.add(base.replace(/manoeuvre/g, 'maneuver'));
  if (base.includes('maneuver')) variants.add(base.replace(/maneuver/g, 'manoeuvre'));
  return [...variants];
}

/**
 * Look up an eBird species code by common name, trying US/UK spelling variants.
 *
 * @param {string} commonName
 * @returns {Promise<{found: boolean, speciesCode?: string, commonName?: string, scientificName?: string}>}
 */
async function getEBirdSpeciesCodeByCommonName(commonName) {
  if (!commonName) return { found: false };
  try {
    const taxonomy = await _loadTaxonomy(process.env.EBIRD_API_KEY);
    if (!taxonomy) return { found: false };
    // Normalize eBird names the same way (hyphens → spaces, strip non-alpha)
    const normalizeBird = s => s.toLowerCase().replace(/-/g, ' ').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    const variants = _usUkVariants(commonName);
    // 1. Exact match against all variants
    for (const bird of taxonomy) {
      const bCom = normalizeBird(bird.comName || '');
      if (variants.includes(bCom)) {
        return { found: true, speciesCode: bird.speciesCode, commonName: toUKSpelling(bird.comName), scientificName: bird.sciName };
      }
    }
    // 2. eBird name contains the full search term (e.g. "Gray-headed Fish Eagle" in taxonomy)
    // Only bCom.includes(v) — never v.includes(bCom) which would match any shorter name like "Kingfisher"
    for (const bird of taxonomy) {
      const bCom = normalizeBird(bird.comName || '');
      if (variants.some(v => v.length >= 6 && bCom.includes(v))) {
        return { found: true, speciesCode: bird.speciesCode, commonName: toUKSpelling(bird.comName), scientificName: bird.sciName };
      }
    }
    return { found: false };
  } catch (err) {
    logger.error('eBird common name lookup failed', { error: err.message });
    return { found: false };
  }
}

/**
 * Verify a bird identification against eBird taxonomy.
 * Handles synonyms and taxonomic revisions via fallback matching.
 *
 * @param {string} scientificName
 * @param {string} [commonName]
 * @returns {Promise<Object>}
 */
async function verifyWithEBird(scientificName, commonName = null) {
  try {
    const nameParts = scientificName.split(' ');
    const genus = nameParts[0].toLowerCase();
    const species = (nameParts[1] || '').toLowerCase();
    const displayName = `${nameParts[0]} ${nameParts[1] || ''}`.trim();

    logger.debug(`eBird: verifying "${displayName}"${commonName ? ` (${commonName})` : ''}`);
    const taxonomy = await _loadTaxonomy(process.env.EBIRD_API_KEY);
    if (!taxonomy) return { verified: false, found: false };

    // 1. Exact scientific name match
    for (const bird of taxonomy) {
      const p = (bird.sciName || '').toLowerCase().split(' ');
      if (p[0] === genus && (p[1] || '') === species) {
        return {
          verified: true,
          found: true,
          matches: true,
          speciesCode: bird.speciesCode,
          commonName: toUKSpelling(bird.comName),
          scientificName: bird.sciName,
        };
      }
    }

    // 2. Exact common name match (synonym resolution)
    if (commonName) {
      const cLower = commonName.toLowerCase().replace(/[^a-z\s]/g, '').trim();
      for (const bird of taxonomy) {
        const bCom = (bird.comName || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
        if (bCom === cLower) {
          return {
            verified: true,
            found: true,
            matches: false,
            speciesCode: bird.speciesCode,
            commonName: toUKSpelling(bird.comName),
            scientificName: bird.sciName,
            originalName: displayName,
            nameUpdatedReason: 'matched by common name',
          };
        }
      }

      // 3. Partial common name match — only allow eBird name to contain the search term, not reverse
      for (const bird of taxonomy) {
        const bCom = (bird.comName || '').toLowerCase().replace(/-/g, ' ').replace(/[^a-z\s]/g, '').trim();
        const cNorm = cLower.replace(/-/g, ' ').trim();
        if (cNorm.length >= 6 && bCom.includes(cNorm)) {
          return {
            verified: true,
            found: true,
            matches: false,
            speciesCode: bird.speciesCode,
            commonName: toUKSpelling(bird.comName),
            scientificName: bird.sciName,
            originalName: displayName,
            nameUpdatedReason: 'partial common name match',
          };
        }
      }
    }

    // 4. Same-genus fallback
    for (const bird of taxonomy) {
      const p = (bird.sciName || '').toLowerCase().split(' ');
      if (p[0] === genus) {
        return {
          verified: true,
          found: true,
          matches: false,
          speciesCode: bird.speciesCode,
          commonName: toUKSpelling(bird.comName),
          scientificName: bird.sciName,
          originalName: displayName,
          nameUpdatedReason: 'same genus',
        };
      }
    }

    return { verified: false, found: false };
  } catch (err) {
    logger.error('eBird verification failed', { error: err.message });
    return { verified: false, found: false };
  }
}

module.exports = {
  EBirdService,
  getEBirdSpeciesCode,
  getEBirdSpeciesCodeByCommonName,
  getEBirdSubspecificGroups,
  verifyWithEBird,
  toUKSpelling,
};
