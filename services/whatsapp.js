const axios = require('axios');

const { WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN } = process.env;

/**
 * Send a generic text message back to the WhatsApp user.
 * @param {string} to - The recipient's phone number
 * @param {string} text - The message to send
 */
async function sendMessage(to, text) {
    try {
        const url = `https://graph.facebook.com/v18.0/${WA_PHONE_NUMBER_ID}/messages`;
        const data = {
            messaging_product: 'whatsapp',
            to: to,
            text: { body: text },
        };

        const headers = {
            'Authorization': `Bearer ${WA_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        };

        const response = await axios.post(url, data, { headers });
        console.log(`Successfully sent message to ${to}`);
        return response.data;
    } catch (error) {
        console.error(`Failed to send message to ${to}:`, error.response?.data || error.message);
        throw error;
    }
}

/**
 * Sends a pre-approved template message to start a conversation to the WhatsApp user.
 * @param {string} to - The recipient's phone number
 * @param {string} templateName - The name of the template
 * @param {string} language - The language code (e.g., 'en_US')
 */
async function sendTemplateMessage(to, templateName, language = 'en_US') {
    try {
        const url = `https://graph.facebook.com/v18.0/${WA_PHONE_NUMBER_ID}/messages`;
        const data = {
            messaging_product: 'whatsapp',
            to: to,
            type: 'template',
            template: {
                name: templateName,
                language: { code: language },
            },
        };

        const headers = {
            'Authorization': `Bearer ${WA_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        };

        const response = await axios.post(url, data, { headers });
        console.log(`Successfully sent template '${templateName}' to ${to}`);
        return response.data;
    } catch (error) {
        console.error(`Failed to send template to ${to}:`, error.response?.data || error.message);
        throw error;
    }
}

/**
 * Gets the actual URL of a media file from its ID.
 * @param {string} mediaId - The ID of the media
 * @returns {string} The public URL for downloading
 */
async function getMediaUrl(mediaId) {
    try {
        const url = `https://graph.facebook.com/v18.0/${mediaId}`;
        const headers = { 'Authorization': `Bearer ${WA_ACCESS_TOKEN}` };
        const response = await axios.get(url, { headers });
        return response.data.url;
    } catch (error) {
        console.error(`Failed to get media URL for ${mediaId}:`, error.response?.data || error.message);
        throw error;
    }
}

/**
 * Downloads a media file as a stream.
 * @param {string} url - The URL obtained from getMediaUrl
 * @returns {Stream} The file stream
 */
async function downloadMedia(url) {
    try {
        const response = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${WA_ACCESS_TOKEN}` },
            responseType: 'stream'
        });
        return response;
    } catch (error) {
        console.error(`Failed to download media from ${url}:`, error.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    sendMessage,
    sendTemplateMessage,
    getMediaUrl,
    downloadMedia,
};
