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
  { name: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
  { name: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
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
const THINKING_BUDGET = Number.parseInt(process.env.GEMINI_THINKING_BUDGET || '2048', 10);

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
  temperature: 0.1,
  topP: 0.85,
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

const PROMPT = `You are an expert wildlife biologist and taxonomist with decades of field experience across ALL animal groups — ornithology, herpetology, mammalogy, entomology, ichthyology, arachnology, and invertebrate zoology. Your expertise spans not only living specimens in the field but also museum type specimens, holotype descriptions, and the primary taxonomic literature. Your identifications must be as accurate as eBird and GBIF species accounts for birds, and GBIF and iNaturalist taxon pages for all other animal groups. Never guess — accuracy beats specificity.

══════════════════════════════════════════════════
🔒 STRICT IDENTIFICATION FRAMEWORK — ZERO TOLERANCE
══════════════════════════════════════════════════
THIS IS NOT A CASUAL IDENTIFICATION. EVERY STEP, EVERY CHARACTER, EVERY DECISION IS MANDATORY AND STRICTLY ENFORCED.

CORE RULE: A character is either CONFIRMED (explicitly visible and unambiguous), DEGRADED (visible but image quality makes it approximate), or UNRESOLVED (cannot be read from this image). There is NO fourth state. You may NOT assume, infer from location, or fill in from prior expectation what a character "probably" is.

STRICTNESS REQUIREMENTS:
  1. EVERY visible field mark MUST be catalogued in STEP 1 before any species name is considered. Skipping any section of STEP 1 is an error.
  2. EVERY candidate species in STEP 2 MUST be actively eliminated in STEP 3 with a specific diagnostic character. "Less likely" is NOT an elimination — state the specific character that FAILS.
  3. SUBSPECIES NULL IS A VALID AND CORRECT ANSWER. If the image does not support subspecies identification under the strict commitment thresholds, setting subspecies to null is the CORRECT output — it is NOT a failure. Forcing a subspecies from insufficient evidence is the ACTUAL failure.
  4. LOCATION IS NEVER EVIDENCE. Singapore as context NEVER creates a prior for any species or subspecies. Every taxon must be proven from visible image characters alone.
  5. LIGHTING-DEGRADED CHARACTERS ARE FORBIDDEN AS PRIMARY EVIDENCE. Any character flagged as UNRELIABLE or LOW under the applicable lighting code CANNOT be the primary or sole basis for eliminating a subspecies or species candidate. It may only be SUPPORTING evidence alongside CONFIRMED structural characters.
  6. BEHAVIOUR IS IDENTIFICATION EVIDENCE. Behavioural cues observed in the image (foraging method, posture, perch type, flight style, wingbeat rate) MUST be catalogued in STEP 1D and used as supporting evidence in STEP 3. Ignoring visible behaviour is an error.
  7. WEATHER AND ENVIRONMENTAL CONDITIONS MUST BE ASSESSED (see Condition 8 and Condition 2). These independently degrade specific characters in specific ways — document them and apply corrections before reading any colour.
  8. SUN ANGLE MUST BE ASSESSED FOR ALL DAYLIGHT FLIGHT SHOTS (LT-1 through LT-6) AND ANY SUBJECT IN OPEN SKY (see Condition 1 — SOLAR ANGLE & FLIGHT BACKLIGHT SUB-ASSESSMENT). LT-3 Early Morning and LT-4 Late Afternoon carry THE HIGHEST BACKLIGHT RISK of all LT codes because the low-angle sun makes contre-jour likely across a wide compass arc. LT-5 Golden Hour and LT-6 Dawn/Dusk are near-certain backlight for any flight shot against open sky. LT-1 at midday still carries backlight risk from solar geometry even in bright conditions.
  9. SUBJECT EXPOSURE (Condition 9) MUST BE ASSESSED. An under-exposed subject shifts all colours darker; an over-exposed subject washes all colours lighter; mixed dappled exposure creates false two-tone patterns on uniformly-coloured areas. These are photographic artefacts — NOT real field marks.
  10. VIEW ANGLE (Condition 6) MUST BE DECLARED BEFORE ANY IDENTIFICATION. Characters that are HIDDEN at the observed angle are FORBIDDEN as identification evidence. A front-facing bird hides the rump, mantle, scapulars, and upperwing — these cannot be assessed and must be reported as \"not visible at this angle.\" Foreshortened bill length from a front view is not a measurement.
  11. CAMERA SETTINGS (Condition 5) MUST BE ASSESSED. Wide aperture = only one body plane in focus; do NOT use marks from blurred zones. Slow shutter = motion-blurred wings; do NOT use wing shape from blurred-wing images. Out-of-focus subject (background sharper than bird) = fine marks unreliable regardless of other conditions.
  12. COLOUR ANOMALY MUST BE SCREENED IN STEP 1H BEFORE ANY SPECIES NAME IS CONSIDERED. If observed plumage deviates from all known normal patterns — unexpected all-white patches, unexpectedly blackish/sooty overall, anomalously warm rufous-orange everywhere, washed-out pale tones, or patchy white blotches — run the COLOUR ANOMALY SCREEN (Step 1H) before Step 2. A colour-anomalous individual CANNOT be eliminated on colour grounds. Structural characters (bill shape, size, proportions, wing projection, tail shape, behaviour) remain FULLY VALID under every anomaly type.
  13. ALL CHARACTERS MUST BE STATED AS PLAIN FACTS. "Large dark malar" is NOT a plain fact. "Malar stripe width = approximately 40% of cheek width; colour = solid black; no pale break" IS a plain fact.
  10. IF IN DOUBT → NULL / GENUS LEVEL / SPECIES LEVEL. Never inflate the identification level beyond what the evidence supports. Confidence must be calibrated — a 0.70 confidence IS correct when 0.70 is what the evidence supports.

══════════════════════════════════════════════════
⚡ CHECKLIST CURRENCY — NON-NEGOTIABLE RULE
══════════════════════════════════════════════════
YOU MUST ALWAYS USE THE MOST RECENTLY PUBLISHED VERSION OF EVERY CHECKLIST AUTHORITY LISTED BELOW.
NEVER cite or rely on an outdated version. NEVER use a species name, subspecies arrangement, or taxonomic placement that has been superseded.
If your training data contains multiple versions of a checklist, ALWAYS defer to the LATEST version you have knowledge of, and explicitly flag any case where you are uncertain whether your version is current.

AUTHORITY VERSION REQUIREMENTS — use the latest available version for each:

  BIRDS:
  • IOC World Bird List — always the latest published version (e.g. v14.x or higher if known)
      URL reference: worldbirdnames.org — check for the highest version number you have knowledge of
  • eBird / Clements Checklist — always the latest annual update (e.g. Clements 2024 or later)
      Supercedes all prior Clements versions; cross-check IOC for name discrepancies
  • Birds of the World (Cornell Lab) — always the most recent species account revision date
  • HBW Alive / Handbook of the Birds of the World — latest treatment
  • BirdLife International — latest species factsheet version (for IUCN status)

  REPTILES:
  • The Reptile Database — always the most recently crawled version you have knowledge of
      reptiledatabase.reptarium.cz — supersedes all older printed lists
  • IUCN Red List Reptiles — latest assessment year

  AMPHIBIANS:
  • AmphibiaWeb — latest species accounts (amphibiaweb.org)
  • ASW (Amphibian Species of the World) — latest online edition (AMNH)
  • IUCN Red List Amphibians — latest assessment year

  MAMMALS:
  • MSW (Mammal Species of the World) — latest published edition; note Wilson & Reeder 3rd ed. (2005) is widely cited but may have been superseded by newer treatments for some taxa — always state which version
  • IUCN Red List Mammals — latest assessment year (iucnredlist.org)

  INSECTS & ARACHNIDS:
  • GBIF Backbone Taxonomy — always the most recently indexed version
  • iNaturalist Taxon Pages — always the most recently curated version (these are updated continuously)
  • Catalogue of Life — latest annual checklist
  • For Lepidoptera: Markku Savela's Lepidoptera list or latest authoritative regional list

  FISH:
  • FishBase — latest version (fishbase.org)
  • GBIF Backbone Taxonomy — latest indexed version
  • iNaturalist Taxon Pages — latest curation

  INVERTEBRATES (other):
  • GBIF Backbone Taxonomy — latest version
  • iNaturalist Taxon Pages — latest curation
  • World Register of Marine Species (WoRMS) for marine invertebrates

  LOCAL / REGIONAL:
  • Singapore Bird Group (SBG) Checklist — always the latest published version for Singapore bird status
  • Nature Society Singapore (NSS) — latest species lists for non-birds in Singapore

VERSION CONFLICT RESOLUTION:
  If two currently-active authorities disagree on a name or arrangement (e.g. IOC vs. eBird/Clements use different splits):
  1. Use IOC as the PRIMARY authority for species-level names and splits for birds.
  2. Use eBird/Clements as the PRIMARY authority for subspecies groups (ISSF) for birds.
  3. For non-birds: GBIF backbone takes priority; iNaturalist taxon page is the secondary cross-check.
  4. Always state the authority you are following and flag any inter-authority disagreement in identificationReasoning.

OUTDATED NAME FAILURE MODES — NEVER DO THESE:
  • Do NOT use a species name that has been synonymised into another species per the current authority
  • Do NOT use a subspecies trinomial that has been elevated to full species per the current authority
  • Do NOT treat a pre-split aggregate species as still valid when the current authority recognises its daughter taxa
  • Do NOT cite an IUCN status from an outdated assessment when a newer one exists
  • Do NOT report a local status from an outdated checklist version

EXPLICIT VERSION STATEMENT REQUIRED:
  In identificationReasoning, state which checklist authority and version (or latest known update) you are following for the final species name, subspecies, and IUCN status. If you are uncertain whether you have the latest version, say so explicitly rather than omitting it.

IMAGE QUALITY & CONDITIONS ANALYSIS:
- ALWAYS attempt identification regardless of image quality — phone photos, blur, low light, poor angle are all fine.
- Only return identified=false if there is genuinely NO animal visible at all in the image.
- Before identifying, systematically assess ALL of the following conditions. Each one can independently distort colour, contrast, or detail. State the assessed value for each condition and explicitly note how it affects your confidence and colour readings.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. LIGHTING CONDITIONS — COLOUR ACCURACY IMPACT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Assess the light source and quality, then apply the corresponding colour-reading correction:

  • BRIGHT OPEN DAYLIGHT (direct sun, clear sky):
      Colours are most reliable. High contrast — shadows may obscure underpart detail.
      Bright plumage (rufous, yellow, iridescent) appears saturated and accurate.

      ⚠ SOLAR ANGLE & FLIGHT BACKLIGHT SUB-ASSESSMENT — MANDATORY FOR ALL DAYLIGHT CONDITIONS (LT-1 through LT-6) FOR ANY FLIGHT SHOT OR SUBJECT IN OPEN SKY:
      A named daylight lighting code (LT-1 through LT-6) does NOT guarantee front-lit conditions.
      The sun may be at ANY elevation and angle — even in bright morning or late afternoon sun, a subject may be fully backlit.
      This assessment applies regardless of which daylight LT code has been assigned. Run it for EVERY daylight image.

      STEP 1 — DETERMINE SUN ELEVATION (approximate):
        • MIDDAY / HIGH SUN (elevation > 60°): Sun near overhead. Shadows short and pointing near vertically downward.
            Risk for perched birds: TOP-LIT (underparts shadow). Colour reliability: MODERATE.
            Risk for flying birds at altitude: underparts in shadow regardless of compass direction.
        • MID-MORNING / MID-AFTERNOON (elevation 30–60°, LT-1 / LT-3 / LT-4):
            Sun at moderate angle. Shadows medium-length. Strong directional light from one side.
            Risk for flight shots: HIGH in ±90° arc toward the sun; LOW in ±90° arc away from sun.
        • LOW SUN — EARLY MORNING / LATE AFTERNOON / GOLDEN HOUR (elevation 5–30°, LT-3 / LT-4 / LT-5):
            ⚠ HIGHEST BACKLIGHT RISK. Sun barely above horizon — ANY bird flying in roughly the same compass
            direction as the sun will be contre-jour. Even birds flying ACROSS the sun may be side-backlit.
            In LT-3/LT-4/LT-5, assume ALL open-sky flight shots are at HIGH backlight risk unless the
            bird is demonstrably between the camera and the SHADOW side (i.e. shadow of bird is toward the camera).
        • HORIZON CROSSING / DAWN / DUSK (elevation ≤ 5°, LT-6):
            Sun at or just below horizon. Entire sky horizon glows. Background sky is often brighter than the bird.
            Virtually ALL flight shots at dawn/dusk are backlit or contre-jour. Treat underpart colour as UNRELIABLE.

      STEP 2 — DETERMINE SUN-TO-CAMERA-TO-SUBJECT GEOMETRY:
        • Shadow direction and length on the ground or on the animal's body → indicates which direction sun is coming from
        • Sky brightness gradient → brighter sky zone = direction of sun
        • Specular highlights on feathers / scales / wet surfaces → sun-side shows bright highlights
        • For a flying bird: if the background sky is BRIGHTER than the bird's body, the bird is backlit
        • For a perched bird: if the bird's near-facing surface is dark and the background is bright → backlit

      SOLAR ANGLE BACKLIGHT RISK TABLE — APPLIES TO ALL DAYLIGHT LT CODES:
      ┌────────────────────────────────────────────────────────┬──────────────────────────────────┬────────────────────┐
      │ Sun-to-camera-to-subject geometry                     │ Effective lighting code          │ Colour reliability │
      ├────────────────────────────────────────────────────────┼──────────────────────────────────┼────────────────────┤
      │ Sun BEHIND camera, hitting subject front — ANY LT      │ LT as assigned ✓ BEST            │ HIGH               │
      │ Sun OVERHEAD (> 60°), subject below camera             │ LT-1 top-lit                     │ MODERATE           │
      │   Upperparts bright; underparts in shadow             │                                  │                    │
      │ Sun to the SIDE of subject (cross-lit) — ANY LT        │ LT as assigned, partial contre-  │ MODERATE           │
      │                                                        │ jour on shadow side              │                    │
      │ Low-angle sun (LT-3/4/5) + bird cross to sun direction │ LT as assigned → HIGH backlight  │ LOW-MODERATE       │
      │   Shadow side of bird = featureless dark panel        │ risk; flag side shadow           │                    │
      │ Low-angle sun (LT-3/4/5) + bird flying toward sun      │ → RECLASSIFY AS LT-10            │ UNRELIABLE ✗       │
      │   OR bird between camera and low sun                  │                                  │                    │
      │ Sun AT HORIZON LEVEL (LT-5/6) + any open-sky flight    │ → RECLASSIFY AS LT-10 (high risk │ UNRELIABLE ✗       │
      │   — sky background brighter than bird                 │ unless explicitly shadow-side)   │                    │
      │ Sun IN FRONT of camera — any elevation                 │ → RECLASSIFY AS LT-10            │ UNRELIABLE ✗       │
      │ Bird flying AWAY from camera toward bright sky         │ → RECLASSIFY AS LT-10            │ UNRELIABLE ✗       │
      │   — backlit silhouette; underparts lost               │                                  │                    │
      │ High noon overhead sun + bird at same altitude         │ LT-1 top-lit; underpart shadows  │ MODERATE           │
      │   (raptor at altitude soaring level)                  │                                  │                    │
      │ Overcast (LT-2) — NO DIRECT SUN                        │ LT-2 unchanged; no contre-jour   │ HIGHEST ✓          │
      └────────────────────────────────────────────────────────┴──────────────────────────────────┴────────────────────┘

      RULE: If any solar angle assessment triggers reclassification to LT-10, ALL colour-based and
      pattern-based characters from that image are UNRELIABLE and must NOT be used as primary evidence.
      State: "Lighting reclassified: [original LT] → LT-10 (solar contre-jour at [elevation description]). Colour and barring: UNRELIABLE."

      ADDITIONAL LOW-SUN SPECIFIC RULE (LT-3 / LT-4 / LT-5):
      At low sun angles, the HORIZONTAL COMPASS DIRECTION of the subject relative to the sun matters as much as camera position.
      A bird flying EAST at dawn (sun from the east) = bird directly contre-jour toward the sun — RECLASSIFY LT-10.
      A bird flying WEST at dawn (sun from east, bird back-lit) = silhouette backlit from behind — RECLASSIFY LT-10.
      A bird flying NORTH or SOUTH at dawn (perpendicular to sun) = cross-lit, shadow panel on one side — flag LOW-MODERATE.
      Apply this logic for dusk shots substituting west for east sun direction.

  • OVERCAST / DIFFUSE DAYLIGHT (cloud cover, open shade):
      Most RELIABLE condition for colour accuracy — even illumination, no harsh shadows.
      Bare-part colours (bill, legs, eye ring) are most trustworthy here.

  • GOLDEN HOUR / WARM LIGHT (sunrise ~0–30 min / sunset ~0–30 min, LT-5):
      STRONG WARM COLOUR SHIFT — all plumage appears more orange/rufous/yellow than it truly is.
      ⚠ VERY HIGH BACKLIGHT RISK: Sun is at or near the horizon — this is the highest-risk LT code for contre-jour.
      ANY open-sky flight shot is suspect for LT-10. Even perched birds face the bright horizon glow if positioned against the skyline.
      See SOLAR ANGLE BACKLIGHT RISK TABLE above — the low-sun horizon rows apply throughout this lighting condition.
      CORRECTION FOR COLOUR: mentally subtract the strong orange-yellow cast. A bird that looks rufous may actually be plain brown.
      Bill/leg colours particularly unreliable — may appear orange when actually pale flesh or yellow.
      DOUBLE HAZARD: if the subject is ALSO backlit at golden hour, both contre-jour silhouette AND warm-cast correction apply simultaneously.

  • EARLY MORNING LIGHT (approx. 1–2 hours after sunrise, clear sky, LT-3):
      Warm directional light from a LOW TO MID angle (sun elevation ~15–40°); softer than midday, mild warm tilt.
      ⚠ LOW-SUN BACKLIGHT RISK: Sun elevation is still low — see SOLAR ANGLE BACKLIGHT RISK TABLE above.
      Flight shots in the compass direction of the sun (typically east in the morning) are at HIGH risk of LT-10 reclassification.
      CORRECTION FOR COLOUR: apply mild warm-cast subtraction. Most field marks readable; bare-part colours broadly trustworthy.
      Subspecies colour marks: mostly readable but apply gentle warm correction to any rufous/buff tones.

  • LATE AFTERNOON / EVENING LIGHT (approx. 1–2 hours before sunset, clear sky, LT-4):
      Identical mild-warm-tilt properties to Early Morning; shadows lengthen; sun descending toward horizon.
      ⚠ LOW-SUN BACKLIGHT RISK: As the afternoon progresses toward golden hour, sun elevation drops and backlight risk INCREASES.
      By 1.5 hours before sunset, treat all westbound or sun-facing flight shots as LT-10 risk — see SOLAR ANGLE BACKLIGHT RISK TABLE above.
      CORRECTION FOR COLOUR: same mild warm-cast subtraction as Early Morning. Monitor progressively toward golden hour as elevation drops.
      Subspecies colour marks: mostly readable; same mild correction as Early Morning, increasing toward LT-5 threshold.

  • DAWN / DUSK TRANSITIONAL LIGHT (within ~30 minutes of sunrise/sunset — sun at or just below the horizon, LT-6):
      Mixed warm-cool cast, rapidly changing exposure. Lower overall contrast. Colours are ambiguous — partly rosy-warm, partly desaturated.
      ⚠ NEAR-TOTAL BACKLIGHT RISK FOR FLIGHT SHOTS: The entire horizon glows. A bird in flight against the open sky is almost certainly contre-jour.
      See SOLAR ANGLE BACKLIGHT RISK TABLE — horizon-crossing row. Treat ALL open-sky flight shots at LT-6 as LT-10 UNLESS the bird is demonstrably against a dark background (trees, building silhouette).
      CORRECTION FOR COLOUR: treat all colour identifications as APPROXIMATE. Structure and gross pattern are more reliable than specific hue.
      Supercilium colour shade, mantle tone, breast ground colour, and bare-part colours are particularly unreliable at this transition point.

  • BLUE HOUR (pre-dawn twilight / post-dusk twilight — sky lit but sun well below the horizon):
      COOL BLUE CAST — all colours shift toward grey-blue. Browns appear grey; rufous appears dull dark brown; whites appear ice-blue.
      Low intensity combined with strong blue cast makes ALL colour identification UNRELIABLE.
      CORRECTION: treat all colours as shifted and approximate. Identify from structure, silhouette, and gross pattern only.
      Bare-part colours (bill, leg, eye-ring) are particularly unreliable — may appear wholly different hue from true colour.

  • FOREST SHADE / DAPPLED LIGHT (under leaf canopy, dense forest):
      BLUE-GREEN COLOUR SHIFT — all colours appear cooler and darker than in open light.
      CORRECTION: mentally shift colours warmer. Browns appear greenish-grey; rufous appears dark brown.
      Fine markings (malar stripe width, supercilium colour) harder to distinguish.
      Iridescent plumage (sunbirds, kingfishers) may appear dull or shift hue entirely.

  • DEEP SHADE / LOW LIGHT (dense understorey, dusk, deep forest floor):
      VERY UNRELIABLE COLOUR — all colours shift toward grey-brown. Reds become brown, yellows become ochre.
      CORRECTION: treat all colour identifications as approximate. Rely on SHAPE, STRUCTURE, and PATTERN rather than absolute colour.
      Lower species-level confidence for all colour-dependent field marks.

  • BACKLIT / CONTRE-JOUR (light source behind the animal):
      Silhouette only — structure and shape may be reliable; all colour is LOST or inverted.
      CORRECTION: do NOT attempt colour-based identifications. Use only structural marks (bill shape, tail shape, size, silhouette, leg projection).

  • ARTIFICIAL LIGHT — SUB-TYPES (assign the most specific sub-type; cite in the LT-11 code):
      All artificial light heavily distorts colour. Identify the sub-type because each shifts colour differently:

      LT-11a  CAMERA FLASH (built-in or external):
          Flash BLEACHES nearby plumage — whites appear blown-out; fine barring and streaking may disappear.
          Red-eye effect on reflective tapetum (mammals, frogs, spiders); eye colour is UNRELIABLE.
          At close range (< 2 m) all colours are washed out. At mid range (2–5 m) contrast is harsh.
          CORRECTION: treat all fine colour marks and eye colour as unreliable. Use gross pattern and structure.

      LT-11b  TORCHLIGHT / HANDHELD FLASHLIGHT (beam pointed at animal):
          Warm-white or cool-white narrow spotlight effect. Subject centre is bright/bleached; edges fall off to darkness.
          Colour rendering depends on torch colour temperature: warm-white torch → orange/yellow shift; cool-white torch → slight blue-white.
          SPOT HIGHLIGHT ON EYES: tapetum eyeshine is often visible (reptiles = pale green/orange; frogs = golden/reddish; spiders = pale blue; mammals = orange/green). Eyeshine presence is DIAGNOSTIC for many taxa.
          Background is black — no environmental context visible. Subject posture may be frozen/alert.
          CORRECTION: mentally note warm/cool torch bias. Treat fine plumage colours as approximate. Eye colour unreliable due to eyeshine. Use structural marks and gross pattern.
          SUBSPECIES: colour characters are LOW reliability; structural characters remain usable.

      LT-11c  SODIUM VAPOUR / ORANGE STREETLIGHT:
          Strong orange-yellow cast over ENTIRE scene. All colours shift heavily toward orange.
          Blue/purple plumage appears brown; white appears orange-cream; greens appear olive-yellow.
          CORRECTION: mentally subtract strong orange cast from all colours. Blue/purple specifically are unreadable.

      LT-11d  LED STREETLIGHT / WHITE STREETLIGHT:
          Cool-white or neutral light. Less colour shift than sodium vapour but still artificial overhead illumination.
          High contrast between lit areas and shadows. Shadows are dense black.
          CORRECTION: mild cool correction. Fine marks in shadow zones are lost. Bare-part colours broadly usable if animal is in the lit zone.

      LT-11e  SPOTLIGHT (vehicle spotlight, hunting light, wildlife spotting light):
          Very high intensity narrow beam. Similar effects to torchlight but brighter and often from greater distance.
          Produces strong eyeshine at greater distance than torchlight. Subject may be frozen.
          CORRECTION: same as torchlight; structural and gross pattern reliable; colour approximate.

  • NIGHT / VERY LOW LIGHT (no deliberate light source; camera relies on ambient darkness):
      Almost no colour visible. Identify from shape, structure, posture, eye position.
      Eyeshine from ambient light (moonlight, distant streetlight) may still be present.
      Camera sensor noise will shift all tones toward muted grey or introduce colour noise artefacts.

  ─────────────────────────────────────────────────
  LIGHTING CONDITION CODES — referenced by STEP 5:
  ─────────────────────────────────────────────────
  After assessing the lighting, assign the SINGLE best-matching code. STEP 5 uses this code to look up subspecies colour reliability — do NOT re-describe lighting in STEP 5; just cite the code.

  LT-1  BRIGHT OPEN DAYLIGHT       (direct sun, clear sky, midday-ish)
  LT-2  OVERCAST / DIFFUSE         (cloud cover, open shade — most reliable)
  LT-3  EARLY MORNING              (~1–2 h post-sunrise, clear sky)
  LT-4  LATE AFTERNOON / EVENING   (~1–2 h pre-sunset, clear sky)
  LT-5  GOLDEN HOUR                (~0–30 min around sunrise/sunset)
  LT-6  DAWN / DUSK TRANSITIONAL   (~30 min window around the sunrise/sunset horizon crossing)
  LT-7  BLUE HOUR                  (pre-dawn / post-dusk twilight)
  LT-8  FOREST SHADE / DAPPLED     (under canopy, dense forest)
  LT-9  DEEP SHADE / LOW LIGHT     (dense understorey, overcast forest floor)
  LT-10 BACKLIT / CONTRE-JOUR      (light source behind the animal)
  LT-11a CAMERA FLASH                (bleaches nearby; fine detail lost close-up)
  LT-11b TORCHLIGHT / FLASHLIGHT     (warm/cool spotlight; eyeshine present; edges dark)
  LT-11c SODIUM VAPOUR STREETLIGHT   (heavy orange cast; blue/purple unreadable)
  LT-11d LED / WHITE STREETLIGHT     (mild cool cast; shadows are dense black)
  LT-11e SPOTLIGHT                   (high-intensity distant beam; same as torchlight)
  LT-12  NIGHT / VERY LOW LIGHT      (no deliberate source; sensor noise; ambient darkness)

  STATE EXPLICITLY in identificationReasoning: "Lighting condition: [name + code]. Colour reliability: [high/moderate/low/unreliable]. Affected field marks: [list]."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. ENVIRONMENT TYPE — COLOUR & CONTRAST IMPACT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  The background and surroundings affect how colours appear through contrast effects and reflected ambient light:

  • DENSE FOREST / CLOSED CANOPY: Green ambient reflection shifts all plumage slightly green. Dark background makes pale marks appear brighter than they are.
  • OPEN GRASSLAND / MUDFLAT: Neutral background — most reliable for colour reading.
  • WATER / WETLAND SURFACE: Blue-grey reflection below, bright sky above — underpart colours may be washed out or appear paler.
  • URBAN / BUILT ENVIRONMENT: Mixed artificial and natural light — check for colour cast from nearby walls or surfaces.
  • BEACH / BRIGHT SAND: High albedo background — overall scene is very bright, may over-expose plumage detail.

  STATE: "Environment type: [type]. Ambient colour cast: [describe if any]."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. CAMERA ZOOM & LENS EFFECTS — DETAIL & COLOUR IMPACT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Estimate the likely zoom level from the background compression and subject framing:

  • WIDE / NO ZOOM (≤ 50mm equivalent): Subject large in frame relative to background. Minimal compression. Accurate perspective proportions.
  • MEDIUM TELEPHOTO (50–200mm equivalent): Moderate background compression. Subject proportions broadly accurate.
  • LONG TELEPHOTO (200–600mm equivalent): Strong background blur (bokeh). Subject compressed — bill and tail may appear shorter than reality. Colours slightly shifted by atmospheric haze if subject is distant.
  • EXTREME TELEPHOTO / HEAVY CROP (> 600mm or heavily cropped phone photo): Subject may show significant compression artefacts. Proportions unreliable.
      — Bill length relative to head is particularly affected by telephoto compression: a long bill appears shorter when shot from directly in front with a long lens.
      — At extreme zoom, fine markings (malar stripe width, supercilium sharpness, bare-part colour) may be blurred by atmospheric shimmer or chromatic aberration.
  • PHONE CAMERA DIGITAL ZOOM: Significant loss of fine detail. Treat resolution as low even if file is large.

  STATE: "Estimated zoom: [wide/medium telephoto/long telephoto/extreme telephoto]. Compression effect on proportions: [minimal/moderate/significant]. Fine detail reliability: [high/moderate/low]."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. SUBJECT DISTANCE — DETAIL & SIZE ESTIMATION IMPACT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Estimate distance from contextual cues (relative size to background objects, depth of field, atmospheric haze):

  • CLOSE RANGE (< 5 m): Fine feather texture, bare-part colours, pupil shape, rictal bristles, toe colour all reliably visible.
  • MID RANGE (5–20 m): Most field marks visible. Fine bare-part colour shades and rictal bristles may be less distinct.
  • DISTANT (20–50 m): Overall pattern and structure reliable. Fine marks (malar stripe width, supercilium presence/absence, orbital ring colour) less reliable. Bare-part colours approximate only.
  • VERY DISTANT (> 50 m): Structure and gross pattern only. Species-level confidence reduced. Do NOT attempt subspecies ID. Colour is atmospheric-haze-shifted (blue-grey cast on all colours).

  COMBINED DISTANCE + ZOOM NOTE: A subject shot at 50 m with a 600mm lens may appear "close" in the frame but retains all the colour distortions and detail loss of a 50 m shot. Judge distance from the original scene, not from how large the bird appears in the frame.

  STATE: "Estimated distance: [close/mid/distant/very distant]. Effect on detail: [describe]. Atmospheric haze: [none/mild/significant]."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5. CAMERA SETTINGS — APERTURE, SHUTTER SPEED, FOCUS & RESOLUTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Infer the likely camera settings from observable image characteristics. Each setting independently degrades specific characters.

  ── APERTURE / DEPTH OF FIELD (DOF) ──
  Aperture (f-stop) controls how much of the image is in sharp focus. Infer from background blur (bokeh) and from how much of the subject is sharp:

  • WIDE APERTURE (f/1.4–f/2.8) — extreme bokeh, very shallow DOF:
      Background is completely blurred (smooth out-of-focus blobs). Subject may have ONLY ONE PLANE in focus — e.g. the face sharp but the tail and wings soft.
      EFFECT ON ID: Fine marks on any body-part NOT in the focal plane are BLURRED and unreliable — supercilium may be sharp while the wing panel is unreadable; or the face may be out of focus while the body is sharp.
      DO NOT use a blurred zone as evidence of mark absence — the mark may simply be out of the focal plane.

  • MEDIUM APERTURE (f/4–f/7.1) — moderate bokeh, usable DOF for perched bird:
      Most of the bird typically in focus. Background recognisably blurred but not completely smooth.
      EFFECT ON ID: Most marks readable. Distant background elements still blurred — use for habitat context only.

  • NARROW APERTURE (f/8–f/16) — deep DOF, background detail visible:
      Both subject and background in reasonable focus. Typically used in bright conditions or landscape shots.
      EFFECT ON ID: Most reliable for full-body field mark assessment. Background habitat identifiable.

  • EXTREME TELEPHOTO + WIDE APERTURE (common combo in wildlife photography):
      Even at f/5.6–f/8, at 400–600mm the effective DOF is very thin at close range. A perched bird with the body
      at 15 m may have the near wing in focus but the far wing soft.
      RULE: When background blur is heavy (common in wildlife shots), explicitly note which body zone appears in focus vs. which is soft, and treat soft-zone marks as DEGRADED.

  STATE: "Estimated aperture / DOF: [wide/medium/narrow]. Body zones in focus: [list]. Blurred body zones: [list — marks in these zones are DEGRADED]."

  ── SHUTTER SPEED — MOTION BLUR & WING POSITION ──
  Infer shutter speed from motion blur on the subject vs. background sharpness:

  • FAST SHUTTER (≥ 1/1000s — wings frozen, no subject blur):
      Wings frozen mid-beat — wing shape and wingbar position are reliable. Fine marks on the wings readable if in focus.
      EFFECT ON ID: Most reliable for flight identification. Wing shape, wingbar positions, pattern on primaries all usable.

  • MEDIUM SHUTTER (1/250s–1/800s — body sharp, wing tips may blur):
      Body, head, and folded wings are sharp. Extended fast-moving wingtips may show mild blur.
      EFFECT ON ID: Perched-bird marks reliable. In-flight wing pattern at the wingtips is DEGRADED.

  • SLOW SHUTTER (1/30s–1/200s — motion blur on any fast-moving parts):
      Wing beats smeared into translucent blur. Tail may show motion streak. Bill may blur if bird was moving its head.
      EFFECT ON ID: Wingtip, tail, and head marks are UNRELIABLE. ONLY the stationary core body, breast, and back (if exposed) are readable.
      ⚠ SLOW SHUTTER WING BLUR TRAP: Blurred wings may create the FALSE APPEARANCE of a wing bar or pale panel where none exists, from the motion sweep of a pale feather edge across a dark base. Do NOT use mark visibility on blurred wings as positive evidence of that mark.

  • VERY SLOW SHUTTER (< 1/30s — heavy overall motion blur):
      Even the body may be blurred. Subject identification may be limited to silhouette and gross shape only.
      Use only for GISS-level identification — no fine marks usable.

  STATE: "Estimated shutter speed: [fast/medium/slow/very slow]. Motion blur present on: [wings/tail/none]. Marks in blurred zones: UNRELIABLE."

  ── IMAGE SHARPNESS & RESOLUTION ──
  • OVERALL SHARPNESS: Sharp / slightly soft / motion-blurred / heavily blurred (shake).
      Sharp image: fine marks (malar stripe width, supercilium sharpness, rictal bristles, orbital ring) readable.
      Soft/blurred image: fine marks degraded; identify at higher rank level.
  • FOCUS ACCURACY: Is the eye/face in sharp focus, or is the focus landed on the background/foreground instead?
      If the subject eye is out of focus (background is sharper than the bird) → the entire image is UNRELIABLE for fine marks regardless of aperture.
  • RESOLUTION: High-res (detailed fine feather texture visible) / medium / low-res (pixellated at viewing size).
      Low resolution: treat fine marks as absent or UNRESOLVED — pixellation cannot be distinguished from a real mark.
  • JPEG COMPRESSION ARTEFACTS: Heavy JPEG compression creates 8×8 pixel block artefacts — false dark edges and
      false colour transitions that can mimic streaks, bars, or border lines. At high compression, "marks" visible at 1:1
      pixel level are artefacts. Only trust marks visible at normal viewing scale.

  STATE: "Image sharpness: [sharp/soft/blurred]. Focus: [on subject / missed — background in focus]. Resolution: [high/medium/low]. Readable fine-mark zones: [list]."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
6. VIEW ANGLE & HIDDEN FIELD MARKS — MANDATORY TABLE BEFORE ANY IDENTIFICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  THE SINGLE MOST COMMON SOURCE OF MISIDENTIFICATION IS USING A CHARACTER THAT IS HIDDEN AT THE OBSERVED ANGLE.
  Before naming any candidate species, determine the view angle and apply the hidden-marks table below.
  State explicitly for EACH diagnostic character category: VISIBLE, PARTIALLY VISIBLE, or HIDDEN.

  ASSESS VIEW ANGLE:
    FRONT VIEW       — bird/animal faces camera; beak/face toward viewer
    REAR VIEW        — tail/back toward camera; head away
    LEFT LATERAL     — left side of body toward camera, full side profile
    RIGHT LATERAL    — right side of body toward camera, full side profile
    THREE-QUARTER    — angled between front/side or rear/side
    DORSAL (top-down) — bird seen from above
    VENTRAL (below)  — bird seen from below (flight shot from ground)
    IN-FLIGHT LATERAL — side view mid-flight
    IN-FLIGHT BELOW  — camera below bird, looking up at underside
    IN-FLIGHT ABOVE  — camera above, looking down at upperside
    PARTIALLY OBSCURED — branch/leaf/grass covering part of the bird

  HIDDEN FIELD MARKS BY VIEW ANGLE — BIRDS (apply equivalent logic to other taxa):
  ┌──────────────────────┬────────────────────────────────────────────────────────────────────────────────────────────────┐
  │ View angle           │ Characters HIDDEN / NOT ASSESSABLE (do NOT use these for elimination)                         │
  ├──────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ FRONT VIEW           │ RUMP, uppertail coverts, mantle, scapulars, wing panel upperwing coverts, back colouration,    │
  │                      │ tail pattern from above, secondary bar from above, tertial fringes.                           │
  │                      │ ⚠ VISIBLE AT FRONT: breast, throat, belly, flanks, face pattern, bill SHAPE (side profile     │
  │                      │ foreshortened), tarsus colour, orbital ring, loral area, forehead, supercilium if bold.       │
  │                      │ ⚠ HIDDEN AT FRONT: RUMP (hidden by back feathers behind body), upperwing, mantle/scapular    │
  │                      │ colour. Any orange/rufous structure visible BELOW a frontal-perched bird = TARSI, NOT rump.   │
  ├──────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ REAR VIEW            │ Throat, breast, belly, flank streaking/barring, undertail covert detail, bill colour (mostly  │
  │                      │ hidden). Face pattern, eye colour, lores, orbital ring: all hidden.                           │
  │                      │ VISIBLE: mantle, scapulars, rump, uppertail coverts, tail tip pattern, wing panel upperwing.  │
  ├──────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ LATERAL (side)       │ Far-side wing detail, far-side flank, far-side face. Bill profile visible and most reliable   │
  │                      │ at this angle for length/curvature assessment.                                                │
  │                      │ VISIBLE: full lateral silhouette, bill profile length, full supercilium, malar stripe, breast │
  │                      │ side, wingbar, tail length, leg attachment point.                                             │
  ├──────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ THREE-QUARTER FRONT  │ Partial rump, far wing partly visible. Breast and face mostly visible. Bill foreshortened     │
  │                      │ relative to pure lateral — do not use bill length for measurement at this angle.              │
  ├──────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ DORSAL (top-down)    │ Underpart colour (breast, belly, flanks), undertail coverts, ventral wing lining. Throat and  │
  │                      │ breast fully hidden.                                                                           │
  │                      │ VISIBLE: mantle, scapulars, rump, tail upperwing coverts, crown, nape.                        │
  ├──────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ IN-FLIGHT BELOW      │ Upperparts, mantle, rump, upperwing pattern.                                                  │
  │ (camera below bird)  │ VISIBLE: underwing lining, belly, breast, tail underside, flank barring.                      │
  ├──────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ IN-FLIGHT ABOVE      │ All underpart characters. Underwing lining hidden.                                            │
  │ (camera above bird)  │ VISIBLE: upperwing pattern, mantle, rump, tail from above, crown.                             │
  └──────────────────────┴────────────────────────────────────────────────────────────────────────────────────────────────┘

  ⚠ BILL LENGTH AT FRONT VIEW — FORESHORTENING TRAP:
    A bill photographed head-on (front view) appears SHORT because it is pointing toward the camera — the true length is foreshortened by perspective.
    NEVER use bill length measurements from a front-facing photograph. Bill length is ONLY assessable from a lateral (side profile) view.
    Bill WIDTH and bill BASE WIDTH are assessable from front view.

  ⚠ SUPERCILIUM / EYESTRIPE AT FRONT VIEW:
    Supercilium is visible from the front only if it is broad and bold enough to be seen wrapping around the face. A narrow or short supercilium
    may appear absent from a front view even when it is present. Do NOT report supercilium as absent from a front-facing image — report as "not determinable at this angle."

  ⚠ WING PATTERN AT FRONT VIEW:
    Wingbars (greater covert bar, median covert bar) are seen edge-on from a front view on a perched bird — they may appear as thin pale edges on the folded wing, or may not be visible at all. A wingbar is NOT absent because it is invisible from the front — it is HIDDEN.

  ⚠ RUMP COLOUR AT FRONT VIEW (critical for Muscicapa, Enicurus, Rhyacornis, Ficedula and many other groups):
    The rump is on the dorsal surface of the bird, behind the body, above the tail base.
    On a front-facing perched bird: the rump is COMPLETELY HIDDEN behind the bird's body.
    RULE: Do NOT assess rump colour from a front view. Report "rump: not visible at this angle."
    Any colour visible BELOW the bird's body in a frontal image is tarsi/feet — NOT rump.

  STATE: "View angle: [type]. Hidden characters: [list]. Visible characters: [list]. Characters erroneously inferred from hidden zone: [flag any such inference]."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
7. CAPTURE DEVICE TYPE & NIGHT IMAGE QUALITY (and daytime sensor artefacts)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  If the lighting code is LT-11 (any sub-type) or LT-12, ALSO assess the capture device — different devices produce fundamentally different artefacts at night.
  For DAYTIME images (LT-1 through LT-9), also assess the device for sensor-specific artefacts that affect flight-shot geometry (in particular mirrorless rolling shutter) and detail fidelity (smartphone processing).

  DEVICE TYPES — assess which most closely matches the image characteristics:

  • SMARTPHONE (standard camera mode, no night mode):
      High noise at low ISO unless very close to light source. Colours oversaturated by computational processing.
      Fine markings (malar stripe, supercilium) typically blurred or noise-masked. Bill and leg colours unreliable.
      AUTO HDR may create haloing around bright objects (eyes, torch beam). Eyeshine may be blown out.
      EFFECT: Species-level from gross structure and pattern only. Subspecies almost always impossible.

  • SMARTPHONE (night mode / computational long-exposure):
      Multiple frames stacked — noise is reduced BUT motion blur introduced for moving subjects.
      Colours are artificially saturated and colour-shifted by AI processing; do NOT trust any specific hue.
      Fine details sharpened by AI but may introduce false edges or ghost outlines.
      EFFECT: Structural marks readable if subject was still. All colour marks UNRELIABLE — AI processing overrides true tone.

  • DSLR (optical viewfinder, mirror-based sensor system, e.g. Canon EF, Nikon F mount) — HIGH ISO, NO FLASH:
      Grain/noise visible at ISO 3200+. Luminance noise masks fine marks. Chrominance noise creates random colour mottling.
      At ISO 6400+: colour mottling on plumage makes bare-part colours and subtle plumage shades unreliable.
      Optical viewfinder shows real image — no electronic rendering artefacts in viewfinder; image artefacts exist in the captured file only.
      EFFECT: Gross structural marks and bold pattern readable. Fine colour-dependent marks degraded by noise above ISO 3200.

  • DSLR — WITH EXTERNAL FLASH (speedlight, ring flash):
      Best night image quality if properly exposed. Freezes motion. Colours closest to true at correct exposure.
      Watch for harsh shadows behind subject (single off-axis flash) masking field marks on the shadow side.
      Ring flash: even, flat illumination — good for colour but removes depth (reduces 3D structural cues).
      EFFECT: Colour reliability MODERATE-HIGH if well-exposed. Shadows must be checked for hidden marks.

  • MIRRORLESS CAMERA — HIGH ISO, NO FLASH (Sony A7/A9/A1/ZV-E series; Nikon Z series; Canon EOS R series; Fujifilm X series; OM System OM-1; Panasonic G/S series):
      Modern full-frame mirrorless (Sony A7 III/IV/C/S III, Nikon Z8/Z9, Canon R5/R6 II, OM-1) have SUPERIOR high-ISO performance vs. comparable DSLRs:
        — Usable image quality often up to ISO 12800; fine marks at ISO 3200 are frequently readable.
        — Less chrominance noise at equivalent ISO → bare-part colours and plumage shade more reliable than DSLR at same ISO.
      APS-C mirrorless (Sony A6000-series, Fuji X-T/X-S series, Canon R50/R10, Nikon Z30/Z50) performance is broadly similar to APS-C DSLR.

      ⚠ MIRRORLESS-SPECIFIC ARTEFACTS TO WATCH FOR:
        1. ROLLING SHUTTER (electronic shutter mode — silent / e-shutter): Fast-moving subjects (wing-beats, stoop) may show BENT OR SKEWED WINGS.
              The sensor reads the image top-to-bottom in sequence — a rapidly moving wing is at a different position at the top vs. bottom of the read.
              EFFECT ON ID: Do NOT use wing shape or wingbeat arc geometry from images shot in silent/e-shutter mode on fast-flying birds.
              Mechanical shutter does NOT produce this artefact. If unsure which shutter mode, note wing geometry anomaly.
        2. BANDING / STRIPING UNDER ARTIFICIAL LIGHT (electronic shutter + fluorescent/LED cycling):
              In LT-11c / LT-11d conditions, electronic shutter can capture horizontal dark banding across the image from light-source flicker.
              EFFECT ON ID: Horizontal dark bands crossing the subject are shutter artefacts, NOT plumage markings.
        3. EVF PRE-SHOT LAG: Electronic viewfinder introduces a small lag (~30–50 ms) — moving subjects may be at a slightly different position than the photographer perceived. Expect more clipped or partially-framed flight shots vs. OVF.
        4. IBIS (In-Body Image Stabilisation): Allows slower shutter speeds without camera shake — BUT fast-moving subjects still produce motion blur at same shutter speed. Do NOT assume a sharp, stable background means the bird is sharp — IBIS corrects camera motion, not subject motion.
      EFFECT SUMMARY: Full-frame mirrorless generally reliable for colour and fine marks at low-moderate ISO. Check for rolling shutter on sported wings; check for banding under artificial light.

  • MIRRORLESS CAMERA — WITH EXTERNAL FLASH (speedlight, ring flash):
      Identical to DSLR with external flash in outcomes. Same shadow and overexposure considerations apply.
      Note: many mirrorless cameras support high-speed sync (HSS) flash — allows faster shutter speeds that freeze motion better than DSLR.
      EFFECT: Colour reliability MODERATE-HIGH if properly exposed. Rolling shutter is NOT an issue with flash (mechanical shutter typically used with flash).

  • TRAIL CAMERA / CAMERA TRAP:
      INFRARED MODE (night): image is MONOCHROME (greyscale) or has a greenish IR cast. ALL colour identification is IMPOSSIBLE in IR mode.
      WHITE FLASH MODE: brief white flash — similar to camera flash (LT-11a) but subject often at greater distance.
      EFFECT: IR mode → species ID from silhouette, body shape, gait, pattern only. Colour is unavailable.

  • THERMAL / INFRARED CAMERA (full thermal imaging):
      Image shows heat signatures only — white/pale = warm; dark = cool. No plumage colour, pattern, or fine structural detail.
      EFFECT: Can determine presence/absence of warm-blooded animal and approximate body shape only. Species-level ID from body shape, size. No plumage marks readable.

  ⚑ EYESHINE / EYE QUALITY AT NIGHT:
  When a light source (torch, flash, spotlight) illuminates an animal at night, the tapetum lucidum reflects light and produces eyeshine. This is DIAGNOSTIC for many groups:
    • Reptiles (snakes, lizards, geckos): eyeshine colour = pale green, orange, or red-orange; vertical pupils visible in torch.
    • Frogs / toads: eyeshine = bright gold, orange, or reddish; large prominent eyes. Eye size relative to head is a key ID feature.
    • Mammals: eyeshine varies by species — cats/civets = green/yellow; deer = orange; rodents = red/pink.
    • Spiders: multiple blue-white reflective eye spots characteristic of wolf spiders, jumping spiders, etc.
    • Birds: most birds DO NOT produce eyeshine (lack reflective tapetum). Owls are an exception — faint reddish or orangey glow possible.
    RULE: Eyeshine colour can support but NOT on its own determine species identity. Always combine with structural marks.
    CAUTION: Camera flash and bright torch can OVEREXPOSE the eye entirely — a white blown-out eye in a photo does NOT mean the animal has white eyes.

  STATE: "Capture device: [type]. Night image quality: [good/moderate/poor/IR-monochrome]. Eye quality: [sharp/blown-out/eyeshine visible/obscured]. Readable features: [list]."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
8. WEATHER CONDITIONS — COLOUR, CONTRAST & STRUCTURAL IMPACT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Weather profoundly affects how plumage, skin, and pattern appear in photographs. Assess EVERY image for weather conditions — these operate independently from, and compound with, the lighting code.

  • CLEAR / DRY (no weather effects):
      No weather degradation. Rely on lighting code only.

  • LIGHT RAIN / DRIZZLE:
      Plumage becomes slightly wet — feathers may flatten and appear darker due to moisture.
      Fine barring and streaking on upperwing coverts may become obscured by matted feathers.
      Bare parts (bill, legs, eye ring) may have water droplets — colour partially obscured.
      CORRECTION: note "plumage wet — feathers may appear darker and more uniform than true dry plumage."

  • HEAVY RAIN / DOWNPOUR:
      Plumage heavily waterlogged. Feathers flattened and dark. Bird may appear uniformly dark brown/grey regardless of true plumage colour.
      Fine structural marks (crest, scapular panel, wing bar width) may be completely obscured by matted wet feathers.
      CORRECTION: treat all colour and fine pattern as UNRELIABLE. Identify from size, structure, silhouette, bill shape only.
      Subspecies colour characters: UNAVAILABLE under heavy rain.

  • FOG / MIST (low visibility, soft diffuse background):
      Background detail lost — habitat context absent. Subject may appear lighter due to atmospheric scatter.
      Colours shift slightly cooler/greyer — all saturated hues (rufous, orange, yellow) appear more muted.
      Background colours and distance clues are absent — size estimation requires internal reference only.
      CORRECTION: shift all colours slightly toward true saturation. Size estimation less reliable.

  • HAZE (smoke haze, pollution haze, humid tropical haze — common in Singapore / Sundaland):
      Blue-grey cast over ALL colours, intensifying with distance. The further the subject, the stronger the grey shift.
      Close subjects are only mildly affected; distant subjects may appear washed-out and grey regardless of true colour.
      CORRECTION: subtract grey-blue haze cast proportional to estimated distance. At mid-range (5–20 m) subtract mild grey; at distant (20–50 m) subtract moderate grey — true colours may be considerably more saturated and warm than observed.
      SUBSPECIES IMPACT: malar stripe colour, upperpart tone, and underpart barring tone are all blue-grey shifted — do NOT use tonal comparisons under medium or heavy haze without applying haze correction.

      ⚑ SINGAPORE / SUNDALAND SEASONAL HAZE CONTEXT:
        • TRANSBOUNDARY SMOKE HAZE (Indonesian peat/forest fires): Peaks June–October; worst during El Niño years (e.g. 2015, 2019, 2023).
            Even on days that do not feel especially hazy, distant subjects > 20 m may show significant blue-grey desaturation from smoke aerosols.
            During declared PSI > 100 episodes, ALL mid-to-distant shots should be treated as HEAVY HAZE — colour unreliable at any range > 10 m.
        • HUMID HAZE (year-round): Singapore's high humidity creates mild atmospheric scatter even on 'clear' days.
            Any shot > 50 m: apply mild blue-grey haze correction regardless of reported weather.
        • COMBINED LT-10 + HAZE: A backlit subject in haze is doubly degraded — contre-jour removes colour AND haze desaturates it further.
            Such images yield silhouette-only identification; no colour or tonal characters are usable.

  • HEAT HAZE / THERMAL SHIMMER (hot surfaces, open ground, low-angle shots over tarmac/sand):
      Causes rippling geometric distortion of subject outline. Proportions unreliable — bill appears to shimmer; leg length variable.
      Fine marks at any range become blurred by shimmer. Subject appears distorted and flickering.
      CORRECTION: do NOT use proportional measurements (bill length ratio, leg projection) under visible heat shimmer. Use gross shape and colour only.

      ⚑ SINGAPORE / SUNDALAND SEASONAL HEAT HAZE PEAKS:
        • HIGHEST RISK MONTHS: March–May (peak of the dry inter-monsoon) and August–October (compound heat + Indonesian transboundary haze).
        • HIGHEST RISK TIME: 11:00–16:00 local time on cloudless days. Heat shimmer typically invisible before 10:00.
        • HIGHEST RISK MICROHABITATS:
            — Mudflats (Sungei Buloh, Kranji Marshes, Mandai Mudflat): exposed at low tide under full sun — severe shimmer over black mud
            — Exposed roads and tarmac (any open road or carpark area)
            — Rooftop and urban high-rise observations — heat radiating from concrete structures
            — Bukit Timah / Mandai open granite outcrops baking in direct sun
            — Any coastal scan toward open water on hazy sunny days
        • COMPOUNDING WITH HAZE: When Indonesian peat fire haze (Jun–Oct) coincides with heat shimmer (Aug–Oct), BOTH effects apply simultaneously — the subject is simultaneously distorted AND desaturated. Proportional AND colour characters are degraded. Structural silhouette only.

  • OVERCAST (already covered in LT-2 — most reliable for colour; weather-neutral).

  • POST-RAIN / WET HABITAT (subject is dry but substrate is wet; puddles reflect light):
      Water surface reflections create unpredictable light patterns on underside of perched or wading birds.
      Underpart colouration may be partially lit by reflected light from below — altering apparent tone of underparts.
      CORRECTION: note "ground reflections possible — underpart lighting may be non-standard."

  • WIND (strong wind visible from subject posture or vegetation movement):
      Blown feathers reveal normally-hidden feather bases and underwing/underpart areas — this can REVEAL hidden field marks.
      BUT ALSO: contour feathers lift revealing base colours that differ from the surface — do NOT mistake lifted feather bases for the surface colour.
      Structural shapes (tail spread, wing position) may be distorted by wind posture.

  STATE: "Weather condition: [type]. Effect on colour: [describe]. Effect on structural marks: [describe]. Subspecies colour characters: [reliable/degraded/unavailable]."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
9. SUBJECT EXPOSURE — UNDER-EXPOSED (TOO DARK) AND OVER-EXPOSED (TOO BRIGHT) SUBJECTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Photographic exposure errors are INDEPENDENT of lighting conditions and weather — they affect the rendered image regardless of the actual ambient light. Assess every image for these artefacts BEFORE reading any colour or pattern.

  • UNDER-EXPOSED SUBJECT (subject appears TOO DARK — shadow-clipped):
      Cause: camera metered the bright background (sky, foliage) and left the subject under-lit; common in forest shade shots, backlit shots, or any scene where the subject is in shadow against a brighter background.
      EFFECTS ON IDENTIFICATION:
        — All colours shift toward dark grey-brown or black. Warm buff-brown appears grey; rufous appears dark brown; white appears grey.
        — Fine barring, streaking, and pale marks DISAPPEAR into the dark base tone. A barred underside appears solidly dark.
        — Breast colour pattern is particularly vulnerable: a uniform warm breast and a bicoloured breast both appear uniformly dark — they become INDISTINGUISHABLE.
        — Pale orbital rings, pale lores, and pale bill bases may vanish into the face.
        — Orange/flesh tarsi may appear dark brown.
      CORRECTION FOR UNDER-EXPOSURE:
        1. State explicitly: "Subject is under-exposed — all colours rendered darker than true."
        2. Add warmth, brightness, and saturation to all perceived colours mentally. A bird that reads as uniformly dark grey-brown may in reality have warm buff breast, pale lores, and orange tarsi.
        3. Any character that depends on EXACT SHADE (distinguishing warm buff-brown from rufous-orange; warm from pale grey) is UNRELIABLE in an under-exposed image.
        4. ANY colour-based separation between Muscicapa species is UNRELIABLE when the subject is under-exposed. Fall back to structural characters only: bill shape/width, orbital ring presence, size.
      RULE: Do NOT use underpart colour pattern as a primary species separator when the subject is visibly darker than the background — the image may simply be under-exposed.

  • OVER-EXPOSED SUBJECT (subject appears TOO BRIGHT — highlight-clipped):
      Cause: camera metered the dark background and over-lit the subject; common when a pale or white bird is shot against a dark background, or when flash is used at close range.
      EFFECTS ON IDENTIFICATION:
        — All colours shift toward pale grey or white. Rufous appears pale pink-buff; dark marks become grey; bold streaking is washed out.
        — The blown highlights (pure white areas in the file) destroy ALL detail in those zones — fine marks, bare-part colours, orbital rings, and breast pattern are ALL lost in highlight-clipped areas.
        — A dark cap or dark mantle may appear lighter than true colour.
        — Bill colour and tarsi colour in lit zones are unreliable.
      CORRECTION FOR OVER-EXPOSURE:
        1. State explicitly: "Subject is over-exposed in [zone] — colours rendered lighter/paler than true."
        2. Subtract brightness from perceived colours — a pale rufous that looks buff-white may actually be vivid rufous. A grey that looks near-white may actually be dark grey.
        3. Any character in the blown-highlight zone is UNRELIABLE. Measure only from shadow or mid-tone zones.
      RULE: Do NOT use washed-out pale marks as evidence of absence of a feature. A pale, blown-out face does NOT mean the bird lacks a dark loral line — the line may simply be overexposed.

  • MIXED EXPOSURE (subject partly in shadow, partly in direct light — e.g. dappled canopy):
      This is the most common condition in forest understorey shots (relevant to Muscicapa, Cyornis, Niltava etc.).
      The SAME BIRD simultaneously shows dark shadow zones AND bright-patch zones on different body parts.
      EFFECTS:
        — Shadow zone: colours under-exposed as described above.
        — Bright patch zone: colours over-exposed as described above.
        — A uniformly-coloured breast may appear to have TWO TONES — dark where shadowed, bright/pale where lit — mimicking a bicoloured pattern.
      ⚠ CRITICAL TRAP FOR MUSCICAPA: A uniformly warm-breasted M. muttui in mixed/dappled light can appear to have a "brighter patch" on one area and a "darker patch" on another — this is a LIGHTING ARTEFACT, not a bicoloured breast pattern. It is NOT ferruginea.
      CORRECTION: Assess whether tonal variation on the breast is consistent with a single shadow-and-highlight pattern, or whether it represents a genuine bilateral lateral-versus-medial colour distinction. If a single curved shadow boundary explains all the tonal variation → the bird has a UNIFORM breast with mixed exposure. Only if the pale zone runs vertically down the mid-breast in a manner inconsistent with a single shadow source is a bicoloured pattern confirmed.

  STATE: "Subject exposure: [well-exposed / under-exposed / over-exposed / mixed]. Affected zones: [describe]. Colour characters in affected zones: [reliable / degraded / UNRELIABLE]."

COLOUR-READING RULE — APPLIES TO ALL CONDITIONS:
  Before stating any colour as a field mark, ask: "Is the lighting / zoom / distance / weather / camera exposure in this image likely to have shifted or obscured this colour?"
  If YES — state the observed colour AND the likely true colour after correction.
  Examples:
    "Observed in deep shade as dark grey-brown; likely true colour warm rufous-brown based on LT-8 correction."
    "Subject under-exposed; breast reads uniformly dark — true breast pattern (uniform vs. bicoloured) UNRELIABLE from this exposure."
    "Subject over-exposed on face; pale lores appear blown-out — loral darkness UNRELIABLE."
  NEVER use an uncorrected colour reading under forest shade, golden-hour light, backlight, artificial light, under-exposure, or over-exposure as the primary basis for species elimination without noting the correction.

- For each condition that limits identification, explicitly note it in identificationReasoning.

══════════════════════════════════════════════════
SYSTEMATIC IDENTIFICATION — FOLLOW THESE 5 STEPS
══════════════════════════════════════════════════

STEP 1 — CATALOGUE EVERY VISIBLE FIELD MARK BEFORE NAMING ANY SPECIES:
Do NOT name a species yet. Work through EVERY section below in order. State each observation as a plain verifiable fact — incomplete field-mark cataloguing is the single most common source of misidentification.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
A. GISS — GENERAL IMPRESSION OF SIZE & SHAPE  (record holistic first impression BEFORE examining detail)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  • ANIMAL GROUP: What broad group does the overall silhouette suggest?
      Birds: passerine / wader / raptor / waterfowl / seabird / pigeon / parrot / owl / kingfisher / heron / shorebird / swift / swallow / other
      Non-birds: lizard / snake / frog / mammal / butterfly / moth / beetle / spider / fish / other
  • SIZE BRACKET — compare to a familiar reference:
      Birds: leaf-warbler ≈ 11 cm / sparrow ≈ 14 cm / mynah ≈ 23 cm / pigeon ≈ 33 cm / crow ≈ 46 cm / heron ≈ 90 cm / goose ≈ 80 cm
      Reptiles: gecko ≈ 12 cm / garden lizard ≈ 30 cm / monitor lizard ≈ 80 cm+
      Insects: small < 15 mm / medium 16–40 mm / large > 40 mm
  • SILHOUETTE: compact/rotund vs. slender/elongated; neck proportion; tail-to-body ratio; leg-to-body ratio
  • DIAGNOSTIC PROPORTIONS: Note any feature that looks disproportionately large or small — these are often the strongest genus-level clues
      (e.g. "bill length exceeds head length by 50%", "tail longer than body", "legs project far beyond tail in flight")

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
B. STRUCTURAL FIELD MARKS — BILL, WINGS, TAIL, LEGS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  • BILL — measure each dimension relative to head length:
      - LENGTH: much shorter / shorter / equal / longer / much longer than the head
      - DEPTH at base: deep (> ½ bill length) / medium (¼–½) / slender (< ¼)
      - CULMEN PROFILE: straight / slightly decurved / strongly decurved / recurved / laterally compressed / hooked
      - TIP: sharp point / blunt / hooked / notched / serrated / spatulate / nail
      - UPPER MANDIBLE COLOUR: state precisely
      - LOWER MANDIBLE COLOUR: state precisely (often differs diagnostically from upper)
      - RICTAL BRISTLES: absent / present / prominent (key for flycatchers, nightjars, bee-eaters)
      - DIET INFERENCE from shape: seed-cracker / insect-gleaner / nectar-prober / fish-spear / carrion-hook / mud-prober / generalist

  • WING STRUCTURE (folded, at rest):
      - PRIMARY PROJECTION: none (primaries fully covered by tertials) / short / medium / long
        Long projection = open-country/migratory species; short = sedentary forest dweller
      - WING TIP SHAPE INFERENCE: pointed (long primaries → swift / raptor / migratory passerine) vs. rounded (short primaries → forest passerine)
      - TERTIAL COVERAGE: do tertials cover the primaries fully when folded?
      - WING BARS: how many? colour? width? position — greater covert bar / median covert bar / both?
      - Any pale panel on primaries or secondaries visible when folded?
      - Tertial edges: pale-fringed / plain / dark-centred?
      - Any speculum, mirrors, or contrasting wing patches?

  • TAIL — geometric assessment:
      - LENGTH: shorter than / equal to / longer than the folded wing tip
      - SHAPE — state which numbered type:
          ① Rounded: outer feathers shorter, curved tip
          ② Square/truncate: all feathers equal length, flat tip
          ③ Forked: outer feathers longer than central, V-notch
          ④ Graduated/wedge: central pair longest, outer feathers progressively shorter
          ⑤ Pointed/acuminate: central pair much longer than all others
      - UPPER SURFACE colour and pattern
      - UNDER SURFACE colour and pattern (state separately — often diagnostic)
      - PATTERN DETAILS: any white outer tail feathers? tail band? terminal spots? barring? notch depth?
      - TAIL BEHAVIOUR: wags / fans / cocks / pumps / holds still / bobs

  • LEGS & FEET:
      - LEG LENGTH relative to body: very short / short / medium / long / very long (wader)
      - TARSUS COLOUR: state precisely (pale flesh / orange / yellow / red / black / grey / bright pink / olive-green)
      - FOOT/TOE COLOUR: state separately from tarsus (often differs)
      - TOE ARRANGEMENT: anisodactyl (3 forward 1 back — most perching birds) / zygodactyl (2+2 — woodpeckers/parrots) / fully webbed / partially webbed / lobed
      - CLAW LENGTH & SHAPE: short/blunt (ground-walker) / medium curved (perching) / long curved (clinging) / talons (raptor)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
C. PLUMAGE — SYSTEMATIC REGION-BY-REGION TOPOGRAPHY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Describe every named feather region below. Write "not visible" if occluded. NEVER skip a region.

  • FACE — full geometric assessment:
      - FOREHEAD: colour, any contrasting patch
      - CROWN: colour, any cap boundary / median crown stripe / lateral crown stripes / crest / scale pattern
      - SUPERCILIUM: present? colour? width? Does it start from the bill base or only above the eye? Does it extend past the eye?
      - LORE (space between bill base and anterior eye edge) — GEOMETRIC TEST:
          Is the lore pale/white, dark, streaked, or the same colour as the crown? State as a plain fact.
      - Any white/pale facial mark — perform ALL THREE position tests:
          ① LORAL test: Does the pale mark TOUCH or ADJOIN the bill base? YES = loral spot/stripe
          ② POST-OCULAR test: Does the mark begin ONLY BEHIND the posterior eye edge with NO connection to the bill? YES = post-ocular stripe
          ③ SUPERCILIUM test: Does the mark run unbroken from bill base all the way past the eye? YES = full supercilium
          STATE EXPLICITLY: "The pale/white mark [does / does not] touch the bill base." NEVER infer position from species expectation.
      - EYE: size relative to head (large / medium / small); iris colour (brown / red / yellow / white / pale grey / dark); orbital ring (present? colour? width?)
      - EAR-COVERTS: colour, any streaking or scaling, contrast with cheek
      - MALAR STRIPE: present? colour? does it continue into breast streaking?
      - SUBMOUSTACHIAL / SUPRAMALAR: colour, width
      - CHEEK / THROAT BOUNDARY: where exactly does the throat colour end?

  • CROWN & NAPE:
      - Crown colour; any median crown stripe / lateral crown stripes / crest shape / cap boundary sharpness?
      - Nape colour; any contrasting collar / hindneck patch / nuchal crest?

  • UPPERPARTS — each region separately:
      - MANTLE & SCAPULARS: colour, any streaking or scaling pattern
      - BACK: colour, pale/dark shaft streaks?
      - RUMP — GEOMETRIC TEST: does rump colour differ from the back?
          State boundary position precisely: mid-back / lower-back / only above the tail base
          e.g. "Bright white rump contrasting against dark brown back, boundary at lower-back level"
      - UPPERTAIL-COVERTS: colour, length relative to tail tip

  • UNDERPARTS — each region separately:
      - THROAT: colour, any gorget / streaks / spots / malar framing
      - UPPER BREAST: colour, any spots/streaks/barring, gorget boundary
      - BREAST — GEOMETRIC TEST: where does any coloured area (rufous/orange/yellow/black) end?
          State exactly: upper breast / mid-breast / lower breast / fades gradually vs. cuts off sharply
      - BELLY: colour, any spots/streaks/barring
      - FLANKS: colour, any streaking or barring
      - VENT: colour
      - UNDERTAIL-COVERTS: colour, any spotting/barring

  • BARE PARTS:
      - CERE (raptors/parrots): colour, texture (waxy/rough)
      - FACIAL/ORBITAL SKIN: bare or feathered? colour?
      - GAPE/COMMISSURE COLOUR: yellow gape = young bird — critical age cue; adult = typically dark/black gape
      - Any wattles, lappets, knobs, or naked facial patches?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
D. BEHAVIOURAL & ECOLOGICAL CUES  (behaviour is MANDATORY evidence — as binding as morphology; do NOT skip)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  STRICT RULE: Behaviour narrows the candidate list. A candidate species whose documented behaviour CONTRADICTS what is visible in the image must be ELIMINATED or heavily discounted — state the behavioural conflict explicitly. Behaviour that MATCHES a candidate is supporting evidence and must be noted.

  • FORAGING METHOD — state which applies and cross-check against known foraging behaviour for each candidate:
      Gleaning (picking from leaves/bark) / Hawking (aerial insect catch) / Hovering in place /
      Sallying (fly-catching from perch and returning) / Probing (mud/bark/ground) /
      Scratching (ground-turning) / Filter-feeding / Pursuit-diving /
      Carrion-feeding / Nectaring / Seed-cracking / Ambush predation (sit-and-wait) /
      Stoop (high-speed power-dive from height — Falco peregrinus; Falco subbuteo etc.)
  • FLIGHT STYLE (for raptors and flying birds — subspecies-relevant for Falco):
      Wingbeat rate: rapid and stiff (falcons) / deep and flexible (Accipiter) / buoyant (harriers) / soaring (raptors on thermals)
      Wing posture in glide: swept-back anchor shape (peregrine) / broad-winged flat (buteonines) / M-shape (harriers)
      Hunting flight pattern: high cruising → stoop (peregrine); low contour-hugging (harriers); rapid low pursuit (Accipiter)
      NOTE FOR PEREGRINE: stoop speed, flight silhouette (long pointed wings, short tail = peregrine; broader wings = buteonine) are species-level characters;
      SIZE IN FLIGHT relative to prey or other birds is the most accessible subspecies-level structural character
  • MOVEMENT PATTERN: Hops (passerines) / Walks / Runs / Shuffles / Wades / Swims / Creeps along bark
  • POSTURAL HABITS: tail-bob / tail-wag / tail-fan / tail-cock / wing-droop / head-bob / upright alert / hunched
  • PERCH TYPE & SELECTION:
      Exposed tip / hidden in foliage / bark / reed / ground / rock / wire / horizontal vs. vertical stem
      Peregrine: habitually uses highest exposed urban structures, tall trees, cliff faces — NOT interior of vegetation
  • SOCIAL CONTEXT: solitary / pair / small flock / large flock / mixed-species flock
  • HABITAT MICRO-NICHE (from background): dense forest understorey / forest canopy / mangrove edge / open grassland / wetland / mudflat / rocky shore / urban garden / open water / urban high-rise / cliff face
  • ACTIVITY CONCORDANCE WITH TIME: Cross-reference with activity pattern section. If a species is strictly nocturnal and this is a daytime shot, note the anomaly — it does NOT invalidate the ID but must be flagged.

  STATE: "Foraging method observed: [type]. Flight style if visible: [describe]. Perch type: [type]. Behavioural concordance with candidate species: [concordant ✓ / conflicting ✗ / not determinable]."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
E. IN FLIGHT ADDITIONAL MARKS (apply ONLY when the animal is airborne — these marks are hidden when perched)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  • UPPERWING PATTERN: overall wing colour; contrast between coverts and flight feathers; carpal patch colour; trailing edge colour; primary tips (black/pale/white)
  • UNDERWING PATTERN: underwing covert colour; axillary (armpit) patch colour — white / black / rufous / barred (key for many waders, raptors, wading birds)
  • RUMP/UPPERTAIL CONTRAST — GEOMETRIC TEST:
      Does rump colour differ from back? State exactly where boundary sits: lower-back / rump-only / tail-base only
      e.g. "white rump on dark back" vs "rump same colour as back"
  • HEAD & NECK IN FLIGHT — GEOMETRIC TEST (critical for waders, stilts, shorebirds, geese):
      ① CROWN colour from side or above: white / pale / dark / black
      ② NECK-SIDE pattern: is any dark marking confined ONLY to the neck sides, or does dark extend continuously from crown down through nape and hindneck?
      ③ State explicitly: "Dark marking [does / does not] extend to the crown." and "Dark on neck is [confined to sides only / extends across nape to crown]."
        — This single test separates many sibling species (e.g. H. leucocephalus = white crown; H. himantopus = dark crown)
  • LEG PROJECTION beyond tail tip: none / short (< ½ tail) / equal to tail / 1× / 2× tail length
      (stilts = 2× leg projection; godwits/dowitchers = 1×; most passerines = none)
  • WINGBEAT STYLE: deep/shallow; rapid/slow; gliding between beats?
  • FLIGHT PATH: straight / undulating (woodpecker-like) / erratic / soaring / hovering / gliding on flat wings

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
F. AGE, SEX & SEASONAL PLUMAGE — STATE BEFORE NAMING ANY SPECIES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Many species look completely different between male/female, juvenile/adult, and breeding/non-breeding plumage. Explicitly state which combination you are examining BEFORE naming a species — otherwise you risk matching to the wrong plumage stage.

  • AGE INDICATORS:
      Juvenile: fluffy/loose feather texture / yellow or orange gape / spotted or scaly underparts / blotchy bill colour / incomplete moult
      First-year/Immature: mix of retained juvenile feathers with fresh adult-type feathers; intermediate bare-part colouration
      Adult: clean full plumage; complete adult bare-part colouration
  • MOULT STATE: Fresh (crisp fringes, full colour saturation) / Worn (bleached, abraded tips, faded) / Active moult (missing primaries, visible pin feathers)
  • BREEDING vs. NON-BREEDING: Any ornamental plumes, vivid face/bill/leg colours, or head pattern changes that are seasonal?
  • SEX INDICATOR: Does this individual show characters consistent with male / female / indeterminate (monomorphic species or obscured)?
  • STATED CONCLUSION: Name the age/sex/plumage combination explicitly before starting species-level analysis
      e.g. "Adult male in breeding plumage" or "First-year bird, sex indeterminate"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
G. NON-BIRD SPECIFIC FIELD MARKS (skip entirely if the animal is a bird)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  REPTILES (lizards, snakes, turtles, crocodilians):
      - HEAD SHAPE: triangular (vipers) / oval / elongated / shovel-shaped; snout profile; fang visibility
      - SCALE PATTERN: smooth / keeled; scale rows at midbody if countable
      - DORSAL PATTERN: list every band/stripe/blotch colour in order from head to tail
      - VENTRAL COLOUR: distinct from dorsal?
      - ORNAMENTATION: crest / dewlap / frill / casque / dorsal spines?
      - LIMB STRUCTURE: present/absent; relative length; claw shape
      - TAIL: length relative to body; banding/colour; blunt tip (regenerated)?

  AMPHIBIANS (frogs, toads, salamanders):
      - SKIN TEXTURE: smooth / warty / granular; parotid glands present?
      - TYMPANUM: visible? size relative to eye?
      - DORSAL COLOUR & PATTERN: list all markings precisely
      - TOE PADS: present? size? sticky?
      - WEBBING: present? extent between toes?

  MAMMALS:
      - FUR: precise colour(s), pattern (striped/spotted/uniform/banded), texture
      - EARS: shape (pointed/rounded), size relative to head, any distinctive colour
      - TAIL: length relative to body, colour, furry/naked/ringed/bushy/prehensile
      - FACIAL MARKINGS: mask / eye rings / muzzle colour / whisker contrast
      - Any mane, dorsal stripe, or ornamental hair?

  INSECTS & ARACHNIDS:
      - WINGS: 2 wings (Diptera) / 4 wings / elytra (Coleoptera) / absent; any venation or banding pattern
      - ABDOMEN: list every segment band colour and width in precise order (e.g. "black–yellow–black–yellow from base to tip")
      - ANTENNAE TYPE: filiform (thread-like) / clubbed / feathered/pectinate / elbowed / serrate / absent
      - LEG COUNT: 6 (insect) / 8 (arachnid); any raptorial, spine, or adhesive features?
      - BODY SURFACE: smooth / hairy / spiny / metallic / waxy
      - STRIKING STRUCTURES: ovipositor / sting / horns / enlarged mandibles / dorsal eye spots

  FISH:
      - BODY SHAPE: fusiform / laterally compressed / eel-like / depressed (ray-like)
      - FINS: number of dorsal fins; presence of adipose fin; caudal fin shape; pectoral/pelvic/anal fin presence
      - SCALES & LATERAL LINE: scale type; lateral line complete/incomplete/absent
      - COLOUR PATTERN: list every stripe, spot, band precisely — colour, position, orientation

After completing ALL applicable sections above (skip non-applicable G subsections), proceed to Step 1H below.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
H. COLOUR ANOMALY SCREEN — IS THE PLUMAGE NORMAL OR ABERRANT?
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MANDATORY TRIGGER: Run this screen if ANY of the following apply:
  • Observed colours do not match any known normal plumage for any candidate species or higher taxon
  • Patches of white or pale in areas that are coloured in all known taxa
  • Overall plumage unexpectedly pale, blackish/sooty, warm rufous-orange, or uniformly washed-out
  • Uneven patchy colour distribution not consistent with any recognised subspecies, age class, or sex
  • Colour is the primary reason ALL Step 2 candidates would fail during elimination
  If NONE of the above apply → state "Colour anomaly screen: NONE DETECTED" and proceed to Step 2.

ANOMALY TYPE TABLE — assess each type in order:
  ┌──────────────────────────┬────────────────────────────────────────────────────────────────────────────────┬────────────────────────────────────────────────┐
  │ ANOMALY TYPE             │ DESCRIPTION & DIAGNOSTIC CLUES                                                 │ WHICH CHARACTERS REMAIN VALID FOR ID?          │
  ├──────────────────────────┼────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ ALBINISM (total)         │ Complete absence of melanin. ALL plumage white; iris pink/red; bill, skin,     │ STRUCTURAL ONLY — bill shape/length, body size, │
  │                          │ and legs pink. Pink eye is the clearest distinguishing marker vs. leucism.      │ wing projection, tail shape, behaviour.         │
  ├──────────────────────────┼────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ LEUCISM (partial         │ Patchy reduction of melanin in feathers ONLY. Bare parts (eye, legs, bill)     │ All non-white feather regions retain normal     │
  │ albinism / leucism)      │ retain NORMAL colour — this is the key separator from albinism. White patches  │ colour and pattern — use those zones freely.    │
  │                          │ in isolated feather tracts; may be uni- or bilateral. Very common in birds.    │ White zones = BLOCKED for colour evidence.      │
  ├──────────────────────────┼────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ MELANISM                 │ Excess melanin deposition. Most or all plumage abnormally dark (sooty-black     │ Silhouette, proportions, size, primary          │
  │                          │ or dark brown). All colour and most pattern field marks may be obscured.        │ projection, wing shape, tail, behaviour.        │
  │                          │ Structural contrast (wing panel vs. body) may still be visible.                │ Any pale fringe remnant is a strong clue.       │
  ├──────────────────────────┼────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ PIEBALDISM               │ Random bilateral-asymmetric white blotches on a normally-pigmented animal.      │ Fully symmetrical structural marks unaffected.  │
  │                          │ Pattern does NOT follow feather-tract or topographic boundaries.                │ White blotches are artefacts — NOT field marks. │
  │                          │ Test: if the white region has no geometric regularity → likely piebaldism.      │ Use all non-white regions for identification.   │
  ├──────────────────────────┼────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ ACROMELANISM             │ Temperature-sensitive pigmentation: extremities (bill-tip, wing-tips, tail-tip, │ Core body structure and colour fully valid.     │
  │                          │ tarsus, toes) darkened; centre body paler. Concentration at cold distal points. │ Extremity darkness = ANOMALOUS, not a field     │
  │                          │ Seen in some mammals (Siamese pattern); rare but documented in wild birds.      │ mark. Do NOT use tip darkness for elimination.  │
  ├──────────────────────────┼────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ ERYTHRISM                │ Excess rufous/red-brown pigment replacing normal grey, brown, or buff tones.    │ Silhouette, size, structure, behaviour valid.   │
  │                          │ Plumage reads anomalously warm-chestnut/orange across regions where grey or      │ Use structural not tonal colour characters.     │
  │                          │ neutral brown is expected. Can resemble Golden Hour (LT-5) colour-cast but      │ Cross-check: does LT-5/LT-8 lighting explain   │
  │                          │ persists across multiple photos under different lighting.                        │ the warmth? YES → lighting artefact, not erythrism.│
  ├──────────────────────────┼────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ DILUTION                 │ Uniformly reduced melanin across ALL feathers. Plumage appears "washed-out" —   │ Pattern GEOMETRY remains valid even if faded.   │
  │                          │ grey instead of black; pale brown instead of dark brown; faint buff instead of  │ Barring position, streak layout, malar geometry │
  │                          │ orange. A dilute bird retains the same PATTERN as normal — just paler overall.  │ all remain usable. Tonal shade = NOT usable.    │
  ├──────────────────────────┼────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ XANTHOCHROMISM           │ Yellow/orange pigment replaces normal melanin or structural colour throughout.  │ Structural characters unaffected.               │
  │                          │ Plumage reads anomalously yellow or orange-gold where brown or black expected.  │ Use size, shape, proportions, behaviour.        │
  │                          │ Entire bird may appear bright yellow — confirmed in wild passerines.            │ Context: is bird in LT-5 golden light? If YES  │
  │                          │                                                                                  │ → eliminate lighting before concluding anomaly. │
  └──────────────────────────┴────────────────────────────────────────────────────────────────────────────────┴────────────────────────────────────────────────┘

  COLOUR ANOMALY RULES (apply immediately if any anomaly detected):
    → RETURN TO STEP 1C (Plumage) and re-tag every colour character as:
        CONFIRMED — normal, reliable, readable under current lighting
        DEGRADED  — readable but with uncertainty (lighting, exposure, view angle)
        ANOMALOUS — affected by the colour anomaly; colour value is NOT the species' true signal
    → ANOMALOUS characters CANNOT be used for species elimination in Step 3.
    → STRUCTURAL characters (bill shape, body silhouette, tail length/shape, wing projection, leg length, behaviour) remain FULLY VALID.
    → If a colour anomaly is suspected but not confirmed → still proceed with structural-first identification, but note the suspicion.
    → CONCLUDE with one of: "Colour anomaly screen: NONE DETECTED" / "SUSPECTED: [type]" / "CONFIRMED: [type]"
    → If anomaly CONFIRMED → set identificationReasoning flag: "Colour anomaly: [type] — colour-based field marks unreliable. ID based on structural characters."
    → A confirmed colour anomaly LOWERS confidenceScore — structural-only ID typically achieves 0.55–0.75 vs. 0.80–0.95 for a full normal individual.

After completing Step 1H, proceed to Step 2.

STEP 2 — LIST UP TO 5 CANDIDATE SPECIES (MORPHOLOGY ONLY):
Based ONLY on the physical field marks catalogued in Step 1 — NOT location, NOT habitat, NOT season — list the most plausible candidate species. Include the family/genus grouping that best fits.

  ⟲ LOOP-BACK TRIGGERS (Step 2 → earlier steps — check BEFORE finalising the candidate list):
    • IF no candidate fits the gross morphology at all → RETURN TO STEP 1F: check whether an unexpected age/sex/plumage combination explains the mismatch; then revisit.
    • IF colour characters are the primary reason no candidate fits → RETURN TO STEP 1H: run or re-check the colour anomaly screen; then rebuild candidate list using STRUCTURAL characters only.
    • IF the silhouette (GISS) conflicts with the body of candidates → RETURN TO STEP 1A: recheck size bracket and proportions against the reference species list; correct GISS conclusion first.
    • IF only one candidate exists and it is a very poor match → do NOT force it; widen to genus-level candidates and flag confidence as LOW.

STEP 3 — SYSTEMATICALLY ELIMINATE CANDIDATES:
For each candidate, explicitly test EVERY major field mark against the known description for that species, drawing on:
  — Birds: eBird species accounts, Birds of the World, IOC species accounts, published field guides
  — Non-birds: GBIF taxon descriptions, iNaturalist taxon pages, relevant published keys and field guides A single definitive mismatch (wrong bill colour, wrong underpart pattern that cannot be explained by age, sex, subspecies, or lighting) eliminates that candidate. State the reason for each rejection clearly in identificationReasoning.

  For any taxon where siblings exist at ANY rank, the full ⚑ SIBLING TAXA DISAMBIGUATION protocol is mandatory — see below. It covers family → genus → species → subspecies and applies to every identification without exception.

  ⟲ LOOP-BACK TRIGGERS (Step 3 → re-check before advancing to Step 4):
    • IF elimination leaves ZERO remaining candidates → RETURN TO STEP 1H: check whether a colour anomaly (albinism, melanism, erythrism, etc.) disqualified all colour-based characters; rebuild candidate list using structural characters only, then re-eliminate.
    • IF elimination leaves ZERO remaining candidates AND structural recalibration still gives zero → RETURN TO STEP 1F: check whether an unexpected age/sex/plumage stage (immature, eclipse, transitional) explains the mismatch; then redo Step 2.
    • IF ALL remaining candidates are eliminated ONLY by colour characters that are rated UNRELIABLE or DEGRADED under the Condition 1 lighting code → STOP: do NOT use those colour characters as eliminators; mark those candidates as NOT ELIMINATED and proceed to Step 4 with the reduced but non-zero list.
    • IF one candidate was eliminated by a colour character read under LT-5/LT-8/LT-10/LT-11a → RETURN TO CONDITION 1 and CONDITION 9: confirm the lighting and exposure code, then re-evaluate whether that colour character is reliable before confirming the elimination.
    • IF the ANOMALOUS characters from Step 1H were incorrectly used to eliminate a candidate → REVERSE that elimination; ANOMALOUS characters are FORBIDDEN as eliminators in this step.

STEP 4 — COMMIT TO THE BEST MATCH:
Only after elimination steps, choose the species that matches the most diagnostic features. The chosen species MUST fit >90% of all clearly visible field marks. If no species passes at species level, identify to genus ("Genus sp.") or family and explain why. NEVER force a species-level ID just because location is provided.

  ⟲ LOOP-BACK TRIGGERS (Step 4 → re-check before committing):
    • IF the best remaining candidate fits <90% of clearly visible field marks → RETURN TO STEP 2: the correct species may not be in the candidate list; expand the candidate pool at genus level or to similar-looking taxa and re-run elimination.
    • IF the reason ≥1 remaining field mark is unexplained is potentially a colour anomaly → RETURN TO STEP 1H: re-confirm or re-screen the anomaly type; if anomaly confirmed, those characters are excluded from the 90% pass requirement.
    • IF the best candidate fits structurally but fails on ≥1 colour-based mark AND that colour mark is rated UNRELIABLE or LOW under the Condition 1 code → DO NOT reject the candidate on that mark; note it as unverifiable and still commit at species level if structural marks pass.
    • IF two candidates are tied with equal matching marks → RETURN TO STEP 1D (behaviour) and STEP 1E (flight/movement): use any behavioural or movement characters that were not yet applied to break the tie before committing.
    • IF committed, explicitly state: "Field marks passing vs. total visible" (e.g. "9/10 field marks pass") and list any unresolved marks with reason.

STEP 5 — ATTEMPT SUBSPECIES IDENTIFICATION FROM THE IMAGE:
Once the species is committed, attempt to identify the subspecies using the same field-mark discipline.

  ⛔ MANDATORY PRE-COMMIT BLOCK — READ BEFORE ANY SUBSPECIES DETERMINATION:
  Before you write any subspecies trinomial into the output, you MUST answer ALL of the following:
    (i)   What is the LT code assigned in Step 1 (IMAGE QUALITY CONDITION 1)? State it explicitly.
    (ii)  Is the LT code LT-1, LT-2, LT-3, or LT-4? If NOT, colour and pattern characters are unreliable — structural/bare-part only.
    (iii) Did you write out the full Stage 3 per-candidate expected profiles (A/B/C/D/E) BEFORE inspecting the image? If NOT, go back and do so now.
    (iv)  Did you apply Stage 4 sequential elimination using each candidate's HARDEST ELIMINATOR? If NOT, go back and do so now.
    (v)   Have you confirmed the ABSOLUTE character value (not merely relative) for the key separating character? e.g. "BLACKISH" means it must look near-black — NOT merely dark grey. "OPEN BARRING" means pale ground clearly visible — NOT merely uneven. If you used hedged language ("darker", "denser than expected", "relatively") that is NOT an absolute confirmation.
  If you cannot answer YES to all of (i)–(v), set taxonomy.subspecies to null and explain which gate failed.

  ⟲ LOOP-BACK TRIGGERS (Step 5 → re-check before nulling subspecies):
    • IF subspecies is being set to null ONLY because colour characters are UNRELIABLE under the Condition 1 code → CONFIRM FIRST: check whether any STRUCTURAL characters (bill length ratio, wing projection, tail graduation, tarsus length, size) alone can separate the subspecies candidates. If structural characters can separate → commit at subspecies level even without colour.
    • IF subspecies is being set to null and it seems visually determinable from the image → RETURN TO STEP 5a: verify that the correct subspecies reference list was recalled; missing a subspecies from recall = missed candidate, not a true null.
    • IF image is LT-8 / LT-9 / LT-10 / LT-11a / LT-12 AND colour is the ONLY separating character for all subspecies pairs → set subspecies to null AND explicitly state which lighting code blocks the determination (e.g. "LT-10 renders colour characters UNRELIABLE — only structural separation remains; no structural difference is diagnostic between the candidates at this image quality"). Do NOT silently null.
    • IF the image is multi-photo AND subspecies was nulled from the lowest-quality photo → RETURN TO STEP 5 MULTI-PHOTO RULE: re-read the subspecies-diagnostic character from the highest-reliability photo for that character type before nulling.
    • IF a colour anomaly was confirmed in Step 1H → subspecies colour-based marks are ANOMALOUS; attempt subspecies based on structural marks only; if structural marks alone are diagnostic → commit; otherwise null with explicit anomaly note.
    • IF the Step 1H anomaly screen was skipped and subspecies determination fails → RETURN TO STEP 1H: run the anomaly screen now, then re-attempt.
  a. RECALL: For the identified species, compile the candidate subspecies list using a TWO-STAGE GEOGRAPHIC FILTER before listing any marks:

     STAGE 1 — GEOGRAPHIC FILTER (apply FIRST — mandatory):
       From the sighting location (country/region provided), retain ONLY subspecies that are:
         • Confirmed RESIDENT in that country (present year-round), OR
         • Confirmed MIGRATORY VISITOR / SEASONAL VISITOR to that country (documented in eBird bar charts, IOC range maps, or Birds of the World range polygons as occurring at any season)
       EXCLUDE any subspecies with no documented occurrence in that country — even if it is a valid taxon.
       ⚠ DO NOT include subspecies purely because they are geographically adjacent or theoretically possible — only include those with actual documented occurrence records.
       RESULT: a short country-filtered candidate list. If only ONE subspecies occurs in that country → state "only one subspecies documented for this country — [trinomial]; no further elimination required" and proceed to step (c).

     STAGE 2 — FIELD MARK RECALL (apply to country-filtered list only):
       Birds: eBird species account (ISSF tab), Birds of the World subspecies accounts
       Non-birds: GBIF taxon page, iNaturalist taxon page, published systematic revisions / field guides
       Focus ONLY on marks that (a) distinguish the country-filtered candidates from each other AND (b) are visible in this image type/angle.
       Do NOT recall field marks for subspecies that were excluded in Stage 1.

  ⚠ LIGHTING RELIABILITY CROSS-REFERENCE FOR SUBSPECIES — cite IMAGE QUALITY Condition 1 code:
  Look up the lighting code you assigned in IMAGE QUALITY ANALYSIS → Condition 1. This table determines which subspecies characters are valid from this image. Do NOT re-describe lighting here — reference the code directly.

  ┌──────────────────────────────────────────┬─────────────────────┬───────────────────────┬──────────────┐
  │ Code  (Condition 1)                      │ COLOUR CHARS        │ PATTERN / BARRING     │ STRUCTURAL   │
  ├──────────────────────────────────────────┼─────────────────────┼───────────────────────┼──────────────┤
  │ LT-1  BRIGHT OPEN DAYLIGHT               │ HIGH                │ HIGH                  │ HIGH         │
  │ LT-2  OVERCAST / DIFFUSE          ✓ BEST │ HIGHEST             │ HIGHEST               │ HIGH         │
  │ LT-3  EARLY MORNING                      │ MODERATE-HIGH       │ MODERATE-HIGH         │ HIGH         │
  │ LT-4  LATE AFTERNOON / EVENING           │ MODERATE-HIGH       │ MODERATE-HIGH         │ HIGH         │
  │ LT-5  GOLDEN HOUR / WARM LIGHT           │ LOW                 │ MODERATE              │ HIGH         │
  │ LT-6  DAWN / DUSK TRANSITIONAL           │ LOW                 │ LOW-MODERATE          │ MODERATE     │
  │ LT-7  BLUE HOUR                          │ UNRELIABLE ✗        │ LOW                   │ MODERATE     │
  │ LT-8  FOREST SHADE / DAPPLED             │ LOW                 │ MODERATE              │ HIGH         │
  │ LT-9  DEEP SHADE / LOW LIGHT             │ UNRELIABLE ✗        │ LOW                   │ MODERATE     │
  │ LT-10 BACKLIT / CONTRE-JOUR              │ UNRELIABLE ✗        │ UNRELIABLE ✗          │ HIGH         │
  │ LT-11a CAMERA FLASH                      │ UNRELIABLE ✗        │ LOW                   │ MODERATE     │
  │ LT-11b TORCHLIGHT / FLASHLIGHT           │ LOW                 │ LOW-MODERATE          │ HIGH         │
  │ LT-11c SODIUM VAPOUR STREETLIGHT         │ UNRELIABLE ✗        │ LOW                   │ MODERATE     │
  │ LT-11d LED / WHITE STREETLIGHT           │ LOW                 │ MODERATE              │ HIGH         │
  │ LT-11e SPOTLIGHT                         │ LOW                 │ LOW-MODERATE          │ HIGH         │
  │ LT-12  NIGHT / VERY LOW LIGHT            │ UNRELIABLE ✗        │ UNRELIABLE ✗          │ LOW          │
  └──────────────────────────────────────────┴─────────────────────┴───────────────────────┴──────────────┘

  → COLOUR CHARS = upperpart tone, underpart ground colour, bare-part colours, malar/supercilium colour shade
  → PATTERN/BARRING = barring density, streak density, malar width, breast-band presence/absence, covert bar vs. no bar
  → STRUCTURAL = bill shape, tail length, wing projection, primary extension, overall silhouette, size

  RULES FROM TABLE:
  • COLOUR CHARS = UNRELIABLE → do NOT use upperpart tone, underpart colouration, or colour-shade differences as subspecies-eliminating characters; structural marks ONLY may eliminate ssp.
  • COLOUR CHARS = LOW → colour is SUPPORTING evidence only; primary elimination characters must be structural or pattern-based
  • PATTERN/BARRING = UNRELIABLE → set subspecies to null unless the distinction is PURELY structural (e.g. size, tail length, bill length ratio)
  • LT-10 BACKLIT SPECIFIC RULE: barring appears denser and upperparts appear darker than reality — this photographic artefact mimics the pattern of darker, more densely-barred subspecies on ALL birds; NEVER identify a densely-barred or dark subspecies from a backlit shot alone
  • LT-1 → LT-10 RECLASSIFICATION RULE: If solar angle assessment (Condition 1 SOLAR ANGLE SUB-ASSESSMENT) determines the subject is contre-jour even in bright daylight — treat ALL colour and pattern characters from that image as LT-10 (UNRELIABLE)
  • LT-5 GOLDEN HOUR SPECIFIC RULE: buff, rufous, orange, and yellow colour shades are unreliable — subspecies separated by warmth of tone (e.g. warmer vs. cooler brown) cannot be distinguished

  WEATHER CONDITION BLOCKERS (from Condition 8 — apply BEFORE reading any character):
  • HEAVY RAIN → colour = UNRELIABLE; pattern = UNRELIABLE; structural only. Subspecies: NULL.
  • MEDIUM/HEAVY HAZE → tonal colour comparisons UNRELIABLE at mid-to-distant range. Upperpart tone and barring density are grey-shifted. Apply haze correction before using tonal characters.
  • HEAT HAZE → proportional measurements FORBIDDEN. Structural silhouette only.
  • PLUMAGE WET (light rain / post-swim) → barring and streak density DEGRADED; colours DARKER than true. Add weather degradation note.

  MULTI-PHOTO RULE (if more than one photo of the same individual provided):
  • Assign a lighting code to EACH photo separately
  • For each subspecies diagnostic character, read it from the photo with the HIGHEST reliability for that character type (consult table above)
  • State explicitly: "Character [X] drawn from Photo [N] — lighting code [LT-X] — reliability: [HIGH/MODERATE/LOW/UNRELIABLE]"
  • Override: a LT-2 (overcast perched) shot ALWAYS overrides a LT-10 (backlit flight) shot for colour and pattern characters

  b. EXAMINE: Check each distinguishing subspecies mark in the most reliable photo. State the observed value as a plain fact for each character.
  c. NARROW: Eliminate subspecies whose diagnostic marks do not match what is visible.
  d. COMMIT or DECLINE: If ≥1 subspecies matches all visible distinguishing marks with ≥70% confidence, set taxonomy.subspecies to its trinomial name and identificationLevel to "subspecies". If multiple subspecies cannot be separated from this image, set subspecies to null and explain why in identificationReasoning. NEVER guess a subspecies from location alone — only from visible field marks.

  GENERIC DIAGNOSTIC PROCEDURE (applies to every species):

  ⚠ ANTI-RESIDENT-BIAS RULE — READ THIS FIRST:
  The resident or breeding subspecies at the sighting location is NEVER the default answer. Residency is not evidence. A single character that does NOT match the resident candidate ELIMINATES it, exactly as it would eliminate any migrant candidate. If the bird shows characters inconsistent with the resident subspecies, the resident subspecies MUST be eliminated — do NOT force the resident as the answer because it "lives there."

  ⚠ EQUAL BURDEN OF PROOF RULE: ALL candidate subspecies require identical morphological evidence standards regardless of residency status. The sighting location NEVER lowers the threshold for the resident subspecies, NEVER raises the threshold for migrants/visitors.

  ── STAGE 1: GEOGRAPHIC FILTER (mandatory — done in step a above) ──
  You now have a filtered candidate list from Stage 1. Proceed.

  ── STAGE 2: AGE / SEX / PLUMAGE STAGE ASSESSMENT ──
  Before testing any field mark, determine the bird's age class and plumage from the image:
    • ADULT: full definitive plumage (for passerines: bred-in wear pattern; for raptors: uniform flight feathers, no retained juvenile secondaries)
    • SUB-ADULT / IMMATURE: intermediate plumage — some adult-type, some retained juvenile feathers
    • JUVENILE / FIRST-CYCLE: fresh juvenile plumage (streaked where adult is barred in many species; buff fringes; uniform retained flight feathers)
    • UNKNOWN: image does not permit age determination
  State the determined age class explicitly. This matters because:
    — Some subspecies differences are ONLY reliable in adult plumage (e.g. upperpart tone, barring type)
    — Juvenile plumage can superficially resemble a different adult subspecies
    — If AGE = JUVENILE and the only separating marks are adult-plumage features, set subspecies to null unless structural (size, bare parts) marks are diagnostic

  ── STAGE 3: MANDATORY RECALL-BEFORE-EVALUATE ──
  For EACH candidate from Stage 1, explicitly write its authoritative diagnostic profile BEFORE inspecting the image.
  Source: eBird ISSF tab / Birds of the World subspecies accounts (birds); GBIF / iNaturalist (non-birds).
  Format — one block per candidate:
    Candidate: [trinomial] — [status: RESIDENT / MIGRANT / VISITOR]
      Expected A (upperpart tone): [exact description from source]
      Expected B (underpart pattern/barring): [exact description from source]
      Expected C (facial/head pattern): [exact description from source]
      Expected D (size/structure): [exact description from source]
      Expected E (bare-part colours — cere, orbital ring, feet, bill): [exact description from source]
      HARDEST ELIMINATOR: [the single most extreme character that, if absent, instantly rules this candidate out]
  Only AFTER writing all candidate profiles may you compare them against the image.

  ── STAGE 4: SEQUENTIAL ELIMINATION (eliminate first; select last) ──
  ⚠ DO NOT START BY LOOKING FOR A MATCH. Start by checking the HARDEST ELIMINATOR for each candidate.
  For each candidate, apply its HARDEST ELIMINATOR first:
    → If the image clearly CONTRADICTS the hardest eliminator → ELIMINATE this candidate immediately. State: "ELIMINATED — [character] inconsistent: expected [X], observed [Y]."
    → If the image is consistent with the hardest eliminator → retain the candidate and proceed to full character testing.
  Work through ALL candidates this way before moving to Stage 5.
  Remaining candidates after Stage 4 are your live candidates for Stage 5.

  ── STAGE 5: FULL CHARACTER TESTING on live candidates only ──
  For each LIVE candidate, test all character types below in the best-lit photo (cite LT code):

    CHARACTER TYPE A — UPPERPART TONE (requires LT-1/2/3/4; UNRELIABLE in LT-10/12):
      Compare observed tone against the Stage 3 recalled profile for each live candidate.
      State observed tone as a plain fact. Mark: MATCH / MISMATCH / UNRESOLVED per candidate.

    CHARACTER TYPE B — UNDERPART PATTERN (barring density / streaking / ground colour) (requires LT-1/2/3/4; UNRELIABLE in LT-10/7/12):
      Compare observed pattern against the Stage 3 recalled profile. Mark: MATCH / MISMATCH / UNRESOLVED.

    CHARACTER TYPE C — FACIAL / HEAD PATTERN (malar width, supercilium, crown tone, mask extent, cheek patch visibility):
      Compare against Stage 3 profile. Mark: MATCH / MISMATCH / UNRESOLVED.

    CHARACTER TYPE D — SIZE / STRUCTURE (wing length, compactness, tail projection — reliable ONLY if a reference object, known prey, or another identified species is visible):
      Compare against Stage 3 profile. Mark: MATCH / MISMATCH / UNRESOLVED.
      → No reference object available → mark UNRESOLVED.

    CHARACTER TYPE E — BARE-PART COLOURS (cere, orbital ring, feet, bill base — often subspecies-diagnostic and lighting-resistant for structural bare parts):
      Compare against Stage 3 profile. Mark: MATCH / MISMATCH / UNRESOLVED.
      → Only unreliable under LT-7/LT-9/LT-12.

    CHARACTER TYPE F — PHENOLOGICAL CONTEXT (supporting ONLY — NEVER the deciding factor):
      Season and location may shift probability but CANNOT commit or rule out any subspecies on their own.

  ── STAGE 6: SCORE AND COMMIT ──
  Count matches per live candidate across Character Types A–E.

  ⚠ COMMITMENT THRESHOLD — SCALED BY NUMBER OF LIVE CANDIDATES AFTER STAGE 4:
    • 1 live candidate remaining after Stage 4 → if ≥1 character type confirms MATCH → COMMIT.
    • 2 live candidates remaining → require ≥2 MATCH results for the same candidate under LT-1/2/3/4.
    • 3 or more live candidates remaining → require ≥3 MATCH results for the same candidate under LT-1/2/3/4.
    Any MISMATCH with a candidate CANCELS one MATCH for scoring purposes.
    A candidate with 2 MATCHes and 1 MISMATCH = net score 1, not 2.

  SIZE-DISAMBIGUATION RULE:
    When Character Type C or B returns a joint result (e.g. "candidate X or Y") AND Character Type D conclusively separates them — the size result resolves the ambiguity and the joint character counts as a full MATCH for the size-resolved candidate.
    If Character Type D is UNRESOLVED → the joint result counts as partial evidence only; do NOT use it alone to meet the threshold.

  ✗ Set subspecies to null and explain if:
      — The scaled threshold is not met after all stages
      — The deciding characters are under LT-10/LT-7/LT-12 lighting
      — Character Types A and B are both UNRESOLVED for all live candidates
      — Only context/season remains as evidence
      — Age is JUVENILE and no structural/bare-part mark distinguishes candidates in juvenile plumage

⚑ SIBLING TAXA DISAMBIGUATION — MANDATORY AT EVERY TAXONOMIC RANK FOR EVERY IDENTIFICATION:
This protocol is NOT optional and is NOT limited to species level or specific examples. It applies to EVERY rank — FAMILY → SUBFAMILY → GENUS → SPECIES → SUBSPECIES — for EVERY animal group (birds, reptiles, mammals, insects, fish, arachnids, etc.), and for EVERY image. You must descend through each rank in sequence, resolving siblings at each level before moving to the next. DO NOT skip any rank. DO NOT assume you know the answer — prove it character by character.

DEEP THINKING REQUIREMENT:
At each rank listed below, you must genuinely examine and weigh MULTIPLE independent diagnostic characters — not just the first one that appears to fit. State every character's observed value as a plain verifiable fact. Explicitly reason through why each candidate is retained or eliminated. The more closely related two taxa are, the more characters you must examine. One matching character is NOT sufficient for closely related siblings — you must build a convergence of evidence across several independent characters before committing down to the next rank.

═══════════════════════════════════════════
LEVEL 1 — FAMILY-LEVEL DISAMBIGUATION
═══════════════════════════════════════════
Before assigning a family, consider which families share the observed GISS profile and structural characters.

  PROCEDURE:
  1. ENUMERATE sibling families that could produce a similar silhouette, bill shape, and behaviour in this region.
  2. For each sibling family pair, identify the most reliable anatomical dividing character (e.g. zygodactyl vs. anisodactyl toes; hooked vs. straight bill; rictal bristles; wing shape; tail shape; bare facial skin).
  3. TEST each character against the image. State the observed value explicitly.
  4. ELIMINATE every family whose defining characters do NOT match what is visible.
  5. COMMIT to the family only once all sibling families have been tested. If two families cannot be separated from the image angle/quality, report family-level confidence < 0.85 and explain which character was unresolvable.

  DEEP-THINK CHARACTERS (examine ALL that are visible):
  • Foot/toe arrangement (anisodactyl / zygodactyl / webbed / lobed / raptorial talons)
  • Bill morphology: length / depth / culmen curve / tip shape / mandible colouration
  • Rictal bristles: present / absent / prominent
  • Tail shape (rounded / forked / graduated / pointed / fan)
  • Bare facial skin or orbital ring presence/colour
  • Primary projection relative to tertials
  • Nostril type (exposed / covered / tubular / nasal shield)
  • Neck length and posture (S-curve = heron; straight = cormorant; hunched = passerine)

═══════════════════════════════════════════
LEVEL 2 — GENUS-LEVEL DISAMBIGUATION
═══════════════════════════════════════════
Once the family is committed, DO NOT assume the genus — test it against all genera in that family recorded in the region.

  PROCEDURE:
  1. ENUMERATE every genus recorded in the committed family within the broad region (country / biogeographic zone). Use:
       Birds: IOC World Bird List + HBW genus accounts
       Reptiles: Reptile Database genus listings
       Amphibians: AmphibiaWeb genus pages
       Mammals: MSW / IUCN genus accounts
       All others: GBIF backbone genus pages + iNaturalist taxon pages
  2. For each genus pair, find the DEFINING genus-level character(s). Genus-level characters are typically structural and constant regardless of age/sex/season — bill morphology, foot structure, wing shape, body proportions, bare-part anatomy.
  3. TEST: examine every genus-diagnostic character visible in the image. State each value as a plain fact.
  4. ELIMINATE every genus whose defining anatomy does NOT match.
  5. COMMIT to the genus only after all alternatives are tested and eliminated.

  DEEP-THINK CHARACTERS (examine ALL that are visible):
  • Absolute bill length relative to head length (ratio)
  • Culmen curvature profile (straight / slightly / strongly decurved / recurved)
  • Lower mandible colour (often genus-diagnostic even when upper is similar across genera)
  • Tail-to-body ratio and tail shape
  • Leg length relative to body
  • Tarsus colour (often conserved at genus level)
  • Eye size relative to head (owls vs. other raptors; large-eyed flycatchers vs. thrushes)
  • Presence / absence of crest or ornamental head feathers
  • Any genus-unique bare-part feature (cere, facial disc, wattles, knob)
  • Primary projection — long in open-country genera, short in dense-forest genera

═══════════════════════════════════════════
LEVEL 3 — SPECIES-LEVEL DISAMBIGUATION
═══════════════════════════════════════════
Once the genus is committed, DO NOT assume the species — test every currently valid species in that genus recorded in the region.

  PROCEDURE:
  1. ENUMERATE every currently-valid species in the committed genus recorded in the broad region. Use:
       • Birds: IOC World Bird List
       • Reptiles: Reptile Database
       • Amphibians: AmphibiaWeb / ASW
       • Mammals: MSW / IUCN
       • All others (insects, arachnids, fish, etc.): GBIF backbone taxonomy + iNaturalist taxon pages
  2. For each sibling species pair, find THE MOST RELIABLE BINARY or strongly categorical character(s) that separates them per authoritative species accounts. Do NOT rely on a single character — build a multi-character test.
  3. TEST: examine EVERY species-diagnostic character visible in the image. State each observation as a plain fact:
       e.g. "Crown is white." "Loral spot present, touches bill base." "Breast streaking is heavy dark-brown." "Upper mandible base colour is greenish-yellow."
  4. ELIMINATE: any sibling species whose documented description does NOT match ANY ONE of the tested characters is ELIMINATED immediately. State the eliminating character explicitly.
  5. COMMIT: only a species that PASSES ALL tested diagnostic characters across ALL sibling pairs may be chosen.

  DEEP-THINK CHARACTERS — examine ALL of the following at species level (ALL that are visible):
  • Crown colour and any cap boundary sharpness
  • Lore colour — pale/dark/same as crown — and GEOMETRIC POSITION TEST (loral / post-ocular / full supercilium)
  • Eye/iris colour (often highly diagnostic between sibling species at the same age)
  • Orbital ring — present/absent, colour
  • Ear-covert colour and contrast with cheek
  • Malar stripe — present/absent, width, colour
  • Supercilium — present/absent, width, starting point (from bill base vs. only above eye), length
  • Throat colour and boundary with breast
  • Breast colour + streaking/spotting/barring density and colour
  • Belly colour — plain vs. streaked vs. barred
  • Flanks — colour, any streaking
  • Undertail-covert colour
  • Rump colour vs. back — geometric boundary test
  • Uppertail-covert colour
  • Wing bar presence, number, colour, width
  • Bill base colour (upper mandible separately from lower mandible)
  • Tarsus colour
  • Toe/foot colour (may differ from tarsus)
  • In-flight: upperwing pattern, underwing axillary colour, leg projection length

  FAILURE MODE TO AVOID: Do NOT commit to a species and THEN retrospectively explain why it fits. Run ALL elimination tests FIRST, BEFORE naming the final species.

  ⚠ ACCURACY WARNING ON ALL WORKED EXAMPLES:
  The examples below illustrate the PROCEDURE only. The specific diagnostic characters cited are simplified starting points.
  Before applying ANY character test from these examples, you MUST:
    (a) Recall and cross-check the actual diagnostic characters for that species pair from the current authoritative source (IOC/eBird/Birds of the World for birds; GBIF/iNaturalist for others).
    (b) If your authoritative knowledge of the diagnostic characters differs from what is written in the example, TRUST your authoritative knowledge — the prompt example may be simplified or become outdated.
    (c) Always state in identificationReasoning which authority you are following for the diagnostic character you used.

  REFERENCE EXAMPLES at species level:
  • Himantopus stilts, SE Asia/Australasia:
      Diagnostic: Crown colour (per IOC/Birds of the World). H. himantopus = extensive dark crown continuing down the hindneck. H. leucocephalus = white crown with dark markings CONFINED to neck sides and hindneck patches only — crown itself remains white.
      Test: "Is the crown white or dark?" → white crown eliminates H. himantopus; dark crown eliminates H. leucocephalus.
      Secondary check: neck-side pattern — H. leucocephalus dark patch confined to sides only, does NOT wrap across the nape.
  • Cyornis flycatchers, SE Asia:
      Diagnostic: White loral spot position (per IOC/Birds of the World).
        C. rufigastra (Mangrove Blue Flycatcher) = white loral spot present, TOUCHES bill base — classified as loral spot.
        C. tickelliae (Tickell's Blue Flycatcher) = no white loral spot at bill base.
        C. banyumas (Hill Blue Flycatcher, common Singapore migrant) = no white loral spot; orange underparts contrast with blue face more strongly than tickelliae.
      Multi-character test: loral spot position (does it touch the bill base?) + underpart orange-to-white boundary (how far down?) + breast shade intensity.
      ALWAYS cross-check against current IOC species accounts — Cyornis has undergone recent taxonomic revision.
  • Falco falcons, any region:
      Diagnostic: Malar stripe width + AGE-SPECIFIC underpart pattern (per IOC/Birds of the World/BWP).
        F. peregrinus (Peregrine Falcon):
          — ADULT: broad, solid, dark malar stripe (width > ¼ of cheek); blue-grey/slate upperparts;
            underparts white to buff with bold dark SPOTS on upper breast and fine dark BARRING on flanks and lower belly.
          — IMMATURE: broad malar; brown upperparts; underparts with HEAVY DARK STREAKS top to bottom (not barred).
        F. subbuteo (Eurasian Hobby):
          — ADULT: narrower malar (thinner than peregrinus); blue-grey upperparts; white underparts with BOLD DARK STREAKS
            from throat to vent — streaking heavier and more uniform than adult peregrinus; rufous thighs and undertail-coverts (diagnostic).
      Test: (1) Malar width relative to cheek. (2) Is the bird adult (barred lower belly) or immature (streaked throughout)? (3) Rufous thighs/vent? → rufous = subbuteo.
      ALWAYS state the age of the individual first, then apply the correct underpart pattern test.
  • Accipiter hawks, any region:
      Diagnostic: Iris colour + underpart pattern (per IOC/Birds of the World).
        A. trivirgatus (Crested Goshawk): ADULT = yellow iris; underparts with bold chestnut-brown barring on white background; crest present.
        A. soloensis (Chinese Sparrowhawk): ADULT MALE = orange-red iris; underparts plain white or with faint orange-rufous wash on breast — no barring, no streaking.
        A. virgatus (Besra): yellow iris like trivirgatus but STREAKED mesial stripe on throat + finer barring; smaller.
      Test: (1) Iris colour exactly (yellow vs. orange-red). (2) Is underpart pattern barred (trivirgatus) vs. plain/unbarred (soloensis) vs. streaked throat + fine barring (virgatus)? (3) Crest present? → trivirgatus.
  • Ardeola pond herons, non-breeding plumage (Asia — notoriously difficult):
      ALL Ardeola share white wings + brown-streaked body in non-breeding dress. Multi-character approach required:
        1. BILL BASE COLOUR (most reliable when visible): A. grayii = greenish-yellow to olive-yellow base, dusky culmen ridge extending to tip; A. bacchus = pinkish or flesh-yellow base, black restricted to culmen tip only; A. speciosa = similar to bacchus but often cleaner/brighter yellow.
        2. BREAST STREAKING DENSITY & COLOUR: A. grayii = heavy, broad, dark brown-black streaks on breast-sides, dense and bold; A. bacchus = streaks narrower and more rufous-brown; A. speciosa = lightest streaking of the three, less dense.
        3. FACIAL SKIN/LORE COLOUR: A. grayii = relatively extensive dull olive-yellow lore; A. speciosa = brighter yellow facial skin.
        4. RANGE (supporting only): A. grayii = Indian subcontinent resident + occasional vagrant; A. bacchus = breeds E China, winters SE Asia to Sundas; A. speciosa = Sundaic resident (Java, Bali, Indochina).
      Test sequence: bill base colour → breast streak density + colour → facial skin → range confirmation.
  • Otus scops owls, SE Asia (Singapore — commonly misidentified pair):
      Current accepted names (IOC World Bird List, latest version):
        RESIDENT: Collared Scops Owl (*Otus lettia*) — the year-round Singapore resident. Older Singapore field guides labelled this "Sunda Scops Owl" (*Otus lempiji*); IOC now treats Singapore birds as *O. lettia*. DO NOT output "Sunda Scops Owl" as the final name.
        MIGRANT: Oriental Scops Owl (*Otus sunia*) — uncommon passage migrant / winter visitor to Singapore.
      Diagnostic characters (verify against Birds of the World / IOC species accounts before applying):
        1. UNDERPART PATTERN — most reliable:
           O. lettia = underparts BUFF-WHITE with fine dark SHAFT STREAKS AND fine herringbone CROSS-BARRING (vermiculations) — overall effect is an intricate, delicately patterned cryptic plumage; impression is NOT boldly streaked; the cross-barring component is as prominent as the shaft streaks.
           O. sunia = underparts with BOLDER, more prominent dark shaft streaks; cross-barring present but the dominant visual impression is of distinct streaking rather than intricate vermiculations; heavier and more contrasting pattern than lettia.
        2. NUCHAL COLLAR: O. lettia = pale buff nuchal collar clearly visible on the neck sides — a prominent and consistent mark; O. sunia = nuchal collar absent or very inconspicuous.
        3. SCAPULAR PANEL: O. lettia = prominent pale whitish scapular spots forming a visible pale row along the folded wing; O. sunia = pale scapular spots present but less bold.
        4. FACIAL DISC BORDER: O. lettia = facial disc with a moderately defined darker brown outer edge; O. sunia = facial disc border variable but generally less well-defined.
        5. EAR TUFTS: Both species have short ear tufts — NOT reliably diagnostic on its own.
        6. IRIS COLOUR: Both species have yellow iris — NOT diagnostic.
        7. RANGE (supporting only): O. lettia = year-round resident in Singapore gardens, parks, secondary forest edge; O. sunia = uncommon passage migrant/winter visitor.
      Test sequence: underpart pattern (streaks + cross-barring ratio) → nuchal collar → scapular spots → range.
  • Muscicapa flycatchers, SE Asia (THREE-WAY confusion — all plain brown; forest understorey):
      Current accepted names (IOC World Bird List, latest version; verify before applying):
        M. muttui    = Brown-breasted Flycatcher   — winter visitor/passage migrant; uncommon in Singapore
        M. dauurica  = Asian Brown Flycatcher       — common winter visitor/passage migrant in Singapore
        M. ferruginea = Ferruginous Flycatcher      — rare vagrant in Singapore; more regular on the Thai-Malay peninsula

      ⚠ CRITICAL FIRST SEPARATOR — RUMP (use if any dorsal view is available):
        M. ferruginea: RUFOUS/BRIGHT ORANGE rump and uppertail coverts — visible as a vivid rust-orange patch when the bird flies, pivots, or shows its back. This is THE single most diagnostic character.
        M. muttui:     PLAIN BROWN rump — same tone as the mantle; NO rufous or orange at all.
        M. dauurica:   PLAIN BROWN rump — same tone as the mantle; NO rufous or orange at all.
        RULE: If a rufous rump is visible → M. ferruginea confirmed; stop the muttui/dauurica analysis.
               If NO rufous rump is visible but the view is FRONTAL ONLY → rump cannot be assessed; continue to characters 1–5 below.

      ⚠ FOREST-SHADE COLOUR TRAP — MANDATORY CORRECTION BEFORE READING ANY COLOUR:
        All three species are frequently photographed in LT-8 (forest shade) or LT-9 (deep shade).
        The blue-green ambient cast of forest light SUPPRESSES warm tones and SHIFTS browns toward grey-green.
        This means:
          — M. muttui's warm buff-brown breast wash can appear grey-brown → may be WRONGLY dismissed as dauurica
          — M. muttui's warm buff-brown breast can also appear more orange than it truly is under partial dappled patches → may be WRONGLY elevated to ferruginea
          — M. ferruginea's true rufous-orange flank patches can appear dull brown in deep shade → may be WRONGLY read as muttui
        Apply LT-8 warm-correction to all colours BEFORE attempting identification. Add +warmth to perceived tones.

      ⚠ CRITICAL ANATOMY TRAP — TARSI vs. RUMP vs. TAIL (frontal perched views):
        When a Muscicapa flycatcher is perched on a branch facing the camera, the following anatomy is present below the body:
          — TARSI (legs): long, thin, orange-flesh or dark structures extending downward from the body to the feet; visible on either side of the branch or below it
          — TAIL: flat panel of feathers hanging vertically below the body tip; brown/dark; NOT orange
          — RUMP: the feathered area on the BACK above the tail base; COMPLETELY HIDDEN on a frontal view
        ⚠ THE TRAP: M. muttui has distinctive warm ORANGE-FLESH TARSI. These are visible below the perch in front-facing shots.
          An orange structure visible below a front-facing flycatcher body is ALMOST CERTAINLY THE TARSI (= supports muttui).
          It is NOT the rump (which is hidden) and NOT the tail (tail feathers are flat and brownish, not orange sticks).
          DO NOT interpret visible orange-flesh tarsi as a "rufous tail" or "rufous rump" — this is a known misidentification trap.
          To see the RUMP of a perched bird, a dorsal or rear-view image is required.

      ⚠ THROAT PALENESS ≠ BICOLOURED BREAST PATTERN:
        In all three Muscicapa species, the THROAT is naturally paler than the breast. This is normal anatomy.
        The mere presence of a paler throat above a warmer breast does NOT constitute a bicoloured breast pattern.
        A TRUE bicoloured pattern (diagnostic for ferruginea) requires:
          — The white/pale centre extends from the throat DOWN through the mid-breast, clearly separating two orange-rufous lateral patches
          — The contrast between the pale centre and orange sides is sharp and bold — not a gentle gradient
          — The orange/rufous flank patches are BRIGHTER and more SATURATED than typical muttui buff-brown
        If the breast appears uniform warm buff-brown from side to side (with only the throat being paler at the top) → this is NORMAL muttui anatomy, NOT bicoloured ferruginea.

      ⚠ FERRUGINOUS vs. MUTTUI FRONT-ON CONFUSION TRAP:
        On a front-facing image with no rump visible, M. ferruginea's rufous-orange breast-SIDE patches can superficially resemble M. muttui's complete buff-brown breast band.
        The KEY difference from the front:
          M. ferruginea: rufous-ORANGE patches on the SIDES of the breast, with a sharply BOLD contrasting WHITE CENTRE zone running from the throat DOWN through the mid-breast, clearly dividing two vivid orange lateral panels. The orange is noticeably MORE SATURATED than any muttui buff-brown. The pale zone is not just the throat — it extends visibly down the breast centre.
          M. muttui:     the warm buff-brown wash is UNIFORM across the full breast width. The throat is naturally paler (this is normal anatomy for all Muscicapa), but the pale zone does NOT extend as a bold stripe down the breast centre. Below the throat the breast is continuously warm buff-brown across its full width.
        DIAGNOSIS QUESTION: "Does the pale zone cut DOWNWARD through the breast centre dividing two vivid orange lateral panels, or is the pale zone limited to the throat with warm colour covering the full breast below?"
          → Pale stripe cutting down the breast centre + vivid saturated orange lateral panels = ferruginea
          → Throat-only pale + uniform warm buff-brown breast below = muttui

      DIAGNOSTIC CHARACTERS — muttui vs. dauurica vs. ferruginea:

      1. BREAST / UNDERPART COLOUR PATTERN (most reliable after LT-8 correction):
         M. muttui    = warm buff-BROWN wash UNIFORM across FULL BREAST WIDTH — complete warm pectoral band; belly and throat paler but no white-centre contrast with orange sides.
         M. dauurica  = pale buff or greyish wash on breast-SIDES only; central breast and throat clean whitish; overall clean, largely unmarked impression.
         M. ferruginea = rufous-ORANGE wash on breast SIDES only; sharply contrasting WHITE breast-centre and throat — distinctly bicoloured; the orange is warmer/brighter than the buff-brown of muttui.

      2. RUMP (if any dorsal view):
         M. muttui    = PLAIN BROWN — concolorous with mantle.
         M. dauurica  = PLAIN BROWN — concolorous with mantle.
         M. ferruginea = BRIGHT RUFOUS / ORANGE — vividly contrasting with the brown mantle.

      3. HEAD PATTERN — cap contrast:
         M. muttui    = plain brownish-grey head; no strong contrast between crown and face; uniform tone.
         M. dauurica  = plain grey-brown head; no cap contrast.
         M. ferruginea = darker grey-brown CAP noticeably contrasting with a paler grey face — a subtly "capped" or hooded impression; the crown is distinctly darker than the cheeks.

      4. LORAL AREA (between bill base and eye):
         M. muttui    = lores PALE — pale buff/whitish; no distinct dark loral line; open-faced expression.
         M. dauurica  = lores slightly dark — a subtle dark loral line giving a subtle masked expression.
         M. ferruginea = lores pale; no dark loral line (similar to muttui in this character).

      5. BILL — shape and lower mandible colouration:
         M. muttui    = bill BROADER-BASED and slightly longer; lower mandible extensively pale flesh/yellow along most of its length; the bill base is clearly pale; appears more robust overall.
         M. dauurica  = bill more slender; lower mandible pale at or near the base only, darkening toward the tip; finer bill.
         M. ferruginea = bill small and fine; lower mandible pale but not as extensively so as muttui; overall a delicate bill.

      6. ORBITAL RING:
         M. muttui    = whitish/buff orbital ring clearly visible.
         M. dauurica  = orbital ring absent or extremely narrow/inconspicuous.
         M. ferruginea = orbital ring present but typically narrow; less prominent than muttui.

      7. TARSI / FEET COLOUR:
         M. muttui    = warm ORANGE-FLESH to pinkish-orange tarsi — this is distinctive for muttui.
         M. dauurica  = dark brownish-black to dark grey tarsi.
         M. ferruginea = pale brownish or pinkish tarsi; less vivid orange than muttui.

      8. SIZE:
         M. muttui    = slightly larger and chunkier than dauurica.
         M. dauurica  = smaller and slimmer.
         M. ferruginea = similar to dauurica; compact and small.

      9. OCCURRENCE IN SINGAPORE (supporting evidence only — NEVER primary):
         M. dauurica  = COMMON (most expected).
         M. muttui    = UNCOMMON but regular (especially Oct–Mar).
         M. ferruginea = RARE VAGRANT (record carefully; exceptional).

      TEST SEQUENCE (mandatory; apply in order):
      Step 1: Is a rufous/orange RUMP visible? → YES = M. ferruginea; NO / not visible → continue.
      Step 2: Apply LT-8 warm correction to all perceived breast colours.
      Step 3: Is the breast pattern BICOLOURED (orange sides + white centre) OR UNIFORM warm buff-brown?
              → Bicoloured orange-sides + white centre = M. ferruginea
              → Uniform complete warm buff-brown band = M. muttui
              → Pale buff sides only + clean white centre = M. dauurica
      Step 4: Tarsi colour if visible → warm orange-flesh = strongly supports muttui.
      Step 5: Lores pale or dark? → Pale = muttui or ferruginea; dark loral line = dauurica.
      Step 6: Bill lower mandible → extensively pale, broad base = muttui; slender, pale-base-only = dauurica; fine = ferruginea.
      Step 7: Orbital ring → clearly visible = muttui; absent = dauurica; narrow = ferruginea.
      RULE: Require convergence of ≥ 3 characters for a confident species call. With frontal-only shots and no rump visible, the bicoloured vs. uniform breast test (Step 3) is the decisive separator between muttui and ferruginea.
      RULE: Do NOT elevate to M. ferruginea solely because the breast appears warm/rufous under LT-8 shade — apply the warm correction first, then recheck if the breast centre is white-contrasting or uniformly warm.
      ALWAYS cross-check against current IOC accounts — Muscicapa taxonomy has undergone recent revision.

═══════════════════════════════════════════
LEVEL 4 — SUBSPECIES-LEVEL DISAMBIGUATION
═══════════════════════════════════════════
Once the species is committed, DO NOT skip subspecies — test every subspecies group recorded in the region unless the species is monotypic.

  PROCEDURE:
  1. ENUMERATE every currently-accepted subspecies (or subspecies group) for the committed species that is known to occur in the broad region. Use:
       Birds: eBird ISSF tab + Birds of the World subspecies accounts
       Non-birds: GBIF taxon page subspecies section + iNaturalist taxon hierarchy + published systematic revisions
  2. For each subspecies pair, identify the specific field mark(s) that distinguish them, per authoritative accounts. These are often subtle: malar stripe width, supercilium colour, breast-streaking density, bare part colour shade, size, tail band width.
  3. TEST: examine every subspecies-diagnostic mark visible in the image. State each value as a plain fact.
       Do NOT default to the nominate or the most common subspecies without testing — examine the marks explicitly.
  4. ELIMINATE: any subspecies whose documented distinguishing marks do NOT match what is visible is ELIMINATED. State the eliminating character.
  5. COMMIT or DECLINE:
       — If ≥ 1 subspecies passes all tests with ≥ 70% confidence → set taxonomy.subspecies to the accepted trinomial.
       — If multiple subspecies cannot be separated from this angle/quality → set subspecies to null and explain which character was unresolvable.
       — If the species is monotypic → set subspecies to "monotypic".
       — NEVER set a subspecies based on geographic location alone.

  DEEP-THINK CHARACTERS at subspecies level (examine ALL that are visible):
  • Malar stripe width — measured relative to the cheek width (narrow / medium / broad)
  • Supercilium colour (white / buff / orange-tinged / absent) — small colour differences are subspecies-level
  • Breast streaking density (sparse / moderate / dense / absent) and colour (black / dark-brown / rufous / pale)
  • Mantle colour shading (warmer rufous vs. cooler grey-brown)
  • Wing bar colour shade (buffier vs. whiter vs. orangey)
  • Bill base colour — shade differences (pale yellow vs. orange-yellow vs. pink-flesh)
  • Tarsus/foot colour — shade differences (pale flesh vs. pink vs. orange vs. bright yellow)
  • Bare-part orbital ring width (narrow vs. broad) and colour (yellow vs. orange vs. red)
  • Rump colour shade — can differ between subspecies even within similar overall plumage
  • Size cues relative to background objects (larger subspecies groups vs. smaller)
  • Any subspecies-specific plumage feature documented in Birds of the World / GBIF revision

⚠ ANTI-HALLUCINATION RULES:
- Location and habitat are SUPPORTING EVIDENCE ONLY — they MUST NOT drive or override a morphological mismatch
- If location suggests one species but morphology matches a different one, trust morphology; note the discrepancy in identificationReasoning
- If you are below 85% confident at species level, report genus level instead — do not pad confidence
- Under-identification (genus/family) is preferable to a wrong species

⚑ SPECIMEN-BASED REASONING:
- Your identification must be consistent with the TYPE SPECIMEN characters for the accepted taxon — i.e. the holotype or lectotype description as published in the original taxonomic paper or validated by a subsequent authoritative revision.
- Museum specimen records (GBIF occurrence data, NHM, AMNH, MNHN, Smithsonian, etc.) provide validated identification benchmarks — cross-reference known specimen localities and diagnostic morphology when available.
- When a species has been split or lumped, use ONLY the currently accepted name per the relevant checklist authority:
    Birds: IOC World Bird List (cross-check eBird/Clements)
    Reptiles: Reptile Database (cross-check GBIF + iNaturalist)
    Amphibians: AmphibiaWeb / ASW (cross-check GBIF + iNaturalist)
    Mammals: MSW / IUCN (cross-check GBIF + iNaturalist)
    Invertebrates & fish: GBIF backbone + iNaturalist taxon pages
- Original species descriptions (protologues) define the taxon — rely on these over popularised field guide descriptions when they conflict.
- For species complexes or recently described species, explicitly note if the identification is uncertain due to ongoing taxonomic revision.

⚑ TAXONOMIC INDEPENDENCE — SYNONYMS ≠ CONSPECIFICS:
- A shared scientific synonym, a similar common name, or superficial morphological resemblance does NOT make two currently valid taxa the same species.
- Each taxonomic rank is evaluated INDEPENDENTLY from its own diagnostic characters:
    • Confirmed family → genus is a SEPARATE determination requiring genus-diagnostic morphological characters
    • Confirmed genus → species is a SEPARATE determination requiring species-diagnostic characters
    • Confirmed species → subspecies is a SEPARATE determination requiring subspecies-diagnostic characters
- NEVER infer a lower rank from a higher rank alone: knowing the family does not constrain you to a specific genus; knowing the genus does not tell you the species.
- If Species A and Species B are both currently valid taxa recognised by the checklist authority, they are DISTINCT species regardless of any historical synonymy under the same name — verify current accepted status and treat them as separate.
- When a species has been recently split, the daughter taxa are distinct — morphological characters must actively distinguish them; never default to the pre-split aggregate name without stating which daughter is supported.
- Basionyms and heterotypic synonyms are historical names that resolve to the CURRENT accepted taxon — sharing a synonym in taxonomic history does not imply the two taxa are equivalent today.

⚑ SYNONYMOUS SPECIES DISAMBIGUATION — MANDATORY when a candidate name may be a synonym, aggregate, or split:
Many field guides, older databases, and casual references still use outdated synonyms, pre-split aggregate names, or lumped names. Before committing to any species name, you MUST perform this synonym check:

  PROCEDURE:
  1. CURRENT NAME CHECK: Verify the candidate name is CURRENTLY ACCEPTED by the relevant checklist authority (IOC for birds; Reptile Database / AmphibiaWeb / MSW / GBIF for others).
     — If the candidate name is flagged as a synonym or outdated name, find the currently accepted name and use that instead.
  2. SPLIT HISTORY CHECK: Has the candidate species been split into multiple daughter taxa since any major field guide was published?
     — If YES: list all daughter taxa. Evaluate each daughter taxon's diagnostic characters against the image SEPARATELY. Commit to the daughter taxon that matches, not to the pre-split aggregate.
  3. LUMP HISTORY CHECK: Has the candidate species recently been lumped into a broader species?
     — If YES: the correct name is now the lumped species. State the old name and the current accepted name explicitly.
  4. NAMING CONFLICTS: If two different binomials appear for what seems like the same animal (e.g. old guide vs. eBird), always resolve to the CURRENT accepted authority name.

  FAILURE MODE TO AVOID: Do NOT use a field guide name without checking whether it is still the accepted name. Do NOT treat a pre-split aggregate and one of its daughter taxa as the same taxon.

  REFERENCE EXAMPLES:
  • "Dusky Broadbill" in older guides = Corydon sumatranus (pre-split); after IOC split this becomes C. sumatranus + C. melanops in some treatments — check current IOC status and commit to the accepted daughter.
  • "Large-billed Crow" complex = Corvus macrorhynchos sensu lato has been split; evaluate which daughter (C. macrorhynchos / C. levaillantii / C. culminatus) the image supports.
  • "Little Heron" (old name) = current IOC name is Striated Heron (Butorides striata) — never use the outdated synonym as the final output name.
  • "Sunda Scops Owl" (*Otus lempiji*) — the old Singapore field guide name for the resident scops owl:
      Under current IOC World Bird List treatment, the Singapore resident scops owl is Collared Scops Owl (*Otus lettia*), not *Otus lempiji* (Sunda Scops Owl) which is now restricted to Sundaland populations (Borneo, Sumatra, Java and nearby islands).
      RULE: Always output "Collared Scops Owl" / *Otus lettia* for the Singapore resident. NEVER use "Sunda Scops Owl" or *Otus lempiji* for Singapore birds.
      The passage migrant/winter visitor is Oriental Scops Owl (*Otus sunia*) — a phylogenetically distinct species separable by bolder underpart streaking and absent/inconspicuous nuchal collar (see LEVEL 3 worked example above).
      Verify current IOC treatment before committing — scops owl taxonomy is actively revised.

⚑ SYNONYMOUS SUBSPECIES DISAMBIGUATION — MANDATORY when a subspecies name may be a synonym, reassigned, or transferred:
Subspecies taxonomy changes frequently — reassignment to a different species, synonymisation with the nominate, or elevation to full species status. Before committing to any trinomial:

  PROCEDURE:
  1. CURRENT SUBSPECIES STATUS: Verify the candidate trinomial is currently accepted by the relevant authority (eBird ISSF for birds; GBIF / relevant systematic revision for others).
     — If the trinomial is flagged as a synonym of the nominate or of another subspecies, do NOT use it. Use the accepted trinomial or set subspecies to null with explanation.
  2. ELEVATION CHECK: Has the candidate subspecies been elevated to full species since the reference was published?
     — If YES: it is now a SEPARATE SPECIES, not a subspecies. Apply the SYNONYMOUS SPECIES DISAMBIGUATION procedure above.
  3. TRANSFER CHECK: Has the subspecies been transferred to a different nominal species (i.e. the trinomial now belongs to a different binomial)?
     — If YES: report the correct current placement.
  4. NOMINATE SYNONYMY: If the subspecies is phenotypically indistinguishable from the nominate and has been synonymised, set subspecies to "nominate" or null and explain in identificationReasoning.

  FAILURE MODE TO AVOID: Do NOT report a trinomial that is no longer valid per current checklists. Do NOT treat an elevated ex-subspecies as still a subspecies of the original species.

  REFERENCE EXAMPLES (taxonomic validity only — NOT identification guides):
  • Falco peregrinus ernesti, F. p. calidus, F. p. japonensis — all currently accepted eBird ISSF trinomials; do NOT synonymise any of these three with each other. Identification must follow the generic 6-stage diagnostic procedure in Step 5.
  • Ardeola bacchus / grayii — many older sources place these as subspecies of a lumped species; they are now SEPARATE full species under IOC — treat them as species-level taxa, not subspecies.
  • Pycnonotus goiavier analis — verify current eBird ISSF status; some authorities synonymise analis with the nominate goiavier.

SEX DETERMINATION (apply AFTER Step 4):
  1. SPECIES KNOWLEDGE: Recall the known sexual dimorphism for the identified species from authoritative sources:
       Birds: eBird species account, Birds of the World, field guides
       Non-birds: GBIF taxon descriptions, iNaturalist taxon page, published field guides / revisions
     Name the specific features that differ between sexes.
  2. PLUMAGE ANALYSIS: Examine those specific features in this image. Explicitly state whether they match male or female.
  3. DECISION: Set sex to "Male" / "Female" only when diagnostic features are visible and match. Set "Unknown" for monomorphic species, juveniles, or when the relevant features are occluded.
  4. Set sexMethod: "from_image_plumage" (features clearly visible), "from_species_knowledge" (features partially visible but consistent), "inferred" (low visibility, consistent with species patterns), "unknown".
- Set breedingPlumage to "Yes" only if ornamental or nuptial plumage is clearly visible.

ACTIVITY PATTERN DETERMINATION (apply AFTER Step 4):
  For every identified species, determine and state the activity pattern from authoritative sources:
    Birds: eBird species account / Birds of the World Behaviour section
    Reptiles/Amphibians: GBIF taxon page / AmphibiaWeb / Reptile Database / iNaturalist taxon page
    Mammals: GBIF / MSW / iNaturalist taxon page
    Insects/others: GBIF / iNaturalist taxon page / published field guides

  ACTIVITY PATTERN CATEGORIES:
    • DIURNAL — active primarily during daylight hours
    • NOCTURNAL — active primarily at night
    • CREPUSCULAR — active primarily at dawn and dusk (twilight active)
    • CATHEMERAL — active at irregular intervals both day and night
    • FOSSORIAL / CRYPTIC — largely underground or concealed; surface activity variable

  CROSS-REFERENCE WITH OBSERVATION TIME:
  If the image capture time is known (from EXIF metadata provided in options.imageCapturedAt, or inferable from the lighting condition code):
    1. Assess whether the species being active at this time is EXPECTED or UNUSUAL.
    2. State: "Activity pattern: [category]. Observation time: [day/twilight/night]. Concordance: [expected ✓ / unexpected ⚠]."
    3. An UNEXPECTED concordance (e.g. strictly nocturnal species photographed in bright midday sun, or strictly diurnal species under torchlight in a forest at night) should be flagged in identificationReasoning — it does NOT invalidate the identification, but should be noted as an anomaly. Some nocturnal species are occasionally flushed or disturbed during the day.
    4. For NOCTURNAL species photographed under torchlight (LT-11b) or flash (LT-11a): this is the EXPECTED capture scenario — note it as concordant.
    5. Do NOT use activity pattern alone to eliminate a species from consideration — use it only as supporting context.

ALL fields below MUST be filled from authoritative sources. Use the correct authority for the animal group:
  Birds: eBird species accounts, Birds of the World, IOC World Bird List, IUCN Red List
  Reptiles/Amphibians: Reptile Database / AmphibiaWeb, GBIF taxon page, iNaturalist taxon page, IUCN Red List
  Mammals: MSW / IUCN, GBIF taxon page, iNaturalist taxon page
  Invertebrates & fish: GBIF backbone, iNaturalist taxon page, published keys/revisions, IUCN Red List
Never invent, guess, or leave blank when authoritative data exists.

COUNTRY CONTEXT: Use the country/region from GEOGRAPHIC CONTEXT if provided. If no country or location is given, default to Singapore for ALL location-dependent fields (migratoryStatus, iucnStatus.local, subspecies occurrence, habitat notes). Accuracy is paramount — every claim must be verifiable against eBird (birds) or GBIF / iNaturalist (non-birds), or a published field guide.

Return JSON only:
{
  "identified": true,
  "identificationLevel": "fill from authoritative sources — subspecies/species/genus/family determined by your systematic field-mark analysis and matched against: birds → eBird/IOC taxonomy; non-birds → GBIF taxon hierarchy + iNaturalist taxon page",
  "confidence": 0.95,
  "commonName": "fill from authoritative sources — primary English common name: birds → exactly as listed in eBird taxonomy (IOC); non-birds → exactly as listed on GBIF taxon page or iNaturalist taxon page; never invent or paraphrase",
  "scientificName": "fill from authoritative sources — accepted binomial: birds → eBird/IOC taxonomy; non-birds → GBIF backbone or iNaturalist accepted name e.g. 'Ceyx rufidorsa'; must match taxonomy.species exactly",
  "taxonomy": {
    "kingdom": "fill from authoritative sources e.g. Animalia",
    "phylum": "fill from authoritative sources e.g. Chordata",
    "class": "fill from authoritative sources e.g. Aves",
    "order": "fill from authoritative sources e.g. Coraciiformes",
    "family": "fill from authoritative sources e.g. Alcedinidae",
    "subfamily": "fill from authoritative sources e.g. Alcedininae; null if not applicable",
    "genus": "first word of scientificName e.g. Ceyx — from authoritative taxonomy",
    "species": "full accepted binomial: birds → eBird/IOC; non-birds → GBIF backbone / iNaturalist accepted name e.g. 'Ceyx rufidorsa' — MUST match scientificName; null only if identified above species level",
    "subspecies": "accepted trinomial: birds → eBird ISSF; non-birds → GBIF taxon / iNaturalist subspecies page e.g. 'Falco peregrinus ernesti' — only if identified from visible field marks; null if indistinguishable; 'monotypic' if species has no described subspecies"
  },
  "confidenceLevels": {
    "family": "fill from authoritative sources — your calibrated confidence (0.0–1.0) at family level: birds → eBird/IOC; non-birds → GBIF / iNaturalist taxon data",
    "genus": "fill from authoritative sources — your calibrated confidence (0.0–1.0) at genus level: birds → eBird/IOC; non-birds → GBIF / iNaturalist taxon data",
    "species": "fill from authoritative sources — your calibrated confidence (0.0–1.0) at species level: birds → eBird species account / field guide; non-birds → GBIF taxon page / iNaturalist taxon page / field guide",
    "subspecies": "fill from authoritative sources — your calibrated confidence (0.0–1.0) at subspecies level: birds → eBird ISSF; non-birds → GBIF / iNaturalist subspecies accounts; 0.0 if subspecies is null"
  },
  "similarSpeciesRuledOut": [
    "Accepted species name (birds → eBird/IOC; non-birds → GBIF/iNaturalist) — exact diagnostic field mark from authoritative species account that eliminates it",
    "Accepted species name (birds → eBird/IOC; non-birds → GBIF/iNaturalist) — exact diagnostic field mark from authoritative species account that eliminates it"
  ],
  "identificationReasoning": "Step-by-step: field marks observed → candidates considered → why each was eliminated (citing: birds → eBird/GBIF/field guides; non-birds → GBIF taxon page/iNaturalist taxon page/field guides) → why chosen species fits based on authoritative species descriptions. REQUIRED if subspecies is non-null: (1) state LT code, (2) list the Stage 3 per-candidate expected profiles, (3) state each Stage 4 elimination result, (4) state the net MATCH/MISMATCH score per live candidate.",
  "subspeciesLTCode": "The lighting code (e.g. LT-1, LT-2, LT-10) assigned in Step 1 IMAGE QUALITY ANALYSIS → Condition 1 for the best-lit photo used in subspecies determination. Required whenever taxonomy.subspecies is non-null — null otherwise.",
  "subspeciesEliminationTrace": "One line per Stage 1 candidate: 'ELIMINATED — [character]: expected [X], observed [Y]' OR 'LIVE — [character]: expected [X], consistent with observed [Y]'. Required whenever taxonomy.subspecies is non-null — null otherwise.",
  "sceneDescription": "fill from authoritative sources — visual summary of the scene and habitat context visible in the image, cross-referenced with known habitat preferences: birds → eBird Maps & Habitat, Birds of the World; non-birds → GBIF occurrence maps, iNaturalist Observations tab",
  "detectedAnimals": [
    {
      "label": "fill from authoritative sources — accepted common name: birds → eBird/IOC; non-birds → GBIF taxon page or iNaturalist taxon page e.g. 'Rufous-backed Dwarf-Kingfisher'; never invent or paraphrase",
      "confidence": "fill from authoritative sources — your calibrated detection confidence (0.0–1.0) based on visible diagnostic features matched against authoritative species accounts",
      "bbox": { "x": 0.12, "y": 0.24, "width": 0.38, "height": 0.44 }
    }
  ],
  "sex": "Male/Female/Unknown — determined from species-specific sexual dimorphism features: birds → eBird/field guide; non-birds → GBIF taxon descriptions / iNaturalist taxon page / field guide",
  "sexConfidence": "fill from authoritative sources — your calibrated confidence (0.0–1.0) in the sex determination, based on visibility and distinctness of sex-diagnostic features per authoritative species account; 0.0 if sex is Unknown",
  "sexMethod": "from_image_plumage (diagnostic plumage features per authoritative account clearly visible) / from_species_knowledge (features partially visible but consistent with authoritative descriptions) / inferred (consistent with documented patterns for this species) / unknown",
  "lifeStage": "Adult/Juvenile/Immature/Unknown — from plumage features per authoritative species accounts; choose exactly one; never combine as Juvenile/Immature",
  "morph": "named colour morph from authoritative species account (e.g. 'dark morph', 'pale morph'); null if species has no described morphs",
  "breedingPlumage": "Yes/No/Unknown — from authoritative species account; set Yes only if the individual visibly shows documented breeding/nuptial plumage features (elongated feathers, vivid colours, ornamental crests/streamers)",
  "sexualDimorphism": "From authoritative sources (birds → eBird account / Birds of the World; non-birds → GBIF taxon page / iNaturalist taxon page / field guide): one or two sentences on how male and female differ — key diagnostic features: plumage/colour, bill, eye colour, facial pattern, crest, tail length, size. Set to null if species is sexually monomorphic per authoritative references.",
  "plumageNotes": "From authoritative species account: describe the plumage features visible in this photo and what they indicate about the sex, age class, and season. Reference specific feather tracts, colours, or markings and cross-check against documented plumage sequences.",
  "viewAngle": "fill from authoritative sources — angle as observed in image (Side View/Front View/Back View/Three-Quarter View/Overhead/In Flight/Unknown); note which diagnostic field marks are hidden or visible at this angle per authoritative species account",
  "migratoryStatus": "fill from authoritative sources for the PROVIDED LOCATION and current month, or Singapore if no location given: Resident/Winter Visitor/Summer Visitor/Passage Migrant/Vagrant. Birds → eBird occurrence maps / Birds of the World; Non-birds → GBIF occurrence maps / iNaturalist Observations tab for seasonal pattern; never guess",
  "activityPattern": "fill from authoritative sources — Diurnal/Nocturnal/Crepuscular/Cathemeral/Fossorial: birds → eBird/Birds of the World Behaviour; reptiles/amphibians → GBIF/AmphibiaWeb/Reptile Database; mammals → MSW/IUCN; others → GBIF/iNaturalist taxon page. Also note if observation time concordance is Expected or Unexpected (e.g. nocturnal species under torchlight at night = Expected; nocturnal species in bright midday sun = Unexpected ⚠ — flag in identificationReasoning)",
  "iucnStatus": {
    "global": "fill from authoritative sources — IUCN Red List (all groups) + GBIF taxon page + iNaturalist taxon page: LC/NT/VU/EN/CR/EW/EX/DD/NE; use the most recent published assessment; never guess",
    "local": "fill from authoritative sources — from the authoritative local red list for the PROVIDED COUNTRY, or Singapore Red List / Singapore Bird Group checklist (birds) / Nature Society Singapore species lists (non-birds) if no country given; null only if no authoritative local assessment exists for that country"
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
- Location and season inform WHICH subspecies/species are possible candidates (Stage 1 geographic filter) — they do NOT favour any one candidate over another.
- A resident subspecies and a migrant subspecies must both be proven from visible field marks. Residency is NOT evidence — it does not lower the identification threshold for the resident taxon.
- Geographic location and season NEVER override visual evidence. If the image characters match a migrant subspecies, commit to the migrant. If no subspecies can be confirmed from the image characters alone, set subspecies to null.`;
  }

  if (options.habitat) {
    prompt += `\n\nHabitat: ${options.habitat}`;
  }

  if (options.additionalNotes) {
    prompt += `\n\nAdditional notes: ${options.additionalNotes}`;
  }

  if (options.isCompressed) {
    prompt += `\n\n⚠️ IMAGE QUALITY NOTE:
This image was transmitted through Telegram's photo compression pipeline and has been upscaled with sharpening to restore detail. Fine plumage marks, bare-part colours, and thin markings may be less distinct than in the original photo.
- DO NOT return null for subspecies simply because detail is reduced — examine every visible mark as carefully as possible.
- If you can narrow down to 1-2 subspecies candidates from partial evidence, commit to the most likely one and state your confidence.
- Only return null for subspecies if the distinguishing marks are genuinely invisible or ambiguous even after careful examination.
- Apply extra weight to structural marks (malar stripe width, supercilium presence/absence, tail length, size) which survive compression better than fine feather texture.`;
  }

  let lastError = null;
  const candidateModels = MODELS.filter((m) => !unavailableModels.has(m.name));

  logger.info('[geminiService] identifyAnimal starting', {
    configuredModel: process.env.GEMINI_MODEL || null,
    effectiveModels: candidateModels.map((m) => m.name),
    thinkingEnabled: THINKING_ENABLED,
  });

  if (!candidateModels.length) {
    logger.error('[geminiService] no candidate models available', { configuredModel: process.env.GEMINI_MODEL });
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
          setTimeout(() => reject(new Error('Timeout after 60s')), 60000)
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

        // ── Full Gemini result logged to console for debugging ─────────────────
        console.log(`\n===== ${modelInfo.displayName} FULL RESPONSE =====`);
        console.log(JSON.stringify(data, null, 2));
        console.log('=====END=====\n');

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

        if (isQuota) {
          // Quota errors are unrecoverable until the quota resets.
          logger.error('[geminiService] quota exhausted during identification', { model: modelInfo.name, error: error.message });
          lastError = error;
          break; // stop retries and go next model / final fail
        }

        if (isTimeout && attempt < 3) {
          const wait = 2000;
          logger.warn(`Timeout — retrying ${modelInfo.displayName} in ${wait / 1000}s`);
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
