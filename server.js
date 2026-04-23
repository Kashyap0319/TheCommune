require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');

// ----------------------------------------------------
// ENV VALIDATION — fail fast on missing critical vars
// ----------------------------------------------------
const REQUIRED_ENV = [
    'META_WEBHOOK_VERIFY_TOKEN',
    'BROKER_WA_PHONE_NUMBER_ID',
    'WA_ACCESS_TOKEN',
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
    logger.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
}

// Import services
const { sendMessage, sendImageMessage, sendButtonMessage, sendListMessage, getMediaUrl, downloadMedia, sendTemplateMessage } = require('./services/whatsapp');
const { sendInstagramMessage, sendInstagramPrivateReply, sendInstagramPublicReply } = require('./services/instagram');
const { processChatMessage, formatSearchResults, rankListingsWithAI, parsePropertyListing, transcribeAndSummarizeCall, generateListingConfirmation } = require('./services/openai');
const { createLead, updateLead, searchLeadByPhone, createNote } = require('./services/zoho');
const { startAutomation, enqueueLeadFollowUps, sendBulkMessage, handleZohoStageChange, getQueueStats, assignAgent } = require('./services/automation');
const { searchInventory, uploadToDrive, appendToInventorySheet, closeListingById, addMediaLinkToRow, createCalendarEvent, getSheetRows, cleanupGarbageListings, clearAllListings } = require('./services/google');

const app = express();

// ----------------------------------------------------
// SECURITY MIDDLEWARE
// ----------------------------------------------------
app.set('trust proxy', 1);
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:    ["'self'"],
            scriptSrc:     ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://unpkg.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc:      ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc:       ["'self'", "https://fonts.gstatic.com"],
            imgSrc:        ["'self'", "data:", "https:"],
            connectSrc:    ["'self'"],
            frameSrc:      ["https://calendly.com"],
        },
    },
}));
app.use(bodyParser.json({ limit: '1mb' }));

// Serve the website (Module E) from the /public folder
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;
const STUDENT_WA_PHONE_NUMBER_ID = process.env.STUDENT_WA_PHONE_NUMBER_ID;
const BROKER_WA_PHONE_NUMBER_ID = process.env.BROKER_WA_PHONE_NUMBER_ID;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

// ----------------------------------------------------
// RATE LIMITERS
// ----------------------------------------------------
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,     // 1 minute
    max: 300,                 // Meta sends multiple events per second; keep generous
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
});

const leadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,                   // Max 10 lead form submissions per IP per 15 min
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests. Please try again later.' },
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
});

// In-memory store for Kanak's pending listings (photo received before text)
const kanakPendingMedia = {};

// Deduplication: track processed WhatsApp message IDs to prevent double-processing
const processedMessageIds = new Set();
const MAX_PROCESSED_IDS = 10000;

// Instagram: track users already DM'd (send welcome only once per user)
const igDmSentUsers = new Set();

// 60-second media grouping window
const GROUPING_WINDOW_SECONDS = parseInt(process.env.GROUPING_WINDOW_SECONDS || '60', 10);
const lastTextTime = {};     // { sender: timestamp_in_seconds }
const lastListingId = {};    // { sender: last_listing_id }
const lastListingText = {};  // { sender: last_text_hash } — for duplicate detection

// ----------------------------------------------------
// IN-MEMORY STORE CLEANUP — run every 2 hours
// Prevents unbounded memory growth from inactive users
// ----------------------------------------------------
const STORE_TTL_SECONDS = 2 * 60 * 60; // 2 hours
setInterval(() => {
    const now = Date.now() / 1000;
    let cleaned = 0;
    for (const key of Object.keys(lastTextTime)) {
        if (now - lastTextTime[key] > STORE_TTL_SECONDS) {
            delete lastTextTime[key];
            delete lastListingId[key];
            delete lastListingText[key];
            delete kanakPendingMedia[key];
            cleaned++;
        }
    }
    if (cleaned > 0) logger.info(`[Cleanup] Removed ${cleaned} stale in-memory entries`);
}, 2 * 60 * 60 * 1000).unref();

// Indian mobile number: 10 digits starting with 6-9
const PHONE_REGEX = /^[6-9]\d{9}$/;

// ----------------------------------------------------
// HEALTH CHECK
// ----------------------------------------------------
// ----------------------------------------------------
// ZOHO OAUTH CALLBACK — auto saves refresh token to .env
// ----------------------------------------------------
app.get('/zoho/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send('❌ No code received.');

    try {
        const response = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
            params: {
                code,
                client_id: process.env.ZOHO_CLIENT_ID,
                client_secret: process.env.ZOHO_CLIENT_SECRET,
                redirect_uri: 'http://localhost:3000/zoho/callback',
                grant_type: 'authorization_code'
            }
        });

        const refreshToken = response.data.refresh_token;
        if (!refreshToken) {
            return res.send('❌ No refresh token returned. Check scopes or try again.<br>Response: ' + JSON.stringify(response.data));
        }

        // Write to .env file
        const fs = require('fs');
        const envPath = require('path').join(__dirname, '.env');
        let envContent = fs.readFileSync(envPath, 'utf8');
        envContent = envContent.replace(/ZOHO_REFRESH_TOKEN=.*/, `ZOHO_REFRESH_TOKEN=${refreshToken}`);
        fs.writeFileSync(envPath, envContent);

        // Update running process
        process.env.ZOHO_REFRESH_TOKEN = refreshToken;

        logger.info('[Zoho] Refresh token saved successfully');
        res.send('✅ Zoho connected! Refresh token saved to .env. You can close this tab.');
    } catch (e) {
        logger.error('[Zoho] OAuth callback error:', e.response?.data || e.message);
        res.send('❌ Error: ' + JSON.stringify(e.response?.data || e.message));
    }
});

// ----------------------------------------------------
// GOOGLE DRIVE OAUTH CALLBACK — auto saves refresh token to .env
// ----------------------------------------------------
app.get('/google/auth', (_req, res) => {
    const { oauth2Client } = require('./services/google');
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/drive.file'],
    });
    res.redirect(url);
});

