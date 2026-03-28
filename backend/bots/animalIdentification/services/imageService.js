/**
 * Image Service — Composite identification result image
 *
 * Ported from Animal-Identification-Bot.
 * Creates a 800×400 composite: the species photo on the left and a dark
 * info panel on the right with the key identification details.
 */
const sharp = require('sharp');
const logger = require('../../../src/utils/logger');

const PANEL_WIDTH = 400;
const IMAGE_HEIGHT = 400;
const COMPOSITE_WIDTH = PANEL_WIDTH * 2;
const FONT_FAMILY = "'Noto Sans CJK SC','Noto Sans CJK TC','Microsoft YaHei','PingFang SC','Hiragino Sans GB','WenQuanYi Zen Hei','Arial Unicode MS','DejaVu Sans',sans-serif";
const ASCII_FALLBACK_ENABLED = process.env.IMAGE_PANEL_ASCII_FALLBACK === 'true' || Boolean(process.env.WEBSITE_HOSTNAME);

/** IUCN status colours used in the badge. */
const IUCN_COLORS = {
  'Extinct': '#000000',
  'Extinct in the Wild': '#542344',
  'Critically Endangered': '#CC0000',
  'Endangered': '#CC6600',
  'Vulnerable': '#CCCC00',
  'Near Threatened': '#669900',
  'Least Concern': '#339900',
  'Data Deficient': '#999999',
  'Not Evaluated': '#666666',
};

function getIUCNColor(status) {
  return IUCN_COLORS[status] || '#666666';
}

/** Safely truncate a string for SVG display. */
function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function hasNonAscii(str) {
  return /[^\x00-\x7F]/.test(String(str || ''));
}

function renderSafeText(text, fallback = '') {
  const value = String(text || '').trim();
  if (!value) return String(fallback || '').trim();
  if (ASCII_FALLBACK_ENABLED && hasNonAscii(value) && fallback) {
    return String(fallback).trim();
  }
  return value;
}

/**
 * Create a composite image buffer for an identification result.
 *
 * @param {string} photoUrl  - URL of the species reference photo
 * @param {object} data       - Identification data from geminiService / verifiers
 * @returns {Promise<Buffer|null>}
 */
async function createCompositeImage(photoUrl, data) {
  try {
    // Fetch the reference photo
    const response = await fetch(photoUrl);
    if (!response.ok) {
      logger.warn('Could not fetch species photo for composite', { url: photoUrl, status: response.status });
      return null;
    }
    const photoBuffer = Buffer.from(await response.arrayBuffer());

    // Resize the photo to fill the left panel
    const photoResized = await sharp(photoBuffer)
      .resize(PANEL_WIDTH, IMAGE_HEIGHT, { fit: 'cover', position: 'centre' })
      .toBuffer();

    // Build info panel as SVG
    const infoPanelSvg = buildInfoPanelSvg(data);

    const infoPanelBuffer = await sharp(
      Buffer.from(`<svg width="${PANEL_WIDTH}" height="${IMAGE_HEIGHT}">${infoPanelSvg}</svg>`)
    )
      .png()
      .toBuffer();

    // Composite side-by-side
    const composite = await sharp({
      create: {
        width: COMPOSITE_WIDTH,
        height: IMAGE_HEIGHT,
        channels: 3,
        background: { r: 34, g: 34, b: 34 },
      },
    })
      .composite([
        { input: photoResized, left: 0, top: 0 },
        { input: infoPanelBuffer, left: PANEL_WIDTH, top: 0 },
      ])
      .jpeg({ quality: 85 })
      .toBuffer();

    return composite;
  } catch (err) {
    logger.error('Failed to create composite image', { error: err.message });
    return null;
  }
}

