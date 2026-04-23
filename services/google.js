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
    scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/calendar',
    ],
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

// ── Column layout (22 columns A–V) ──────────────────────────────────────────
// A=ListingID  B=Status     C=Area        D=BHK/Type    E=Rent
// F=Furnishing G=Avail Date H=Floor       I=Amenities/Services
// J=Photo 1    K=Photo 2    L=Photo 3     M=Photo 4
// N=Video 1    O=Video 2
// P=Listed On  Q=Raw Message
// R=Property_Name  S=Sharing  T=Restrictions  U=Exclusions  V=Property_Category
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
            propertyData.services || propertyData.amenities || '',      // I
            hyperlink(photos[0], 'Photo 1'),                            // J
            hyperlink(photos[1], 'Photo 2'),                            // K
            hyperlink(photos[2], 'Photo 3'),                            // L
            hyperlink(photos[3], 'Photo 4'),                            // M
            hyperlink(videos[0], 'Video 1'),                            // N
            hyperlink(videos[1], 'Video 2'),                            // O
            new Date().toISOString(),                                   // P
            rawMessage,                                                 // Q
            propertyData.property_name || propertyData.building_name || '', // R
            propertyData.sharing || '',                                 // S
            propertyData.restrictions || '',                            // T
            propertyData.exclusions || '',                              // U
            propertyData.property_category || '',                       // V
        ];

        const response = await sheets.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: 'Sheet1!A:V',
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
        range: 'Sheet1!A:V',
        valueRenderOption: 'FORMULA',
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
// Sub-area → known roads mapping (for road-level search matching)
const AREA_ROADS = {
    'vile parle west': ['sv road', 'swami vivekanand', 'tejpal', 'irla', 'juhu lane', 'dadabhai road', 'lallubhai', 'gulmohar road', 'vallabhbhai patel', 'mg road', 'subhash road', 'hanuman road', 'jvpd', 'ns road', 'vile parle'],
    'vile parle east': ['nehru road', 'hanuman road', 'sahar', 'subhash road', 'dixit', 'nanda patkar', 'domestic airport', 'western express', 'jawaharlal nehru', 'sv road', 'ns phadke', 'vile parle'],
    'juhu': ['juhu tara', 'gulmohar', 'vaikunthlal mehta', 'ns road no 10', 'juhu church', 'janki kutir', 'dadabhai cross', 'indradhanush', 'indrawadan oza', 'parulekar', 'jvpd', 'cd barfiwala', 'juhu'],
    'andheri west': ['link road', 'sv road', 'andheri west', 'dn nagar', 'd.n. nagar', 'lokhandwala', 'versova', 'seven bungalows', 'yari road', 'four bungalows', 'oshiwara', 'juhu circle', 'veera desai'],
    'andheri east': ['andheri east', 'chakala', 'sakinaka', 'marol', 'saki naka', 'mahakali', 'jb nagar', 'sher e punjab', 'parsi wada'],
    'bandra west': ['bandra west', 'pali hill', 'carter road', 'linking road', 'hill road', 'bandstand', 'turner road', 'perry cross'],
    'bandra east': ['bandra east', 'kalanagar', 'bkc', 'bandra kurla', 'kherwadi', 'government colony'],
    'santacruz west': ['santacruz west', 'santacruz', 'khar west', 'khar', 'linking road', 'sv road'],
    'santacruz east': ['santacruz east', 'kalina', 'vakola', 'kurla', 'chunabhatti'],
};