app.get('/google/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send('❌ No code received.');

    try {
        const { oauth2Client } = require('./services/google');
        const { tokens } = await oauth2Client.getToken(code);

        if (!tokens.refresh_token) {
            return res.send('❌ No refresh token returned. Try again.');
        }

        oauth2Client.setCredentials(tokens);
        process.env.GOOGLE_OAUTH_REFRESH_TOKEN = tokens.refresh_token;

        logger.info('[Google] OAuth refresh token received — set it in Railway env vars');
        res.send(`✅ Google Drive connected!<br><br>Refresh Token (copy this):<br><code>${tokens.refresh_token}</code><br><br>Now set this in Railway dashboard as GOOGLE_OAUTH_REFRESH_TOKEN.`);
    } catch (e) {
        logger.error('[Google] OAuth callback error:', e.response?.data || e.message);
        res.send('❌ Error: ' + JSON.stringify(e.response?.data || e.message));
    }
});

app.get('/admin', (_req, res) => res.redirect('/admin.html'));

app.get('/health', (_req, res) => {
    res.status(200).json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});

// ----------------------------------------------------
// WEBSITE LEAD FORM → ZOHO CRM
// ----------------------------------------------------
app.post('/lead', leadLimiter, async (req, res) => {
    const { name, phone, type, area, budget, gender } = req.body;

    if (!name || !phone || !type || !area || !budget) {
        return res.status(400).json({ message: 'Missing required fields.' });
    }

    // Validate and sanitize inputs
    const cleanName = String(name).trim().substring(0, 100);
    const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
    const cleanArea = String(area).trim().substring(0, 100);
    const cleanBudget = String(budget).trim().substring(0, 50);
    const cleanType = String(type).trim().substring(0, 50);
    const cleanGender = gender ? String(gender).trim().substring(0, 50) : '';

    if (cleanName.length < 2) {
        return res.status(400).json({ message: 'Invalid name.' });
    }
    if (!PHONE_REGEX.test(cleanPhone)) {
        return res.status(400).json({ message: 'Invalid phone number. Enter a valid 10-digit Indian mobile number.' });
    }

    const leadData = {
        property_type: cleanType,
        area: cleanArea,
        budget: cleanBudget,
        gender: cleanGender,
        name: cleanName,
        source: 'Website Form',
    };

    try {
        const existingWebLead = await searchLeadByPhone(cleanPhone);
        if (existingWebLead?.id) {
            await updateLead(existingWebLead.id, leadData);
            logger.info(`[Website Lead] Updated existing lead for ${cleanPhone}`);
        } else {
            await createLead(leadData, cleanPhone);
            logger.info(`[Website Lead] New lead from ${cleanName} (${cleanPhone})`);
        }
        enqueueLeadFollowUps(cleanPhone, leadData);
        return res.status(200).json({ message: 'Lead received.' });
    } catch (error) {
        logger.error('[Website Lead] Error saving lead in Zoho:', error.message);
        return res.status(500).json({ message: 'Could not save your enquiry. Please try again.' });
    }
});

