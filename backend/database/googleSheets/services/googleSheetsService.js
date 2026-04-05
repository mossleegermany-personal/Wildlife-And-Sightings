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
   * Count how many Animal Identification rows exist for a given chatId on a given SGT date.
   * Used for daily rate-limiting: private chats allow 15/day, groups allow 20/day.
   *
   * @param {number|string} chatId   - Telegram chat ID
   * @param {string}        dateStr  - date in 'dd/mm/yyyy' format (SGT)
   * @returns {Promise<number>}
   */
  async getDailyIdentificationCount(chatId, dateStr) {
    const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id) return 0;
    try {
      // Read columns B (Chat Id) through K (Date) — B2:K is cols [0]=B … [9]=K
      const rows = await this.getRows(id, 'Animal Identification!B2:K');
      const chatIdStr = String(chatId);
      return rows.filter(r => {
        const rowChatId = String(r[0] || '').trim();
        const rowDate   = String(r[9] || '').replace(/^'/, '').trim(); // strip leading ' prefix
        return rowChatId === chatIdStr && rowDate === dateStr;
      }).length;
    } catch {
      return 0;
    }
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
   * Columns: S/N | Chat Id | Session Id | User Name | Display Name | Sender | Platform | Date | Time | Country | Species | Image
   *
   * @param {{ user: object, species: string|null, canvasFileId: string|null, country: string|null, chatId: number|string|null, sessionId: string|null, chatType?: string, channelName?: string }} params
   */
  async logAnimalIdentification({ user, species, canvasFileId, location, country, chatId, sessionId, chatType, channelName }) {
    const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id) { logger.warn('GOOGLE_SHEETS_SPREADSHEET_ID not set — skipping log'); return; }

    const sn = await this.getNextSerialNumber();

    const { date, time } = getSingaporeDateTimeParts(new Date());

    const personDisplayName = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
    const normalizedChatType = String(chatType || '').trim().toLowerCase();
    const isPrivate = normalizedChatType === 'private';
    const displayName = personDisplayName || 'Unknown';
    const channelNameValue = isPrivate ? '' : String(channelName || '').trim();
    // Channel Id: the group/channel's Telegram ID — blank for private chats.
    const channelIdValue = isPrivate ? '' : (chatId != null ? String(chatId) : '');
    const userName = user?.username ? `@${user.username}` : '';
    const sender = userName || personDisplayName || 'Unknown';
    const chatTypeFmt = normalizedChatType.charAt(0).toUpperCase() + normalizedChatType.slice(1);

    const row = [
      sn,                                       // A [0]:  S/N
      chatId != null ? String(chatId) : '',     // B [1]:  Chat Id
      channelIdValue,                           // C [2]:  Channel Id (group/channel only)
      sessionId || '',                          // D [3]:  Session Id
      userName,                                 // E [4]:  User Name
      displayName || 'Unknown',                 // F [5]:  Display Name (private only)
      channelNameValue,                         // G [6]:  Channel Name (group/channel only)
      sender,                                   // H [7]:  Sender
      chatTypeFmt,                              // I [8]:  Chat Type
      'Telegram',                               // J [9]:  Platform
      `'${date}`,                               // K [10]: Date (prefixed ' to force text)
      `'${time}`,                               // L [11]: Time (prefixed ' to force text)
      location || '',                           // M [12]: Location
      country || '',                            // N [13]: Country
      species || '',                            // O [14]: Species
      canvasFileId || '',                       // P [15]: Image
    ];
    const appendRes = await this.appendRow(id, `${SHEET_NAME}!A:P`, row);

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
              // Remove bold from all 16 columns
              {
                repeatCell: {
                  range: { sheetId: 0, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: 16 },
                  cell: { userEnteredFormat: { textFormat: { bold: false } } },
                  fields: 'userEnteredFormat.textFormat.bold',
                },
              },
              // Force column L (Time, index 11) to plain text so 24-hr display is preserved
              {
                repeatCell: {
                  range: { sheetId: 0, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 11, endColumnIndex: 12 },
                  cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } },
                  fields: 'userEnteredFormat.numberFormat',
                },
              },
            ],
          },
        });
      }
    } catch { /* formatting is best-effort, never block the log */ }

    logger.debug('Logged identification to Google Sheets', { sn, userName, displayName, sender, chatId, sessionId, chatType: normalizedChatType });
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
   * Log a personal bird sighting from /addsighting to the "Bird Sightings" sheet.
   * Columns (A:W, 23 cols): S/N | Date | Time | Chat Id | Channel Id | Session Id |
   *   User Name | Display Name | Channel Name | Sender | Chat Type | Command | Search Query |
   *   Location | Country | Total Sightings | Count | Species List |
   *   Species | Observation Date | Count | Observation Type | Notes
   *
   * @param {{ user: object, chat: object, species: string, location: string,
   *            observationDate: string, count: number, obsType: string, notes: string }} data
   */
  async logBirdSightingCommand({ user, chat, sessionId, channelId: explicitChannelId, channelName: explicitChannelName, species, location, observationDate, count, obsType, notes }) {
    const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id) { logger.warn('GOOGLE_SHEETS_SPREADSHEET_ID not set — skipping Bird Sightings log'); return; }

    // S/N
    let sn = 1;
    try {
      const rows = await this.getRows(id, 'Bird Sightings!A:A');
      const dataRows = rows.slice(1).filter(r => r[0] && !isNaN(parseInt(r[0])));
      if (dataRows.length > 0) sn = Math.max(...dataRows.map(r => parseInt(r[0]))) + 1;
    } catch { /* default to 1 */ }

    // Date: dd/mm/yyyy, Time: hh:mm:ss hrs — both in GMT+8 (Asia/Singapore)
    const sgParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Singapore',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const sp  = Object.fromEntries(sgParts.map(p => [p.type, p.value]));
    const date = `'${sp.day}/${sp.month}/${sp.year}`;
    const time = `'${sp.hour}:${sp.minute}:${sp.second} hrs`;

    const chatTypeRaw = String(chat?.type || 'private').toLowerCase();
    const isPrivate   = chatTypeRaw === 'private';
    const chatTypeFmt = chatTypeRaw.charAt(0).toUpperCase() + chatTypeRaw.slice(1);
    const chatIdStr   = chat?.id != null ? String(chat.id) : '';
    const channelId   = isPrivate ? '' : String(explicitChannelId ?? chatIdStr);
    const channelName = isPrivate ? '' : String(explicitChannelName ?? (chat?.title || ''));
    const personName  = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
    const userName    = user?.username ? `@${user.username}` : '';
    const displayName = personName || (isPrivate ? 'Unknown' : '');
    const sender      = user?.username ? `@${user.username}` : (personName || 'Unknown');

    const row = [
      sn,                          // A [0]:  S/N
      date,                        // B [1]:  Date (dd/mm/yyyy)
      time,                        // C [2]:  Time (hh:mm:ss hrs)
      chatIdStr,                   // D [3]:  Chat Id
      channelId,                   // E [4]:  Channel Id (blank for private)
      sessionId || '',             // F [5]:  Session Id
      userName,                    // G [6]:  User Name (@username or blank)
      displayName,                 // H [7]:  Display Name
      channelName,                 // I [8]:  Channel Name (blank for private)
      sender,                      // J [9]:  Sender
      chatTypeFmt,                 // K [10]: Chat Type
      '/addsighting',              // L [11]: Command
      species,                     // M [12]: Search Query (species entered)
      location || '',              // N [13]: Location
      '',                          // O [14]: Country
      String(count),               // P [15]: Total Sightings
      '1',                         // Q [16]: Count (Unique Species Count)
      species,                     // R [17]: Species List
      species,                     // S [18]: Species (personal sighting)
      observationDate || '',       // T [19]: Observation Date (personal sighting)
      String(count),               // U [20]: Count (personal sighting)
      obsType || 'Incidental',     // V [21]: Observation Type (personal sighting)
      notes || '',                 // W [22]: Notes (personal sighting)
    ];

    return this.appendRow(id, 'Bird Sightings!A:W', row);
  }

  /**
   * Log a bird API query (non-personal-sighting) to the "Bird Sightings" sheet.
   * Columns (A:W, 23 cols): S/N | Date | Time | Chat Id | Channel Id | Session Id |
   *   User Name | Display Name | Channel Name | Sender | Chat Type | Command | Search Query |
   *   Location | Country | Total Sightings | Count | Species List |
   *   Species | Observation Date | Count | Observation Type | Notes
   * Cols A–R are populated; S–W (personal sighting fields) are left blank.
   *
   * @param {{ user: object, chat: object, command: string, searchQuery: string,
   *            regionCode: string, totalSightings: number,
   *            uniqueSpeciesCount: number, speciesList: string }} params
   */
  async logBirdQuery({ user, chat, sessionId, channelId: explicitChannelId, channelName: explicitChannelName, command, searchQuery, regionCode, totalSightings, uniqueSpeciesCount, speciesList }) {
    const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id) { logger.warn('GOOGLE_SHEETS_SPREADSHEET_ID not set — skipping Bird Sightings log'); return; }

    let sn = 1;
    try {
      const rows = await this.getRows(id, 'Bird Sightings!A:A');
      const dataRows = rows.slice(1).filter(r => r[0] && !isNaN(parseInt(r[0])));
      if (dataRows.length > 0) sn = Math.max(...dataRows.map(r => parseInt(r[0]))) + 1;
    } catch { /* default to 1 */ }

    const sgParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Singapore',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const sp   = Object.fromEntries(sgParts.map(p => [p.type, p.value]));
    const date = `'${sp.day}/${sp.month}/${sp.year}`;
    const time = `'${sp.hour}:${sp.minute}:${sp.second} hrs`;

    const chatTypeRaw = String(chat?.type || 'private').toLowerCase();
    const isPrivate   = chatTypeRaw === 'private';
    const chatTypeFmt = chatTypeRaw.charAt(0).toUpperCase() + chatTypeRaw.slice(1);
    const chatIdStr   = chat?.id != null ? String(chat.id) : '';
    const channelId   = isPrivate ? '' : String(explicitChannelId ?? chatIdStr);
    const channelName = isPrivate ? '' : String(explicitChannelName ?? (chat?.title || ''));
    const personName  = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
    const userName    = user?.username ? `@${user.username}` : '';
    const displayName = personName || (isPrivate ? 'Unknown' : '');
    const sender      = user?.username ? `@${user.username}` : (personName || 'Unknown');

    const row = [
      sn,                                // A [0]:  S/N
      date,                              // B [1]:  Date (dd/mm/yyyy)
      time,                              // C [2]:  Time (hh:mm:ss hrs)
      chatIdStr,                         // D [3]:  Chat Id
      channelId,                         // E [4]:  Channel Id (blank for private)
      sessionId || '',                   // F [5]:  Session Id
      userName,                          // G [6]:  User Name (@username or blank)
      displayName,                       // H [7]:  Display Name
      channelName,                       // I [8]:  Channel Name (blank for private)
      sender,                            // J [9]:  Sender
      chatTypeFmt,                       // K [10]: Chat Type
      command || '',                     // L [11]: Command
      searchQuery || '',                 // M [12]: Search Query
      '',                                // N [13]: Location (blank — region stored in Country)
      regionCode || '',                  // O [14]: Country (region/country code e.g. SG)
      String(totalSightings || 0),       // P [15]: Total Sightings
      String(uniqueSpeciesCount || 0),   // Q [16]: Count (Unique Species Count)
      speciesList || '',                 // R [17]: Species List
      '', '', '', '', '',                // S–W [18–22]: personal sighting fields (blank)
    ];

    return this.appendRow(id, 'Bird Sightings!A:W', row);
  }

  /**
   * Get personal bird sightings logged via /addsighting for a given sender.
   * Reads from "Bird Sightings" sheet (columns A:V) and filters by command and sender.
   *
   * @param {string} sender  — @username or display name to filter by
   * @returns {Promise<Array<{species:string, location:string, observationDate:string, count:string, obsType:string, notes:string}>>}
   */
  async getPersonalBirdSightings(sender) {
    const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id) return [];
    try {
      const rows = await this.getRows(id, 'Bird Sightings!A2:W5000');
      return rows
        .filter(r => r[11] === '/addsighting' && r[9] === sender)
        .map(r => ({
          species:         r[18] || '',
          location:        r[13] || '',
          observationDate: r[19] || '',
          count:           r[20] || '',
          obsType:         r[21] || '',
          notes:           r[22] || '',
        }));
    } catch (err) {
      logger.warn('getPersonalBirdSightings failed', { error: err.message });
      return [];
    }
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
   * Get next serial number for the "Telegram" sheet.
   * @returns {Promise<number>}
   */
  async getNextTelegramGroupSerialNumber() {
    try {
      const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
      const rows = await this.getRows(id, 'Telegram!A:A');
      const dataRows = rows.slice(1).filter(r => r[0] && !isNaN(parseInt(r[0])));
      if (dataRows.length === 0) return 1;
      return Math.max(...dataRows.map(r => parseInt(r[0]))) + 1;
    } catch {
      return 1;
    }
  }

  /**
   * Log Telegram /start events to "Telegram" sheet.
   * Columns: S/N | Chat Type | Chat Id | Channel Id | Sender | Display Name | Channel Name
   *
   * Channel Id and Channel Name are only populated for group/channel chats.
   * Display Name is only populated for private chats.
   *
   * @param {{ chatId: number|string, channelId: number|string|null, chatType: string, sender: string, displayName: string, channelName: string }} data
   */
  async logTelegramGroupStart(data) {
    const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id) {
      logger.warn('GOOGLE_SHEETS_SPREADSHEET_ID not set — skipping Telegram log');
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
    const channelIdValue = isPrivate ? '' : (data.channelId != null ? String(data.channelId) : '');
    const displayNameValue = data.displayName || '';
    const channelNameValue = isPrivate ? '' : (data.channelName || '');

    const buildRow = (sn) => [
      sn,                          // A: S/N
      chatType,                    // B: Chat Type
      chatIdValue,                 // C: Chat Id
      channelIdValue,              // D: Channel Id (group/channel only)
      data.sender || 'Unknown',    // E: Sender
      displayNameValue,            // F: Display Name (private only)
      channelNameValue,            // G: Channel Name (group/channel only)
    ];

    try {
      // Enforce uniqueness by Chat Id (column C): update existing row when found.
      const rows = await this.getRows(id, 'Telegram!A:G');
      const existingIndex = rows.findIndex((r, i) => i > 0 && String(r[2] || '').trim() === chatIdValue);

      if (existingIndex !== -1) {
        const sheetRow = existingIndex + 1;
        const existingSn = rows[existingIndex]?.[0] || '';

        const sheets = this._getSheets();
        await sheets.spreadsheets.values.update({
          spreadsheetId: id,
          range: `Telegram!A${sheetRow}:G${sheetRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [buildRow(existingSn)] },
        });

        logger.debug('Updated existing Telegram row by Chat Id', { chatId: chatIdValue, row: sheetRow });
        return Number.parseInt(existingSn, 10) || null;
      }
    } catch (err) {
      logger.warn('Failed to check/update Telegram duplicate by Chat Id; falling back to append', { error: err.message, chatId: chatIdValue });
    }

    const sn = await this.getNextTelegramGroupSerialNumber();

    try {
      await this.appendRow(id, 'Telegram!A:G', buildRow(sn));
      logger.debug('Logged /start to Telegram sheet', { sn, chatId: data.chatId, chatType });
      return sn;
    } catch (err) {
      logger.error('Failed to log Telegram /start', { error: err.message });
      return null;
    }
  }

  /**
   * Append a new session row to the "Sessions" sheet with Status = "Active".
   * Columns: S/N | Sub-bot | Session Id | Sender | Display Name | Chat Id | Channel Id | Channel Name | Chat Type | Start Date | Start Time | End Date | End Time | Status
   *
   * Channel Id and Channel Name are only populated for group/channel chats.
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
      return `'${map.day}/${map.month}/${map.year}`;
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
      return `'${map.hour}:${map.minute}:${map.second} hrs`;
    };

    const sender = (data.user?.username ? `@${data.user.username}` : [data.user?.first_name, data.user?.last_name].filter(Boolean).join(' '))
      || 'Unknown';
    const displayName = [data.user?.first_name, data.user?.last_name].filter(Boolean).join(' ') || '';

    const sessionId = `S-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const chatType = data.chatType
      ? data.chatType.charAt(0).toUpperCase() + data.chatType.slice(1)
      : 'Private';
    const isPrivate = (data.chatType || '').toLowerCase() === 'private';

    // Channel Id / Channel Name should stay aligned with the specific group/channel context
    // that started the session. For private chats both remain blank.
    const channelIdValue = isPrivate
      ? ''
      : (data.channelId != null ? String(data.channelId) : (data.chatId != null ? String(data.chatId) : ''));
    const channelNameValue = isPrivate ? '' : String(data.channelName || data.chatTitle || '');

    const startDt = data.startTime || new Date();
    const row = [
      sn,                                             // A: S/N
      data.subBot || 'Animal Identification',         // B: Sub-bot
      sessionId,                                      // C: Session Id
      sender,                                         // D: Sender
      displayName,                                    // E: Display Name
      data.chatId != null ? String(data.chatId) : '', // F: Chat Id
      channelIdValue,                                 // G: Channel Id (group/channel only)
      channelNameValue,                               // H: Channel Name (group/channel only)
      chatType,                                       // I: Chat Type
      formatDate(startDt),                            // J: Start Date
      formatTime(startDt),                            // K: Start Time
      '',                                             // L: End Date — filled in when session ends
      '',                                             // M: End Time — filled in when session ends
      'Active',                                       // N: Status
    ];

    try {
      await this.appendRow(id, 'Sessions!A:N', row);
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
      return `'${map.day}/${map.month}/${map.year}`;
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
      return `'${map.hour}:${map.minute}:${map.second} hrs`;
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
        range: `Sessions!L${sheetRow}:N${sheetRow}`,
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
   * Sessions columns: S/N(A,0) | Sub-bot(B,1) | Session Id(C,2) | Sender(D,3) | Display Name(E,4) |
   *   Chat Id(F,5) | Channel Id(G,6) | Channel Name(H,7) | Chat Type(I,8) |
   *   Start Date(J,9) | Start Time(K,10) | End Date(L,11) | End Time(M,12) | Status(N,13)
   *
   * @param {{ subBot: string, sender: string, chatType: string, chatId?: number|string }} data
   * @returns {Promise<{ sn: number|null, sessionId: string, status: string, row: number }|null>}
   */
  async getLatestSessionStatus(data) {
    const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!id) return null;

    const normalize = (v) => String(v || '').trim().toLowerCase();
    const targetSubBot = normalize(data.subBot || 'Animal Identification');
    const targetSender = normalize(data.sender || '');
    const targetChatId = normalize(data.chatId != null ? String(data.chatId) : '');
    const targetChannelId = normalize(data.channelId != null ? String(data.channelId) : '');
    const targetChannelName = normalize(data.channelName || '');
    const targetChatType = normalize(
      data.chatType ? data.chatType.charAt(0).toUpperCase() + data.chatType.slice(1) : 'Private'
    );

    try {
      const rows = await this.getRows(id, 'Sessions!A:N');
      if (!rows || rows.length <= 1) return null;

      for (let i = rows.length - 1; i >= 1; i -= 1) {
        const row = rows[i] || [];
        const rowSubBot = normalize(row[1]);
        const rowChatId = normalize(row[5]);
        const rowChannelId = normalize(row[6]);
        const rowChannelName = normalize(row[7]);
        const rowSender = normalize(row[3]);
        const rowChatType = normalize(row[8]);  // I: Chat Type

        const chatIdMatches = !targetChatId || rowChatId === targetChatId;
        const channelIdMatches = !targetChannelId || rowChannelId === targetChannelId;
        const channelNameMatches = !targetChannelName || rowChannelName === targetChannelName;

        if (rowSubBot === targetSubBot && chatIdMatches && channelIdMatches && channelNameMatches && rowSender === targetSender && rowChatType === targetChatType) {
          return {
            sn: Number.parseInt(row[0], 10) || null,
            sessionId: row[2] || '',
            status: row[13] || '',  // N: Status
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
