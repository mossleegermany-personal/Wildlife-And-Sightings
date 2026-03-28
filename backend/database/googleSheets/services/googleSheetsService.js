/**
 * Google Sheets Service
 *
 * Reads and writes to Google Spreadsheets using a Service Account.
 * Stores Telegram file_ids for input photos and output canvases.
 *
 * Required env vars:
 *   GOOGLE_SHEETS_CLIENT_EMAIL       service account email
 *   GOOGLE_SHEETS_PRIVATE_KEY        PEM key (literal \n or real newlines)
 *   GOOGLE_SHEETS_SPREADSHEET_ID     default spreadsheet ID
 */
const { google } = require('googleapis');
const logger = require('../../../src/utils/logger');

const SHEET_NAME = 'Animal Identification';
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
];

function getSingaporeDateTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    date: `${map.day}/${map.month}/${map.year}`,
    time: `${map.hour}:${map.minute}:${map.second} hrs`,
  };
}

class GoogleSheetsService {
  constructor() {
    this._auth = null;
    this._sheets = null;
  }

  /** Lazy-initialize JWT auth from environment variables. */
  _getAuth() {
    if (this._auth) return this._auth;

    const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
    const privateKey = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');

    if (!clientEmail || !privateKey) {
      throw new Error(
        'Google Sheets credentials not configured. ' +
          'Set GOOGLE_SHEETS_CLIENT_EMAIL and GOOGLE_SHEETS_PRIVATE_KEY in your .env file.'
      );
    }

    this._auth = new google.auth.JWT({
      email: clientEmail,
      key: privateKey,
      scopes: SCOPES,
    });

    return this._auth;
  }

  _getSheets() {
    if (this._sheets) return this._sheets;
    this._sheets = google.sheets({ version: 'v4', auth: this._getAuth() });
    return this._sheets;
  }


  /**
   * Read the next available serial number from the Animal Identification sheet.
   * @returns {Promise<number>}
   */
  async getNextSerialNumber() {
    try {
      const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
      const rows = await this.getRows(id, `${SHEET_NAME}!A:A`);
      const dataRows = rows.slice(1).filter(r => r[0] && !isNaN(parseInt(r[0])));
      if (dataRows.length === 0) return 1;
      return Math.max(...dataRows.map(r => parseInt(r[0]))) + 1;
    } catch {
      return 1;
    }
  }

  /**
   * Log an animal identification event to the "Animal Identification" sheet.
    * Columns: S/N | Chat Id | Session Id | User Name | Display Name | Platform | Date | Time | Country | Species | Image
   *
    * @param {{ user: object, species: string|null, canvasFileId: string|null, country: string|null, chatId: number|string|null, sessionId: string|null, chatType?: string, channelName?: string }} params
   */
    async logAnimalIdentification({ user, species, canvasFileId, country, chatId, sessionId, chatType, channelName }) {
    const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id) { logger.warn('GOOGLE_SHEETS_SPREADSHEET_ID not set — skipping log'); return; }

    const sn = await this.getNextSerialNumber();

    const { date, time } = getSingaporeDateTimeParts(new Date());

    const personDisplayName = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
    const normalizedChatType = String(chatType || '').trim().toLowerCase();
    const isPrivate = normalizedChatType === 'private';
    const displayName = isPrivate
      ? (personDisplayName || 'Unknown')
      : String(channelName || '').trim();
    const userName = user?.username ? `@${user.username}` : '';

    const row = [
      sn,
      chatId != null ? String(chatId) : '',
      sessionId || '',
      userName,
      displayName || 'Unknown',
      'Telegram',
      date,
      time,
      country || '',
      species || '',
      canvasFileId || '',
    ];
    const appendRes = await this.appendRow(id, `${SHEET_NAME}!A:K`, row);