// ----------------------------------------------------
// META WEBHOOK VERIFICATION (Needed for WhatsApp & IG)
// ----------------------------------------------------
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            logger.info('[Webhook] Verified');
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
app.post('/webhook', webhookLimiter, async (req, res) => {
    const body = req.body;

    // Respond immediately so Meta doesn't retry
    res.sendStatus(200);

    // Guard against malformed payloads
    if (!body || !body.object || !body.entry || !body.entry[0]) return;

    logger.debug(`[Webhook] object="${body.object}"`);

    // 1. WHATSAPP HANDLER
    if (body.object === 'whatsapp_business_account') {
        const value = body.entry[0]?.changes?.[0]?.value;
        const metadata = value?.metadata;
        const phoneNumberId = metadata?.phone_number_id;

        if (!value?.messages?.[0]) return;

        const message = value.messages[0];
        const from = message.from;

        // --- DEDUPLICATION ---
        const messageId = message.id;
        if (messageId && processedMessageIds.has(messageId)) {
            logger.debug(`[WhatsApp] Duplicate ${messageId}, skipping`);
            return;
        }
        if (messageId) {
            processedMessageIds.add(messageId);
            if (processedMessageIds.size > MAX_PROCESSED_IDS) {
                processedMessageIds.delete(processedMessageIds.values().next().value);
            }
        }

        logger.info(`[WhatsApp] Message from ${from} to phone ID ${phoneNumberId}, type: ${message.type}`);

        try {
            // MODULE F: BROKER / KANAK LISTING INTAKE (Routed by arriving Phone Number ID)
            if (phoneNumberId === BROKER_WA_PHONE_NUMBER_ID) {
                await handleKanakMessage(from, message, phoneNumberId);
                return;
            }

            // MODULE B: NORMAL USER CHATBOT FLOW (Routed by arriving Phone Number ID)
            if (phoneNumberId === STUDENT_WA_PHONE_NUMBER_ID) {
                const isText = message.type === 'text';
                const isInteractive = message.type === 'interactive';

                if (isText || isInteractive) {
                    const msg_body = isText ? message.text?.body : null;

                    // Lookup once — reused for auto-save + flow completion (avoids duplicate API call)
                    let cachedZohoLead = null;
                    try {
                        cachedZohoLead = await searchLeadByPhone(from);
                        if (!cachedZohoLead) {
                            const created = await createLead({ source: 'WhatsApp Chatbot', area: '', budget: '', property_type: '' }, from);
                            const createdId = created?.data?.[0]?.details?.id;
                            if (createdId) cachedZohoLead = { id: createdId };
                            logger.info(`[WhatsApp] New contact auto-saved to Zoho: ${from}`);
                        }
                    } catch (e) {
                        logger.warn(`[WhatsApp] Auto-save to Zoho failed for ${from}:`, e.message);
                    }

                    const { replyText, nextStep, leadData, searchFilters, isHotLead, humanHandoff }
                        = await processChatMessage(from, msg_body, message);

                // Send confirmation / reply text FIRST
                if (replyText) {
                    await sendMessage(from, replyText, phoneNumberId);
                }

                if (nextStep) {
                    if (nextStep.inputType === 'button') {
                        await sendButtonMessage(from, nextStep.question, nextStep.options, phoneNumberId);
                    } else if (nextStep.inputType === 'list') {
                        await sendListMessage(from, nextStep.question, nextStep.buttonLabel, nextStep.options, phoneNumberId);
                    }
                }

                // PROPERTY SEARCH (Module F — Flow 2) — runs AFTER confirmation msg
                if (searchFilters) {
                    logger.info(`[WhatsApp] Search request:`, searchFilters);
                    const allListings = await searchInventory(searchFilters);
                    const ranked = await rankListingsWithAI(searchFilters, allListings);

                    if (!ranked || ranked.length === 0) {
                        // No results — connect student to agent directly
                        const noResultMsg = `😔 *No listings found* for your requirements right now.\n\n` +
                            `But don't worry — our agent will personally find the best options for you!\n\n` +
                            `📞 Contact our agent directly:\n` +
                            `👉 wa.me/917977070447\n\n` +
                            `_Share your requirements and they'll get back to you within 30 minutes._\n\n` +
                            `🔗 Check us out:\n` +
                            `🌐 https://linktr.ee/commun.mumbai\n` +
                            `📸 https://www.instagram.com/commun.mumbai`;
                        await sendMessage(from, noResultMsg, phoneNumberId);
                    } else {
                        const searchReply = formatSearchResults(ranked);
                        await sendMessage(from, searchReply, phoneNumberId);
                    }

                    // Convert Google Drive view URLs to direct image URLs for WhatsApp
                    function driveDirectUrl(url) {
                        if (!url) return url;
                        const m = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
                        if (m) return `https://drive.google.com/uc?export=view&id=${m[1]}`;
                        const m2 = url.match(/drive\.google\.com\/open\?id=([^&]+)/);
                        if (m2) return `https://drive.google.com/uc?export=view&id=${m2[1]}`;
                        return url;
                    }

                    // Send photos only for AVAILABLE listings
                    const availableWithPhotos = ranked
                        .filter(r => r.status === 'AVAILABLE' && r.photoLinks?.length > 0)
                        .slice(0, 4);

                    for (const listing of availableWithPhotos) {
                        for (let pi = 0; pi < listing.photoLinks.length; pi++) {
                            const caption = pi === 0
                                ? `📸 *${[listing.bhk, listing.area].filter(Boolean).join(' — ')}*${listing.rent ? ' | ₹' + listing.rent + '/mo' : ''} (${pi + 1}/${listing.photoLinks.length})`
                                : `Photo ${pi + 1}/${listing.photoLinks.length}`;
                            try {
                                await sendImageMessage(from, driveDirectUrl(listing.photoLinks[pi]), caption, phoneNumberId);
                                await new Promise(r => setTimeout(r, 600)); // avoid Meta rate limit
                            } catch (imgErr) {
                                logger.error(`[WhatsApp] Photo send failed for ${listing.listingId}:`, imgErr.message);
                            }
                        }
                    }

                    // Always send closing contact message (even if listings were found)
                    if (ranked && ranked.length > 0) {
                        const closingMsg = `📞 For more options, contact our agent directly:\n` +
                            `👉 wa.me/917977070447\n\n` +
                            `_Share your requirements and they'll get back to you within 30 minutes._\n\n` +
                            `🔗 Check us out:\n` +
                            `🌐 https://linktr.ee/commun.mumbai\n` +
                            `📸 https://www.instagram.com/commun.mumbai`;
                        await sendMessage(from, closingMsg, phoneNumberId);
                    }
                }

                if (leadData) {
                    let zohoResult;
                    if (cachedZohoLead?.id) {
                        zohoResult = await updateLead(cachedZohoLead.id, leadData);
                        logger.info(`[WhatsApp] Lead updated in Zoho: ${cachedZohoLead.id}. Hot lead: ${isHotLead}`);
                    } else {
                        zohoResult = await createLead(leadData, from);
                        logger.info(`[WhatsApp] Lead created in Zoho. Hot lead: ${isHotLead}`);
                    }
                    enqueueLeadFollowUps(from, leadData);

                    // Human handoff → add note on lead in Zoho CRM
                    if (humanHandoff) {
                        try {
                            const leadId = cachedZohoLead?.id || zohoResult?.data?.[0]?.details?.id;
                            if (leadId) {
                                await createNote(leadId,
                                    '👤 Human Handoff Requested',
                                    `Student +${from} selected "Talk to Human" in the chatbot.\n\n` +
                                    `🏠 Type: ${leadData.property_type || 'N/A'}\n` +
                                    `📍 Area: ${leadData.area || 'N/A'}\n` +
                                    `💰 Budget: ${leadData.budget || 'N/A'}\n\n` +
                                    `Please follow up manually.`
                                );
                                logger.info(`[WhatsApp] Human handoff note added to lead ${leadId}`);
                            }
                        } catch (noteErr) {
                            logger.error('[WhatsApp] Handoff note failed:', noteErr.message);
                        }
                    }

                    // Notify assigned agent for every new lead
                    if (BROKER_WA_PHONE_NUMBER_ID) {
                        const assignedAgent = assignAgent(leadData.area);
                        const agentPhone = assignedAgent || process.env.KANAK_PHONE_NUMBER;
                        if (agentPhone) {
                            const urgency = isHotLead ? '🔥 *HOT LEAD* — ' : '';
                            const agentAlert = `${urgency}*New Lead Assigned*\n\n` +
                                `📱 Phone: +${from}\n` +
                                `📍 Area: ${leadData.area || 'N/A'}\n` +
                                `🏠 Type: ${leadData.property_type || 'N/A'}\n` +
                                `💰 Budget: ${leadData.budget || 'N/A'}\n` +
                                `📅 Moving in: ${leadData.timeline || 'N/A'}\n` +
                                (isHotLead ? `\n_Urgent — follow up ASAP!_` : `\n_Please reach out within 24 hours._`);
                            try {
                                await sendMessage(agentPhone, agentAlert, BROKER_WA_PHONE_NUMBER_ID);
                                logger.info(`[Agent Notify] Alert sent to ${agentPhone} for lead +${from}`);
                            } catch (alertErr) {
                                logger.error('[Agent Notify] Failed:', alertErr.message);
                            }
                        }
                    }
                }
                // CLOSE if (isText || isInteractive) {
                }
            } else {
                logger.warn(`[WhatsApp] Message received on unknown phone_number_id: ${phoneNumberId}`);
            }
        } catch (error) {
            logger.error('[WhatsApp] Error processing message:', error.message);
        }
        return;
    }

    // 2. INSTAGRAM HANDLER
    if (body.object === 'instagram') {
        const entry = body.entry[0];

        if (entry.messaging?.[0]?.message) {
            const messaging = entry.messaging[0];
            const senderId = messaging.sender.id;
            const msg_body = messaging.message.text;
            const pageIgId = entry.id;

            // Skip echo messages
            if (senderId === pageIgId || messaging.message.is_echo) {
                logger.debug(`[Instagram] Skipping echo message`);
                return;
            }

            logger.info(`[Instagram] DM from ${senderId}: ${msg_body}`);

            // Skip if already sent welcome DM to this user
            if (igDmSentUsers.has(senderId)) {
                logger.info(`[Instagram] Already DM'd user ${senderId}, skipping.`);
                return;
            }

            const IG_DM_REPLY = `Hey! 🦉\nWelcome to The Commūn's Community.\n\n` +
                `We're here to help students and parents navigate college admissions and the move to Mumbai — from finding the right place to stay to figuring out the admission process.\n\n` +
                `Here's what The Commūn can help you with:\n` +
                `🏠 Hostels & Flats near major colleges\n` +
                `🎓 Admission Guidance and Direct Admissions\n` +
                `📚 Entrance Prep Kits\n\n` +
                `WhatsApp: wa.me/917977070447 📲\n` +
                `🔗 https://linktr.ee/commun.mumbai\n\n` +
                `Let us know how we can help you, and our team would be happy to help ✨\n\n` +
                `Love,\nThe Commūn`;

            try {
                await sendInstagramMessage(senderId, IG_DM_REPLY);
                igDmSentUsers.add(senderId);
                logger.info('[Instagram] Sent DM with WhatsApp redirect.');
            } catch (error) {
                logger.error('[Instagram] Error processing message:', error.message);
            }
        }

        // 2b. INSTAGRAM COMMENT HANDLER — auto-DM on any comment
        const change = entry.changes?.[0]?.value;
        if (change && change.id) {
            const commentId = change.id;
            const commenterId = change.from?.id;

            // Skip if no commenter ID or if already messaged this user
            if (!commenterId || igDmSentUsers.has(commenterId)) {
                if (commenterId) logger.info(`[Instagram] Already DM'd user ${commenterId}, skipping.`);
                return;
            }

            logger.info(`[Instagram] Comment from ${commenterId}: ${change.text || '(no text)'}`);

            const IG_COMMENT_DM = `Hey! 🦉\nWelcome to The Commūn's Community.\n\n` +
                `We're here to help students and parents navigate college admissions and the move to Mumbai — from finding the right place to stay to figuring out the admission process.\n\n` +
                `Here's what The Commūn can help you with:\n` +
                `🏠 Hostels & Flats near major colleges\n` +
                `🎓 Admission Guidance and Direct Admissions\n` +
                `📚 Entrance Prep Kits\n\n` +
                `WhatsApp: wa.me/917977070447 📲\n` +
                `🔗 https://linktr.ee/commun.mumbai\n\n` +
                `Let us know how we can help you, and our team would be happy to help ✨\n\n` +
                `Love,\nThe Commūn`;

            try {
                await sendInstagramPrivateReply(commentId, IG_COMMENT_DM);
                igDmSentUsers.add(commenterId);
                logger.info(`[Instagram] Sent welcome DM to commenter ${commenterId}`);
            } catch (error) {
                logger.error(`[Instagram] Comment DM failed for ${commenterId}:`, error.message);
            }
        }

        return;
    }

    // Unknown object type — already sent 200 above
});


