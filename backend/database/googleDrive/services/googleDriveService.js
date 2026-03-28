/**
 * Google Drive Service
 *
 * Uploads image buffers to a configured Drive folder using a Service Account.
 *
 * Required env vars:
 *   GOOGLE_SHEETS_CLIENT_EMAIL
 *   GOOGLE_SHEETS_PRIVATE_KEY
 * Optional env vars:
 *   GOOGLE_DRIVE_FOLDER_ID
 *   GOOGLE_DRIVE_SHARED_DRIVE_ID
 *   GOOGLE_DRIVE_ALLOW_ROOT_UPLOAD
 */
const { google } = require('googleapis');
const { Readable } = require('stream');
const logger = require('../../../src/utils/logger');

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

class GoogleDriveService {
  constructor() {
    this._auth = null;
    this._drive = null;
  }

  _getAuth() {
    if (this._auth) return this._auth;

    const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
    const privateKey = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');

    if (!clientEmail || !privateKey) {
      throw new Error(
        'Google credentials not configured. Set GOOGLE_SHEETS_CLIENT_EMAIL and GOOGLE_SHEETS_PRIVATE_KEY.'
      );
    }

    this._auth = new google.auth.JWT({
      email: clientEmail,
      key: privateKey,
      scopes: DRIVE_SCOPES,
    });

    return this._auth;
  }

  _getDrive() {
    if (this._drive) return this._drive;
    this._drive = google.drive({ version: 'v3', auth: this._getAuth() });
    return this._drive;
  }

  _getTargetFolderId() {
    return (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  }

  _getTargetSharedDriveId() {
    return (process.env.GGOOGLE_DRIVE_FOLDER_ID || '').trim();
  }

  _allowRootUpload() {
    return String(process.env.GOOGLE_DRIVE_ALLOW_ROOT_UPLOAD || '').toLowerCase() === 'true';
  }

  /**
   * Upload a binary image buffer to Google Drive.
   *
   * @param {{buffer: Buffer, fileName: string, mimeType: string, folderId?: string}} params
   * @returns {Promise<{fileId: string, webViewLink: string, webContentLink: string}>}
   */
  async uploadImageBuffer({ buffer, fileName, mimeType = 'image/jpeg', folderId }) {
    if (!buffer || !Buffer.isBuffer(buffer)) {
      throw new Error('uploadImageBuffer requires a Buffer.');
    }

    const drive = this._getDrive();
    const parentFolder = folderId || this._getTargetFolderId();
    const allowRootUpload = this._allowRootUpload();

    if (!parentFolder && !allowRootUpload) {
      throw new Error(
        'GOOGLE_DRIVE_FOLDER_ID is not set. Configure a shared-drive folder in .env or set GOOGLE_DRIVE_ALLOW_ROOT_UPLOAD=true.'
      );
    }

    let createRes;
    try {
      createRes = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: parentFolder ? [parentFolder] : undefined,
        },
        media: {
          mimeType,
          body: Readable.from(buffer),
        },
        fields: 'id,webViewLink,webContentLink',
        supportsAllDrives: true,
      });
    } catch (err) {
      const message = err?.message || 'Unknown Drive upload error';
      if (/Service Accounts do not have storage quota/i.test(message)) {
        throw new Error(
          'Drive upload failed: service accounts have no personal My Drive quota. Set GOOGLE_DRIVE_FOLDER_ID to a folder inside a Shared Drive.'
        );
      }
      throw err;
    }

    const fileId = createRes.data.id;
    if (!fileId) {
      throw new Error('Drive upload did not return a file id.');
    }

    // Best effort: make the file readable by link so it can be opened from logs.
    try {
      await drive.permissions.create({
        fileId,
        requestBody: { role: 'reader', type: 'anyone' },
        supportsAllDrives: true,
      });
    } catch (err) {
      logger.warn('Could not set Drive file public permission', { error: err.message, fileId });
    }

    const metaRes = await drive.files.get({
      fileId,
      fields: 'id,webViewLink,webContentLink',
      supportsAllDrives: true,
    });

    return {
      fileId,
      webViewLink: metaRes.data.webViewLink || '',
      webContentLink: metaRes.data.webContentLink || '',
    };
  }
}

module.exports = new GoogleDriveService();
