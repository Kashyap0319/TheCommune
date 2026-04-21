/**
 * Module D — Automation Service
 *
 * D1: Bulk messaging       — sendBulkMessage() via /api/bulk-message endpoint
 * D2: Student Lifecycle    — enqueueLeadFollowUps() + handleZohoStageChange()
 * D3: Team Notifications   — 48h no-follow-up alert, weekly summary, round-robin assign
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const logger = require('../utils/logger');

const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, '../data');
const QUEUE_FILE = path.join(DATA_DIR, 'followup-queue.json');
const RR_FILE    = path.join(DATA_DIR, 'rr-counter.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // every hour

let _sendMessage;
function getSendMessage() {
    if (!_sendMessage) _sendMessage = require('./whatsapp').sendMessage;
    return _sendMessage;
}

let _sendTemplate;
function getSendTemplate() {
    if (!_sendTemplate) _sendTemplate = require('./whatsapp').sendTemplateMessage;
    return _sendTemplate;
}

const BROADCAST_TEMPLATE = process.env.WA_BROADCAST_TEMPLATE || 'broadcasting';

const STUDENT_PHONE_ID = () => process.env.STUDENT_WA_PHONE_NUMBER_ID;
const BROKER_PHONE_ID  = () => process.env.BROKER_WA_PHONE_NUMBER_ID;
const KANAK_PHONE      = () => process.env.KANAK_PHONE_NUMBER;

const ZOHO_BASE_URL = process.env.ZOHO_BASE_URL || 'https://www.zohoapis.in/crm/v3';
const ZOHO_AUTH_URL = process.env.ZOHO_AUTH_URL || 'https://accounts.zoho.in/oauth/v2/token';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function loadJSON(file, fallback) {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        logger.error(`[Automation] Failed to load ${file}:`, e.message);
    }
    return fallback;
}

function saveJSON(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (e) {
        logger.error(`[Automation] Failed to save ${file}:`, e.message);
    }
}

async function getZohoToken() {
    const res = await axios.post(ZOHO_AUTH_URL, null, {
        params: {
            refresh_token: process.env.ZOHO_REFRESH_TOKEN,
            client_id:     process.env.ZOHO_CLIENT_ID,
            client_secret: process.env.ZOHO_CLIENT_SECRET,
            grant_type:    'refresh_token',
        },
        timeout: 15000,
    });
    return res.data.access_token;
}

// ─────────────────────────────────────────────────────────────────────────────
// D3: ROUND-ROBIN ASSIGNMENT
// Area-based primary; round-robin fallback when area doesn't match
// ─────────────────────────────────────────────────────────────────────────────

// Parse a comma-separated env var into an array of phone numbers
function parseAgentPool(envVal) {
    if (!envVal) return [];
    return envVal.split(',').map(p => p.trim()).filter(Boolean);
}

function roundRobinFromPool(pool, poolKey) {
    if (pool.length === 0) return process.env.KANAK_PHONE_NUMBER || '';
    if (pool.length === 1) return pool[0];
    const counters = loadJSON(RR_FILE, {});
    const idx      = (counters[poolKey] || 0) % pool.length;
    counters[poolKey] = idx + 1;
    saveJSON(RR_FILE, counters);
    return pool[idx];
}

function getRoundRobinAgent() {
    // Global fallback pool — all Mumbai agents
    const pool = parseAgentPool(process.env.AGENT_PHONE_VILEPARLE);
    return roundRobinFromPool(pool, 'global');
}

function assignAgent(area) {
    const a = (area || '').toLowerCase();
    if ((a.includes('vile parle') || a.includes('andheri') || a.includes('juhu') || a.includes('svkm'))) {
        const pool = parseAgentPool(process.env.AGENT_PHONE_VILEPARLE);
        if (pool.length) return roundRobinFromPool(pool, 'vileparle');
    }
    if (a.includes('bandra') || a.includes('bkc') || a.includes('santacruz')) {
        const pool = parseAgentPool(process.env.AGENT_PHONE_BANDRA);
        if (pool.length) return roundRobinFromPool(pool, 'bandra');
    }
    if (a.includes('kharghar') || a.includes('navi mumbai') || a.includes('navi')) {
        const pool = parseAgentPool(process.env.AGENT_PHONE_NAVI);
        if (pool.length) return roundRobinFromPool(pool, 'navi');
    }
    if (a.includes('south') || a.includes('fort') || a.includes('mahalaxmi')) {
        const pool = parseAgentPool(process.env.AGENT_PHONE_OTHER);
        if (pool.length) return roundRobinFromPool(pool, 'south');
    }
    return getRoundRobinAgent();
}

// ─────────────────────────────────────────────────────────────────────────────
// D2: LIFECYCLE MESSAGE TEMPLATES (from proposal)
// ─────────────────────────────────────────────────────────────────────────────

const MESSAGES = {
    // Time-based — triggered on lead creation
    welcome: (l) =>
        `Hi ${l.name || 'there'}! 👋 Welcome to *The Commūn*.\n\n` +
        `We help NMIMS & Vile Parle students find verified PGs & flats — honest pricing, zero broker drama.\n\n` +
        `✅ Verified options near NMIMS / Vile Parle\n` +
        `✅ Vile Parle, Andheri, Bandra & nearby\n` +
        `✅ ₹8K to ₹35K+ options\n` +
        `✅ Single, double & triple sharing\n\n` +
        `Our team will reach out with matching options shortly! 🏠`,

    no_response_24h: (l) =>
        `Hey ${l.name || 'there'}! 👋 Still looking for accommodation in *${l.area || 'your area'}*?\n\n` +
        `We can help you find the right place fast. Reply *YES* and we'll send matching options right away!\n\n` +
        `— The Commūn`,

    still_cold_3d: (l) =>
        `Hi! Quick heads up 🏠\n\n` +
        `*2 PGs near NMIMS just got booked* this week — availability is filling up fast in *${l.area || 'Vile Parle'}*.\n\n` +
        `Don't miss out — reply *OPTIONS* to see what's still available in your budget of *${l.budget || 'your range'}*.\n\n` +
        `— The Commūn`,

    // Stage-based — triggered by Zoho webhook
    visit_reminder: (l) =>
        `Hi ${l.name || 'there'}! 🗓️ Reminder — your property visit is *tomorrow*!\n\n` +
        `📍 Location: *${l.area || 'as discussed'}*\n\n` +
        `Please confirm your timing with the agent. Any questions? Just reply here.\n` +
        `— The Commūn`,

    visited_not_confirmed: (l) =>
        `Hey ${l.name || 'there'}! Hope the visit went well 😊\n\n` +
        `Liked what you saw? Here are *2 similar options* in *${l.area || 'your area'}* you might love too.\n\n` +
        `Reply *MORE* to see listings, or *BOOK* to confirm the one you visited.\n\n` +
        `— The Commūn`,

    deal_closed: (l) =>
        `Congratulations ${l.name || ''}! 🎉 Welcome to The Commūn family!\n\n` +
        `*Your Move-In Checklist:*\n` +
        `☑️ Collect keys from owner / caretaker\n` +
        `☑️ Take photos of the room before moving in\n` +
        `☑️ Confirm electricity & WiFi setup\n` +
        `☑️ Save the owner's number\n` +
        `☑️ Read the agreement carefully before signing\n\n` +
        `Need anything? We're always here. Best of luck! 🏠`,

    moved_in_7d: (l) =>
        `Hey ${l.name || 'there'}! 👋 It's been a week — how's the PG going?\n\n` +
        `Settled in comfortably? Any issues with the place?\n\n` +
        `We're always here if you need help. Just reply anytime!\n\n` +
        `— The Commūn`,

    moved_in_30d: (l) =>
        `Hi ${l.name || 'there'}! 🙏\n\n` +
        `Hope you're loving your new place! Quick favour — do you know anyone looking for a PG or flat?\n\n` +
        `*Refer a friend → Get ₹500 off your next month's rent!* 🎁\n\n` +
        `Just share their number with us and we'll take it from there.\n\n` +
        `— The Commūn`,

    // Cold re-engagement — for leads who didn't convert
    cold_7d: (l) =>
        `Hi ${l.name || 'there'}! 👋 Still looking for a place in *${l.area || 'your area'}*?\n\n` +
        `It's been a week — we may have fresh options matching your budget.\n\n` +
        `Reply *OPTIONS* and we'll send the latest listings right away. 🏠\n\n` +
        `— The Commūn`,

    cold_14d: (l) =>
        `Hey ${l.name || 'there'}! 🏠 Still searching after 2 weeks?\n\n` +
        `We just got *new PG & flat listings* in *${l.area || 'your area'}* — some are going fast!\n\n` +
        `Reply *YES* to get verified options in your budget right now.\n\n` +
        `— The Commūn`,

    cold_30d: (l) =>
        `Hi ${l.name || 'there'}! One last check-in from The Commūn 🙏\n\n` +
        `It's been 30 days since you reached out. Still hunting for a place — or know someone who is?\n\n` +
        `Reply *HELP* and we'll personally assist you.\n\n` +
        `— The Commūn`,
};

// ─────────────────────────────────────────────────────────────────────────────
// D2: QUEUE — load / save
// ─────────────────────────────────────────────────────────────────────────────

function loadQueue()      { return loadJSON(QUEUE_FILE, []); }
function saveQueue(queue) { saveJSON(QUEUE_FILE, queue); }

// ─────────────────────────────────────────────────────────────────────────────
// D2: ENQUEUE TIME-BASED MESSAGES (on new lead creation)
// ─────────────────────────────────────────────────────────────────────────────

function enqueueLeadFollowUps(phone, leadData) {
    if (!phone) return;

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    const entries = [
        { phone, key: 'welcome',         sendAt: now + 5 * 60 * 1000, leadData, sent: false }, // 5 min
        { phone, key: 'no_response_24h', sendAt: now + DAY,           leadData, sent: false }, // 1 day
        { phone, key: 'still_cold_3d',   sendAt: now + 3 * DAY,       leadData, sent: false }, // 3 days
        { phone, key: 'cold_7d',         sendAt: now + 7 * DAY,       leadData, sent: false }, // 7 days
        { phone, key: 'cold_14d',        sendAt: now + 14 * DAY,      leadData, sent: false }, // 14 days
        { phone, key: 'cold_30d',        sendAt: now + 30 * DAY,      leadData, sent: false }, // 30 days
    ];

    const queue    = loadQueue();
    const filtered = queue.filter(e => !(e.phone === phone && !e.sent));
    filtered.push(...entries);
    saveQueue(filtered);
    logger.info(`[Automation] Follow-ups enqueued for ${phone}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// D2: HANDLE ZOHO STAGE CHANGE (called from POST /zoho/notify)
// ─────────────────────────────────────────────────────────────────────────────

async function handleZohoStageChange(leadRecord) {
    const stage      = (leadRecord.Lead_Status || '').toLowerCase().trim();
    const cleanPhone = (leadRecord.Phone || '').replace(/[^0-9]/g, '');

    if (!cleanPhone) return;

    const lead = {
        name:   leadRecord.Last_Name || '',
        area:   leadRecord.Area      || '',
        budget: leadRecord.Budget    || '',
    };

    const DAY   = 24 * 60 * 60 * 1000;
    const queue = loadQueue();

    if (stage === 'visit scheduled') {
        queue.push({ phone: cleanPhone, key: 'visit_reminder', sendAt: Date.now() + DAY, leadData: lead, sent: false });
        saveQueue(queue);
        logger.info(`[Automation] Visit reminder queued for ${cleanPhone}`);
    }

    else if (stage === 'visited') {
        queue.push({ phone: cleanPhone, key: 'visited_not_confirmed', sendAt: Date.now() + DAY, leadData: lead, sent: false });
        saveQueue(queue);
        logger.info(`[Automation] Post-visit follow-up queued for ${cleanPhone}`);
    }

    else if (stage === 'deal closed') {
        try {
            await getSendTemplate()(cleanPhone, BROADCAST_TEMPLATE, STUDENT_PHONE_ID(), MESSAGES.deal_closed(lead));
            logger.info(`[Automation] Move-in checklist sent to ${cleanPhone}`);
        } catch (err) {
            logger.error(`[Automation] Deal closed msg failed for ${cleanPhone}:`, err.message);
        }
    }

    else if (stage === 'moved in') {
        const now = Date.now();
        queue.push({ phone: cleanPhone, key: 'moved_in_7d',  sendAt: now + 7  * DAY, leadData: lead, sent: false });
        queue.push({ phone: cleanPhone, key: 'moved_in_30d', sendAt: now + 30 * DAY, leadData: lead, sent: false });
        saveQueue(queue);
        logger.info(`[Automation] Moved-in 7d + 30d follow-ups queued for ${cleanPhone}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// D2: PROCESS DUE MESSAGES (runs every hour)
// ─────────────────────────────────────────────────────────────────────────────

async function processDueFollowUps() {
    const queue = loadQueue();
    const now   = Date.now();
    let changed = false;

    for (const entry of queue) {
        if (entry.sent || entry.sendAt > now) continue;

        const templateFn = MESSAGES[entry.key];
        const message    = templateFn ? templateFn(entry.leadData || {}) : null;
        if (!message) { entry.sent = true; changed = true; continue; }

        try {
            await getSendTemplate()(entry.phone, BROADCAST_TEMPLATE, STUDENT_PHONE_ID(), message);
            logger.info(`[Automation] Sent '${entry.key}' to ${entry.phone}`);
            entry.sent = true;
            changed    = true;
        } catch (err) {
            logger.error(`[Automation] Failed '${entry.key}' for ${entry.phone}:`, err.message);
        }
    }

    if (changed) {
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        saveQueue(queue.filter(e => !e.sent || e.sendAt > cutoff));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// D1: BULK MESSAGING (called from /api/bulk-message)
// ─────────────────────────────────────────────────────────────────────────────

async function sendBulkMessage(phones, message, delayMs = 1500) {
    if (!phones || phones.length === 0) return { sent: 0, failed: 0, errors: [] };

    const sendDirect = getSendMessage();
    const sendTemplate = getSendTemplate();
    let sent = 0, failed = 0;
    const errors = [];

    for (const phone of phones) {
        const p = String(phone).replace(/\D/g, '');
        if (!p) continue;
        try {
            // Try direct message first (clean, no template wrapper). Works within 24h window.
            await sendDirect(p, message, STUDENT_PHONE_ID());
            sent++;
        } catch (err) {
            // Fallback to template if outside 24h window
            try {
                await sendTemplate(p, BROADCAST_TEMPLATE, STUDENT_PHONE_ID(), message);
                sent++;
            } catch (err2) {
                failed++;
                errors.push({ phone: p, error: err2.message });
                logger.error(`[Bulk] Failed for ${p}:`, err2.message);
            }
        }
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    }

    logger.info(`[Bulk] Done — sent: ${sent}, failed: ${failed}`);
    return { sent, failed, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// D3: 48H NO FOLLOW-UP REMINDER
// ─────────────────────────────────────────────────────────────────────────────

async function check48hNoFollowUp() {
    try {
        const token = await getZohoToken();

        const res = await axios.get(`${ZOHO_BASE_URL}/Leads/search`, {
            params:  { criteria: `(Lead_Status:equals:New Lead)`, per_page: 100 },
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            timeout: 15000,
        });

        const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
        const stale  = (res.data?.data || []).filter(l =>
            !l.Last_Messaged_At || new Date(l.Last_Messaged_At) < cutoff
        );

        if (stale.length === 0) return;

        // Group by agent
        const byAgent = {};
        for (const lead of stale) {
            const agent = lead.Assigned_Agent || KANAK_PHONE();
            if (!agent) continue;
            if (!byAgent[agent]) byAgent[agent] = [];
            byAgent[agent].push(lead);
        }

        const sendMessage = getSendMessage();
        for (const [agentPhone, leads] of Object.entries(byAgent)) {
            const lines = leads.slice(0, 10).map((l, i) =>
                `${i + 1}. *${l.Last_Name || 'Unknown'}* — ${l.Area || 'N/A'} — 📞 ${l.Phone || 'N/A'}`
            );
            const msg =
                `⚠️ *Follow-Up Reminder — The Commūn*\n\n` +
                `${leads.length} lead(s) not contacted in 48+ hours:\n\n` +
                lines.join('\n') +
                `\n\n_Please follow up today and log in Zoho CRM._`;

            try {
                await sendMessage(agentPhone, msg, BROKER_PHONE_ID());
                logger.info(`[Automation] 48h reminder → ${agentPhone}`);
            } catch (err) {
                logger.error(`[Automation] 48h reminder failed for ${agentPhone}:`, err.message);
            }
            await new Promise(r => setTimeout(r, 1000));
        }
    } catch (err) {
        logger.error('[Automation] 48h check error:', err.response?.data || err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// D3: WEEKLY SUMMARY — every Monday 10 AM IST
// ─────────────────────────────────────────────────────────────────────────────

async function sendWeeklySummary() {
    logger.info('[Automation] Running weekly summary...');
    try {
        const token = await getZohoToken();

        const res = await axios.get(`${ZOHO_BASE_URL}/Leads`, {
            params:  { per_page: 200, sort_by: 'Created_Time', sort_order: 'desc' },
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            timeout: 15000,
        });

        const since    = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const leads    = (res.data?.data || []).filter(l => new Date(l.Created_Time) > since);

        const total   = leads.length;
        const hot     = leads.filter(l => l.Hot_Lead).length;
        const closed  = leads.filter(l => (l.Lead_Status || '').toLowerCase() === 'deal closed').length;
        const movedIn = leads.filter(l => (l.Lead_Status || '').toLowerCase() === 'moved in').length;
        const pending = leads.filter(l => (l.Lead_Status || '').toLowerCase() === 'new lead').length;

        // Per-agent breakdown
        const byAgent = {};
        for (const l of leads) {
            const a = l.Assigned_Agent || 'Unassigned';
            if (!byAgent[a]) byAgent[a] = { total: 0, closed: 0 };
            byAgent[a].total++;
            if ((l.Lead_Status || '').toLowerCase() === 'deal closed') byAgent[a].closed++;
        }

        const agentLines = Object.entries(byAgent)
            .map(([a, s]) => `• ...${a.slice(-4)}: ${s.total} leads, ${s.closed} closed`)
            .join('\n');

        const msg =
            `📊 *Weekly Summary — The Commūn*\n` +
            `_${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}_\n\n` +
            `📥 New leads: *${total}*\n` +
            `🔥 Hot leads: *${hot}*\n` +
            `✅ Deals closed: *${closed}*\n` +
            `🏠 Moved in: *${movedIn}*\n` +
            `⏳ Still pending: *${pending}*\n\n` +
            `*Per Agent:*\n${agentLines || 'No data'}`;

        const kanakPhone = KANAK_PHONE();
        if (kanakPhone) {
            await getSendMessage()(kanakPhone, msg, BROKER_PHONE_ID());
            logger.info('[Automation] Weekly summary sent to Kanak');
        }
    } catch (err) {
        logger.error('[Automation] Weekly summary error:', err.response?.data || err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// D3: DAILY AGENT REMINDERS — 10 AM IST
// ─────────────────────────────────────────────────────────────────────────────

async function sendAgentReminders() {
    logger.info('[Automation] Running daily agent reminders...');
    try {
        const token = await getZohoToken();
        const res   = await axios.get(`${ZOHO_BASE_URL}/Leads/search`, {
            params:  { criteria: `(Lead_Status:equals:New Lead)`, per_page: 200 },
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            timeout: 15000,
        });

        const leads = res.data?.data || [];
        if (leads.length === 0) return;

        const byAgent = {};
        for (const l of leads) {
            const agent = l.Assigned_Agent || KANAK_PHONE();
            if (!agent) continue;
            if (!byAgent[agent]) byAgent[agent] = [];
            byAgent[agent].push(l);
        }

        const sendMessage = getSendMessage();
        for (const [agentPhone, agentLeads] of Object.entries(byAgent)) {
            const lines = agentLeads.slice(0, 10).map((l, i) =>
                `${i + 1}. *${l.Last_Name || 'Unknown'}* — ${l.Area || '?'} — ₹${l.Budget || '?'} — 📞 ${l.Phone || '?'}`
            );
            const msg =
                `🔔 *Daily Lead Reminder — The Commūn*\n\n` +
                `You have *${agentLeads.length} lead(s)* assigned:\n\n` +
                lines.join('\n') +
                (agentLeads.length > 10 ? `\n...and ${agentLeads.length - 10} more` : '') +
                `\n\n_Log calls in Zoho CRM after follow-up._`;

            try {
                await sendMessage(agentPhone, msg, BROKER_PHONE_ID());
            } catch (err) {
                logger.error(`[Automation] Daily reminder failed for ${agentPhone}:`, err.message);
            }
            await new Promise(r => setTimeout(r, 1000));
        }

        // Morning summary to Kanak
        const kanakPhone = KANAK_PHONE();
        if (kanakPhone) {
            const summary =
                `📊 *Morning Summary — The Commūn*\n\n` +
                `*${leads.length} new leads* pending in Zoho.\n\n` +
                leads.slice(0, 8).map((l, i) => `${i + 1}. ${l.Last_Name || '?'} — ${l.Area || '?'} — ₹${l.Budget || '?'}`).join('\n') +
                (leads.length > 8 ? `\n...and ${leads.length - 8} more.` : '');
            try {
                await sendMessage(kanakPhone, summary, BROKER_PHONE_ID());
            } catch (err) {
                logger.error('[Automation] Morning summary to Kanak failed:', err.message);
            }
        }
    } catch (err) {
        logger.error('[Automation] Agent reminders error:', err.response?.data || err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULER
// ─────────────────────────────────────────────────────────────────────────────

function msUntilNextIST(hour, minute, targetDay = null) {
    const now    = new Date();
    const nowIST = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const target = new Date(nowIST);
    target.setHours(hour, minute, 0, 0);

    if (targetDay !== null) {
        const diff = (targetDay - target.getDay() + 7) % 7 || 7;
        target.setDate(target.getDate() + diff);
    } else if (target <= nowIST) {
        target.setDate(target.getDate() + 1);
    }

    return target.getTime() - now.getTime();
}

function startAutomation() {
    // D2: Process follow-up queue every hour
    const qi = setInterval(
        () => processDueFollowUps().catch(e => logger.error('[Automation] Queue error:', e.message)),
        CHECK_INTERVAL_MS
    );
    qi.unref();
    processDueFollowUps().catch(e => logger.error('[Automation] Startup queue check:', e.message));

    // D3: 48h no-follow-up check — every 6 hours starting at 10 AM
    const t1 = setTimeout(function run48h() {
        check48hNoFollowUp().catch(e => logger.error('[Automation] 48h check error:', e.message));
        const i = setInterval(
            () => check48hNoFollowUp().catch(e => logger.error('[Automation] 48h check error:', e.message)),
            6 * 60 * 60 * 1000
        );
        i.unref();
    }, msUntilNextIST(10, 0));
    t1.unref();

    // D3: Daily agent reminders — 10 AM IST
    const t2 = setTimeout(function runDaily() {
        sendAgentReminders().catch(e => logger.error('[Automation] Daily reminder error:', e.message));
        const i = setInterval(
            () => sendAgentReminders().catch(e => logger.error('[Automation] Daily reminder error:', e.message)),
            24 * 60 * 60 * 1000
        );
        i.unref();
    }, msUntilNextIST(10, 0));
    t2.unref();

    // D3: Weekly summary — Monday 10 AM IST (1 = Monday)
    const t3 = setTimeout(function runWeekly() {
        sendWeeklySummary().catch(e => logger.error('[Automation] Weekly summary error:', e.message));
        const i = setInterval(
            () => sendWeeklySummary().catch(e => logger.error('[Automation] Weekly summary error:', e.message)),
            7 * 24 * 60 * 60 * 1000
        );
        i.unref();
    }, msUntilNextIST(10, 0, 1));
    t3.unref();

    logger.info('[Automation] Module D started ✅');
}

function getQueueStats() {
    const queue = loadQueue();
    const pending = queue.filter(e => !e.sent).length;
    const sent    = queue.filter(e => e.sent).length;
    return { total: queue.length, pending, sent };
}

module.exports = {
    startAutomation,
    enqueueLeadFollowUps,
    sendBulkMessage,
    handleZohoStageChange,
    assignAgent,
    getQueueStats,
};