// ----------------------------------------------------
// MODULE C: IVR / PHONE CALL ROUTING (Exotel)
// ----------------------------------------------------

app.post('/ivr/menu', (req, res) => {
    logger.info('[IVR] Incoming call from:', req.body.From || req.body.CallFrom || 'unknown');

    const menuXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Welcome to The Commun. For Andheri properties, press 1. For Vile Parle, press 2. For Bandra, press 3. For other areas, press 4.</Say>
    <Gather action="/ivr/route" method="POST" numDigits="1" timeout="10">
    </Gather>
    <Say>We did not receive any input. Goodbye.</Say>
</Response>`;

    res.set('Content-Type', 'application/xml');
    res.send(menuXml);
});

app.post('/ivr/route', (req, res) => {
    const digit = String(req.body.digits || req.body.Digits || '4').trim();
    logger.info(`[IVR] User pressed: ${digit}`);

    const routeMap = {
        '1': { area: 'Andheri', agent: process.env.AGENT_PHONE_ANDHERI || '0000000000' },
        '2': { area: 'Vile Parle', agent: process.env.AGENT_PHONE_VILEPARLE || '0000000000' },
        '3': { area: 'Bandra', agent: process.env.AGENT_PHONE_BANDRA || '0000000000' },
        '4': { area: 'Other', agent: process.env.AGENT_PHONE_OTHER || '0000000000' },
    };

    const route = routeMap[digit] || routeMap['4'];

    const routeXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Connecting you to our ${route.area} specialist. Please hold.</Say>
    <Dial record="true" action="/ivr/status">
        <Number>${route.agent}</Number>
    </Dial>
</Response>`;

    res.set('Content-Type', 'application/xml');
    res.send(routeXml);
});

app.post('/ivr/status', async (req, res) => {
    res.sendStatus(200); // Respond immediately to Exotel

    const { CallSid, From, RecordingUrl, Duration, Status } = req.body;
    logger.info(`[IVR] Call ended — From: ${From}, Duration: ${Duration}s, Status: ${Status}`);

    try {
        if (!RecordingUrl) return;

        // Step 1: Download recording from Exotel
        let audioBuffer;
        try {
            const audioResponse = await axios.get(RecordingUrl, {
                responseType: 'arraybuffer',
                timeout: 30000,
                auth: process.env.EXOTEL_API_KEY && process.env.EXOTEL_API_TOKEN ? {
                    username: process.env.EXOTEL_API_KEY,
                    password: process.env.EXOTEL_API_TOKEN,
                } : undefined,
            });
            audioBuffer = Buffer.from(audioResponse.data);
            logger.info(`[IVR] Downloaded recording: ${audioBuffer.length} bytes`);
        } catch (dlErr) {
            logger.error('[IVR] Failed to download recording:', dlErr.message);
            return;
        }

        // Step 2: Transcribe + summarize with Gemini
        const { transcript, summary } = await transcribeAndSummarizeCall(audioBuffer, 'audio/mpeg');
        logger.info(`[IVR] Summary:`, summary);

        // Step 3: Find matching lead in Zoho and attach note
        const callerPhone = From || '';
        const lead = await searchLeadByPhone(callerPhone);

        if (lead) {
            const noteTitle = `📞 IVR Call — ${Duration}s — ${new Date().toLocaleDateString('en-IN')}`;
            const noteContent = `**Call Summary:**\n${summary}\n\n` +
                `**Full Transcript:**\n${transcript}\n\n` +
                `**Recording:** ${RecordingUrl}\n` +
                `**Duration:** ${Duration}s | **Call SID:** ${CallSid}`;
            await createNote(lead.id, noteTitle, noteContent);
            logger.info(`[IVR] Transcript attached to lead ${lead.id}`);
        } else {
            logger.info(`[IVR] No matching lead for ${callerPhone}. Creating new lead.`);
            await createLead({
                area: 'IVR Call',
                budget: 'N/A',
                sharing: 'N/A',
                timeline: 'N/A',
                contract: 'N/A',
                property_type: 'IVR Enquiry',
                source: 'IVR Call',
            }, callerPhone);
        }
    } catch (error) {
        logger.error('[IVR] Error processing call status:', error.message);
    }
});


