/**
 * GBIF (Global Biodiversity Information Facility) Service
 *
 * Ported from Animal-Identification-Bot.
 *
 * Used in the identification flow to:
 *  - Verify Gemini's scientific name against the world's largest biodiversity DB
 *  - Resolve taxonomic synonyms to the currently accepted name
 *  - Optionally verify that the species has been recorded near the user's location
 */
const logger = require('../../../src/utils/logger');

const GBIF_API = 'https://api.gbif.org/v1';
const NOMINATIM_API = 'https://nominatim.openstreetmap.org';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Reverse-geocode lat/lng to a country code using Nominatim. */
async function reverseGeocodeCountry(lat, lng) {
  try {
    const url = `${NOMINATIM_API}/reverse?lat=${lat}&lon=${lng}&format=json&zoom=3&accept-language=en`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'WildlifeSightingsBackend/1.0' },
    });
    const data = await res.json();
    return (data?.address?.country_code || '').toUpperCase() || null;
  } catch { return null; }
}

/** Geocode a place name to lat/lng using OpenStreetMap Nominatim. */
async function geocodeLocation(locationName) {
  try {
    const url = `${NOMINATIM_API}/search?q=${encodeURIComponent(locationName)}&format=json&limit=1&addressdetails=1&accept-language=en`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'WildlifeSightingsBackend/1.0', 'Accept-Language': 'en' },
    });
    const data = await response.json();
    if (data && data.length > 0) {
      const addr = data[0].address || {};
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon),
        displayName: data[0].display_name,
        country_code: (addr.country_code || '').toUpperCase(),
        country: addr.country || '',
        city: addr.city || addr.town || addr.village || addr.state || '',
        state: addr.state || addr.county || addr.municipality || addr.region || '',
        district: addr.county || addr.district || addr.municipality || '',
        // ISO 3166-2 subdivision code e.g. "JP-20" for Nagano — maps directly to eBird subnational codes
        isoSubdivision: addr['ISO3166-2-lvl4'] || addr['ISO3166-2-lvl3'] || null,
        // Nominatim OSM class/type — used to detect administrative boundaries vs specific places
        osmClass: data[0].class || null,
        osmType: data[0].type || null,
        // Bounding box [south, north, west, east] — used to calculate appropriate search radius
        boundingbox: Array.isArray(data[0].boundingbox) ? data[0].boundingbox.map(Number) : null,
      };
    }
    return null;
  } catch (err) {
    logger.warn('Geocoding failed', { location: locationName, error: err.message });
    return null;
  }
}

