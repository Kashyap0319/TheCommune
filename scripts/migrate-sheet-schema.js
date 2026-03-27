/**
 * Migrates the original inventory sheet from 13-column to 17-column schema.
 *
 * Old: A=ListingID B=Status C=Area D=BHK E=Rent F=Furnishing G=AvailDate H=Floor
 *      I=Amenities J=PhotoLinks(multi,\n) K=VideoLinks(multi,\n) L=ListedOn M=RawMsg
 *
 * New: A=ListingID B=Status C=Area D=BHK E=Rent F=Furnishing G=AvailDate H=Floor
 *      I=Amenities J=Photo1 K=Photo2 L=Photo3 M=Photo4 N=Video1 O=Video2
 *      P=ListedOn Q=RawMsg
 *
 * Run: node scripts/migrate-sheet-schema.js
 */

require('dotenv').config();
const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const privateKey = process.env.GOOGLE_PRIVATE_KEY
    ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/\\/g, '')
    : '';

const serviceAuth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: privateKey,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

function hyperlink(url, label) {
    return url ? `=HYPERLINK("${url}","${label}")` : '';
}

function extractUrls(cell) {
    if (!cell) return [];
    return String(cell).split('\n').map(s => s.trim()).filter(Boolean);
}

async function main() {
    const sheetsClient = google.sheets({ version: 'v4', auth: serviceAuth });

    // 1. Read all existing data
    const res = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Sheet1!A:M',
    });
    const rows = res.data.values || [];
    console.log(`Read ${rows.length} rows (including header)`);

    // 2. Build new data array
    const newRows = [];

    // Header row
    newRows.push([
        'Listing ID', 'Status', 'Area', 'BHK / Type', 'Rent',
        'Furnishing', 'Available Date', 'Floor', 'Amenities',
        'Photo 1', 'Photo 2', 'Photo 3', 'Photo 4',
        'Video 1', 'Video 2',
        'Listed On', 'Raw Message',
    ]);

    // Data rows (skip row 0 = old header)
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const [listingId, status, area, bhk, rent, furnishing,
               availDate, floor, amenities, photoCol, videoCol, listedOn, rawMsg] = r;

        const photos = extractUrls(photoCol);
        const videos = extractUrls(videoCol);

        newRows.push([
            listingId  || '',
            status     || '',
            area       || '',
            bhk        || '',
            rent       || '',
            furnishing || '',
            availDate  || '',
            floor      || '',
            amenities  || '',
            hyperlink(photos[0], 'Photo 1'),
            hyperlink(photos[1], 'Photo 2'),
            hyperlink(photos[2], 'Photo 3'),
            hyperlink(photos[3], 'Photo 4'),
            hyperlink(videos[0], 'Video 1'),
            hyperlink(videos[1], 'Video 2'),
            listedOn   || '',
            rawMsg     || '',
        ]);
    }

    // 3. Clear old range and write new data
    await sheetsClient.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: 'Sheet1!A:Q',
    });
    console.log('Cleared A:Q');

    await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Sheet1!A1',
        valueInputOption: 'USER_ENTERED',
        resource: { values: newRows },
    });
    console.log(`Wrote ${newRows.length} rows with new schema`);

    // 4. Format header row
    const info = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const tabId = info.data.sheets[0].properties.sheetId;

    await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
            requests: [
                {
                    repeatCell: {
                        range: { sheetId: tabId, startRowIndex: 0, endRowIndex: 1 },
                        cell: {
                            userEnteredFormat: {
                                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                                backgroundColor: { red: 0.1, green: 0.1, blue: 0.18 },
                            },
                        },
                        fields: 'userEnteredFormat(textFormat,backgroundColor)',
                    },
                },
                {
                    updateSheetProperties: {
                        properties: {
                            sheetId: tabId,
                            gridProperties: { frozenRowCount: 1 },
                        },
                        fields: 'gridProperties.frozenRowCount',
                    },
                },
            ],
        },
    });
    console.log('Formatted header row');

    // 5. Update Kanak's view sheet IMPORTRANGE range
    const KANAK_SHEET_ID = '17zxcLCYjEsG1cfZN-IwYxcjQU0aGO_VUwrHUP54jR_A';
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_OAUTH_CLIENT_ID,
        process.env.GOOGLE_OAUTH_CLIENT_SECRET,
        'https://lovely-adventure-production-719e.up.railway.app/google/callback',
    );
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
    const kanakSheets = google.sheets({ version: 'v4', auth: oauth2Client });

    await kanakSheets.spreadsheets.values.update({
        spreadsheetId: KANAK_SHEET_ID,
        range: 'Listings!A2',
        valueInputOption: 'USER_ENTERED',
        resource: {
            values: [[`=IMPORTRANGE("https://docs.google.com/spreadsheets/d/${SHEET_ID}", "Sheet1!A2:Q")`]],
        },
    });
    console.log("Updated Kanak's IMPORTRANGE to A:Q");

    console.log('\n✅ Migration complete!');
    console.log(`Original: https://docs.google.com/spreadsheets/d/${SHEET_ID}`);
    console.log(`Kanak's:  https://docs.google.com/spreadsheets/d/${KANAK_SHEET_ID}`);
}

main().catch(err => {
    console.error('Error:', err.message || err);
    process.exit(1);
});