function buildInfoPanelSvg(data) {
  const commonName = truncate(renderSafeText(data.commonName || data.common_name, data.scientificName || data.scientific_name || 'Unknown'), 28);
  const sciName = truncate(
    renderSafeText(data.scientificName || data.scientific_name || '', ''),
    32
  );
  const iucnStatus = data.iucnStatus || data.iucn_status || 'Not Evaluated';
  const iucnColor = getIUCNColor(iucnStatus);
  const sex = data.sex || '';
  const lifeStage = data.lifeStage || data.life_stage || '';
  const morph = data.morph || '';
  const accuracy = data.accuracy || data.identificationAccuracy || '';
  const country = truncate(renderSafeText(data.country || '', ''), 30);

  const badges = [];
  if (sex && sex !== 'Unknown') badges.push(sex);
  if (lifeStage && lifeStage !== 'Unknown' && lifeStage !== 'Adult') badges.push(lifeStage);
  if (morph && morph !== 'None' && morph !== 'N/A') badges.push(morph);

  let badgesSvg = '';
  let bx = 20;
  const by = 340;
  for (const badge of badges.slice(0, 3)) {
    const bw = badge.length * 8 + 16;
    badgesSvg += `
      <rect x="${bx}" y="${by}" width="${bw}" height="24" rx="12" fill="#444" />
      <text x="${bx + bw / 2}" y="${by + 16}" font-size="12" fill="#ddd" text-anchor="middle" font-family="${FONT_FAMILY}">${renderSafeText(badge, '')}</text>`;
    bx += bw + 8;
  }

  let accuracySvg = '';
  if (accuracy) {
    const pct = parseFloat(accuracy) || 0;
    const barW = Math.round((pct / 100) * (PANEL_WIDTH - 40));
    accuracySvg = `
        <text x="20" y="298" font-size="12" fill="#888" font-family="${FONT_FAMILY}">Confidence</text>
      <rect x="20" y="308" width="${PANEL_WIDTH - 40}" height="8" rx="4" fill="#333" />
      <rect x="20" y="308" width="${barW}" height="8" rx="4" fill="${iucnColor}" />
        <text x="${PANEL_WIDTH - 20}" y="318" font-size="12" fill="#aaa" text-anchor="end" font-family="${FONT_FAMILY}">${Math.round(pct)}%</text>`;
  }

  return `
    <rect width="${PANEL_WIDTH}" height="${IMAGE_HEIGHT}" fill="#1c1c1c" />
    <!-- Header bar -->
    <rect width="${PANEL_WIDTH}" height="6" fill="${iucnColor}" />
    <!-- Common name -->
    <text x="20" y="50" font-size="22" fill="#f0f0f0" font-weight="bold" font-family="${FONT_FAMILY}">${escSvg(commonName)}</text>
    <!-- Scientific name -->
    <text x="20" y="76" font-size="14" fill="#aaa" font-style="italic" font-family="${FONT_FAMILY}">${escSvg(sciName)}</text>
    <!-- Divider -->
    <line x1="20" y1="92" x2="${PANEL_WIDTH - 20}" y2="92" stroke="#333" stroke-width="1" />
    <!-- IUCN status -->
    <rect x="20" y="106" width="120" height="28" rx="6" fill="${iucnColor}33" />
    <rect x="20" y="106" width="4" height="28" rx="2" fill="${iucnColor}" />
    <text x="32" y="125" font-size="12" fill="${iucnColor}" font-weight="bold" font-family="${FONT_FAMILY}">${escSvg(renderSafeText(iucnStatus, 'Not Evaluated'))}</text>
    <!-- Country -->
    ${country ? `<text x="20" y="162" font-size="13" fill="#bbb" font-family="${FONT_FAMILY}">Location: ${escSvg(country)}</text>` : ''}
    <!-- Accuracy bar -->
    ${accuracySvg}
    <!-- Badges -->
    ${badgesSvg}
    <!-- Footer -->
    <text x="${PANEL_WIDTH / 2}" y="${IMAGE_HEIGHT - 12}" font-size="11" fill="#555" text-anchor="middle" font-family="${FONT_FAMILY}">Wildlife Sightings API</text>
  `;
}