/** Fetch species info from GBIF, resolving synonyms to accepted names. */
async function getSpeciesInfo(scientificName) {
  try {
    const name = scientificName.split(' ').slice(0, 2).join(' ');
    const url = `${GBIF_API}/species/match?name=${encodeURIComponent(name)}&verbose=true`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.usageKey) return { found: false };

    const result = {
      found: true,
      key: data.usageKey,
      scientificName: data.scientificName,
      canonicalName: data.canonicalName,
      rank: data.rank,
      status: data.status,
      confidence: data.confidence,
      kingdom: data.kingdom,
      phylum: data.phylum,
      class: data.class,
      order: data.order,
      family: data.family,
      genus: data.genus,
      species: data.species,
      isSynonym: false,
      acceptedName: null,
      acceptedKey: null,
    };

    // Resolve synonym → accepted name
    if (data.status === 'SYNONYM' && data.acceptedUsageKey) {
      logger.debug(`"${name}" is a GBIF synonym — fetching accepted name`);
      const accRes = await fetch(`${GBIF_API}/species/${data.acceptedUsageKey}`);
      const accData = await accRes.json();

      if (accData) {
        let resolvedData = accData;

        // If GBIF resolves to a subspecies/variety, use the parent species key to keep
        // occurrence counts and naming at species level.
        if (
          (accData.rank === 'SUBSPECIES' || accData.rank === 'VARIETY')
          && accData.speciesKey
          && accData.speciesKey !== accData.key
        ) {
          try {
            const spRes = await fetch(`${GBIF_API}/species/${accData.speciesKey}`);
            const spData = await spRes.json();
            if (spData && spData.key) {
              resolvedData = spData;
              logger.debug('GBIF synonym normalized to species-level accepted name', {
                requestedName: name,
                acceptedUsageKey: data.acceptedUsageKey,
                resolvedSpeciesKey: spData.key,
                resolvedScientificName: spData.scientificName,
              });
            }
          } catch {
            // Keep accData as fallback.
          }
        }

        result.isSynonym = true;
        result.acceptedKey = resolvedData.key;
        result.acceptedName = resolvedData.canonicalName || resolvedData.scientificName;
        result.scientificName = resolvedData.scientificName;
        result.canonicalName = resolvedData.canonicalName;
        result.key = resolvedData.key;
        result.rank = resolvedData.rank || result.rank;
        result.genus = resolvedData.genus || result.genus;
        result.species = resolvedData.species || result.species;

        // Fetch English vernacular name
        const vernRes = await fetch(`${GBIF_API}/species/${resolvedData.key}/vernacularNames`);
        const vernData = await vernRes.json();
        if (vernData.results) {
          const eng = vernData.results.find((v) => v.language === 'eng' || v.language === 'en');
          if (eng) result.commonName = eng.vernacularName;
        }
      }
    }

    return result;
  } catch (err) {
    logger.error('GBIF species lookup failed', { error: err.message });
    return { found: false, error: err.message };
  }
}

/** Fetch known subspecies from GBIF for a species key. */
async function getSubspecies(speciesKey) {
  try {
    const response = await fetch(`${GBIF_API}/species/${speciesKey}/children?limit=100`);
    const data = await response.json();
    if (!data.results) return [];
    return data.results
      .filter((r) => r.rank === 'SUBSPECIES' || r.rank === 'VARIETY')
      .map((r) => ({ name: r.canonicalName || r.scientificName, rank: r.rank, key: r.key }));
  } catch (err) {
    logger.warn('GBIF subspecies lookup failed', { error: err.message });
    return [];
  }
}