// ----------------------------------------------------
// MODULE F: KANAK LISTING INTAKE HANDLER
// ----------------------------------------------------

function generateListingId() {
    return 'LST-' + crypto.randomUUID().substring(0, 8).toUpperCase();
}

async function handleKanakMessage(from, message, phoneNumberId) {
    const isText = message.type === 'text';
    const isImage = message.type === 'image';
    const isVideo = message.type === 'video';
    const isDocument = message.type === 'document';

    if (isImage || isVideo || isDocument) {
        const mediaObj = message[message.type];
        const mediaId = mediaObj.id;
        const caption = mediaObj.caption || '';

        logger.info(`[Kanak] Received ${message.type} (ID: ${mediaId})`);

        try {
            const mediaUrl = await getMediaUrl(mediaId);
            const mediaResponse = await downloadMedia(mediaUrl);

            const mimeType = mediaObj.mime_type || (isImage ? 'image/jpeg' : 'video/mp4');
            const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('png') ? 'png' : mimeType.includes('mp4') ? 'mp4' : 'file';
            const fileName = `listing_${Date.now()}.${ext}`;

            const driveLink = await uploadToDrive(mediaResponse.data, fileName, mimeType);
            logger.info(`[Kanak] Uploaded to Drive: ${driveLink}`);

            const lastTime = lastTextTime[from];
            const currentTime = Date.now() / 1000;
            const withinWindow = lastTime && (currentTime - lastTime) < GROUPING_WINDOW_SECONDS;

            if (withinWindow && lastListingId[from]) {
                await addMediaLinkToRow(lastListingId[from], driveLink, mimeType);
                logger.info(`[Kanak] Photo attached to listing ${lastListingId[from]}`);
                await sendMessage(from, `📸 Photo attached to listing *${lastListingId[from]}*`, phoneNumberId);
            } else {
                if (!kanakPendingMedia[from]) kanakPendingMedia[from] = { links: [], mimes: [] };
                kanakPendingMedia[from].links.push(driveLink);
                kanakPendingMedia[from].mimes.push(mimeType);

                if (caption && caption.length > 15) {
                    const listingId = generateListingId();
                    const propertyData = await parsePropertyListing(caption);
                    const mediaLinks = kanakPendingMedia[from]?.links || [];
                    const mediaMimes = kanakPendingMedia[from]?.mimes || [];
                    await appendToInventorySheet(listingId, propertyData, mediaLinks, from, caption, mediaMimes);

                    const confirmMsg = generateListingConfirmation(listingId, propertyData, mediaLinks);
                    await sendMessage(from, confirmMsg, phoneNumberId);

                    lastTextTime[from] = Date.now() / 1000;
                    lastListingId[from] = listingId;
                    delete kanakPendingMedia[from];
                } else {
                    const mediaLabel = isVideo ? '🎥 Video' : '📸 Photo';
                    await sendMessage(from, `${mediaLabel} received & uploaded! Send the listing details as text and I'll add it to the inventory.`, phoneNumberId);
                }
            }
        } catch (err) {
            logger.error('[Kanak] Media processing error:', err.message);
            await sendMessage(from, `❌ Error processing media: ${err.message}`, phoneNumberId);
        }
        return;
    }

    if (isText) {
        const text = message.text.body;

        // ─── #broadcast command ───
        // Format: #broadcast <area|all>\n<message>
        // Example: #broadcast vile parle\nHey! New PG available. Interested?
        // Example: #broadcast all\nSeason offer! 10% off first month.
        const broadcastMatch = text.match(/^#broadcast\s+(.+?)\n([\s\S]+)$/i);
        if (broadcastMatch) {
            const areaFilter = broadcastMatch[1].trim().toLowerCase();
            const broadcastMsg = broadcastMatch[2].trim();

            if (!broadcastMsg) {
                await sendMessage(from, `⚠️ Format:\n#broadcast <area|all>\n<message>\n\nExample:\n#broadcast vile parle\nNew PG available!`, phoneNumberId);
                return;
            }

            await sendMessage(from, `⏳ Fetching leads from Zoho for *${areaFilter}*...`, phoneNumberId);

            try {
                const axios = require('axios');
                const token = await (async () => {
                    const res = await axios.post(process.env.ZOHO_AUTH_URL || 'https://accounts.zoho.in/oauth/v2/token', null, {
                        params: {
                            refresh_token: process.env.ZOHO_REFRESH_TOKEN,
                            client_id: process.env.ZOHO_CLIENT_ID,
                            client_secret: process.env.ZOHO_CLIENT_SECRET,
                            grant_type: 'refresh_token',
                        },
                        timeout: 15000,
                    });
                    return res.data.access_token;
                })();

                const criteria = areaFilter === 'all'
                    ? '(Lead_Status:equals:New Lead)'
                    : `((Lead_Status:equals:New Lead)and(Area:equals:${broadcastMatch[1].trim()}))`;

                const res = await axios.get(`${process.env.ZOHO_BASE_URL || 'https://www.zohoapis.in/crm/v3'}/Leads/search`, {
                    params: { criteria, per_page: 200 },
                    headers: { Authorization: `Zoho-oauthtoken ${token}` },
                    timeout: 15000,
                });

                const leads = res.data?.data || [];
                const phones = leads.map(l => (l.Phone || '').replace(/\D/g, '')).filter(Boolean);

                if (phones.length === 0) {
                    await sendMessage(from, `ℹ️ No leads found for *${areaFilter}*. Check Zoho CRM.`, phoneNumberId);
                    return;
                }

                await sendMessage(from, `📤 Sending to *${phones.length}* leads...\nThis may take a few minutes.`, phoneNumberId);

                const result = await sendBulkMessage(phones, broadcastMsg);

                await sendMessage(from,
                    `✅ *Broadcast Complete*\n\n` +
                    `📤 Sent: *${result.sent}*\n` +
                    `❌ Failed: *${result.failed}*\n` +
                    `📊 Total: *${phones.length}*`,
                    phoneNumberId
                );
            } catch (err) {
                logger.error('[Broadcast] Error:', err.response?.data || err.message);
                await sendMessage(from, `❌ Broadcast failed: ${err.message}`, phoneNumberId);
            }
            return;
        }

        const closeMatch = text.match(/^(?:close|taken|remove)?\s*(LST-[A-Z0-9]+)$/i);
        if (closeMatch) {
            const listingId = closeMatch[1].toUpperCase();
            const result = await closeListingById(listingId);
            await sendMessage(from, result.message, phoneNumberId);
            return;
        }

        const rowCloseMatch = text.match(/^(close|taken|remove)\s+#?(\d+)$/i);
        if (rowCloseMatch) {
            await sendMessage(from, `⚠️ Row-number closing is no longer supported. Please use the Listing ID (e.g. *close LST-XXXXXXXX*).`, phoneNumberId);
            return;
        }

        logger.info(`[Kanak] Received listing text: ${text.substring(0, 80)}...`);

        // Duplicate detection: same text within 60 sec → skip creating new listing
        const textKey = text.trim().toLowerCase().slice(0, 200);
        const now = Date.now() / 1000;
        if (lastListingText[from] === textKey && lastTextTime[from] && (now - lastTextTime[from]) < 60) {
            logger.info(`[Kanak] Duplicate listing text within 60s from ${from} — skipping`);
            await sendMessage(from, `⚠️ Same listing just saved as *${lastListingId[from]}* — not creating duplicate. If this is a new listing, wait a minute and try again.`, phoneNumberId);
            return;
        }

        try {
            const listingId = generateListingId();
            const propertyData = await parsePropertyListing(text);
            const mediaLinks = kanakPendingMedia[from]?.links || [];
            const mediaMimes = kanakPendingMedia[from]?.mimes || [];

            await appendToInventorySheet(listingId, propertyData, mediaLinks, from, text, mediaMimes);

            const confirmMsg = generateListingConfirmation(listingId, propertyData, mediaLinks);
            await sendMessage(from, confirmMsg, phoneNumberId);

            lastTextTime[from] = Date.now() / 1000;
            lastListingId[from] = listingId;
            lastListingText[from] = textKey;
            delete kanakPendingMedia[from];
        } catch (err) {
            logger.error('[Kanak] Listing processing error:', err.message);
            await sendMessage(from, `❌ Something went wrong saving this listing. Please try again.`, phoneNumberId);
        }
        return;
    }

    await sendMessage(from, `⚠️ I can only process text and photos for listings. Please send the property details as text or forward the broker message.`, phoneNumberId);
}


// ----------------------------------------------------
// MODULE D: ZOHO STAGE CHANGE WEBHOOK
// Zoho fires this when a lead's stage is updated in CRM
// Setup: Zoho CRM → Settings → Workflow Rules → Webhook → POST /zoho/notify
// ----------------------------------------------------
app.post('/zoho/notify', async (req, res) => {
    res.sendStatus(200); // respond immediately

    try {
        const body = req.body || {};

        // Handle all Zoho webhook formats
        let leads;
        if (body.leads) {
            leads = Array.isArray(body.leads) ? body.leads : [body.leads];
        } else if (body.data) {
            leads = Array.isArray(body.data) ? body.data : [body.data];
        } else if (body.Lead_Status) {
            leads = [body]; // flat params at top level
        } else {
            leads = [];
        }

        for (const lead of leads) {
            if (!lead || !lead.Lead_Status) continue;
            logger.info(`[Zoho Notify] Stage change — ${lead.Last_Name || 'Unknown'} → ${lead.Lead_Status}`);
            await handleZohoStageChange(lead);

            // A5: Auto-create Google Calendar event when lead moves to Visit Scheduled
            if (lead.Lead_Status?.toLowerCase() === 'visit scheduled') {
                createCalendarEvent(lead).catch(e => logger.error('[Calendar] Event creation failed:', e.message));
            }
        }
    } catch (err) {
        logger.error('[Zoho Notify] Error:', err.message);
    }
});

// ----------------------------------------------------
// ADMIN: DEBUG SEARCH — test what listings match given filters
// GET /api/debug-search?area=BKC+/+Santacruz+/+Bandra&minBudget=41667&stayType=PG+/+Hostel
// ----------------------------------------------------
// Read wider range (A:ZZ) to detect any data beyond column V
app.get('/api/debug-wide', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!INTERNAL_API_KEY || apiKey !== INTERNAL_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { google } = require('googleapis');
        const { oauth2Client } = require('./services/google');
        const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
        const r = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: 'Sheet1!A1:ZZ10',
            valueRenderOption: 'FORMULA',
        });
        const rows = r.data.values || [];
        res.json({
            rowCount: rows.length,
            rows: rows.map((row, i) => ({ rowIdx: i, length: row.length, cells: row })),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/debug-search', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!INTERNAL_API_KEY || apiKey !== INTERNAL_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const filters = {};
        if (req.query.area) filters.area = req.query.area;
        if (req.query.minBudget) filters.minBudget = parseInt(req.query.minBudget, 10);
        if (req.query.maxBudget) filters.maxBudget = parseInt(req.query.maxBudget, 10);
        if (req.query.stayType) filters.stayType = req.query.stayType;
        if (req.query.gender) filters.gender = req.query.gender;

        const rows = await getSheetRows();
        const matching = await searchInventory(filters);

        res.json({
            filters,
            totalRowsInSheet: rows.length - 1,
            matchCount: matching.length,
            rawRows: rows.slice(0, Math.min(rows.length, 10)).map((r, idx) => ({
                rowIdx: idx,
                length: r.length,
                cells: r,
            })),
            matches: matching.slice(0, 10).map(m => ({
                listingId: m.listingId, area: m.area, bhk: m.bhk, rent: m.rent,
                propertyName: m.propertyName, propertyCategory: m.propertyCategory,
                status: m.status, aboveBudget: m.aboveBudget,
            })),
        });
    } catch (err) {
        logger.error('[Debug] Error:', err.message);
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

// ----------------------------------------------------
// ADMIN: GET SHEET URL — returns the Google Sheet link for viewing
// ----------------------------------------------------
app.get('/api/sheet-url', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!INTERNAL_API_KEY || apiKey !== INTERNAL_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) return res.status(500).json({ error: 'Sheet ID not configured' });
    res.json({ url: `https://docs.google.com/spreadsheets/d/${sheetId}` });
});

// ----------------------------------------------------
// ADMIN: CLEAR ALL LISTINGS (destructive — for fresh start)
// POST /api/clear-all-listings  { confirm: "YES" }
// ----------------------------------------------------
app.post('/api/clear-all-listings', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!INTERNAL_API_KEY || apiKey !== INTERNAL_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (req.body?.confirm !== 'YES') {
        return res.status(400).json({ error: 'Missing confirmation. Send {"confirm":"YES"} in body.' });
    }
    try {
        const result = await clearAllListings();
        res.json(result);
    } catch (err) {
        logger.error('[ClearAll] Error:', err.message);
        res.status(500).json({ error: 'Clear failed: ' + err.message });
    }
});

