/**
 * iNaturalist Service — Species reference photo lookup
 *
 * Ported from Animal-Identification-Bot.
 * Fetches a representative photo for a species to use alongside
 * identification results.
 */
const logger = require('../../../src/utils/logger');

const INATURALIST_API = 'https://api.inaturalist.org/v1';

/** Low-level fetch from iNaturalist taxa endpoint. */
async function getINaturalistPhoto(scientificName) {
  try {
    const parts = scientificName.split(' ');
    const binomial = `${parts[0]} ${parts[1] || ''}`.trim();

    const url = `${INATURALIST_API}/taxa?q=${encodeURIComponent(binomial)}&per_page=20`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.results || data.results.length === 0) return { found: false };

    // First pass — exact binomial match
    for (const taxon of data.results) {
      const tp = (taxon.name || '').split(' ');
      const taxonBinomial = `${tp[0]} ${tp[1] || ''}`.trim().toLowerCase();
      if (taxonBinomial === binomial.toLowerCase() && taxon.default_photo) {
        return _buildPhotoResult(taxon);
      }
    }

    // Second pass — same genus with a photo
    const genus = parts[0].toLowerCase();
    for (const taxon of data.results) {
      const taxonGenus = (taxon.name?.split(' ')[0] || '').toLowerCase();
      if (taxonGenus === genus && taxon.default_photo) {
        return _buildPhotoResult(taxon);
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

  return { found: false, taxonId: null, taxonSlug: null, taxonName: null, commonName: null };
}

module.exports = { getSpeciesPhoto };
