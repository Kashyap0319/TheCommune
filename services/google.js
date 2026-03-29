const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const {
    GOOGLE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_PRIVATE_KEY,
    GOOGLE_DRIVE_FOLDER_ID,
    GOOGLE_SHEET_ID,
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REFRESH_TOKEN,
} = process.env;

// Guard against missing private key — prevents crash at module load time
const privateKey = GOOGLE_PRIVATE_KEY
    ? GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/\\/g, '')
    : '';

if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !privateKey) {
    logger.warn('[Google] GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY not set — Google services will fail');
}

// ── Service Account auth (for Sheets — no storage quota needed) ──
const serviceAuth = new google.auth.GoogleAuth({
    credentials: {
        client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: privateKey,
    },
    scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'],
});

// ── OAuth2 auth (for Drive uploads — uses Kanak's storage quota) ──
const REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI ||
    'https://lovely-adventure-production-719e.up.railway.app/google/callback';

const oauth2Client = new google.auth.OAuth2(
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    REDIRECT_URI,
);

if (GOOGLE_OAUTH_REFRESH_TOKEN) {
    oauth2Client.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });
    logger.info('[Google] OAuth2 refresh token loaded — Drive uploads will use Kanak\'s account');
}

// Drive uses OAuth2 (Kanak's account), Sheets uses service account
const drive  = google.drive({ version: 'v3', auth: GOOGLE_OAUTH_REFRESH_TOKEN ? oauth2Client : serviceAuth });
const sheets = google.sheets({ version: 'v4', auth: serviceAuth });

// oauth2Client exported at bottom with other exports

/**
 * Uploads a file stream to a specific folder in Google Drive.
 * @param {Stream} fileStream - The file stream to upload
 * @param {string} fileName - Name of the file in Drive
 * @param {string} mimeType - MIME type of the file
 * @returns {string} The public webViewLink for the file
 */
async function uploadToDrive(fileStream, fileName, mimeType) {
    try {
        const fileMetadata = {
            name: fileName,
            parents: [GOOGLE_DRIVE_FOLDER_ID],
        };
        const media = {
            mimeType: mimeType,
            body: fileStream,
        };

        const file = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink',
            supportsAllDrives: true,
        });

        // Make file readable to anyone with the link (optional/optional per client preference)
        await drive.permissions.create({
            fileId: file.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone',
            },
        });

        logger.info(`Uploaded file to Drive: ${file.data.webViewLink}`);
        return file.data.webViewLink;
    } catch (error) {
        logger.error("Error uploading to Google Drive:", error);
        throw error;
    }
}

// ── Column layout (17 columns A–Q) ──────────────────────────────────────────
// A=ListingID  B=Status     C=Area        D=BHK/Type    E=Rent
// F=Furnishing G=Avail Date H=Floor       I=Amenities
// J=Photo 1    K=Photo 2    L=Photo 3     M=Photo 4
// N=Video 1    O=Video 2
// P=Listed On  Q=Raw Message
const PHOTO_COLS  = ['J', 'K', 'L', 'M']; // indices 9–12
const VIDEO_COLS  = ['N', 'O'];            // indices 13–14

function hyperlink(url, label) {
    return url ? `=HYPERLINK("${url}","${label}")` : '';
}

/**
 * Appends a new property listing row to the Google Sheet (17-column schema).
 */
