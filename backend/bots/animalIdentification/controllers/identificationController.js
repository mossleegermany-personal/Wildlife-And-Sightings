/**
 * Identification Controller — Animal Identification Bot
 *
 * Handles the full pipeline:
 *   Gemini AI → GBIF verification → eBird verification → iNaturalist photo
 */
const geminiService = require('../services/geminiService');
const { verifyWithGBIF } = require('../services/gbifService');
const { verifyWithEBird } = require('../../birdSighting/services/ebirdService');
const { getSpeciesPhoto } = require('../services/inaturalistService');
const { createCompositeImage } = require('../services/imageService');
const logger = require('../../../src/utils/logger');

function parseOptions(body) {
  return {
    location: body.location || '',
    identifyTarget: body.identifyTarget || 'auto',
    habitat: body.habitat || '',
    additionalNotes: body.notes || body.additionalNotes || '',
    country: body.country || '',
  };
}

async function runVerification(geminiData, location) {
  const scientificName =
    geminiData.scientificName || geminiData.taxonomy?.scientific_name;
  const commonName = geminiData.commonName || geminiData.taxonomy?.common_name;
  if (!scientificName) return geminiData;

  try {
    const [gbif, ebird] = await Promise.allSettled([
      verifyWithGBIF({ ...geminiData, scientificName, commonName }, location),
      verifyWithEBird(scientificName, commonName),
    ]);

    if (gbif.status === 'fulfilled' && gbif.value?.verified) {
      Object.assign(geminiData, {
        gbifKey: gbif.value.speciesKey,
        gbifVerified: true,
        gbifAcceptedName: gbif.value.acceptedName,
        gbifCommonName: gbif.value.vernacularName,
        occursAtLocation: gbif.value.occursAtLocation,
      });
    }

    if (ebird.status === 'fulfilled' && ebird.value?.verified) {
      Object.assign(geminiData, {
        ebirdCode: ebird.value.speciesCode,
        ebirdVerified: true,
        ebirdUrl: ebird.value.url,
      });
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

  const photo = await getSpeciesPhoto(scientificName);
  if (photo.found) {
    resultData.referencePhoto = {
      url: photo.photoUrl,
      source: photo.source,
      taxonId: photo.taxonId,
    };
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
