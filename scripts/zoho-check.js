require('dotenv').config();
const axios = require('axios');

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;

async function getAccessToken() {
    const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
        params: {
            refresh_token: ZOHO_REFRESH_TOKEN,
            client_id: ZOHO_CLIENT_ID,
            client_secret: ZOHO_CLIENT_SECRET,
            grant_type: 'refresh_token'
        }
    });
    return res.data.access_token;
}

async function checkFields(token) {
    const res = await axios.get('https://www.zohoapis.in/crm/v2/settings/fields?module=Leads', {
        headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    return res.data.fields.map(f => f.api_name);
}

async function checkPipeline(token) {
    const res = await axios.get('https://www.zohoapis.in/crm/v2/settings/pipeline?module=Leads', {
        headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    return res.data;
}

const REQUIRED_FIELDS = [
    'Budget', 'Area', 'Property_Type', 'Sharing_Preference',
    'Move_in_Timeline', 'Contract_Length', 'Source_Channel',
    'Lead_Scoring', 'Hot_Lead', 'Assigned_Agent', 'Last_Messaged_At'
];

const REQUIRED_STAGES = [
    'New Lead', 'Contacted', 'Visit Scheduled', 'Visited', 'Deal Closed', 'Moved In'
];

async function main() {
    console.log('\n====== ZOHO CRM DIAGNOSTIC ======\n');

    // 1. Check credentials
    console.log('Checking credentials...');
    console.log('  Client ID:     ', ZOHO_CLIENT_ID ? ZOHO_CLIENT_ID.slice(0, 15) + '...' : '❌ MISSING');
    console.log('  Client Secret: ', ZOHO_CLIENT_SECRET ? ZOHO_CLIENT_SECRET.slice(0, 10) + '...' : '❌ MISSING');
    console.log('  Refresh Token: ', ZOHO_REFRESH_TOKEN ? ZOHO_REFRESH_TOKEN.slice(0, 15) + '...' : '❌ MISSING');

    if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
        console.log('\n❌ Missing credentials. Fill .env first.\n');
        process.exit(1);
    }

    // 2. Get access token
    let token;
    try {
        token = await getAccessToken();
        console.log('\n✅ API Connection: WORKING\n');
    } catch (e) {
        console.log('\n❌ API Connection FAILED:', e.response?.data || e.message);
        console.log('\nRefresh token is invalid or expired. Need to regenerate.\n');
        process.exit(1);
    }

    // 3. Check fields
    let fields;
    try {
        fields = await checkFields(token);
        console.log('--- Custom Fields ---');
        for (const f of REQUIRED_FIELDS) {
            const exists = fields.some(name => name.toLowerCase().includes(f.toLowerCase().replace(/ /g, '_')));
            console.log(`  ${exists ? '✅' : '❌'} ${f}`);
        }
    } catch (e) {
        console.log('❌ Could not fetch fields:', e.response?.data || e.message);
    }

    // 4. Check pipeline
    try {
        const pipeline = await checkPipeline(token);
        const stages = pipeline?.pipeline?.[0]?.maps?.map(m => m.display_value) || [];
        console.log('\n--- Pipeline Stages ---');
        for (const s of REQUIRED_STAGES) {
            const exists = stages.some(st => st?.toLowerCase() === s.toLowerCase());
            console.log(`  ${exists ? '✅' : '❌'} ${s}`);
        }
    } catch (e) {
        // Pipeline endpoint may not exist for all Zoho plans
        console.log('\n⚠️  Pipeline check skipped:', e.response?.status || e.message);
    }

    console.log('\n=================================\n');
}

main();
