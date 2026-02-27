const axios = require('axios');

const { IG_PAGE_ACCESS_TOKEN } = process.env;

/**
 * Send an Instagram Direct Message back to the user.
 * @param {string} recipientId - The Instagram IGID of the recipient
 * @param {string} text - The message to send
 */
async function sendInstagramMessage(recipientId, text) {
    try {
        const url = `https://graph.facebook.com/v18.0/me/messages`;
        const data = {
            recipient: { id: recipientId },
            message: { text: text },
            messaging_type: 'RESPONSE',
        };

        const headers = {
            'Authorization': `Bearer ${IG_PAGE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        };

        const response = await axios.post(url, data, { headers });
        console.log(`Successfully sent IG DM to ${recipientId}`);
        return response.data;
    } catch (error) {
        console.error(`Failed to send IG DM to ${recipientId}:`, error.response?.data || error.message);
        throw error;
    }
}

/**
 * Send a Private Reply to an Instagram comment.
 * @param {string} commentId - The ID of the comment to reply to
 * @param {string} text - The message to send
 */
async function sendInstagramPrivateReply(commentId, text) {
    try {
        const url = `https://graph.facebook.com/v18.0/me/messages`;
        const data = {
            recipient: { comment_id: commentId },
            message: { text: text },
        };

        const headers = {
            'Authorization': `Bearer ${IG_PAGE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        };

        const response = await axios.post(url, data, { headers });
        console.log(`Successfully sent IG Private Reply to comment ${commentId}`);
        return response.data;
    } catch (error) {
        console.error(`Failed to send IG Private Reply:`, error.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    sendInstagramMessage,
    sendInstagramPrivateReply,
};
