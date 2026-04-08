/**
 * iNaturalist Service — Species reference photo lookup
 *
 * Ported from Animal-Identification-Bot.
 * Fetches a representative photo for a species to use alongside
 * identification results.
 */
const logger = require('../../../src/utils/logger');

const INATURALIST_API = 'https://api.inaturalist.org/v1';

// ─── Performance helpers ─────────────────────────────────────────────────────
const PHOTO_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const _photoCache = new Map(); // normalized binomial → { result, ts }

function fetchWithTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

/** Low-level fetch from iNaturalist taxa endpoint. */
async function getINaturalistPhoto(scientificName) {
  try {
    const parts = scientificName.split(' ');
    const binomial = `${parts[0]} ${parts[1] || ''}`.trim();

    const cacheKey = binomial.toLowerCase();
    const cached = _photoCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < PHOTO_CACHE_TTL) {
      logger.debug(`iNaturalist photo cache hit for "${binomial}"`);
      return cached.result;
    }

    const url = `${INATURALIST_API}/taxa?q=${encodeURIComponent(binomial)}&per_page=20`;
    const response = await fetchWithTimeout(url);
    const data = await response.json();

    if (!data.results || data.results.length === 0) return { found: false };

    // First pass — exact binomial match
    for (const taxon of data.results) {
      const tp = (taxon.name || '').split(' ');
      const taxonBinomial = `${tp[0]} ${tp[1] || ''}`.trim().toLowerCase();
      if (taxonBinomial === binomial.toLowerCase() && taxon.default_photo) {
        const hit = _buildPhotoResult(taxon);
        _photoCache.set(cacheKey, { result: hit, ts: Date.now() });
        return hit;
      }
    }

    // Second pass — same genus with a photo
    const genus = parts[0].toLowerCase();
    for (const taxon of data.results) {
      const taxonGenus = (taxon.name?.split(' ')[0] || '').toLowerCase();
      if (taxonGenus === genus && taxon.default_photo) {
        const hit = _buildPhotoResult(taxon);
        _photoCache.set(cacheKey, { result: hit, ts: Date.now() });
        return hit;
      }
    }

    return { found: false };
  } catch (err) {
    logger.warn('iNaturalist photo lookup failed', {
      name: scientificName,
      error: err.message,
    });
    return { found: false };
  }
}

function _buildPhotoResult(taxon) {
  let photoUrl =
    taxon.default_photo?.medium_url ||
    taxon.default_photo?.small_url ||
    taxon.default_photo?.square_url;

  if (photoUrl) {
    photoUrl = photoUrl.replace('square', 'medium').replace('small', 'medium');
  }

  // Build slug for direct taxon URL: "850880-Ceyx-erithaca"
  const slug = taxon.id + '-' + (taxon.name || '').replace(/\s+/g, '-');

  return {
    found: true,
    photoUrl,
    taxonId: taxon.id,
    taxonSlug: slug,
    taxonName: taxon.name,                          // accepted scientific name
    commonName: taxon.preferred_common_name || null, // accepted common name
    name: taxon.name,
  };
}

/** Fetch the main species photo from Wikipedia's page summary API. */
async function getWikipediaPhoto(scientificName, commonName) {
  const terms = [commonName, scientificName].filter(Boolean);
  for (const term of terms) {
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`;
      const res = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'WildlifeSightingsBackend/1.0' },
      }, 6000);
      const data = await res.json();
      if (data.thumbnail?.source) {
        return {
          found: true,
          photoUrl: data.thumbnail.source.replace(/\/\d+px-/, '/400px-'),
          source: 'Wikipedia',
          taxonName: scientificName,
          commonName: data.title || commonName,
        };
      }
    } catch { /* try next term */ }
  }
  return { found: false };
}

/**
 * Get a reference species photo from iNaturalist.
 *
 * @param {string} scientificName - Full binomial or trinomial name
 * @returns {Promise<{found: boolean, photoUrl?: string, taxonId?: number, taxonName?: string}>}
 */
async function getSpeciesPhoto(scientificName) {
  const parts = scientificName.split(' ');
  const binomial = `${parts[0]} ${parts[1] || ''}`.trim();

  logger.debug(`Getting iNaturalist photo for "${binomial}"`);
  const photo = await getINaturalistPhoto(binomial);

  if (photo.found && photo.photoUrl) {
    return {
      found: true,
      photoUrl: photo.photoUrl,
      source: 'iNaturalist',
      taxonId: photo.taxonId,
      taxonSlug: photo.taxonSlug,
      taxonName: photo.taxonName,
      commonName: photo.commonName,
    };
  }

  // Fallback: try Wikipedia if iNaturalist has no photo
  logger.debug(`iNaturalist photo not found for "${binomial}", trying Wikipedia`);
  const wikiPhoto = await getWikipediaPhoto(binomial, null);
  if (wikiPhoto.found) return wikiPhoto;

  return { found: false, taxonId: null, taxonSlug: null, taxonName: null, commonName: null };
}

/**
 * Fetch the best-rated species photo from eBird's Macaulay Library CDN.
 * URL pattern: https://cdn.download.ams.cornell.edu/api/2.0/SpeciesImages/{speciesCode}
 * The endpoint may redirect to an image or return JSON with photo assets.
 *
 * @param {string} speciesCode - eBird species code e.g. 'comkin'
 * @returns {Promise<{found: boolean, photoUrl?: string, source: string}>}
 */
async function getEBirdPhoto(speciesCode) {
  if (!speciesCode) return { found: false, source: 'eBird' };
  try {
    // Macaulay Library search API — returns best-rated photo for a species code
    const apiUrl = `https://search.macaulaylibrary.org/api/v1/search?taxonCode=${encodeURIComponent(speciesCode)}&mediaType=photo&count=1`;
    const res = await fetchWithTimeout(apiUrl, {
      headers: { 'User-Agent': 'WildlifeBot/1.0' },
    }, 8000);
    if (!res.ok) return { found: false, source: 'eBird' };

    const json = await res.json().catch(() => null);
    const mediaUrl = json?.results?.content?.[0]?.mediaUrl;
    if (mediaUrl) {
      return { found: true, photoUrl: mediaUrl, source: 'eBird' };
    }

    return { found: false, source: 'eBird' };
  } catch {
    return { found: false, source: 'eBird' };
  }
}

module.exports = { getSpeciesPhoto, getEBirdPhoto };
