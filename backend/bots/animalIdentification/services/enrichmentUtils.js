/**
 * Shared enrichment utilities for animal identification pipelines.
 *
 * Used by:
 *   - bots/telegram/commands/identify.js          (Telegram bot)
 *   - bots/animalIdentification/controllers/identificationController.js  (REST API)
 *   - bots/animalIdentification/services/imageService.js  (canvas/SVG renderers)
 *
 * Single source of truth for: local-status classification, abundance classification,
 * subspecies helpers, sex-confidence gate, and pre-computed display fields.
 */

// ── Local status ─────────────────────────────────────────────────────────────

const LOCAL_STATUS_DEFINITIONS = {
  R:   'Resident',
  RB:  'Resident Breeder',
  WV:  'Winter Visitor',
  PM:  'Passage Migrant',
  MB:  'Migrant Breeder',
  NBV: 'Non-breeding Visitor',
  V:   'Vagrant',
  I:   'Introduced',
  rI:  'Reintroduced',
};

/** @param {string} text @param {string[]} words */
function includesAny(text, words) {
  const n = String(text || '').toLowerCase();
  return words.some(w => n.includes(w));
}

/**
 * Classify a species' local status from occurrence data.
 *
 * @param {{ gbifOccurrence?: object, ebirdSummary?: object, migratoryStatus?: string }} opts
 *   gbifOccurrence: { count, monthsObservedCount, breedingSignalCount, establishmentMeans[] }
 *   ebirdSummary:   { count }
 */
function classifyLocalStatus({ gbifOccurrence = {}, ebirdSummary = {}, migratoryStatus = '' } = {}) {
  const occCount            = gbifOccurrence.count              || 0;
  const monthsObservedCount = gbifOccurrence.monthsObservedCount || 0;
  const breedingSignalCount = gbifOccurrence.breedingSignalCount || 0;
  const establishmentMeans  = gbifOccurrence.establishmentMeans  || [];
  const ebirdCount          = ebirdSummary.count                 || 0;
  const migration           = String(migratoryStatus || '').toLowerCase();

  if (establishmentMeans.some(s => includesAny(s, ['introduced', 'released', 'escape', 'escaped'])))
    return { code: 'I', label: LOCAL_STATUS_DEFINITIONS.I };

  if (establishmentMeans.some(s => includesAny(s, ['reintroduced', 're-introduced', 'reintroduction'])))
    return { code: 'rI', label: LOCAL_STATUS_DEFINITIONS.rI };

  if (occCount === 0 && ebirdCount === 0)
    return { code: 'V', label: LOCAL_STATUS_DEFINITIONS.V };

  if (includesAny(migration, ['passage']))
    return { code: 'PM', label: LOCAL_STATUS_DEFINITIONS.PM };

  if (includesAny(migration, ['winter visitor', 'wintering', 'wv']))
    return { code: 'WV', label: LOCAL_STATUS_DEFINITIONS.WV };

  const hasYearRoundSignal = monthsObservedCount >= 10;
  const hasBreedingSignal  = breedingSignalCount > 0 || includesAny(migration, ['breeder', 'breeding']);

  if (hasYearRoundSignal && hasBreedingSignal)  return { code: 'RB',  label: LOCAL_STATUS_DEFINITIONS.RB };
  if (hasYearRoundSignal && !hasBreedingSignal) return { code: 'R',   label: LOCAL_STATUS_DEFINITIONS.R };
  if (hasBreedingSignal  && !hasYearRoundSignal) return { code: 'MB', label: LOCAL_STATUS_DEFINITIONS.MB };
  if (occCount > 0 || ebirdCount > 0)           return { code: 'NBV', label: LOCAL_STATUS_DEFINITIONS.NBV };

  return { code: 'V', label: LOCAL_STATUS_DEFINITIONS.V };
}

// ── Abundance ─────────────────────────────────────────────────────────────────

const ABUNDANCE_DEFINITIONS = {
  VC: 'Very common (VC) - found almost all the time in suitable locations',
  C:  'Common (C) - found most of the time in suitable locations',
  U:  'Uncommon (U) - found some of the time',
  R:  'Rare (R) - found several times a year',
  VR: 'Very rare (VR) - not found every year',
  Ex: 'Extirpated (Ex) - used to be found in Singapore, but not any more',
};

/**
 * @param {{ gbifOccurrence?: { count: number }, ebirdSummary?: { count: number } }} opts
 */
