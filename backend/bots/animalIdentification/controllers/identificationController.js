/**
 * Identification Controller — Animal Identification Bot
 *
 * Handles the full pipeline:
 *   Gemini AI → GBIF verification → eBird verification → iNaturalist photo good
 */
const geminiService = require('../services/geminiService');
const axios = require('axios');
const { verifyWithGBIF, geocodeLocation } = require('../services/gbifService');
const { verifyWithEBird, getEBirdSubspecificGroups } = require('../../birdSighting/services/ebirdService');
const { getSpeciesPhoto, getEBirdPhoto } = require('../services/inaturalistService');
const { getNearbySpeciesObservations } = require('../services/ebirdService');
const { createCompositeImage } = require('../services/imageService');
const { getWikipediaInfo } = require('../services/wikipediaService');
const logger = require('../../../src/utils/logger');
const {
  classifyLocalStatus,
  isMonotypic,
  getEpithet,
  getEpithets,
  computeDisplayFields,
} = require('../services/enrichmentUtils');

function parseOptions(body) {
  return {
    location: body.location || '',
    identifyTarget: body.identifyTarget || 'auto',
    habitat: body.habitat || '',
    additionalNotes: body.notes || body.additionalNotes || '',
    country: body.country || '',
  };
}

// Maps GBIF iucnThreatStatus enum strings to standard IUCN Red List codes
const GBIF_IUCN_MAP = {
  LEAST_CONCERN: 'LC',
  NEAR_THREATENED: 'NT',
  VULNERABLE: 'VU',
  ENDANGERED: 'EN',
  CRITICALLY_ENDANGERED: 'CR',
  EXTINCT_IN_THE_WILD: 'EW',
  EXTINCT: 'EX',
  DATA_DEFICIENT: 'DD',
  NOT_EVALUATED: 'NE',
};

