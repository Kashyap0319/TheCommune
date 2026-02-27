require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

// Import services
const { getMediaUrl, downloadMedia, sendMessage } = require('./services/whatsapp');
const { sendInstagramMessage, sendInstagramPrivateReply } = require('./services/instagram');
const { processChatMessage, parsePropertyListing } = require('./services/openai');
const { createLead } = require('./services/zoho');
const { uploadToDrive, appendToInventorySheet } = require('./services/google');

// In-memory sessions for listing flow (Kanak's media uploads)
const listingSessions = {};

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;

// ----------------------------------------------------
// META WEBHOOK VERIFICATION (Needed for WhatsApp & IG)
// ----------------------------------------------------
app.get('/webhook', (req, res) => {
    // Parse params from the webhook verification request
    let mode = req.query['hub.mode'];
    let token = req.query['hub.verify_token'];
    let challenge = req.query['hub.challenge'];

    // Check if a token and mode were sent
    if (mode && token) {
        // Check the mode and token sent are correct
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            return res.status(200).send(challenge);
        } else {
            return res.sendStatus(403);
        }
    }
    return res.status(400).send('Missing params');
});

// ----------------------------------------------------
// RECEIVE MESSAGES FROM WHATSAPP / IG
// ----------------------------------------------------
app.post('/webhook', async (req, res) => {
    const body = req.body;

    console.log(`\n\nIncoming Webhook Event:`, JSON.stringify(body, null, 2));

    // 1. WHATSAPP HANDLER
    if (body.object === 'whatsapp_business_account') {
        const value = body.entry[0].changes[0].value;
        if (value.messages && value.messages[0]) {
            const message = value.messages[0];
            const from = message.from;
            const isAdmin = from === process.env.KANAK_PHONE_NUMBER;

            console.log(`[WhatsApp] Message from ${from} (Admin: ${isAdmin})`);

            try {
                // --- ADMIN / LISTING FLOW ---
                if (isAdmin) {
                    let mediaLinks = [];

                    // A. Handle Media (Images/Videos)
                    if (message.type === 'image' || message.type === 'video') {
                        const mediaId = message.image ? message.image.id : message.video.id;
                        const mimeType = message.image ? message.image.mime_type : message.video.mime_type;

                        console.log(`[Listing Flow] Downloading media ${mediaId}...`);
                        const mediaUrl = await getMediaUrl(mediaId);
                        const mediaStream = await downloadMedia(mediaUrl);

                        const fileName = `${Date.now()}_${mediaId}`;
                        const driveLink = await uploadToDrive(mediaStream.data, fileName, mimeType);

                        // Store link in a session for Kanak so it can be combined with text later
                        if (!listingSessions[from]) listingSessions[from] = { media: [] };
                        listingSessions[from].media.push(driveLink);

                        await sendMessage(from, "Media saved! Send the listing text to finalize.");
                        return res.sendStatus(200);
                    }

                    // B. Handle Text (Parsing)
                    if (message.type === 'text') {
                        const msg_body = message.text.body;
                        console.log(`[Listing Flow] Parsing text: ${msg_body}`);

                        const propertyData = await parsePropertyListing(msg_body);
                        const media = (listingSessions[from] && listingSessions[from].media) || [];

                        await appendToInventorySheet(propertyData, media);

                        // Clear session
                        delete listingSessions[from];

                        await sendMessage(from, `✅ Listing Added!\nArea: ${propertyData.area}\nBHK: ${propertyData.bhk}\nRent: ${propertyData.rent}\nMedia: ${media.length} files`);
                        return res.sendStatus(200);
                    }
                }

                // --- NORMAL LEAD FLOW ---
                if (message.type === 'text') {
                    const msg_body = message.text.body;
                    const { reply, leadData } = await processChatMessage(from, msg_body);
                    await sendMessage(from, reply);

                    if (leadData) {
                        await createLead(leadData, from);
                        console.log("[WhatsApp] Lead created in Zoho.");
                    }
                }
            } catch (error) {
                console.error("[WhatsApp] Error processing message:", error);
            }
        }
        return res.sendStatus(200);
    }

    // 2. INSTAGRAM HANDLER
    if (body.object === 'instagram') {
        if (
            body.entry &&
            body.entry[0].messaging &&
            body.entry[0].messaging[0] &&
            body.entry[0].messaging[0].message
        ) {
            let senderId = body.entry[0].messaging[0].sender.id;
            let msg_body = body.entry[0].messaging[0].message.text;

            console.log(`[Instagram] Message from ${senderId}: ${msg_body}`);

            try {
                const { reply, leadData } = await processChatMessage(senderId, msg_body);
                await sendInstagramMessage(senderId, reply);

                if (leadData) {
                    await createLead(leadData, `IG:${senderId}`);
                    console.log("[Instagram] Lead created in Zoho.");
                }
            } catch (error) {
                console.error("[Instagram] Error processing message:", error);
            }
        }

        // 2b. INSTAGRAM COMMENT HANDLER
        if (
            body.entry[0].changes &&
            body.entry[0].changes[0].value.item === 'comment' &&
            body.entry[0].changes[0].value.verb === 'add'
        ) {
            let commentId = body.entry[0].changes[0].value.id;
            let msg_body = body.entry[0].changes[0].value.text;
            let senderId = body.entry[0].changes[0].value.from.id;

            console.log(`[Instagram Comment] From ${senderId}: ${msg_body}`);

            try {
                // For comments, we initiate the conversation with a Private Reply (DM)
                const { reply, leadData } = await processChatMessage(senderId, msg_body);
                await sendInstagramPrivateReply(commentId, reply);

                if (leadData) {
                    await createLead(leadData, `IG:${senderId}`);
                    console.log("[Instagram Comment] Lead created in Zoho.");
                }
            } catch (error) {
                console.error("[Instagram Comment] Error processing message:", error);
            }
        }

        return res.sendStatus(200);
    }

    // Default 404 if object unknown
    res.sendStatus(404);
});


// ----------------------------------------------------
// START SERVER
// ----------------------------------------------------
app.listen(PORT, () => {
    console.log(`Caratsene Backend listening at http://localhost:${PORT}`);
    console.log(`Webhook URL for Meta: https://<your-ngrok-url>/webhook`);
    console.log(`Verification Token: ${VERIFY_TOKEN}`);
});
