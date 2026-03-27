/**
 * Creates a new Google Sheet with IMPORTRANGE from the original inventory sheet,
 * then shares it with Kanak's email address.
 *
 * Run: node scripts/create-kanak-sheet.js
 */

require('dotenv').config();
const { google } = require('googleapis');

const ORIGINAL_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const KANAK_EMAIL = 'kanakmurarka.thecommun@gmail.com';

const privateKey = process.env.GOOGLE_PRIVATE_KEY
    ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/\\/g, '')
    : '';

// Use OAuth2 (Kanak's account) — has Drive quota + permission to create files
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    'https://lovely-adventure-production-719e.up.railway.app/google/callback',
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });

async function main() {
    const sheetsClient = google.sheets({ version: 'v4', auth: oauth2Client });
    const driveClient  = google.drive({ version: 'v3', auth: oauth2Client });

    // 1. Create new spreadsheet
    console.log('Creating new spreadsheet...');
    const created = await sheetsClient.spreadsheets.create({
        requestBody: {
            properties: {
                title: 'The Commūn — Property Inventory (View)',
            },
            sheets: [{
                properties: { title: 'Listings' },
            }],
        },
    });

    const newSheetId   = created.data.spreadsheetId;
    const newSheetUrl  = created.data.spreadsheetUrl;
    console.log(`Created: ${newSheetUrl}`);

    // 2. Add header row + IMPORTRANGE formula
    // Row 1: headers matching original sheet columns A–M
    const headers = [
        'Listing ID', 'Status', 'Area', 'BHK / Type', 'Rent',
        'Furnishing', 'Available Date', 'Floor', 'Amenities',
        'Photo Links', 'Video Links', 'Listed On', 'Raw Message',
    ];

    // IMPORTRANGE pulls all data from original (A2:M onwards — skip header)
    // We put our own header in row 1 and use IMPORTRANGE starting row 2
    await sheetsClient.spreadsheets.values.batchUpdate({
        spreadsheetId: newSheetId,
        requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: [
                // Header row
                {
                    range: 'Listings!A1:M1',
                    values: [headers],
                },
                // IMPORTRANGE formula — pulls rows 2 onwards from original
                {
                    range: 'Listings!A2',
                    values: [[`=IMPORTRANGE("https://docs.google.com/spreadsheets/d/${ORIGINAL_SHEET_ID}", "Sheet1!A2:M")`]],
                },
            ],
        },
    });

    console.log('Added headers and IMPORTRANGE formula.');

    // 3. Format header row — bold + background
    const newSheetTabId = created.data.sheets[0].properties.sheetId;
    await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: newSheetId,
        requestBody: {
            requests: [
                // Bold header
                {
                    repeatCell: {
                        range: {
                            sheetId: newSheetTabId,
                            startRowIndex: 0,
                            endRowIndex: 1,
                        },
                        cell: {
                            userEnteredFormat: {
                                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                                backgroundColor: { red: 0.1, green: 0.1, blue: 0.18 },
                            },
                        },
                        fields: 'userEnteredFormat(textFormat,backgroundColor)',
                    },
                },
                // Freeze header row
                {
                    updateSheetProperties: {
                        properties: {
                            sheetId: newSheetTabId,
                            gridProperties: { frozenRowCount: 1 },
                        },
                        fields: 'gridProperties.frozenRowCount',
                    },
                },
            ],
        },
    });

    console.log('Formatted header row.');

    // 4. Share with Kanak (editor access so she can see/share but not break the formula)
    await driveClient.permissions.create({
        fileId: newSheetId,
        requestBody: {
            type: 'user',
            role: 'writer',
            emailAddress: KANAK_EMAIL,
        },
        sendNotificationEmail: true,
        emailMessage: 'Here is your live property inventory view for The Commūn. It auto-syncs from the main listing database.',
    });

    console.log(`\nShared with ${KANAK_EMAIL}`);
    console.log(`\n✅ Done! New sheet URL:\n   ${newSheetUrl}`);
    console.log(`\nNOTE: When Kanak first opens the sheet, she'll see a prompt`);
    console.log(`to "Allow Access" for the IMPORTRANGE connection — she just needs to click Allow once.`);
}

main().catch(err => {
    console.error('Error:', err.message || err);
    process.exit(1);
});