// ----------------------------------------------------
// ADMIN: CLEANUP GARBAGE LISTINGS
// POST /api/cleanup-listings → auto-close listings with empty rent/area/bhk
// ----------------------------------------------------
app.post('/api/cleanup-listings', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!INTERNAL_API_KEY || apiKey !== INTERNAL_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const result = await cleanupGarbageListings();
        res.json(result);
    } catch (err) {
        logger.error('[Cleanup] Error:', err.message);
        res.status(500).json({ error: 'Cleanup failed' });
    }
});

// ----------------------------------------------------
// HEALTH CHECK — for Railway/uptime monitoring
// ----------------------------------------------------
app.get('/healthz', (_req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});

// ----------------------------------------------------
// ADMIN AUTH (used by admin.html login)
// ----------------------------------------------------
app.post('/api/admin-auth', (req, res) => {
    const { key } = req.body;
    if (key && key === INTERNAL_API_KEY) {
        return res.status(200).json({ ok: true });
    }
    return res.status(401).json({ error: 'Invalid key' });
});

// ----------------------------------------------------
// ADMIN: LOAD LEADS FROM ZOHO (for bulk broadcast)
// GET /api/zoho-leads?area=Vile+Parle&status=New+Lead
// ----------------------------------------------------
app.get('/api/zoho-leads', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!INTERNAL_API_KEY || apiKey !== INTERNAL_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const axios = require('axios');
        const tokenRes = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
            params: {
                refresh_token: process.env.ZOHO_REFRESH_TOKEN,
                client_id:     process.env.ZOHO_CLIENT_ID,
                client_secret: process.env.ZOHO_CLIENT_SECRET,
                grant_type:    'refresh_token',
            },
        });
        const token = tokenRes.data.access_token;

        const { area, status } = req.query;
        let leadsRes;

        if (area || status) {
            // Use search with criteria
            const parts = [];
            if (area)   parts.push(`(Area:equals:${area})`);
            if (status) parts.push(`(Lead_Status:equals:${status})`);
            leadsRes = await axios.get('https://www.zohoapis.in/crm/v3/Leads/search', {
                params: { criteria: parts.join('and'), per_page: 200 },
                headers: { Authorization: `Zoho-oauthtoken ${token}` },
            });
        } else {
            // No filters — get all leads
            leadsRes = await axios.get('https://www.zohoapis.in/crm/v3/Leads', {
                params: { per_page: 200, fields: 'Phone' },
                headers: { Authorization: `Zoho-oauthtoken ${token}` },
            });
        }

        const leads = leadsRes.data?.data || [];
        const phones = leads
            .map(l => (l.Phone || '').replace(/[^0-9]/g, ''))
            .filter(p => p.length >= 10);

        res.json({ total: phones.length, phones });
    } catch (err) {
        logger.error('[Admin] zoho-leads error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch leads from Zoho' });
    }
});