function escSvg(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── IUCN code → human label + color ─────────────────────────────────────────
const IUCN_CODE_MAP = {
  EX: { label: 'Extinct',               color: '#6d28d9' },
  EW: { label: 'Extinct in the Wild',   color: '#7c3aed' },
  CR: { label: 'Critically Endangered', color: '#dc2626' },
  EN: { label: 'Endangered',            color: '#ea580c' },
  VU: { label: 'Vulnerable',            color: '#d97706' },
  NT: { label: 'Near Threatened',       color: '#65a30d' },
  LC: { label: 'Least Concern',         color: '#16a34a' },
  DD: { label: 'Data Deficient',        color: '#64748b' },
  NE: { label: 'Not Evaluated',         color: '#475569' },
};

function resolveIucn(raw) {
  const val = typeof raw === 'object' ? (raw?.global || raw?.local || '') : (raw || '');
  const byCode = IUCN_CODE_MAP[val.trim().toUpperCase()];
  if (byCode) return byCode;
  // try full-name match from original map
  const color = getIUCNColor(val) || '#475569';
  return { label: val || 'Not Evaluated', color };
}

/** Strip status code suffixes like "(PM)", "(RB)", "PM - description", etc. */
function cleanBadgeLabel(label) {
  return String(label || '')
    .replace(/\s*\([A-Za-z]{1,5}\)\s*$/, '')   // trailing (CODE)
    .replace(/\s*-\s*.+$/, '')                   // " - anything after dash"
    .trim();
}

function wordWrap(text, maxChars) {
  const words = String(text || '').split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars) { cur = next; }
    else { if (cur) lines.push(cur); cur = w.slice(0, maxChars); }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Create a result canvas: reference species photo on the left (from iNaturalist),
 * identification panel on the right.
 *
 * @param {string|null} refPhotoUrl  - species reference photo URL (null = use userBuffer)
 * @param {Buffer}      userBuffer   - fallback: user's submitted photo
 * @param {Object}      data         - identification result from geminiService
 * @returns {Promise<Buffer|null>}
 */
async function createResultCanvas(refPhotoUrl, userBuffer, data) {
  const W = 1200, H = 600, HALF = 600;
  try {
    let leftBuffer = null;
    if (refPhotoUrl) {
      try {
        const resp = await fetch(refPhotoUrl);
        if (resp.ok) leftBuffer = Buffer.from(await resp.arrayBuffer());
      } catch { /* fall through to user photo */ }
    }
    if (!leftBuffer) leftBuffer = userBuffer;

    const leftImg = await sharp(leftBuffer)
      .resize(HALF, H, {
        fit: 'contain',
        position: 'centre',
        background: { r: 0, g: 0, b: 0 },
      })
      .toBuffer();

    const rightImg = await sharp(Buffer.from(buildResultPanel(data, HALF, H)))
      .png()
      .toBuffer();

    return await sharp({
      create: { width: W, height: H, channels: 3, background: { r: 15, g: 23, b: 42 } },
    })
      .composite([
        { input: leftImg,  left: 0,    top: 0 },
        { input: rightImg, left: HALF, top: 0 },
      ])
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (err) {
    logger.error('createResultCanvas failed', { error: err.message });
    return null;
  }
}

function buildResultPanel(data, W, H) {
    // ...existing code...
  const tax    = data.taxonomy || {};
  const subspRaw = tax.subspecies;
  const subsp  = (subspRaw && subspRaw !== 'null' && subspRaw !== 'monotypic') ? subspRaw : '';

  const iucn     = resolveIucn(data.iucnStatus);
  const migratory = (data.migratoryStatus && data.migratoryStatus !== 'null' && data.migratoryStatus !== 'Resident') ? data.migratoryStatus : '';
  const sexVal = data.sex || '';
  const lifeStageVal = data.lifeStage || data.life_stage || '';
  const morphVal = data.morph || '';
  const breedingPlumageVal = data.breedingPlumage || data.breeding_plumage || '';

  // ── Header badges — only show when the value is meaningful ──────────────────
  const headerBadges = [];
  const _skip = (v) => !v || ['Unknown', 'unknown', 'None', 'N/A', 'null', '-', ''].includes(String(v).trim());

  // 1. Local Status
  if (!_skip(data.localStatus)) {
    headerBadges.push({ label: renderSafeText(cleanBadgeLabel(data.localStatus), data.localStatusCode || ''), color: '#38bdf8' });
  }
  // 2. IUCN Conservation Status (hide Not Evaluated / NE)
  const _iucnSkip = ['Not Evaluated', 'NE', 'Unknown', '-', ''];
  if (iucn.label && !_iucnSkip.includes(iucn.label.trim())) {
    headerBadges.push({ label: cleanBadgeLabel(iucn.label), color: '#22c55e' });
  }
  // 3. Sex
  if (!_skip(sexVal) && sexVal !== 'Unknown') {
    let sexLabel = cleanBadgeLabel(sexVal);
    if (sexVal.toLowerCase() === 'male') sexLabel += ' (M)';
    else if (sexVal.toLowerCase() === 'female') sexLabel += ' (F)';
    headerBadges.push({ label: sexLabel, color: '#a78bfa' });
  }
  // 4. Life Stage
  if (!_skip(lifeStageVal)) {
    headerBadges.push({ label: cleanBadgeLabel(lifeStageVal), color: '#fb923c' });
  }
  // 5. Breeding Plumage
  if (data.breedingPlumage && data.breedingPlumage.toLowerCase() === 'yes') {
    headerBadges.push({ label: 'Breeding Plumage', color: '#34d399' });
  }
  // 6. Morph
  if (!_skip(morphVal)) {
    headerBadges.push({ label: cleanBadgeLabel(morphVal), color: '#f472b6' });
  }
  // 7. Migratory Status (skip Resident — it adds no info)
  // if (!_skip(data.migratoryStatus) && !['Resident', 'resident'].includes(String(data.migratoryStatus).trim())) {
  //   headerBadges.push({ label: data.migratoryStatus, color: '#38bdf8' });
  // }
  // Render as grid: max 2 per row
  let headerBadgesSvg = '';
  if (headerBadges.length > 0) {
    const leftX = 16;
    const rightX = Math.floor(W / 2) + 4;
    const rowTop = 56;
    const rowGap = 40; // Increased gap for more space between badge rows
    const badgeW = Math.floor((W - 16 - 16 - 8) / 2);
    headerBadges.forEach((badge, idx) => {
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      const bx = col === 0 ? leftX : rightX;
      const by = rowTop + row * rowGap;
      const text = truncate(badge.label, 48);
      headerBadgesSvg += `
        <rect x="${bx}" y="${by}" width="${badgeW}" height="26" rx="13" fill="${badge.color}1a" stroke="${badge.color}" stroke-width="1.2"/>
        <text x="${bx + badgeW / 2}" y="${by + 17}" font-size="12" fill="${badge.color}" text-anchor="middle" font-family="${FONT_FAMILY}" font-weight="600">${escSvg(renderSafeText(text, 'N/A'))}</text>`;
    });
  }

  // Compose headerSvg for legacy code compatibility
  const headerSvg = headerBadgesSvg;

  // ── Names — word-wrap, no truncation ──────────────────────────────────────
  const commonLines = wordWrap(renderSafeText(data.commonName || 'Unknown', data.scientificName || 'Unknown'), 26).slice(0, 2);
  const sciLines    = wordWrap(renderSafeText(data.scientificName || '', ''), 36).slice(0, 2);

  // Dynamically calculate curY based on header badge rows to avoid overlap
  let curY;
  if (headerBadges.length > 0) {
    // Each row is 40px tall, starts at 56, so bottom = 56 + (rows-1)*40 + 26 (badge height)
    const badgeRows = Math.ceil(headerBadges.length / 2);
    curY = 56 + (badgeRows - 1) * 40 + 26 + 70; // 70px extra gap after badges for even more separation
  } else {
    curY = 120;
  }
  let nameSvg = '';
  commonLines.forEach(line => {
    nameSvg += `<text x="16" y="${curY}" font-size="30" fill="#f8fafc" font-weight="bold" font-family="${FONT_FAMILY}">${escSvg(line)}</text>`;
    curY += 38;
  });
  curY += 6;
  sciLines.forEach(line => {
    nameSvg += `<text x="16" y="${curY}" font-size="18" fill="#7dd3fc" font-style="italic" font-family="${FONT_FAMILY}">${escSvg(line)}</text>`;
    curY += 26;
  });
  // eBird Identifiable Sub-specific Groups (ISSF) — shown when confirmed from image or derived from location
  if (data.subspecies && Array.isArray(data.subspecies) && data.subspecies.length > 0 && (data.subspeciesFromImage || data.subspeciesByLocation)) {
    curY += 6;
    const subspLabel = data.subspeciesFromImage ? 'Subspecies (from image):' : `Subspecies (${data.subspeciesLocation || 'location'}):`;
    nameSvg += `<text x="16" y="${curY}" font-size="13" fill="#94a3b8" font-family="${FONT_FAMILY}">${escSvg(renderSafeText(subspLabel, 'Subspecies:'))}</text>`;
    curY += 20;
    for (const grp of data.subspecies.slice(0, 6)) {
      // Trinomial e.g. "Falco peregrinus ernesti" → show only "ernesti"
      const parts = (grp || '').trim().split(/\s+/);
      const epithet = parts.length >= 3 ? parts.slice(2).join(' ') : grp;
      nameSvg += `<text x="24" y="${curY}" font-size="13" fill="#86efac" font-style="italic" font-family="${FONT_FAMILY}">- ${escSvg(renderSafeText(epithet, 'subspecies'))}</text>`;
      curY += 18;
    }
  }

  // No morph or breeding plumage in body, only as header badges
  let detailsSvg = '';

  let infoSvg = '';

  // Footer: eBird sightings count for this species at the user location
  let ebirdSightingsFooter = '';
  const loc = renderSafeText(data.ebirdSightingsLocation || 'Singapore', data.country || 'Singapore');
  if (typeof data.ebirdSightingsCount === 'number' && data.ebirdSightingsCount >= 0) {
    ebirdSightingsFooter = `<text x="${W / 2}" y="${H - 42}" font-size="32" fill="#facc15" text-anchor="middle" font-family="${FONT_FAMILY}" font-weight="bold">No. of Sightings (${escSvg(loc)}): ${data.ebirdSightingsCount}</text>`;
  } else {
    ebirdSightingsFooter = `<text x="${W / 2}" y="${H - 42}" font-size="32" fill="#facc15" text-anchor="middle" font-family="${FONT_FAMILY}" font-weight="bold">No. of Sightings (${escSvg(loc)}): N/A</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#000000"/>
    ${headerSvg}
    ${headerBadgesSvg}
    ${nameSvg}
    ${detailsSvg}
    ${infoSvg}
    ${ebirdSightingsFooter}
  </svg>`;
}

module.exports = { createCompositeImage, createResultCanvas };
