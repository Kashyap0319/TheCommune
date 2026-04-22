const axios = require('axios');
const logger = require('../utils/logger');

const { WA_ACCESS_TOKEN } = process.env;

const WA_API_VERSION = process.env.WA_API_VERSION || 'v18.0';
const WA_TIMEOUT_MS = 10000;

/**
 * Send a generic text message back to the WhatsApp user.
 * @param {string} to - The recipient's phone number
 * @param {string} text - The message to send
 * @param {string} phoneNumberId - The sending phone number ID
 */
async function sendMessage(to, text, phoneNumberId) {
    try {
        const url = `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`;
        const data = {
            messaging_product: 'whatsapp',
            to: to,
            text: { body: text },
        };

        const headers = {
            'Authorization': `Bearer ${WA_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        };

        const response = await axios.post(url, data, { headers, timeout: WA_TIMEOUT_MS });
        logger.info(`[WA] Sent message to ${to}`);
        return response.data;
    } catch (error) {
        logger.error(`[WA] Failed to send message to ${to}:`, error.response?.data || error.message);
        throw error;
    }
}

/**
 * Sends a pre-approved template message to start a conversation to the WhatsApp user.
 * @param {string} to - The recipient's phone number
 * @param {string} templateName - The name of the template
 * @param {string} phoneNumberId - The sending phone number ID
 * @param {string} language - The language code (e.g., 'en_US')
 */
// Send approved template with optional body variable ({{message}} named param)
async function sendTemplateMessage(to, templateName, phoneNumberId, bodyText = null, language = 'en') {
    try {
        const url = `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`;

        const template = {
            name: templateName,
            language: { code: language },
        };

        if (bodyText) {
            template.components = [{
                type: 'body',
                parameters: [
                    { type: 'text', text: String(bodyText).slice(0, 900) },   // {{1}} message
                ],
            }];
        }

        const data = { messaging_product: 'whatsapp', to, type: 'template', template };

        const headers = {
            'Authorization': `Bearer ${WA_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        };

        const response = await axios.post(url, data, { headers, timeout: WA_TIMEOUT_MS });
        logger.info(`[WA] Sent template '${templateName}' to ${to}`);
        return response.data;
    } catch (error) {
        logger.error(`[WA] Failed to send template to ${to}:`, error.response?.data || error.message);
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
        const url = `https://graph.facebook.com/${WA_API_VERSION}/${mediaId}`;
        const headers = { 'Authorization': `Bearer ${WA_ACCESS_TOKEN}` };
        const response = await axios.get(url, { headers, timeout: WA_TIMEOUT_MS });
        return response.data.url;
    } catch (error) {
        logger.error(`[WA] Failed to get media URL for ${mediaId}:`, error.response?.data || error.message);
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
            responseType: 'stream',
            timeout: 180000, // 3 min — videos can be large
            maxContentLength: 100 * 1024 * 1024, // 100 MB
            maxBodyLength: 100 * 1024 * 1024,
        });
        return response;
    } catch (error) {
        logger.error(`[WA] Failed to download media:`, error.response?.data || error.message);
        throw error;
    }
}

/**
 * Send an image message with optional caption via WhatsApp.
 * @param {string} to - The recipient's phone number
 * @param {string} imageUrl - Public URL of the image
 * @param {string} caption - Caption text for the image
 * @param {string} phoneNumberId - The sending phone number ID
 */
async function sendImageMessage(to, imageUrl, caption = '', phoneNumberId) {
    try {
        const url = `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`;
        const data = {
            messaging_product: 'whatsapp',
            to: to,
            type: 'image',
            image: {
                link: imageUrl,
                caption: caption,
            },
        };

        const headers = {
            'Authorization': `Bearer ${WA_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        };

        const response = await axios.post(url, data, { headers, timeout: WA_TIMEOUT_MS });
        logger.info(`[WA] Sent image to ${to}`);
        return response.data;
    } catch (error) {
        logger.error(`[WA] Failed to send image to ${to}:`, error.response?.data || error.message);
        throw error;
    }
}

/**
 * Send a WhatsApp interactive button message (max 3 buttons).
 * @param {string} to - Recipient phone number
 * @param {string} bodyText - The message body text
 * @param {Array} buttons - Array of { id, title } objects (max 3)
 * @param {string} phoneNumberId - The sending phone number ID
 */
async function sendButtonMessage(to, bodyText, buttons, phoneNumberId) {
    try {
        const url = `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`;
        const data = {
            messaging_product: 'whatsapp',
            to: to,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: { text: bodyText },
                action: {
                    buttons: buttons.map(btn => ({
                        type: 'reply',
                        reply: { id: btn.id, title: btn.title }
                    }))
                }
            }
        };

        const headers = {
            'Authorization': `Bearer ${WA_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        };

        const response = await axios.post(url, data, { headers, timeout: WA_TIMEOUT_MS });
        logger.info(`[WA] Sent button message to ${to}`);
        return response.data;
    } catch (error) {
        logger.error(`[WA] Failed to send button message to ${to}:`, error.response?.data || error.message);
        throw error;
    }
}

/**
 * Send a WhatsApp interactive list message (up to 10 options).
 * @param {string} to - Recipient phone number
 * @param {string} bodyText - The message body text
 * @param {string} buttonLabel - The label on the list button (e.g. "Select Option")
 * @param {Array} rows - Array of { id, title, description? } objects
 * @param {string} phoneNumberId - The sending phone number ID
 */
async function sendListMessage(to, bodyText, buttonLabel, rows, phoneNumberId) {
    try {
        const url = `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`;
        const data = {
            messaging_product: 'whatsapp',
            to: to,
            type: 'interactive',
            interactive: {
                type: 'list',
                body: { text: bodyText },
                action: {
                    button: buttonLabel,
                    sections: [
                        {
                            title: 'Options',
                            rows: rows.map(row => ({
                                id: row.id,
                                title: row.title,
                                ...(row.description ? { description: row.description } : {})
                            }))
                        }
                    ]
                }
            }
        };

        const headers = {
            'Authorization': `Bearer ${WA_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        };

        const response = await axios.post(url, data, { headers, timeout: WA_TIMEOUT_MS });
        logger.info(`[WA] Sent list message to ${to}`);
        return response.data;
    } catch (error) {
        logger.error(`[WA] Failed to send list message to ${to}:`, error.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    sendMessage,
    sendTemplateMessage,
    sendImageMessage,
    sendButtonMessage,
    sendListMessage,
    getMediaUrl,
    downloadMedia,
};
