const axios = require('axios');
const logger = require('../utils/logger');

const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = process.env;

const ZOHO_BASE_URL = process.env.ZOHO_BASE_URL || 'https://www.zohoapis.in/crm/v3';
const ZOHO_AUTH_URL = process.env.ZOHO_AUTH_URL || 'https://accounts.zoho.in/oauth/v2/token';
const ZOHO_TIMEOUT_MS = 15000;

let currentAccessToken = null;

async function refreshZohoToken() {
    try {
        const response = await axios.post(ZOHO_AUTH_URL, null, {
            params: {
                refresh_token: ZOHO_REFRESH_TOKEN,
                client_id: ZOHO_CLIENT_ID,
                client_secret: ZOHO_CLIENT_SECRET,
                grant_type: 'refresh_token',
            },
            timeout: ZOHO_TIMEOUT_MS,
        });

        if (response.data.access_token) {
            currentAccessToken = response.data.access_token;
            logger.info('[Zoho] Access token refreshed');
        } else {
            throw new Error('No access_token in Zoho response');
        }
    } catch (error) {
        logger.error('[Zoho] Token refresh failed:', error.response?.data || error.message);
        throw error;
    }
}

function zohoHeaders() {
    return {
        'Authorization': `Zoho-oauthtoken ${currentAccessToken}`,
        'Content-Type': 'application/json',
    };
}

async function withTokenRetry(fn) {
    if (!currentAccessToken) await refreshZohoToken();
    try {
        return await fn();
    } catch (error) {
        if (error.response?.status === 401) {
            logger.info('[Zoho] Token expired, refreshing and retrying...');
            await refreshZohoToken();
            return await fn();
        }
        throw error;
    }
}

/**
 * Creates a Lead in Zoho CRM.
 */
// Lead scoring logic
function calculateLeadScore(leadData) {
    let score = 0;
    const timeline = (leadData.timeline || '').toLowerCase();
    const budget = (leadData.budget || '').toLowerCase();

    // Timeline scoring
    if (timeline.includes('7 days') || timeline.includes('within 7')) score += 50;
    else if (timeline.includes('1 month') || timeline.includes('within 1')) score += 30;
    else score += 10;

    // Budget scoring
    if (budget.includes('25,000') || budget.includes('above')) score += 30;
    else if (budget.includes('18,000') || budget.includes('12,000')) score += 20;
    else score += 10;

    // Area scoring
    const area = (leadData.area || '').toLowerCase();
    if (area.includes('vile parle') || area.includes('andheri')) score += 20;
    else score += 10;

    return Math.min(score, 100);
}

// Auto-assign by area — picks first from comma-separated pool
function assignAgentByArea(area) {
    const a = (area || '').toLowerCase();
    const pick = (envVal) => (envVal || '').split(',')[0].trim() || process.env.KANAK_PHONE_NUMBER;
    if (a.includes('vile parle') || a.includes('andheri') || a.includes('svkm') || a.includes('juhu'))
        return pick(process.env.AGENT_PHONE_VILEPARLE);
    if (a.includes('bandra') || a.includes('bkc') || a.includes('santacruz'))
        return pick(process.env.AGENT_PHONE_BANDRA);
    if (a.includes('kharghar') || a.includes('navi'))
        return pick(process.env.AGENT_PHONE_NAVI);
    return pick(process.env.AGENT_PHONE_OTHER) || process.env.KANAK_PHONE_NUMBER;
}

// Parse max budget number from strings like "₹8k-12k", "Under ₹8,000", "Above ₹25,000"
function parseBudgetNumber(budgetStr) {
    if (!budgetStr) return null;
    const s = String(budgetStr).replace(/[₹,\s]/g, '').toLowerCase();
    // Handle shorthand like 8k, 25k
    const nums = s.match(/\d+(\.\d+)?k?/g) || [];
    const values = nums.map(n => n.endsWith('k') ? parseFloat(n) * 1000 : parseFloat(n));
    if (values.length === 0) return null;
    return Math.max(...values); // use upper bound
}

