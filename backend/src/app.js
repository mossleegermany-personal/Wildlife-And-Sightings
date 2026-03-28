const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const logger = require('./utils/logger');
const { generalLimiter } = require('./middleware/rateLimiter');
const errorHandler = require('./middleware/errorHandler');
const apiRoutes = require('./routes');

const app = express();

// ── Security & parsing ────────────────────────────────────────────────────────
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ── Logging ───────────────────────────────────────────────────────────────────
const morganFormat = process.env.WEBSITE_HOSTNAME ? 'combined' : 'dev';
app.use(morgan(morganFormat, {
  stream: { write: (msg) => logger.http(msg.trim()) },
}));

// ── Rate limiting (apply broadly; identify routes add their own on top) ───────
app.use(generalLimiter);

// ── Health / info ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (_req, res) => {
  res.json({
    name: 'Wildlife Sightings API',
    version: '1.0.0',
    bots: {
      animalIdentification: {
        identify: 'POST /api/v1/identify',
        identifyUrl: 'POST /api/v1/identify/url',
      },
      birdSighting: {
        sightingsNearby: 'POST /api/v1/sightings/nearby',
        sightingsByRegion: 'POST /api/v1/sightings/region',
        notableSightings: 'POST /api/v1/sightings/notable',
        speciesSightings: 'POST /api/v1/sightings/species',
        hotspotsNearby: 'POST /api/v1/hotspots/nearby',
        hotspotsByRegion: 'POST /api/v1/hotspots/region',
        hotspotObservations: 'POST /api/v1/hotspots/observations',
        speciesSearch: 'POST /api/v1/species/search',
        speciesObservations: 'POST /api/v1/species/observations',
      },
      googleSheets: {
        appendSighting: 'POST /api/v1/sheets/sightings',
        getSightings: 'POST /api/v1/sheets/sightings/list',
        appendIdentification: 'POST /api/v1/sheets/identifications',
        getIdentifications: 'POST /api/v1/sheets/identifications/list',
        appendRow: 'POST /api/v1/sheets/append',
        readRows: 'POST /api/v1/sheets/read',
      },
    },
  });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/v1', apiRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler (must be last) ───────────────────────────────────────
app.use(errorHandler);

module.exports = app;