async function searchInventory(filters) {
    try {
        const rows = await getSheetRows();
        if (!rows || rows.length <= 1) return [];

        const results = [];

        for (let i = 1; i < rows.length; i++) {
            const [listingId, status, area, bhkType, rent, furnishing,
                availableDate, floor, amenities,
                p1, p2, p3, p4, v1, v2,
                listedOn, rawMsg,
                propertyName, sharing, restrictions, exclusions, propertyCategory] = rows[i];

            if (!listingId) continue;

            const isAvailable = !status || status.toUpperCase() === 'AVAILABLE';

            // Area filter — split multi-area filters (e.g. "Vile Parle / Juhu / Andheri West")
            if (filters.area && area) {
                const areaLower = area.toLowerCase();
                const na = areaLower.replace(/[^a-z0-9]/g, '');
                const filterParts = filters.area.toLowerCase().split(/[/,]/).map(s => s.trim()).filter(Boolean);

                let areaMatch = false;
                for (const part of filterParts) {
                    const nf = part.replace(/[^a-z0-9]/g, '');
                    if (na.includes(nf) || nf.includes(na)) { areaMatch = true; break; }

                    // Road-level matching: check all AREA_ROADS whose key contains this part
                    for (const [areaKey, roads] of Object.entries(AREA_ROADS)) {
                        if (areaKey.includes(part.trim())) {
                            if (roads.some(road => areaLower.includes(road))) { areaMatch = true; break; }
                        }
                    }
                    if (areaMatch) break;
                }
                if (!areaMatch) continue;
            }

            // Budget filter — exclude below minimum, flag above maximum
            // Normalize rent to monthly: if value > 1L, it's likely annual — divide by 12
            let aboveBudget = false;
            if (isAvailable && rent) {
                const numericRent = parseInt(String(rent).replace(/[^0-9]/g, ''), 10);
                if (!isNaN(numericRent)) {
                    const monthlyRent = numericRent > 100000 ? Math.round(numericRent / 12) : numericRent;
                    if (filters.minBudget !== undefined && monthlyRent < filters.minBudget) continue;
                    if (filters.maxBudget && filters.maxBudget < 999999 && monthlyRent > filters.maxBudget) aboveBudget = true;
                }
            }

            // BHK filter — support variant matching (1 BHK + 1.5 BHK, etc.)
            if (filters.bhkVariants && bhkType) {
                const bhkLower = bhkType.toLowerCase().replace(/\s+/g, '');
                const matches = filters.bhkVariants.some(v => bhkLower.includes(v.replace(/\s+/g, '')));
                if (!matches) continue;
            } else if (filters.bhk && bhkType) {
                if (!bhkType.toLowerCase().includes(filters.bhk.toLowerCase())) continue;
            }

            // Possession / available date filter — match against multiple months
            if (filters.possessionMonths && availableDate) {
                const dateLower = availableDate.toLowerCase();
                const matches = filters.possessionMonths.some(m => dateLower.includes(m.toLowerCase()));
                if (!matches) continue;
            }

            // Property type filter — PG students shouldn't see Serviced Apartments / Flats and vice-versa
            if (filters.stayType) {
                const wantsPG = /pg|hostel/i.test(filters.stayType);
                const wantsFlat = /flat|serviced/i.test(filters.stayType);
                const listingCat = (propertyCategory || '').toLowerCase();
                const listingType = (bhkType || '').toLowerCase();

                const isListingPG = /pg|hostel/i.test(listingCat) || /\bpg\b|\bhostel\b/i.test(listingType);
                const isListingSA = /serviced/i.test(listingCat) || /serviced/i.test(listingType);
                const isListingFlat = /bhk|flat/i.test(listingType) && !isListingPG;

                // Skip category mismatches. Old listings (no category set) are still allowed through.
                if (listingCat || isListingPG || isListingSA) {
                    if (wantsPG && !isListingPG) continue;
                    if (wantsFlat && isListingPG) continue;
                }
            }

            // Gender / restrictions filter — match student's preference against listing's restrictions
            if (filters.gender) {
                const g = filters.gender.toLowerCase();
                const rlower = (restrictions || '').toLowerCase();
                const alower = (amenities || '').toLowerCase();
                const combined = rlower + ' ' + alower;

                // If listing specifies "girls only" or "boys only", filter accordingly
                const isGirlsOnly = /\b(girls?\s*only|only\s*girls?|female\s*only|ladies)\b/.test(combined);
                const isBoysOnly  = /\b(boys?\s*only|only\s*boys?|male\s*only|gents)\b/.test(combined);

                if (g.includes('girls') && isBoysOnly) continue;   // student wants girls, listing is boys only
                if (g.includes('boys')  && isGirlsOnly) continue;  // student wants boys, listing is girls only
                // co-ed preferences don't filter out anything
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
                services:      amenities     || '',
                propertyName:  propertyName  || '',
                sharing:       sharing       || '',
                restrictions:  restrictions  || '',
                exclusions:    exclusions    || '',
                propertyCategory: propertyCategory || '',
                photoLinks,
                videoLinks,
                aboveBudget,
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

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE CALENDAR — create visit event when lead moves to "Visit Scheduled"
// Share Kanak's calendar with thecommun-bot@thecommun.iam.gserviceaccount.com
// ─────────────────────────────────────────────────────────────────────────────

async function createCalendarEvent(lead) {
    try {
        const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
        const auth = await serviceAuth.getClient();
        const calendar = google.calendar({ version: 'v3', auth });

        // Visit time: tomorrow 11am IST unless visit_date is specified
        const visitDate = lead.visit_date ? new Date(lead.visit_date) : (() => {
            const d = new Date();
            d.setDate(d.getDate() + 1);
            d.setHours(11, 0, 0, 0);
            return d;
        })();

        const endDate = new Date(visitDate.getTime() + 60 * 60 * 1000); // +1 hour

        const name   = lead.Last_Name || lead.name || 'Student';
        const area   = lead.Area      || lead.area || 'N/A';
        const phone  = lead.Phone     || lead.phone || 'N/A';
        const budget = lead.Budget    || lead.budget || 'N/A';

        const event = {
            summary:     `PG Visit — ${name} — ${area}`,
            description: `Student: ${name}\nPhone: ${phone}\nArea: ${area}\nBudget: ${budget}\n\nAuto-created by TheCommun bot`,
            start: { dateTime: visitDate.toISOString(), timeZone: 'Asia/Kolkata' },
            end:   { dateTime: endDate.toISOString(),   timeZone: 'Asia/Kolkata' },
            reminders: {
                useDefault: false,
                overrides: [
                    { method: 'popup', minutes: 60 },
                    { method: 'popup', minutes: 15 },
                ],
            },
        };

        const response = await calendar.events.insert({ calendarId, requestBody: event });
        logger.info(`[Calendar] Event created: ${response.data.htmlLink}`);
        return response.data;
    } catch (error) {
        logger.error('[Calendar] Failed to create event:', error.message);
        throw error;
    }
}

/**
 * Clean up "garbage" listings — close rows where rent, area, and BHK/type are all empty.
 * These are usually listings that got saved when parser failed (Drive invalid_grant etc).
 */
async function cleanupGarbageListings() {
    try {
        const rows = await getSheetRows();
        if (!rows || rows.length <= 1) return { scanned: 0, closed: 0 };

        let closed = 0;
        const closedRows = [];

        for (let i = 1; i < rows.length; i++) {
            const [listingId, status, area, bhkType, rent] = rows[i];
            if (!listingId) continue;
            if (status && status.toUpperCase() === 'CLOSED') continue;

            const hasRent = rent && String(rent).replace(/[^0-9]/g, '').length > 0;
            const hasArea = area && String(area).trim().length > 0;
            const hasBhk  = bhkType && String(bhkType).trim().length > 0;

            // Garbage = no rent AND (no area OR no bhk)
            if (!hasRent && (!hasArea || !hasBhk)) {
                try {
                    await sheets.spreadsheets.values.update({
                        spreadsheetId: GOOGLE_SHEET_ID,
                        range: `Sheet1!B${i + 1}`,
                        valueInputOption: 'USER_ENTERED',
                        resource: { values: [['CLOSED']] },
                    });
                    closedRows.push(listingId);
                    closed++;
                } catch (err) {
                    logger.error(`[Cleanup] Failed to close row ${i + 1}:`, err.message);
                }
            }
        }

        invalidateSheetCache();
        logger.info(`[Cleanup] Closed ${closed} garbage listings: ${closedRows.join(', ')}`);
        return { scanned: rows.length - 1, closed, closedIds: closedRows };
    } catch (error) {
        logger.error('[Cleanup] Error:', error);
        throw error;
    }
}

/**
 * Clears all data rows from the inventory sheet. Keeps row 1 (headers).
 * DESTRUCTIVE — used only by explicit admin action.
 */
async function clearAllListings() {
    try {
        // Step 1: Clear all existing rows (including any stale/corrupted rows up to row 10000)
        await sheets.spreadsheets.values.clear({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: `Sheet1!A2:V10000`,
        });

        // Step 2: Set proper 22-column headers in row 1
        const headers = [
            'Listing ID', 'Status', 'Area', 'BHK/Type', 'Rent',
            'Furnishing', 'Possession', 'Floor', 'Services/Amenities',
            'Photo 1', 'Photo 2', 'Photo 3', 'Photo 4',
            'Video 1', 'Video 2',
            'Listed On', 'Raw Message',
            'Property Name', 'Sharing', 'Restrictions', 'Exclusions', 'Property Category',
        ];
        await sheets.spreadsheets.values.update({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: 'Sheet1!A1:V1',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [headers] },
        });

        invalidateSheetCache();
        logger.warn(`[ClearAll] Sheet cleared and headers reset.`);
        return { cleared: true, headersReset: true, columnCount: 22 };
    } catch (error) {
        logger.error('[ClearAll] Error:', error);
        throw error;
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
    createCalendarEvent,
    getSheetRows,
    cleanupGarbageListings,
    clearAllListings,
};
