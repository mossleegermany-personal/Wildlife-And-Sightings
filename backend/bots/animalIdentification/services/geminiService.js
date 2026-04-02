/**
 * Gemini AI Service — Animal / Wildlife Identification
 *
 * Ported from Animal-Identification-Bot with platform-agnostic interface.
 * Accepts an image buffer (or URL) and returns a structured identification
 * result ready to be consumed by any platform adapter (Telegram, web, etc.).
 *
 * Exported functions:
 *   identifyAnimal(imageBuffer, mimeType, options)  → identification result
 *   identifyAnimalFromUrl(imageUrl, options)         → same but fetches first
 */
const { GoogleGenAI } = require('@google/genai');
const logger = require('../../../src/utils/logger');

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const DEFAULT_MODELS = [
  { name: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview' },
  { name: 'deep-research-pro-preview-12-2025', displayName: 'Deep Research Pro Preview' },
];

function normalizeModelDisplayName(modelName) {
  return modelName
    .split('-')
    .map((part) => (part.length ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function parseConfiguredModels(raw) {
  if (!raw) return null;
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!names.length) return null;

  return names.map((name) => ({
    name,
    displayName: normalizeModelDisplayName(name),
  }));
}

const MODELS = parseConfiguredModels(process.env.GEMINI_MODEL) || DEFAULT_MODELS;
const unavailableModels = new Set();
const warnedUnavailableModels = new Set();

function isEnvTrue(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

const THINKING_ENABLED = isEnvTrue(process.env.GEMINI_THINKING_ENABLED || 'true');
const THINKING_BUDGET = Number.parseInt(process.env.GEMINI_THINKING_BUDGET || '1024', 10);

function buildGenerationConfig(modelName) {
  const config = { ...GENERATION_CONFIG };
  const supportsThinking = /gemini-(2\.5|3\.)/.test(modelName) || modelName.includes('deep-research');
  if (THINKING_ENABLED && supportsThinking) {
    config.thinkingConfig = {
      thinkingBudget: Number.isFinite(THINKING_BUDGET) ? THINKING_BUDGET : 1024,
    };
  }
  return config;
}

const GENERATION_CONFIG = {
  temperature: 0.2,
  topP: 0.9,
  topK: 32,
  maxOutputTokens: 8192,
  responseMimeType: 'application/json',
};

function extractTextFromGenAIResponse(response) {
  if (!response) return '';
  if (typeof response.text === 'function') return response.text();
  if (typeof response.text === 'string') return response.text;
  if (typeof response.outputText === 'string') return response.outputText;

  const textFromCandidates = response.candidates
    ?.flatMap((candidate) => candidate?.content?.parts || [])
    ?.map((part) => part?.text)
    ?.filter(Boolean)
    ?.join('\n');

  return textFromCandidates || '';
}

const PROMPT = `You are an expert wildlife biologist, ornithologist, and taxonomist with decades of field experience.

IMAGE QUALITY & CONDITIONS ANALYSIS:
- ALWAYS attempt identification regardless of image quality — phone photos, blur, low light, poor angle are all fine.
- Only return identified=false if there is genuinely NO animal visible at all in the image.
- Before identifying, assess the following image conditions and let them guide your confidence and reasoning:
  1. LIGHT: Is it bright daylight, golden hour, dusk, night, backlit, or low light? Low light / artificial light can affect colour accuracy — note this.
  2. BLUR: Is the image sharp, slightly blurred, or heavily motion-blurred? Blur reduces diagnostic detail — lower species-level confidence accordingly.
  3. RESOLUTION: Is the image high-res, medium, or low-res (pixelated)? Low resolution limits fine markings — identify at a higher taxonomic rank if needed.
  4. ANGLE: What angle is the animal at? (Side, front, back, three-quarter, overhead, in flight, partially obscured) — some angles hide key field marks; state which marks were or were not visible.
  5. DISTANCE: Is the animal close-up, mid-range, or distant? Distant subjects have less diagnostic detail.
- For each condition that limits identification, explicitly note it in identificationReasoning.
- If quality is poor, still identify to the best level you can (family or genus is fine) and explain the limiting factor.

IF THE IMAGE CONTAINS AN ANIMAL, ANALYZE CAREFULLY:
Look at:
1. Body shape, size proportions, and posture
2. Bill/beak shape, size, and color
3. Leg length, color, and structure
4. Wing pattern, length, and shape
5. Tail shape and length
6. Plumage/fur colors, patterns, and markings
7. Eye color, size, and ring patterns
8. Any distinctive field marks
9. Scene context (habitat, water/forest/urban, perching surface, behavior)
10. If multiple animals are visible, identify the most salient subject unless user specified a target

CRITICAL ACCURACY RULES:
- Only identify to the taxonomic level you are 90%+ CONFIDENT about
- If you can confidently identify the species but NOT the subspecies, leave subspecies as null
- If you can only confidently identify the genus, use "Genus sp." format
- Do NOT guess — accuracy is more important than specificity
- Consider similar species that could be confused — rule them out explicitly
- Prioritize species identification from visible morphology first, then use habitat/season/location as supporting evidence.
- For occluded or blurry animals, identify at the highest reliable taxonomic rank and explain why finer rank is uncertain.
- SEX DETERMINATION (use ALL of the following in order):
  1. SPECIES KNOWLEDGE: Once you have identified the species, recall its sexual dimorphism from authoritative sources (eBird species accounts, GBIF taxon descriptions, field guides). Know which features differ between sexes — e.g. plumage colour, bill colour, eye colour, orbital ring, crest, wing markings, tail length, facial pattern.
  2. PLUMAGE ANALYSIS: Examine the visible plumage, markings, bill, eye, and any other features in this image. Explicitly match them against the known male/female descriptions for this species.
  3. DECISION: Set sex to "Male" or "Female" when the visible features match the species' dimorphic characteristics. Set sexConfidence (0.0–1.0) to reflect how clearly the diagnostic features are visible. Only set sex to "Unknown" when the species is monomorphic, the animal is juvenile (pre-adult plumage), or the relevant features are entirely obscured/invisible.
  4. Set sexMethod to one of: "from_image_plumage" (features clearly visible), "from_species_knowledge" (features partially visible but consistent with species dimorphism), "inferred" (low visibility but consistent with species patterns), "unknown" (cannot determine).
- Set breedingPlumage to "Yes" only if ornamental or nuptial plumage is clearly visible (elongated tail streamers, vivid breeding colours, crests). Otherwise set "No" or "Unknown".

Return JSON only:
{
  "identified": true,
  "identificationLevel": "subspecies/species/genus/family",
  "confidence": 0.95,
  "commonName": "Common Name",
  "scientificName": "Full scientific name",
  "taxonomy": {
    "kingdom": "Animalia",
    "phylum": "",
    "class": "",
    "order": "",
    "family": "",
    "subfamily": "",
    "genus": "",
    "species": "null if not confident enough",
    "subspecies": "null if not confident enough, or 'monotypic'"
  },
  "confidenceLevels": {
    "family": 0.99,
    "genus": 0.95,
    "species": 0.85,
    "subspecies": 0.60
  },
  "similarSpeciesRuledOut": [
    "Species Name 1 - reason why ruled out",
    "Species Name 2 - reason why ruled out"
  ],
  "identificationReasoning": "What features you could see clearly",
  "sceneDescription": "Short visual summary of the scene and habitat context",
  "detectedAnimals": [
    {
      "label": "what animal appears to be present",
      "confidence": 0.92,
      "bbox": { "x": 0.12, "y": 0.24, "width": 0.38, "height": 0.44 }
    }
  ],
  "sex": "Male/Female/Unknown",
  "sexConfidence": 0.0,
  "sexMethod": "from_image_plumage/from_species_knowledge/inferred/unknown",
  "lifeStage": "Adult/Juvenile/Immature/Unknown (choose exactly one; never combine as Juvenile/Immature)",
  "morph": "color morph or null",
  "breedingPlumage": "Yes/No/Unknown — set Yes only if the bird visibly shows breeding plumage (elongated feathers, vivid colours, ornamental crests/streamers clearly different from non-breeding)",
  "viewAngle": "Side View/Front View/Back View/Three-Quarter View/Overhead/In Flight/Unknown",
  "migratoryStatus": "status AT THE PROVIDED LOCATION (Resident/Winter Visitor/Summer Visitor/Passage Migrant/Vagrant/null if no location given)",
  "iucnStatus": {
    "global": "LC/NT/VU/EN/CR/EW/EX/DD/NE",
    "local": "Local status or null"
  }
}

If no animal: {"identified": false, "reason": "no_animal", "qualityIssue": "No animal detected in the image", "suggestion": "Please send a photo containing an animal"}`;

/**
 * Identify an animal from an image buffer.
 *
 * @param {Buffer} imageBuffer
 * @param {string} [mimeType='image/jpeg']
 * @param {Object} [options]
 * @param {string} [options.location]        - Location context for better accuracy
 * @param {string} [options.identifyTarget]  - Specific subject to identify (e.g. "the bird on the left")
 * @param {string} [options.habitat]         - Habitat context
 * @param {string} [options.additionalNotes] - Any extra notes
 * @param {string} [options.imageCapturedAt] - ISO datetime from EXIF metadata when available
 * @returns {Promise<{success: boolean, data?: Object, model?: string, error?: string}>}
 */
async function identifyAnimal(imageBuffer, mimeType = 'image/jpeg', options = {}) {
  const lower = (v) => String(v || '').toLowerCase();
  const isModelUnavailableError = (err) => {
    const msg = lower(err?.message);
    return (
      msg.includes('[404 not found]') ||
      msg.includes('models/') && msg.includes('is not found') ||
      msg.includes('not supported for generatecontent')
    );
  };
  const isQuotaError = (err) => {
    const msg = lower(err?.message);
    return (
      msg.includes('quota') ||
      msg.includes('resource exhausted') ||
      msg.includes('rate limit') ||
      msg.includes('too many requests') ||
      msg.includes(' 429') ||
      msg.includes('[429')
    );
  };

  const base64Image = imageBuffer.toString('base64');

  let prompt = PROMPT;

  if (options.identifyTarget) {
    prompt += `\n\n🎯 IDENTIFICATION TARGET:
The user wants you to specifically identify: "${options.identifyTarget}"
Focus on this specific subject in the image. If there are multiple animals, identify only the one matching this description.
If you cannot find what the user described, return: {"identified": false, "reason": "target_not_found", "qualityIssue": "Could not find the specified subject in the image", "suggestion": "Please describe the animal more clearly or send a photo with the subject more visible"}`;
  }

  if (options.location || options.country) {
    prompt += `\n\n🌍 GEOGRAPHIC CONTEXT (use to help narrow down identification):`;
    if (options.country) prompt += `\nCountry: ${options.country}`;
    if (options.location) prompt += `\nLocation: ${options.location}`;

    const capturedDate = options.imageCapturedAt ? new Date(options.imageCapturedAt) : null;
    const hasValidCapturedDate = capturedDate && !Number.isNaN(capturedDate.getTime());
    const referenceDate = hasValidCapturedDate ? capturedDate : new Date();
    if (hasValidCapturedDate) {
      prompt += `\nImage Capture Date (EXIF): ${capturedDate.toISOString()}`;
    }
    prompt += `\nReference Month/Year: ${referenceDate.toLocaleString('en-US', { month: 'long' })} ${referenceDate.getFullYear()}`;

    prompt += `\n\n🦅 MIGRATORY BIRDS CONSIDERATION:
- Consider whether this could be a migratory species passing through or wintering in this location
- For the given location and time of year, consider: Resident / Winter Visitor / Summer Visitor / Passage Migrant
- Migratory status can help narrow down identification between similar species
- Geographic location and season should not override clear visual evidence.`;
  }

  if (options.habitat) {
    prompt += `\n\nHabitat: ${options.habitat}`;
  }

  if (options.additionalNotes) {
    prompt += `\n\nAdditional notes: ${options.additionalNotes}`;
  }

  let lastError = null;
  const candidateModels = MODELS.filter((m) => !unavailableModels.has(m.name));

  if (!candidateModels.length) {
    return {
      success: false,
      error: 'No available Gemini models for this API version/project. Set GEMINI_MODEL to a supported model, e.g. gemini-2.5-pro.',
    };
  }

  for (const modelInfo of candidateModels) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        logger.debug(`Trying ${modelInfo.displayName} (attempt ${attempt}/3)`);

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout after 120s')), 120000)
        );

        const result = await Promise.race([
          genAI.models.generateContent({
            model: modelInfo.name,
            contents: [{
              role: 'user',
              parts: [
                { text: prompt },
                { inlineData: { mimeType, data: base64Image } },
              ],
            }],
            config: buildGenerationConfig(modelInfo.name),
          }),
          timeoutPromise,
        ]);

        const text = extractTextFromGenAIResponse(result);
        logger.debug(`${modelInfo.displayName} responded`, { preview: text.substring(0, 200) });

        // Strip markdown code fences if present
        const jsonText = text
          .replace(/```json\n?/g, '')
          .replace(/```\n?/g, '');

        const jsonMatch = jsonText.match(/\{[\s\S]*/);
        if (!jsonMatch) throw new Error('No valid JSON in response');

        let data;
        try {
          // Try strict parse first
          const fullMatch = jsonText.match(/\{[\s\S]*\}/);
          data = JSON.parse(fullMatch ? fullMatch[0] : jsonMatch[0]);
        } catch {
          // JSON was truncated — repair by closing open braces/arrays
          try {
            data = repairJson(jsonMatch[0]);
            logger.warn(`${modelInfo.displayName} returned truncated JSON — repaired`, { preview: jsonMatch[0].slice(-80) });
          } catch (repairErr) {
            // Repair also failed — treat as a retryable error
            throw new Error(`JSON repair failed: ${repairErr.message}`);
          }
        }

        return { success: true, data, model: modelInfo.displayName };

      } catch (error) {
        logger.debug(`${modelInfo.displayName} failed`, { error: error.message });

        const isTimeout = error.message?.includes('Timeout');
        const isQuota = isQuotaError(error);

        if (isModelUnavailableError(error)) {
          unavailableModels.add(modelInfo.name);
          if (!warnedUnavailableModels.has(modelInfo.name)) {
            logger.warn(`${modelInfo.displayName} is unavailable on this API version/project. Trying next model.`);
            warnedUnavailableModels.add(modelInfo.name);
          }
          lastError = error;
          break;
        }

        if ((isQuota || isTimeout) && attempt < 3) {
          const wait = isTimeout ? 5000 : attempt * 20000;
          logger.warn(`${isTimeout ? 'Timeout' : 'Quota'} — retrying in ${wait / 1000}s`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }

        lastError = error;
        break; // next model
      }
    }
  }

  return {
    success: false,
    error:
      isModelUnavailableError(lastError)
        ? 'Configured Gemini model is unavailable for this API version/project. Set GEMINI_MODEL to a supported model, e.g. gemini-2.5-pro.'
        : isQuotaError(lastError)
        ? 'API quota exceeded. Please wait a minute and try again.'
        : lastError?.message?.includes('Timeout')
        ? 'Gemini took too long to respond. Please try again.'
        : lastError?.message || 'All models failed',
  };
}

/**
 * Identify an animal from a public image URL.
 * Fetches the image first, then delegates to identifyAnimal().
 *
 * @param {string} imageUrl
 * @param {Object} [options]  - Same options as identifyAnimal()
 * @returns {Promise<Object>}
 */
async function identifyAnimalFromUrl(imageUrl, options = {}) {
  // Basic URL validation — must be http/https
  const url = new URL(imageUrl); // throws if malformed
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http/https URLs are supported.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(imageUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch image: HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const imageBuffer = Buffer.from(await response.arrayBuffer());

    return identifyAnimal(imageBuffer, contentType.split(';')[0], options);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort repair of a truncated JSON string.
 * Extracts all key:value pairs reachable before the cut-off and wraps them
 * in a valid object. Handles nested objects by stripping any incomplete tail.
 */
function repairJson(raw) {
  // Walk char by char, track brace/bracket depth, collect complete pairs
  let depth = 0;
  let lastSafePos = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escape)          { escape = false; continue; }
    if (ch === '\\')     { escape = true;  continue; }
    if (ch === '"')      { inString = !inString; continue; }
    if (inString)        { continue; }
    if (ch === '{' || ch === '[') { depth++; continue; }
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) lastSafePos = i + 1;
    }
  }

  // If we found a fully-closed top-level object, use it
  if (lastSafePos > 0) {
    try { return JSON.parse(raw.slice(0, lastSafePos)); } catch { /* fall through */ }
  }

  // Otherwise strip the incomplete trailing fragment and close braces
  let trimmed = raw.replace(/,\s*$/, '').replace(/:\s*$/, '');

  // ── Handle unterminated string values ─────────────────────────────────────
  // Find the opening quote of any unclosed string and trim from there.
  {
    let inStr = false, esc = false;
    let lastOpenQuotePos = -1;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (esc)         { esc = false; continue; }
      if (ch === '\\') { esc = true;  continue; }
      if (ch === '"')  {
        inStr = !inStr;
        if (inStr) lastOpenQuotePos = i;
      }
    }
    if (inStr && lastOpenQuotePos >= 0) {
      // Trim from the opening quote, removing any trailing , or :
      trimmed = trimmed.slice(0, lastOpenQuotePos).replace(/[,\s:]+$/, '');
    }
  }

  // Strip incomplete last key (key without value)
  trimmed = trimmed.replace(/,?\s*"[^"]*"\s*:\s*$/, '');
  trimmed = trimmed.replace(/,?\s*"[^"]*"\s*$/, '');
  // Close any remaining open braces
  let opens = 0;
  let arrOpens = 0;
  let inStr2 = false;
  let esc2 = false;
  for (const ch of trimmed) {
    if (esc2)         { esc2 = false; continue; }
    if (ch === '\\') { esc2 = true;  continue; }
    if (ch === '"')  { inStr2 = !inStr2; continue; }
    if (inStr2)      { continue; }
    if (ch === '{')  opens++;
    if (ch === '}')  opens--;
    if (ch === '[')  arrOpens++;
    if (ch === ']')  arrOpens--;
  }
  while (arrOpens-- > 0) trimmed += ']';
  while (opens-- > 0)    trimmed += '}';

  return JSON.parse(trimmed);
}

module.exports = { identifyAnimal, identifyAnimalFromUrl };