    // Clear bold formatting from the newly appended data row
    try {
      const updatedRange = appendRes?.updates?.updatedRange || '';
      const rowMatch = updatedRange.match(/(\d+):(\d+)$/);
      const rowIndex = rowMatch ? parseInt(rowMatch[1]) - 1 : null;
      if (rowIndex !== null) {
        const sheets = this._getSheets();
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: id,
          requestBody: {
            requests: [
              // Remove bold from all columns
              {
                repeatCell: {
                  range: { sheetId: 0, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: 11 },
                  cell: { userEnteredFormat: { textFormat: { bold: false } } },
                  fields: 'userEnteredFormat.textFormat.bold',
                },
              },
              // Force column E (Time) to 24-hour HH:mm display
              {
                repeatCell: {
                  range: { sheetId: 0, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 7, endColumnIndex: 8 },
                  cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } },
                  fields: 'userEnteredFormat.numberFormat',
                },
              },
            ],
          },
        });
      }
    } catch { /* formatting is best-effort, never block the log */ }

    logger.debug('Logged identification to Google Sheets', { sn, userName, displayName, chatId, sessionId, chatType: normalizedChatType });
  }

  /**
   * Append a single row to a sheet range.
   * @param {string} spreadsheetId
   * @param {string} range   e.g. 'Sightings!A:K'
   * @param {Array}  values  Row values
   */
  async appendRow(spreadsheetId, range, values) {
    const sheets = this._getSheets();
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });
    logger.debug('Appended row to Google Sheets', { spreadsheetId, range });
    return response.data;
  }

  /**
   * Read rows from a sheet range.
   * @param {string} spreadsheetId
   * @param {string} range   e.g. 'Sightings!A1:K200'
   * @returns {Promise<Array[]>}
   */
  async getRows(spreadsheetId, range) {
    const sheets = this._getSheets();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return response.data.values || [];
  }

  /**
   * Log a bird sighting to the Sightings sheet.
   * Expected columns: Timestamp | CommonName | SciName | RegionCode | Location |
   *   Lat | Lng | ObsDate | Count | Notes | eBirdUrl
   */
  async appendSighting(data, spreadsheetId) {
    const id = spreadsheetId || process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id) throw new Error('No spreadsheet ID provided and GOOGLE_SHEETS_SPREADSHEET_ID is not set.');

    const row = [
      new Date().toISOString(),
      data.commonName || '',
      data.scientificName || '',
      data.regionCode || '',
      data.location || '',
      data.lat != null ? String(data.lat) : '',
      data.lng != null ? String(data.lng) : '',
      data.observationDate || '',
      data.count != null ? String(data.count) : '',
      data.notes || '',
      data.ebirdUrl || '',
    ];

    return this.appendRow(id, 'Sightings!A:K', row);
  }

  /**
   * Log an identification result to the Identifications sheet.
   * Expected columns: Timestamp | CommonName | SciName | IUCNStatus | Accuracy |
   *   Location | GBIFVerified | eBirdVerified | ReferencePhoto | Model
   */
  async appendIdentification(data, spreadsheetId) {
    const id = spreadsheetId || process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id) throw new Error('No spreadsheet ID provided and GOOGLE_SHEETS_SPREADSHEET_ID is not set.');

    const row = [
      new Date().toISOString(),
      data.commonName || '',
      data.scientificName || '',
      data.iucnStatus || '',
      data.accuracy != null ? String(data.accuracy) : '',
      data.location || '',
      data.gbifVerified ? 'Yes' : 'No',
      data.ebirdVerified ? 'Yes' : 'No',
      data.referencePhotoUrl || data.referencePhoto?.url || '',
      data.model || '',
    ];

    return this.appendRow(id, 'Identifications!A:J', row);
  }

  /** Read all sightings rows.  @param {string} [spreadsheetId]  @param {string} [range] */
  async getSightings(spreadsheetId, range) {
    const id = spreadsheetId || process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id) throw new Error('No spreadsheet ID provided.');
    return this.getRows(id, range || 'Sightings!A2:K1000');
  }

  /** Read all identification rows.  @param {string} [spreadsheetId]  @param {string} [range] */
  async getIdentifications(spreadsheetId, range) {
    const id = spreadsheetId || process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id) throw new Error('No spreadsheet ID provided.');
    return this.getRows(id, range || 'Identifications!A2:J1000');
  }

  /**
   * Get the next available serial number for the Sessions sheet.
   * @returns {Promise<number>}
   */
  async getNextSessionSerialNumber() {
    try {
      const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
      const rows = await this.getRows(id, 'Sessions!A:A');
      const dataRows = rows.slice(1).filter(r => r[0] && !isNaN(parseInt(r[0])));
      if (dataRows.length === 0) return 1;
      return Math.max(...dataRows.map(r => parseInt(r[0]))) + 1;
    } catch {
      return 1;
    }
  }

  /**
   * Get next serial number for the "Telegram Group" sheet.
   * @returns {Promise<number>}
   */
  async getNextTelegramGroupSerialNumber() {
    try {
      const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
      const rows = await this.getRows(id, 'Telegram Group!A:A');
      const dataRows = rows.slice(1).filter(r => r[0] && !isNaN(parseInt(r[0])));
      if (dataRows.length === 0) return 1;
      return Math.max(...dataRows.map(r => parseInt(r[0]))) + 1;
    } catch {
      return 1;
    }
  }

  /**
   * Log Telegram /start events to "Telegram Group" sheet.
    * Columns: S/N | Chat Id | Chat Type | Sender | Display Name | Channel Name | Chat Type
   *
    * @param {{ chatId: number|string, chatType: string, sender: string, displayName: string, channelName: string }} data
   */
  async logTelegramGroupStart(data) {
    const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id) {
      logger.warn('GOOGLE_SHEETS_SPREADSHEET_ID not set — skipping Telegram Group log');
      return null;
    }

    const toTitle = (v) => {
      const s = String(v || '').trim();
      if (!s) return 'Private';
      return s.charAt(0).toUpperCase() + s.slice(1);
    };

    const chatType = toTitle(data.chatType);
    const chatTypeLower = String(data.chatType || '').trim().toLowerCase();
    const chatIdValue = data.chatId != null ? String(data.chatId) : '';
    const isPrivate = chatTypeLower === 'private';
    const displayNameValue = isPrivate ? (data.displayName || '') : '';
    const channelNameValue = isPrivate ? '' : (data.channelName || '');

    try {
      // Enforce uniqueness by Chat Id (column B): update existing row when found.
      const rows = await this.getRows(id, 'Telegram Group!A:G');
      const existingIndex = rows.findIndex((r, i) => i > 0 && String(r[1] || '').trim() === chatIdValue);

      if (existingIndex !== -1) {
        const sheetRow = existingIndex + 1; // 1-based row index including header
        const existingSn = rows[existingIndex]?.[0] || '';

        const sheets = this._getSheets();
        await sheets.spreadsheets.values.update({
          spreadsheetId: id,
          range: `Telegram Group!A${sheetRow}:G${sheetRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [[
              existingSn,
              chatIdValue,
              chatType,
              data.sender || 'Unknown',
              displayNameValue,
              channelNameValue,
              `${chatType}`,
            ]],
          },
        });

        logger.debug('Updated existing Telegram Group row by Chat Id', { chatId: chatIdValue, row: sheetRow });
        return Number.parseInt(existingSn, 10) || null;
      }
    } catch (err) {
      logger.warn('Failed to check/update Telegram Group duplicate by Chat Id; falling back to append', { error: err.message, chatId: chatIdValue });
    }

    const sn = await this.getNextTelegramGroupSerialNumber();

    const row = [
      sn,
      chatIdValue,
      chatType,
      data.sender || 'Unknown',
      displayNameValue,
      channelNameValue,
      `${chatType}`,
    ];

    try {
      await this.appendRow(id, 'Telegram Group!A:G', row);
      logger.debug('Logged /start to Telegram Group sheet', { sn, chatId: data.chatId, chatType });
      return sn;
    } catch (err) {
      logger.error('Failed to log Telegram Group /start', { error: err.message });
      return null;
    }
  }

  /**
   * Append a new session row to the "Sessions" sheet with Status = "Active".
    * Columns: S/N | Sub-bot | Session Id | Sender | Display Name | Chat Id | Chat Type | Start Date | Start Time | End Date | End Time | Status
   *
    * @param {{ subBot: string, chatId: number|string, chatTitle: string|null, user: object, chatType: string, startTime: Date }} data
    * @returns {Promise<{sn: number, sessionId: string}|null>} Session row identifiers
   */
  async logSessionStart(data) {
    const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id) { logger.warn('GOOGLE_SHEETS_SPREADSHEET_ID not set — skipping session log'); return null; }

    const sn = await this.getNextSessionSerialNumber();

    const formatDate = (date) => {
      if (!date) return '';
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Singapore',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).formatToParts(date);
      const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
      return `${map.day}/${map.month}/${map.year}`;
    };

    const formatTime = (date) => {
      if (!date) return '';
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Singapore',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(date);
      const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
      return `${map.hour}:${map.minute}:${map.second} hrs`;
    };

    const sender = data.chatTitle
      || (data.user?.username ? `@${data.user.username}` : [data.user?.first_name, data.user?.last_name].filter(Boolean).join(' '))
      || 'Unknown';
    const displayName = [data.user?.first_name, data.user?.last_name].filter(Boolean).join(' ') || '';

    const sessionId = `S-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const chatType = data.chatType
      ? data.chatType.charAt(0).toUpperCase() + data.chatType.slice(1)
      : 'Private';

    const startDt = data.startTime || new Date();
    const row = [
      sn,
      data.subBot || 'Animal Identification',
      sessionId,
      sender,
      displayName,
      data.chatId != null ? String(data.chatId) : '',
      chatType,
      formatDate(startDt),  // Start Date
      formatTime(startDt),  // Start Time
      '',                   // End Date — filled in when session ends
      '',                   // End Time — filled in when session ends
      'Active',
    ];

    try {
      await this.appendRow(id, 'Sessions!A:L', row);
      logger.debug('Logged session start to Google Sheets', { sn, sessionId, chatId: data.chatId, sender });
      return { sn, sessionId };
    } catch (err) {
      logger.error('Failed to log session start', { error: err.message });
      return null;
    }
  }

  /**
   * Update End Time and Status on the Sessions row that matches the given S/N.
   *
   * @param {number} sn       The S/N of the row to update
   * @param {Date}   endTime
   * @param {string} status   e.g. 'Ended'
   */
  async updateSessionEnd(sn, endTime, status) {
    const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id || sn == null) return;

    const formatDate = (date) => {
      if (!date) return '';
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Singapore',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).formatToParts(date);
      const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
      return `${map.day}/${map.month}/${map.year}`;
    };

    const formatTime = (date) => {
      if (!date) return '';
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Singapore',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(date);
      const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
      return `${map.hour}:${map.minute}:${map.second} hrs`;
    };

    try {
      // Find the row index by matching S/N in column A (all rows including header)
      const col = await this.getRows(id, 'Sessions!A:A');
      const rowIndex = col.findIndex((r, i) => i > 0 && parseInt(r[0]) === sn);
      if (rowIndex === -1) {
        logger.warn('updateSessionEnd: row not found for S/N', { sn });
        return;
      }
      const sheetRow = rowIndex + 1; // 1-based sheet row

      const sheets = this._getSheets();
      await sheets.spreadsheets.values.update({
        spreadsheetId: id,
        range: `Sessions!J${sheetRow}:L${sheetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[formatDate(endTime), formatTime(endTime), status || 'Ended']] },
      });
      logger.debug('Updated session end in Google Sheets', { sn, status });
    } catch (err) {
      logger.error('Failed to update session end', { error: err.message });
    }
  }

  /**
   * Get the most recent session row for a context.
    * Match keys: Sub-bot + Sender + Chat Type (+ Chat Id when provided).
   *
    * @param {{ subBot: string, sender: string, chatType: string, chatId?: number|string }} data
   * @returns {Promise<{ sn: number|null, status: string, row: number }|null>}
   */
  async getLatestSessionStatus(data) {
    const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id) return null;

    const normalize = (v) => String(v || '').trim().toLowerCase();
    const targetSubBot = normalize(data.subBot || 'Animal Identification');
    const targetSender = normalize(data.sender || '');
    const targetChatId = normalize(data.chatId != null ? String(data.chatId) : '');
    const targetChatType = normalize(
      data.chatType ? data.chatType.charAt(0).toUpperCase() + data.chatType.slice(1) : 'Private'
    );

    try {
      const rows = await this.getRows(id, 'Sessions!A:J');
      if (!rows || rows.length <= 1) return null;

      for (let i = rows.length - 1; i >= 1; i -= 1) {
        const row = rows[i] || [];
        const rowSubBot = normalize(row[1]);
        const rowChatId = normalize(row[5]);
        const rowSender = normalize(row[3]);
        const rowChatType = normalize(row[6]);

        const chatIdMatches = !targetChatId || rowChatId === targetChatId;

        if (rowSubBot === targetSubBot && chatIdMatches && rowSender === targetSender && rowChatType === targetChatType) {
          return {
            sn: Number.parseInt(row[0], 10) || null,
            sessionId: row[2] || '',
            status: row[9] || '',
            row: i + 1,
          };
        }
      }

      return null;
    } catch (err) {
      logger.error('Failed to read latest session status', { error: err.message });
      return null;
    }
  }
}

module.exports = new GoogleSheetsService();