// ----------------------------------------------------
// ADMIN DASHBOARD STATS (A6)
// GET /api/stats — live numbers for admin panel
// ----------------------------------------------------
app.get('/api/stats', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!INTERNAL_API_KEY || apiKey !== INTERNAL_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const axios = require('axios');

        // 1. Zoho lead counts
        const tokenRes = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
            params: {
                refresh_token: process.env.ZOHO_REFRESH_TOKEN,
                client_id:     process.env.ZOHO_CLIENT_ID,
                client_secret: process.env.ZOHO_CLIENT_SECRET,
                grant_type:    'refresh_token',
            },
        });
        const token = tokenRes.data.access_token;
        const headers = { Authorization: `Zoho-oauthtoken ${token}` };

        // Count total records by paginating through all pages (Zoho's info.count = page count, not total)
        async function countAll(url, params = {}) {
            let total = 0;
            let page = 1;
            while (true) {
                try {
                    const res = await axios.get(url, {
                        params: { ...params, per_page: 200, page, fields: 'id' },
                        headers,
                    });
                    const records = res.data?.data || [];
                    total += records.length;
                    if (!res.data?.info?.more_records || page > 50) break; // safety: max 10,000 records
                    page++;
                } catch (err) {
                    if (err.response?.status === 204) break; // no records
                    return total;
                }
            }
            return total;
        }

        const [totalLeads, hotLeads, visitLeads] = await Promise.all([
            countAll('https://www.zohoapis.in/crm/v3/Leads'),
            countAll('https://www.zohoapis.in/crm/v3/Leads/search', { criteria: '(Hot_Lead:equals:true)' }).catch(() => 0),
            countAll('https://www.zohoapis.in/crm/v3/Leads/search', { criteria: '(Lead_Status:equals:Visit Scheduled)' }).catch(() => 0),
        ]);

        // 2. Inventory counts from Google Sheets
        let availableListings = 0, closedListings = 0;
        try {
            const rows = await getSheetRows();
            for (let i = 1; i < rows.length; i++) {
                const status = (rows[i][1] || '').toUpperCase();
                if (status === 'CLOSED') closedListings++;
                else availableListings++;
            }
        } catch (_) { /* sheet unavailable */ }

        // 3. Follow-up queue stats
        const queueStats = getQueueStats();

        res.json({
            leads:     { total: totalLeads, hot: hotLeads, visitScheduled: visitLeads },
            inventory: { available: availableListings, closed: closedListings },
            queue:     queueStats,
        });
    } catch (err) {
        logger.error('[Stats] Error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ----------------------------------------------------
// MODULE D: BULK MESSAGING (D1)
// POST /api/bulk-message { phones: [...], message }
// ----------------------------------------------------
app.post('/api/bulk-message', apiLimiter, async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!INTERNAL_API_KEY || apiKey !== INTERNAL_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized. Provide valid X-API-Key header.' });
    }

    const { phones, message: msgText } = req.body;

    if (!Array.isArray(phones) || phones.length === 0) {
        return res.status(400).json({ error: 'phones must be a non-empty array.' });
    }
    if (!msgText || typeof msgText !== 'string' || msgText.trim().length === 0) {
        return res.status(400).json({ error: 'message is required.' });
    }
    if (phones.length > 500) {
        return res.status(400).json({ error: 'Max 500 numbers per request.' });
    }

    // Respond immediately — bulk send runs in background
    res.status(202).json({ accepted: phones.length, status: 'sending' });

    sendBulkMessage(phones, msgText.trim())
        .then(result => logger.info(`[Bulk] Done — sent: ${result.sent}, failed: ${result.failed}`))
        .catch(err => logger.error('[Bulk] Job error:', err.message));
});