/** Check GBIF occurrence records near a coordinate box (~1° around the point). */
async function checkOccurrencesAtLocation(speciesKey, coords) {
  try {
    const url =
      `${GBIF_API}/occurrence/search?taxonKey=${speciesKey}` +
      `&decimalLatitude=${coords.lat - 1},${coords.lat + 1}` +
      `&decimalLongitude=${coords.lng - 1},${coords.lng + 1}` +
      `&limit=100`;
    const response = await fetch(url);
    const data = await response.json();
    const records = data.results || [];

    const monthSet = new Set();
    const establishmentMeansSet = new Set();
    let breedingSignalCount = 0;

    for (const r of records) {
      const d = new Date(r.eventDate || r.lastInterpreted || '');
      const month = Number.isNaN(d.getTime()) ? null : (d.getUTCMonth() + 1);
      if (month) monthSet.add(month);

      const establishment = (r.establishmentMeans || '').toString().trim();
      if (establishment) establishmentMeansSet.add(establishment.toLowerCase());

      const breedingText = [
        r.behavior,
        r.occurrenceRemarks,
        r.fieldNotes,
        r.reproductiveCondition,
      ].filter(Boolean).join(' ').toLowerCase();

      if (breedingText.includes('breed') || breedingText.includes('nest')) {
        breedingSignalCount += 1;
      }
    }

    return {
      count: data.count || 0,
      hasRecords: (data.count || 0) > 0,
      recentRecords: records.slice(0, 5).map((r) => ({
        date: r.eventDate,
        country: r.country,
        locality: r.locality,
        recordedBy: r.recordedBy,
      })),
      monthsObserved: [...monthSet].sort((a, b) => a - b),
      monthsObservedCount: monthSet.size,
      establishmentMeans: [...establishmentMeansSet],
      breedingSignalCount,
    };
  } catch (err) {
    logger.warn('GBIF occurrence check failed', { error: err.message });
    return {
      count: 0,
      hasRecords: false,
      monthsObserved: [],
      monthsObservedCount: 0,
      establishmentMeans: [],
      breedingSignalCount: 0,
    };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Full verification of a Gemini identification result using GBIF.
 *
 * @param {Object} geminiResult    - Result data from Gemini (must have .scientificName)
 * @param {string|null} [location] - Human-readable location (will be geocoded)
 * @returns {Promise<Object>}
 */
async function verifyWithGBIF(geminiResult, location = null) {
  logger.debug('GBIF: verifying identification', { name: geminiResult.scientificName });

  const result = {
    verified: false,
    matches: false,
    geminiName: geminiResult.scientificName,
    gbifName: null,
    species: null,
    subspeciesList: [],
    locationVerified: false,
    occurrences: null,
  };

  if (!geminiResult.identified || !geminiResult.scientificName) return result;

  const speciesInfo = await getSpeciesInfo(geminiResult.scientificName);
  if (!speciesInfo.found) {
    logger.debug('GBIF: species not found', { name: geminiResult.scientificName });
    return result;
  }

  logger.debug(`GBIF: found ${speciesInfo.canonicalName} (${speciesInfo.rank})`);
  result.verified = true;
  result.species = speciesInfo;
  result.gbifName = speciesInfo.canonicalName;

  const geminiBase = geminiResult.scientificName.toLowerCase().split(' ').slice(0, 2).join(' ');
  const gbifBase = (speciesInfo.canonicalName || '').toLowerCase().split(' ').slice(0, 2).join(' ');
  result.matches = geminiBase === gbifBase;

  result.subspeciesList = await getSubspecies(speciesInfo.key);

  if (location) {
    const coords = await geocodeLocation(location);
    if (coords) {
      const occ = await checkOccurrencesAtLocation(speciesInfo.key, coords);
      result.occurrences = occ;
      result.locationVerified = occ.hasRecords;
    }
  }

  return result;
}

/**
 * Get accepted scientific + common name and GBIF URL for the identification pipeline.
 * Resolves synonyms automatically via getSpeciesInfo().
 *
 * @param {string} scientificName - Binomial e.g. "Ceyx erithaca"
 * @returns {Promise<{found: boolean, usageKey?: number, scientificName?: string, commonName?: string, gbifUrl?: string}>}
 */
async function getGBIFNames(scientificName) {
  logger.debug('Looking up GBIF names for', { name: scientificName });
  const speciesInfo = await getSpeciesInfo(scientificName);
  if (!speciesInfo.found) {
    logger.debug('GBIF names not found', { name: scientificName });
    return { found: false };
  }

  const usageKey = speciesInfo.key;
  const acceptedScientificName = speciesInfo.canonicalName || null;

  // getSpeciesInfo only fills commonName for synonyms — fetch for everyone else too
  let commonName = speciesInfo.commonName || null;
  if (!commonName) {
    try {
      const vernRes = await fetch(`${GBIF_API}/species/${usageKey}/vernacularNames?limit=50`);
      const vernData = await vernRes.json();
      if (vernData.results && vernData.results.length > 0) {
        const eng = vernData.results.find(v => v.language === 'eng' || v.language === 'en');
        if (eng) commonName = eng.vernacularName;
      }
    } catch {
      // vernacular names are optional — silently skip
    }
  }

  logger.debug('GBIF names resolved', { usageKey, acceptedScientificName, commonName });
  return {
    found: true,
    usageKey,
    scientificName: acceptedScientificName,
    commonName,
    gbifUrl: `https://www.gbif.org/species/${usageKey}`,
  };
}

/**
 * Fetch a readable geographic range string for a species from GBIF distributions.
 *
 * @param {number} usageKey - GBIF taxon key
 * @returns {Promise<string|null>}
 */
async function getGeographicRange(usageKey) {
  try {
    const res = await fetch(`${GBIF_API}/species/${usageKey}/distributions?limit=100`);
    const data = await res.json();
    if (!data.results || data.results.length === 0) return null;

    // Prefer human-readable locality strings (e.g. "Southeast Asia")
    const localities = new Set();
    const codes = new Set();
    for (const d of data.results) {
      const loc = (d.locality || '').trim();
      if (loc) {
        localities.add(loc);
      } else if (d.countryCode) {
        codes.add(d.countryCode);
      }
    }

    const parts = localities.size > 0 ? [...localities] : [...codes];
    if (parts.length === 0) return null;
    return parts.slice(0, 6).join(' · ');
  } catch (err) {
    logger.warn('GBIF distributions lookup failed', { error: err.message });
    return null;
  }
}

/**
 * Get the all-time total GBIF occurrence count for a species in a country.
 * This aggregates eBird + iNaturalist + museum records etc.
 *
 * @param {number} taxonKey  - GBIF usageKey
 * @param {string} countryCode - ISO 2-letter e.g. 'SG'
 * @returns {Promise<number>}
 */
async function getOccurrenceCountByCountry(taxonKey, countryCode) {
  logger.debug('GBIF occurrence count by country', { taxonKey, countryCode });
  try {
    const url = `${GBIF_API}/occurrence/search?taxonKey=${taxonKey}&country=${countryCode.toUpperCase()}&limit=0`;
    const response = await fetch(url);
    const data = await response.json();
    const count = typeof data.count === 'number' ? data.count : 0;
    logger.debug('GBIF occurrence count result', { taxonKey, countryCode, count });
    return count;
  } catch (err) {
    logger.warn('GBIF country occurrence count failed', { taxonKey, countryCode, error: err.message });
    return 0;
  }
}

async function getGlobalOccurrenceCount(taxonKey) {
  try {
    const url = `${GBIF_API}/occurrence/search?taxonKey=${taxonKey}&limit=0`;
    const response = await fetch(url);
    const data = await response.json();
    return typeof data.count === 'number' ? data.count : 0;
  } catch (err) {
    logger.warn('GBIF global occurrence count failed', { taxonKey, error: err.message });
    return 0;
  }
}

/**
 * Return GBIF child taxa (subspecies) that have occurrence records in a specific country.
 * Combines /species/{key}/children with a per-subspecies /occurrence/search count query.
 * Useful for cross-referencing which subspecies have actually been recorded at a location,
 * drawing on iNaturalist research-grade IDs, museum records, and eBird data aggregated by GBIF.
 *
 * @param {number} speciesKey  - GBIF usageKey for the species
 * @param {string} countryCode - ISO 2-letter code, e.g. 'SG'
 * @returns {Promise<Array<{name: string, key: number, count: number}>>}
 */
async function getSubspeciesOccurrencesByCountry(speciesKey, countryCode) {
  const subspecies = await getSubspecies(speciesKey);
  if (!subspecies.length) return [];

  const cc = countryCode.toUpperCase();
  const results = [];
  await Promise.all(subspecies.map(async (sub) => {
    try {
      const url = `${GBIF_API}/occurrence/search?taxonKey=${sub.key}&country=${cc}&limit=0`;
      const res = await fetch(url);
      const d = await res.json();
      if ((d.count || 0) > 0) {
        results.push({ name: sub.name, key: sub.key, count: d.count });
      }
    } catch {
      /* skip individual subspecies failures */
    }
  }));
  return results;
}

module.exports = {
  verifyWithGBIF,
  getSpeciesInfo,
  getSubspecies,
  checkOccurrencesAtLocation,
  geocodeLocation,
  reverseGeocodeCountry,
  getGBIFNames,
  getGeographicRange,
  getOccurrenceCountByCountry,
  getGlobalOccurrenceCount,
  getSubspeciesOccurrencesByCountry,
};