function classifyAbundance({ gbifOccurrence = {}, ebirdSummary = {} } = {}) {
  const gbifCount  = gbifOccurrence.count || 0;
  const ebirdCount = ebirdSummary.count   || 0;
  const total      = gbifCount + ebirdCount;

  if (gbifCount === 0 && ebirdCount === 0) return { code: 'Ex', label: ABUNDANCE_DEFINITIONS.Ex };
  if (total > 100) return { code: 'VC', label: ABUNDANCE_DEFINITIONS.VC };
  if (total > 50)  return { code: 'C',  label: ABUNDANCE_DEFINITIONS.C  };
  if (total > 10)  return { code: 'U',  label: ABUNDANCE_DEFINITIONS.U  };
  if (total > 1)   return { code: 'R',  label: ABUNDANCE_DEFINITIONS.R  };
  if (total === 1) return { code: 'VR', label: ABUNDANCE_DEFINITIONS.VR };
  return { code: 'Ex', label: ABUNDANCE_DEFINITIONS.Ex };
}

// ── Subspecies helpers ────────────────────────────────────────────────────────

/** True if the subspecies string is a placeholder (monotypic / null / none / empty). */
function isMonotypic(v) {
  return ['monotypic', 'null', 'none', ''].includes(String(v || '').toLowerCase().trim());
}

/**
 * Extract the last word of a trinomial name as the lowercase epithet.
 * Handles slash taxa by taking the last token before splitting on '/'.
 * e.g. "Falco peregrinus ernesti" → "ernesti"
 *      "ernesti/nesiotes"         → "ernesti"   (via getEpithets)
 */
function getEpithet(name) {
  return String(name || '').trim().split(/\s+/).pop().toLowerCase();
}

/**
 * Returns all slash-separated epithet variants as an array.
 * e.g. "Falco peregrinus ernesti/nesiotes" → ["ernesti", "nesiotes"]
 */
function getEpithets(name) {
  return getEpithet(name).split('/').map(p => p.trim()).filter(Boolean);
}

/**
 * Extract the display epithet: for trinomials return the third+ word,
 * then take only the primary (first) slash-separated part.
 * e.g. "Falco peregrinus ernesti/nesiotes" → "ernesti"
 *      "Falco peregrinus ernesti"          → "ernesti"
 *      "ernesti/nesiotes"                  → "ernesti"
 */
function getEpithetDisplay(s) {
  const parts = String(s || '').trim().split(/\s+/);
  const epithet = parts.length >= 3 ? parts.slice(2).join(' ') : String(s || '').trim();
  return epithet.split('/')[0].trim();
}

// ── Sex confidence gate ───────────────────────────────────────────────────────

/**
 * Returns true when sex data is reliable enough to show to the user.
 * Threshold: confidence ≥ 55 % OR determined by unambiguous visual/species-knowledge method.
 */
function shouldShowSex(data) {
  const conf   = typeof data.sexConfidence === 'number' ? data.sexConfidence : 1.0;
  const method = String(data.sexMethod || '').toLowerCase();
  return conf >= 0.55 || method === 'from_image_plumage' || method === 'from_species_knowledge';
}

// ── Pre-computed display fields ───────────────────────────────────────────────

/**
 * Mutates `data` in-place, adding pre-computed display fields so renderers
 * (imageService, IdentifyAnimal.jsx) are pure rendering with no logic:
 *
 *   data.displaySex             — "Male" | "Female" | null
 *   data.displaySubspecies      — string (image-confirmed epithet) | string[] (location list) | undefined
 *   data.displaySubspeciesLabel — "Subspecies" | "Subspecies (Singapore)" | undefined
 */
function computeDisplayFields(data) {
  // Sex
  const sexVal = data.sex || '';
  if (sexVal && sexVal !== 'Unknown') {
    const isMaleFemale = ['male', 'female'].includes(sexVal.toLowerCase());
    data.displaySex = (shouldShowSex(data) && isMaleFemale) ? sexVal : null;
  }

  // Subspecies
  if (data.subspeciesImageMatch) {
    data.displaySubspecies      = getEpithetDisplay(data.subspeciesImageMatch);
    data.displaySubspeciesLabel = 'Subspecies';
  } else if (Array.isArray(data.subspecies) && data.subspecies.length > 0) {
    data.displaySubspecies      = data.subspecies.map(getEpithetDisplay);
    data.displaySubspeciesLabel = `Subspecies (${data.subspeciesLocation || 'location'})`;
  } else {
    // Fallback: Gemini identified a subspecies from the image but eBird cross-ref found no match
    const taxSub = data.taxonomy?.subspecies;
    if (taxSub && !isMonotypic(taxSub) && String(taxSub).toLowerCase().trim() !== 'unknown') {
      data.displaySubspecies      = getEpithetDisplay(taxSub);
      data.displaySubspeciesLabel = 'Subspecies';
    }
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  LOCAL_STATUS_DEFINITIONS,
  ABUNDANCE_DEFINITIONS,
  includesAny,
  isMonotypic,
  classifyLocalStatus,
  classifyAbundance,
  getEpithet,
  getEpithets,
  getEpithetDisplay,
  shouldShowSex,
  computeDisplayFields,
};