// ----------------------------------------------------
// MODULE D: FOLLOW-UP API (for N8N / external calls)
// POST /api/send-followup { phone, message }
// ----------------------------------------------------
app.post('/api/send-followup', apiLimiter, async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!INTERNAL_API_KEY || apiKey !== INTERNAL_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized. Provide valid X-API-Key header.' });
    }

    const { phone, message: msgText, template } = req.body;

    if (!phone || typeof phone !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid required field: phone' });
    }

    // Validate phone is numeric (WhatsApp format: country code + number)
    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
        return res.status(400).json({ error: 'Invalid phone number format.' });
    }

    try {
        // N8N Follows up on the Student bot
        if (template) {
            await sendTemplateMessage(cleanPhone, template, STUDENT_WA_PHONE_NUMBER_ID);
            logger.info(`[Follow-up API] Sent template '${template}' to ${cleanPhone}`);
        } else if (msgText && typeof msgText === 'string') {
            await sendMessage(cleanPhone, msgText.trim().substring(0, 4096), STUDENT_WA_PHONE_NUMBER_ID);
            logger.info(`[Follow-up API] Sent message to ${cleanPhone}`);
        } else {
            return res.status(400).json({ error: 'Provide either message or template.' });
        }

        return res.status(200).json({ success: true, phone: cleanPhone });
    } catch (error) {
        logger.error('[Follow-up API] Error:', error.response?.data || error.message);
        return res.status(500).json({ error: 'Failed to send message.' });
    }
});


// ----------------------------------------------------
// GOOGLE FORM WEBHOOKS → ZOHO CRM
// Flat form & Hostel form submissions via Google Apps Script
// ----------------------------------------------------
app.post('/form-webhook/flat', express.json(), async (req, res) => {
    try {
        const { name, phone, area, budget, bhk, possession, source } = req.body;
        if (!phone) return res.status(400).json({ error: 'Phone is required' });

        const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
        if (!PHONE_REGEX.test(cleanPhone)) {
            return res.status(400).json({ error: 'Invalid phone number' });
        }

        const leadData = {
            name: name || '',
            property_type: 'Flat',
            area: area || '',
            budget: budget || '',
            bhk: bhk || '',
            possession: possession || '',
            timeline: possession || '',
            source: source || 'Google Form (Flat)',
        };

        const existing = await searchLeadByPhone(cleanPhone);
        if (existing?.id) {
            await updateLead(existing.id, leadData);
            logger.info(`[Form Flat] Updated existing lead for ${cleanPhone}`);
        } else {
            await createLead(leadData, cleanPhone);
            logger.info(`[Form Flat] New lead: ${name || cleanPhone}`);
        }
        enqueueLeadFollowUps(cleanPhone, leadData);

        return res.status(200).json({ success: true });
    } catch (error) {
        logger.error('[Form Flat] Error:', error.message);
        return res.status(500).json({ error: 'Failed to save lead' });
    }
});

app.post('/form-webhook/hostel', express.json(), async (req, res) => {
    try {
        const { name, phone, area, budget, gender, sharing, timeline, source } = req.body;
        if (!phone) return res.status(400).json({ error: 'Phone is required' });

        const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
        if (!PHONE_REGEX.test(cleanPhone)) {
            return res.status(400).json({ error: 'Invalid phone number' });
        }

        const leadData = {
            name: name || '',
            property_type: 'PG / Hostel',
            area: area || '',
            budget: budget || '',
            gender: gender || '',
            sharing: sharing || '',
            timeline: timeline || '',
            source: source || 'Google Form (Hostel)',
        };

        const existing = await searchLeadByPhone(cleanPhone);
        if (existing?.id) {
            await updateLead(existing.id, leadData);
            logger.info(`[Form Hostel] Updated existing lead for ${cleanPhone}`);
        } else {
            await createLead(leadData, cleanPhone);
            logger.info(`[Form Hostel] New lead: ${name || cleanPhone}`);
        }
        enqueueLeadFollowUps(cleanPhone, leadData);

        return res.status(200).json({ success: true });
    } catch (error) {
        logger.error('[Form Hostel] Error:', error.message);
        return res.status(500).json({ error: 'Failed to save lead' });
    }
});

// ----------------------------------------------------
// GRACEFUL SHUTDOWN
// ----------------------------------------------------
function shutdown(signal) {
    logger.info(`[Server] Received ${signal}. Shutting down gracefully...`);
    server.close(() => {
        logger.info('[Server] HTTP server closed.');
        process.exit(0);
    });
    // Force exit after 10s if still hanging
    setTimeout(() => {
        logger.error('[Server] Force exit after 10s timeout');
        process.exit(1);
    }, 10000).unref();
}

// ----------------------------------------------------
// START SERVER
// ----------------------------------------------------
const server = app.listen(PORT, () => {
    logger.info(`The Commun Backend listening on port ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    startAutomation();
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    logger.error('[Server] Uncaught exception:', err.message, err.stack);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    logger.error('[Server] Unhandled rejection:', reason);
});