async function runVerification(geminiData, location) {
  const scientificName =
    geminiData.scientificName || geminiData.taxonomy?.scientific_name;
  const commonName = geminiData.commonName || geminiData.taxonomy?.common_name;
  if (!scientificName) return geminiData;

  const isBird = ['aves', 'bird'].some(k =>
    (geminiData.taxonomy?.class || '').toLowerCase().includes(k)
  );

  try {
    // Geocode location in parallel with GBIF + eBird verification
    const [gbif, ebird, geoRes] = await Promise.allSettled([
      verifyWithGBIF({ ...geminiData, scientificName, commonName }, location),
      verifyWithEBird(scientificName, commonName),
      location ? geocodeLocation(location) : Promise.resolve(null),
    ]);

    const locationCoords = geoRes.status === 'fulfilled' ? geoRes.value : null;
    const countryCode = (locationCoords?.country_code || '').toUpperCase() || null;

    if (gbif.status === 'fulfilled' && gbif.value?.verified) {
      const gv = gbif.value;
      const sp = gv.species || {};
      Object.assign(geminiData, {
        gbifKey: sp.key || null,
        gbifVerified: true,
        gbifAcceptedName: gv.gbifName || sp.canonicalName || null,
        gbifCommonName: sp.commonName || null,
        occursAtLocation: gv.locationVerified || false,
        gbifUrl: sp.key ? `https://www.gbif.org/species/${sp.key}` : null,
      });
      // Correct scientific name if GBIF resolved a different accepted name
      if (!gv.matches && gv.gbifName) {
        geminiData.originalGeminiName = geminiData.scientificName;
        geminiData.scientificName = gv.gbifName;
      }
      // Patch taxonomy hierarchy from GBIF authoritative data
      if (geminiData.taxonomy) {
        const tax = geminiData.taxonomy;
        if (sp.kingdom) tax.kingdom = sp.kingdom;
        if (sp.phylum)  tax.phylum  = sp.phylum;
        if (sp.class)   tax.class   = sp.class;
        if (sp.order)   tax.order   = sp.order;
        if (sp.family)  tax.family  = sp.family;
        if (sp.genus)   tax.genus   = sp.genus;
      }
      // Override IUCN threat status with GBIF's authoritative value
      if (sp.iucnThreatStatus) {
        const gbifCode = GBIF_IUCN_MAP[sp.iucnThreatStatus] || sp.iucnThreatStatus;
        if (!geminiData.iucnStatus) geminiData.iucnStatus = {};
        geminiData.iucnStatus.global = gbifCode;
        geminiData.iucnStatus.source = 'gbif';
      }
      // Apply GBIF common name (synonym-resolved species; lower priority than eBird)
      if (sp.commonName) {
        geminiData.commonName = sp.commonName;
      }
      // Flag when GBIF has confirmed the species does NOT occur at the given location.
      if (location && gv.occurrences !== null && !gv.locationVerified) {
        geminiData.locationWarning = true;
        logger.warn('Location mismatch: GBIF found no records near the given location', {
          species: geminiData.scientificName,
          location,
        });
      }
    }

    if (ebird.status === 'fulfilled' && ebird.value?.verified) {
      const ev = ebird.value;
      Object.assign(geminiData, {
        ebirdCode: ev.speciesCode,
        ebirdVerified: true,
        ebirdUrl: `https://ebird.org/species/${ev.speciesCode}`,
      });
      if (ev.commonName) geminiData.commonName = ev.commonName;
      const isEBirdRevision = !ev.matches && ev.scientificName &&
        (ev.nameUpdatedReason === 'matched by common name' ||
         ev.nameUpdatedReason === 'partial common name match');
      if (isEBirdRevision) {
        if (!geminiData.originalGeminiName) {
          geminiData.originalGeminiName = geminiData.scientificName;
        }
        geminiData.scientificName = ev.scientificName;
        geminiData.ebirdUpdatedName = ev.scientificName;
        const ebirdGenus = ev.scientificName.split(' ')[0];
        if (ebirdGenus && geminiData.taxonomy) geminiData.taxonomy.genus = ebirdGenus;
      }

      // eBird/IOC taxonomy takes precedence over GBIF for birds.
      // If eBird found an exact match for the original Gemini name, revert any GBIF synonym override.
      if (isBird && ev.matches && geminiData.originalGeminiName) {
        geminiData.scientificName = scientificName;
        if (ev.commonName) geminiData.commonName = ev.commonName;
        delete geminiData.originalGeminiName;
      }
    }

    // ── Location-filtered subspecies + sightings ──────────────────────────────
    const gbifKey   = gbif.status  === 'fulfilled' ? (gbif.value?.species?.key  || null) : null;
    const ebirdCode = ebird.status === 'fulfilled' ? (ebird.value?.speciesCode  || null) : null;
    const isSingapore = countryCode === 'SG';

    // singaporebirds.com slug: common name → kebab-case
    let sgSpeciesSlug = null;
    if (isSingapore) {
      if (geminiData.commonName) {
        sgSpeciesSlug = String(geminiData.commonName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      } else if (ebirdCode) {
        sgSpeciesSlug = ebirdCode.replace(/_/g, '-');
      } else if (geminiData.scientificName) {
        sgSpeciesSlug = String(geminiData.scientificName).toLowerCase().replace(/ /g, '-');
      }
    }

    if (ebirdCode) {
      const [ebirdSubsRes, sightingsRes, sgRes] = await Promise.allSettled([
        countryCode
          ? getEBirdSubspecificGroups(ebirdCode, countryCode)
          : Promise.resolve([]),
        countryCode
          ? getNearbySpeciesObservations(ebirdCode, { countryCode, isCountryOnly: true })
          : Promise.resolve(null),
        (isSingapore && sgSpeciesSlug)
          ? axios.get(`https://singaporebirds.com/species/${sgSpeciesSlug}/`, { headers: { 'User-Agent': 'WildlifeBot/1.0' }, timeout: 5000 }).catch(() => null)
          : Promise.resolve(null),
      ]);

      // singaporebirds.com — preferred local status + abundance for SG
      const sgResp = sgRes.status === 'fulfilled' ? sgRes.value : null;
      if (sgResp?.data) {
        const lsMatch = sgResp.data.match(/Local Status:\s*<[^>]*>\s*([^<]+)/i);
        if (lsMatch) geminiData.localStatus = lsMatch[1].trim();
        const abMatch = sgResp.data.match(/Abundance:\s*<[^>]*>\s*([^<]+)/i);
        if (abMatch) geminiData.abundance = abMatch[1].trim();
      }

      const ebirdSubInCountry = (ebirdSubsRes.status === 'fulfilled' ? ebirdSubsRes.value : []) || [];

      // Display list: eBird ISSF only — exclude monotypic and bracket-group entries (e.g. "[bengalensis Group]")
      const filteredSubs = ebirdSubInCountry.filter(s => !isMonotypic(s) && !String(s).includes('['));
      if (filteredSubs.length > 0) {
        geminiData.subspecies = filteredSubs;
        geminiData.subspeciesByLocation = true;
        geminiData.subspeciesLocation = locationCoords?.country || location || 'location';
      }

      // Cross-reference Gemini's image-identified subspecies against eBird ISSF list
      const geminiSubRaw = geminiData.taxonomy?.subspecies || '';
      const geminiSubNorm = geminiSubRaw.toLowerCase().trim();
      if (geminiSubNorm && !isMonotypic(geminiSubNorm) && geminiSubNorm !== 'unknown') {
        const geminiEp = getEpithet(geminiSubRaw);
        const issfMatch = ebirdSubInCountry.find(g => getEpithets(String(g)).includes(geminiEp));
        if (issfMatch) {
          geminiData.subspeciesFromImage = true;
          geminiData.subspeciesImageMatch = issfMatch;
        }
      }

      // Sightings count
      const sData = sightingsRes.status === 'fulfilled' ? sightingsRes.value : null;
      if (sData?.found) {
        geminiData.ebirdSightingsCount        = sData.count ?? null;
        geminiData.ebirdSightingsLocation     = locationCoords?.country || location || '';
        geminiData.ebirdSightingsRegionCode   = countryCode || null;
      }
    }

    // ── Normalize taxonomy to match final resolved scientificName ─────────────
    if (geminiData.taxonomy && geminiData.scientificName) {
      const _parts = geminiData.scientificName.trim().split(/\s+/);
      if (_parts.length >= 2) {
        geminiData.taxonomy.genus   = _parts[0];
        geminiData.taxonomy.species = `${_parts[0]} ${_parts[1]}`;
      }
    }

    // ── Pre-compute display fields so the frontend is pure rendering ──────────
    computeDisplayFields(geminiData);

    // ── Local status + abundance (birds only) ─────────────────────────────────
    // Only run classifier if singaporebirds.com didn't already supply localStatus
    if (isBird && !geminiData.localStatus && typeof geminiData.ebirdSightingsCount === 'number') {
      const gbifOcc = gbif.status === 'fulfilled' ? (gbif.value?.occurrences || {}) : {};
      const classified = classifyLocalStatus({
        gbifOccurrence: gbifOcc,
        ebirdSummary:   { count: geminiData.ebirdSightingsCount },
        migratoryStatus: geminiData.migratoryStatus,
      });
      if (!geminiData.localStatus) {
        geminiData.localStatus     = classified.label;
        geminiData.localStatusCode = classified.code;
      }
    }
  } catch (err) {
    logger.warn('Verification step failed', { error: err.message });
  }

  return geminiData;
}

async function attachPhoto(resultData) {
  const scientificName =
    resultData.scientificName || resultData.taxonomy?.scientific_name;
  if (!scientificName) return;

  const taxClass = (resultData.taxonomy?.class || '').toLowerCase();
  const isBird = ['aves', 'bird'].some(k => taxClass.includes(k));

  logger.debug('[attachPhoto] start', {
    scientificName,
    taxClass: resultData.taxonomy?.class || '(none)',
    isBird,
    ebirdCode: resultData.ebirdCode || '(none)',
  });

  // Birds: eBird CDN → Wikipedia (never iNaturalist)
  // Non-birds: iNaturalist → Wikipedia
  if (isBird) {
    if (resultData.ebirdCode) {
      const ebirdPhoto = await getEBirdPhoto(resultData.ebirdCode);
      logger.debug('[attachPhoto] eBird photo result', { found: ebirdPhoto.found, photoUrl: ebirdPhoto.photoUrl || null });
      if (ebirdPhoto.found) {
        resultData.referencePhoto = { url: ebirdPhoto.photoUrl, source: 'eBird' };
        return;
      }
    }
    // eBird failed — try Wikipedia
    const wikiInfo = await getWikipediaInfo(scientificName).catch(() => null);
    logger.debug('[attachPhoto] Wikipedia result', { found: !!wikiInfo?.imageUrl });
    if (wikiInfo?.imageUrl) {
      resultData.referencePhoto = { url: wikiInfo.imageUrl, source: 'Wikipedia' };
    }
    return;
  }

  // Non-bird: iNaturalist → Wikipedia
  const photo = await getSpeciesPhoto(scientificName);
  logger.debug('[attachPhoto] iNaturalist result', { found: photo.found });
  if (photo.found) {
    resultData.referencePhoto = {
      url: photo.photoUrl,
      source: photo.source,
      taxonId: photo.taxonId,
    };
    return;
  }
  // iNaturalist fallback: Wikipedia
  const wikiInfo = await getWikipediaInfo(scientificName).catch(() => null);
  if (wikiInfo?.imageUrl) {
    resultData.referencePhoto = { url: wikiInfo.imageUrl, source: 'Wikipedia' };
  }
}

/**
 * POST /api/v1/identify
 * Accepts multipart/form-data with an 'image' field.
 * Optional body fields: location, notes, habitat, identifyTarget, country, withImage
 */
exports.identifyFromUpload = async (req, res, next) => {
  if (!req.file) {
    return res
      .status(400)
      .json({ error: 'No image file provided. Send the file as the "image" field.' });
  }

  const options = parseOptions(req.body);
  const withImage = req.body.withImage === '1' || req.body.withImage === 'true';

  try {
    const geminiResult = await geminiService.identifyAnimal(
      req.file.buffer,
      req.file.mimetype,
      options
    );

    if (!geminiResult.success) {
      return res
        .status(502)
        .json({ error: 'Identification failed', details: geminiResult.error });
    }

    const data = geminiResult.data;
    await runVerification(data, options.location);
    await attachPhoto(data);

    if (withImage && data.referencePhoto?.url) {
      const imgBuffer = await createCompositeImage(data.referencePhoto.url, data);
      if (imgBuffer) {
        return res.status(200).json({
          success: true,
          model: geminiResult.model,
          data,
          compositeImage: imgBuffer.toString('base64'),
        });
      }
    }

    return res.status(200).json({ success: true, model: geminiResult.model, data });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/identify/url
 * Body: { imageUrl, location?, notes?, habitat?, identifyTarget?, country?, withImage? }
 */
exports.identifyFromUrl = async (req, res, next) => {
  const { imageUrl } = req.body;

  if (!imageUrl || typeof imageUrl !== 'string') {
    return res
      .status(400)
      .json({ error: 'imageUrl is required in the request body.' });
  }

  // SSRF prevention — allow only http/https
  let parsedUrl;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    return res.status(400).json({ error: 'imageUrl is not a valid URL.' });
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'imageUrl must use http or https.' });
  }

  const options = parseOptions(req.body);
  const withImage = req.body.withImage === true || req.body.withImage === 'true';

  try {
    const geminiResult = await geminiService.identifyAnimalFromUrl(imageUrl, options);

    if (!geminiResult.success) {
      return res
        .status(502)
        .json({ error: 'Identification failed', details: geminiResult.error });
    }

    const data = geminiResult.data;
    await runVerification(data, options.location);
    await attachPhoto(data);

    if (withImage && data.referencePhoto?.url) {
      const imgBuffer = await createCompositeImage(data.referencePhoto.url, data);
      if (imgBuffer) {
        return res.status(200).json({
          success: true,
          model: geminiResult.model,
          data,
          compositeImage: imgBuffer.toString('base64'),
        });
      }
    }

    return res.status(200).json({ success: true, model: geminiResult.model, data });
  } catch (err) {
    next(err);
  }
};