async function appendToInventorySheet(listingId, propertyData, mediaLinks, sender = '', rawMessage = '', mediaMimeTypes = []) {
    try {
        const rent = propertyData.rent_max
            ? `${propertyData.rent_min} - ${propertyData.rent_max}`
            : propertyData.rent_min || '';

        const photos = [];
        const videos = [];
        mediaLinks.forEach((link, i) => {
            const mime = mediaMimeTypes[i] || '';
            if (mime.startsWith('video/')) videos.push(link);
            else photos.push(link);
        });

        const row = [
            listingId,                                                  // A
            'AVAILABLE',                                                // B
            propertyData.location || '',                                // C
            propertyData.property_type || '',                           // D
            rent,                                                       // E
            propertyData.furnishing || '',                              // F
            propertyData.possession_date || '',                         // G
            propertyData.floor || '',                                   // H
            propertyData.amenities || '',                               // I
            hyperlink(photos[0], 'Photo 1'),                            // J
            hyperlink(photos[1], 'Photo 2'),                            // K
            hyperlink(photos[2], 'Photo 3'),                            // L
            hyperlink(photos[3], 'Photo 4'),                            // M
            hyperlink(videos[0], 'Video 1'),                            // N
            hyperlink(videos[1], 'Video 2'),                            // O
            new Date().toISOString(),                                   // P
            rawMessage,                                                 // Q
        ];

        const response = await sheets.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: 'Sheet1!A:Q',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [row] },
        });

        invalidateSheetCache();
        logger.info(`Added listing ${listingId} to Google Sheet:`, response.data.updates.updatedRange);
        return response.data;
    } catch (error) {
        logger.error('Error appending to Google Sheet:', error);
        throw error;
    }
}

// In-memory sheet cache — 5 min TTL to avoid hammering Google Sheets API
let _sheetCache = null;
let _sheetCacheTime = 0;
const SHEET_CACHE_TTL_MS = 5 * 60 * 1000;

async function getSheetRows() {
    const now = Date.now();
    if (_sheetCache && (now - _sheetCacheTime) < SHEET_CACHE_TTL_MS) {
        return _sheetCache;
    }
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: 'Sheet1!A:Q',
    });
    _sheetCache = response.data.values || [];
    _sheetCacheTime = now;
    return _sheetCache;
}

// Call this after any write to sheet so cache is invalidated immediately
function invalidateSheetCache() {
    _sheetCache = null;
    _sheetCacheTime = 0;
}

// Extract raw URL from a HYPERLINK formula or plain text
function extractUrl(cell) {
    if (!cell) return null;
    const m = String(cell).match(/=HYPERLINK\("([^"]+)"/i);
    return m ? m[1] : (cell.startsWith('http') ? cell : null);
}

/**
 * Searches the inventory sheet for AVAILABLE listings matching the given filters.
 * Uses the 17-column schema (A–Q).
 * @param {object} filters - { area: string, maxBudget: number, bhk?: string }
 * @returns {Array} Array of matching listing objects
 */
async function searchInventory(filters) {
    try {
        const rows = await getSheetRows();
        if (!rows || rows.length <= 1) return [];

        const results = [];

        for (let i = 1; i < rows.length; i++) {
            const [listingId, status, area, bhkType, rent, furnishing,
                availableDate, floor, amenities,
                p1, p2, p3, p4, v1, v2] = rows[i];

            if (!listingId) continue;

            const isAvailable = !status || status.toUpperCase() === 'AVAILABLE';

            // Area filter — loose match both ways
            if (filters.area && area) {
                const nf = filters.area.toLowerCase().replace(/[^a-z0-9]/g, '');
                const na = area.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (!na.includes(nf) && !nf.includes(na)) continue;
            }

            // Budget filter — only apply to available listings
            if (isAvailable && filters.maxBudget && rent) {
                const numericRent = parseInt(String(rent).replace(/[^0-9]/g, ''), 10);
                if (!isNaN(numericRent) && numericRent > filters.maxBudget * 1.2) continue; // 20% tolerance
            }

            // BHK filter
            if (filters.bhk && bhkType) {
                if (!bhkType.toLowerCase().includes(filters.bhk.toLowerCase())) continue;
            }

            const photoLinks = [p1, p2, p3, p4].map(extractUrl).filter(Boolean);
            const videoLinks = [v1, v2].map(extractUrl).filter(Boolean);

            results.push({
                listingId: listingId || `ROW-${i + 1}`,
                rowNumber: i + 1,
                status: isAvailable ? 'AVAILABLE' : 'CLOSED',
                area:          area          || '',
                bhk:           bhkType       || '',
                rent:          rent          || '',
                furnishing:    furnishing    || '',
                availableDate: availableDate || '',
                floor:         floor         || '',
                amenities:     amenities     || '',
                photoLinks,
                videoLinks,
            });
        }

        logger.info(`[Search] Found ${results.length} listings (available+closed) for filters:`, filters);
        return results;
    } catch (error) {
        logger.error('Error searching inventory sheet:', error);
        throw error;
    }
}