async function createLead(leadData, phoneNumber) {
    const score = calculateLeadScore(leadData);
    const assignedAgent = assignAgentByArea(leadData.area);
    const isHot = score >= 70;
    const source = leadData.source || 'WhatsApp Chatbot';
    const budget = parseBudgetNumber(leadData.budget);

    const payload = {
        data: [{
            Last_Name: leadData.name || `Lead (${phoneNumber})`,
            Phone: phoneNumber,
            Lead_Source: source,
            Area: leadData.area || '',
            Budget: budget,
            Sharing_Preference: leadData.sharing || '',
            Move_in_Timeline: leadData.timeline || '',
            Contract_Length: leadData.contract || '',
            Property_Type: leadData.property_type || leadData.stayType || '',
            Lead_Status: 'New Lead',
            Lead_Scoring: score,
            Hot_Lead: isHot,
            Assigned_Agent: assignedAgent,
            Source_Channel: source,
            Last_Messaged_At: new Date().toISOString().slice(0, 19).replace('T', 'T') + '+05:30',
        }],
    };

    return withTokenRetry(async () => {
        const response = await axios.post(`${ZOHO_BASE_URL}/Leads`, payload, {
            headers: zohoHeaders(),
            timeout: ZOHO_TIMEOUT_MS,
        });
        logger.info(`[Zoho] Lead created — Score: ${score}, Hot: ${isHot}, Agent: ${assignedAgent}`);
        return response.data;
    });
}

/**
 * Search for a Lead in Zoho CRM by phone number.
 */
async function searchLeadByPhone(phoneNumber) {
    if (!phoneNumber) return null;

    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');

    try {
        return await withTokenRetry(async () => {
            const response = await axios.get(`${ZOHO_BASE_URL}/Leads/search`, {
                params: { phone: cleanPhone },
                headers: zohoHeaders(),
                timeout: ZOHO_TIMEOUT_MS,
            });
            if (response.data?.data?.length > 0) {
                logger.info(`[Zoho] Found lead for ${cleanPhone}: ${response.data.data[0].id}`);
                return response.data.data[0];
            }
            return null;
        });
    } catch (error) {
        logger.error('[Zoho] searchLeadByPhone error:', error.response?.data || error.message);
        return null;
    }
}

/**
 * Update an existing Lead in Zoho CRM by ID.
 */
async function updateLead(leadId, leadData) {
    const score = calculateLeadScore(leadData);
    const assignedAgent = assignAgentByArea(leadData.area);
    const isHot = score >= 70;
    const budget = parseBudgetNumber(leadData.budget);

    const payload = {
        data: [{
            Area:               leadData.area || '',
            Budget:             budget,
            Sharing_Preference: leadData.sharing || '',
            Move_in_Timeline:   leadData.timeline || '',
            Contract_Length:    leadData.contract || '',
            Property_Type:      leadData.property_type || leadData.stayType || '',
            Lead_Scoring:       score,
            Hot_Lead:           isHot,
            Assigned_Agent:     assignedAgent,
            Last_Messaged_At:   new Date().toISOString().slice(0, 19) + '+05:30',
        }],
    };

    return withTokenRetry(async () => {
        const response = await axios.put(`${ZOHO_BASE_URL}/Leads/${leadId}`, payload, {
            headers: zohoHeaders(),
            timeout: ZOHO_TIMEOUT_MS,
        });
        logger.info(`[Zoho] Lead ${leadId} updated — Score: ${score}, Hot: ${isHot}`);
        return response.data;
    });
}

/**
 * Create a Note on a Lead in Zoho CRM.
 */
async function createNote(leadId, title, content) {
    const payload = {
        data: [{
            Note_Title: title,
            Note_Content: content,
            Parent_Id: leadId,
            se_module: 'Leads',
        }],
    };

    return withTokenRetry(async () => {
        const response = await axios.post(`${ZOHO_BASE_URL}/Notes`, payload, {
            headers: zohoHeaders(),
            timeout: ZOHO_TIMEOUT_MS,
        });
        logger.info(`[Zoho] Note created on lead ${leadId}`);
        return response.data;
    });
}

module.exports = {
    createLead,
    updateLead,
    searchLeadByPhone,
    createNote,
};
