/**
 * SheetWatcher
 *
 * Polls every watched Google Sheets range on a fixed interval.
 * When the row count changes it emits a `sheet:update` Socket.IO event
 * with the full updated rows so the frontend can re-render without a manual refresh.
 *
 * Event payload: { range: string, rows: string[][] }
 */

const logger = require('../../../src/utils/logger');

const POLL_INTERVAL_MS = 15_000; // 15 seconds

// Must match the ranges used in the frontend Admin page
const WATCHED_RANGES = [
  { id: 'telegram',               range: 'Telegram!A1:G5000' },
  { id: 'sessions',               range: 'Sessions!A1:N5000' },
  { id: 'animal-identification',  range: 'Animal Identification!A1:P5000' },
  { id: 'bird-sightings',         range: 'Bird Sightings!A1:W5000' },
];

class SheetWatcher {
  constructor(sheetsService, io) {
    this._sheets = sheetsService;
    this._io = io;
    this._snapshots = {}; // range -> last row count
    this._timer = null;
  }

  start() {
    logger.info('[sheetWatcher] starting — polling every ' + POLL_INTERVAL_MS / 1000 + 's');
    // No immediate poll: first interval tick silently populates snapshots (prev===undefined
    // so no spurious emit), subsequent ticks detect row-count changes as normal.
    this._timer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _poll() {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!spreadsheetId) return;

    for (const watched of WATCHED_RANGES) {
      try {
        const rows = await this._sheets.getRows(spreadsheetId, watched.range);
        const prev = this._snapshots[watched.range];
        const current = rows.length;

        if (prev !== undefined && current !== prev) {
          logger.debug(`[sheetWatcher] ${watched.id}: ${prev} -> ${current} rows — emitting sheet:update`);
          this._io.emit('sheet:update', { range: watched.range, rows });
        }

        this._snapshots[watched.range] = current;
      } catch (err) {
        logger.warn(`[sheetWatcher] error polling ${watched.id}: ${err.message}`);
      }
    }
  }
}

module.exports = { SheetWatcher };
