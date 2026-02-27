const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const {
    GOOGLE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_PRIVATE_KEY,
    GOOGLE_DRIVE_FOLDER_ID,
    GOOGLE_SHEET_ID
} = process.env;

// Initialize Google Auth
const auth = new google.auth.JWT(
    GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Fix multi-line private key
    ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']
);

const drive = google.drive({ version: 'v3', auth });
const sheets = google.sheets({ version: 'v4', auth });

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
        });

        // Make file readable to anyone with the link (optional/optional per client preference)
        await drive.permissions.create({
            fileId: file.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone',
            },
        });

        console.log(`Uploaded file to Drive: ${file.data.webViewLink}`);
        return file.data.webViewLink;
    } catch (error) {
        console.error("Error uploading to Google Drive:", error);
        throw error;
    }
}

/**
 * Appends a new property listing row to a Google Sheet.
 * @param {object} propertyData - Parsed property details
 * @param {string[]} mediaLinks - Array of Drive links for images/videos
 */
async function appendToInventorySheet(propertyData, mediaLinks) {
    try {
        const values = [
            [
                new Date().toISOString(), // Timestamp
                propertyData.area,
                propertyData.bhk,
                propertyData.rent,
                propertyData.furnishing,
                propertyData.available_date,
                mediaLinks.join(', '), // Media Links column
                'AVAILABLE' // Status
            ]
        ];

        const response = await sheets.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: 'Sheet1!A:H', // Adjust range/sheet name as needed
            valueInputOption: 'USER_ENTERED',
            resource: { values },
        });

        console.log(`Added listing to Google Sheet:`, response.data.updates.updatedRange);
        return response.data;
    } catch (error) {
        console.error("Error appending to Google Sheet:", error);
        throw error;
    }
}

module.exports = {
    uploadToDrive,
    appendToInventorySheet,
};
