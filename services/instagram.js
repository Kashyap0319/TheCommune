const axios = require('axios');
const logger = require('../utils/logger');

const { IG_PAGE_ACCESS_TOKEN } = process.env;
const IG_API_VERSION = process.env.IG_API_VERSION || 'v21.0';
const IG_TIMEOUT_MS = 10000;

async function sendInstagramMessage(recipientId, text) {
    try {
        const url = `https://graph.facebook.com/${IG_API_VERSION}/me/messages`;
        const data = {
            recipient: { id: recipientId },
            message: { text: text },
            messaging_type: 'RESPONSE',
        };
        const headers = {
            'Authorization': `Bearer ${IG_PAGE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        };
        const response = await axios.post(url, data, { headers, timeout: IG_TIMEOUT_MS });
        logger.info(`[IG] Sent DM to ${recipientId}`);
        return response.data;
    } catch (error) {
        logger.error(`[IG] Failed to send DM to ${recipientId}:`, error.response?.data || error.message);
        throw error;
    }
}

async function sendInstagramPrivateReply(commentId, text) {
    try {
        const url = `https://graph.facebook.com/${IG_API_VERSION}/me/messages`;
        const data = {
            recipient: { comment_id: commentId },
            message: { text: text },
        };
        const headers = {
            'Authorization': `Bearer ${IG_PAGE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        };
        const response = await axios.post(url, data, { headers, timeout: IG_TIMEOUT_MS });
        logger.info(`[IG] Sent private reply to comment ${commentId}`);
        return response.data;
    } catch (error) {
        logger.error(`[IG] Failed to send private reply:`, error.response?.data || error.message);
        throw error;
    }
}

async function sendInstagramPublicReply(commentId, text) {
    try {
        const url = `https://graph.facebook.com/${IG_API_VERSION}/${commentId}/replies`;
        const data = { message: text };
        const headers = {
            'Authorization': `Bearer ${IG_PAGE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        };
        const response = await axios.post(url, data, { headers, timeout: IG_TIMEOUT_MS });
        logger.info(`[IG] Sent public reply to comment ${commentId}`);
        return response.data;
    } catch (error) {
        logger.error(`[IG] Failed to send public reply:`, error.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    sendInstagramMessage,
    sendInstagramPrivateReply,
    sendInstagramPublicReply,
};