/**
 * Find a row index in the sheet by Listing ID.
 * @param {string} listingId - The listing ID to search for (e.g. LST-A3B8D1B6)
 * @returns {object|null} { rowIndex, rowData } or null if not found
 */
async function findRowByListingId(listingId) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: 'Sheet1!A:Q',
        });

        const rows = response.data.values;
        if (!rows || rows.length <= 1) return null;

        for (let i = 1; i < rows.length; i++) {
            if (rows[i][0] && rows[i][0].toUpperCase() === listingId.toUpperCase()) {
                return { rowIndex: i + 1, rowData: rows[i] }; // 1-indexed for Sheets API
            }
        }
        return null;
    } catch (error) {
        logger.error(`Error finding listing ${listingId}:`, error);
        throw error;
    }
}

/**
 * Marks a listing as CLOSED by its Listing ID.
 * @param {string} listingId - The unique listing ID (e.g. LST-A3B8D1B6)
 * @returns {object} { success: boolean, message: string }
 */
async function closeListingById(listingId) {
    try {
        const found = await findRowByListingId(listingId);

        if (!found) {
            return { success: false, message: `❌ Listing *${listingId}* not found. Please check and try again.` };
        }

        const { rowIndex, rowData } = found;
        const [, status, , propertyType, rent, , , , , , , , ] = rowData;
        const location = rowData[2] || '';

        if (status && status.toUpperCase() === 'CLOSED') {
            return { success: false, message: `Listing *${listingId}* is already CLOSED.` };
        }

        // Update Status column (B = column 2) to CLOSED
        await sheets.spreadsheets.values.update({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: `Sheet1!B${rowIndex}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [['CLOSED']] },
        });

        invalidateSheetCache();
        logger.info(`[Close] Listing ${listingId} (row ${rowIndex}) marked as CLOSED.`);
        return {
            success: true,
            message: `✅ Listing *${listingId}* (${propertyType || ''} ${location || ''} ₹${rent || ''}) marked as *CLOSED*.`,
        };
    } catch (error) {
        logger.error(`Error closing listing ${listingId}:`, error);
        throw error;
    }
}

/**
 * Add a media Drive link to an existing listing row by Listing ID.
 * Finds the next empty photo column (J–M) or video column (N–O) and writes a HYPERLINK formula.
 */
async function addMediaLinkToRow(listingId, driveLink, mimeType = '') {
    try {
        const found = await findRowByListingId(listingId);
        if (!found) {
            logger.info(`[Media] Listing ${listingId} not found. Cannot attach media.`);
            return false;
        }

        const { rowIndex, rowData } = found;
        const isVideo = mimeType.startsWith('video/');
        const cols     = isVideo ? VIDEO_COLS : PHOTO_COLS;
        const startIdx = isVideo ? 13 : 9; // N=13, J=9 (0-indexed)

        // Find first empty slot
        let targetCol = cols[cols.length - 1]; // default: last column (overwrite if all full)
        for (let i = 0; i < cols.length; i++) {
            if (!rowData[startIdx + i]) {
                targetCol = cols[i];
                break;
            }
        }

        const label = isVideo
            ? `Video ${cols.indexOf(targetCol) + 1}`
            : `Photo ${cols.indexOf(targetCol) + 1}`;

        await sheets.spreadsheets.values.update({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: `Sheet1!${targetCol}${rowIndex}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[hyperlink(driveLink, label)]] },
        });

        logger.info(`[Media] Added ${label} to listing ${listingId} (${targetCol}${rowIndex})`);
        return true;
    } catch (error) {
        logger.error(`Error adding media to listing ${listingId}:`, error);
        return false;
    }
}

module.exports = {
    oauth2Client,
    uploadToDrive,
    appendToInventorySheet,
    searchInventory,
    closeListingById,
    addMediaLinkToRow,
    findRowByListingId,
};
