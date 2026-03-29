const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const logger = require('../utils/logger');

const genAI = new GoogleGenerativeAI(process.env.AI_API_KEY);

// In-memory session store
const sessions = {};

// Session TTL: evict after 24 hours
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    let evicted = 0;
    for (const userId of Object.keys(sessions)) {
        if (now - (sessions[userId].lastActivity || 0) > SESSION_TTL_MS) {
            delete sessions[userId];
            evicted++;
        }
    }
    if (evicted > 0) logger.info(`[Sessions] Evicted ${evicted} inactive sessions`);
}, 60 * 60 * 1000).unref();

// ─────────────────────────────────────────────────────────────────────────────
// FLOW STEPS — fully branching, all tap-based (no typing)
//
// Entry → 4 options
//   ├── College Group → send form link
//   ├── Admission / Tickets → connect to human
//   └── Hostels / Flats → LOOKING_FOR
//       ├── PG: Area → Gender → Budget → Sharing → Timeline → DONE
//       ├── Flat: Possession → BHK → Budget → Action(AI/Human) → DONE
//       └── Serviced Apt: Area → Budget → Duration → Action → DONE
// ─────────────────────────────────────────────────────────────────────────────

const FLOW_STEPS = {
    // ── ENTRY POINT ──
    ENTRY: {
        key: 'entry',
        question: 'Hey! 👋 Welcome to *The Commūn*!\n\nWhat are you here for?',
        inputType: 'list',
        buttonLabel: 'Select',
        options: [
            { id: 'entry_college',   title: 'College Group Link',  description: 'Join our student community' },
            { id: 'entry_admission', title: 'Admission Info',       description: 'Get admission guidance' },
            { id: 'entry_tickets',   title: 'Tickets',              description: 'Event tickets & passes' },
            { id: 'entry_hostels',   title: 'Hostels / Flats',      description: 'Find PGs, flats & apartments' },
        ],
        nextMap: {
            entry_college:   'END_COLLEGE',
            entry_admission: 'END_HUMAN',
            entry_tickets:   'END_HUMAN',
            entry_hostels:   'AREA',
        },
    },

    // ── AREA (asked first for everyone) ──
    AREA: {
        key: 'area',
        question: '📍 Which area are you looking in?',
        inputType: 'list',
        buttonLabel: 'Choose Area',
        options: [
            { id: 'area_svkm',    title: 'Vile Parle & nearby',  description: 'VP, Juhu, Andheri W — near SVKM' },
            { id: 'area_atlas',   title: 'BKC / Bandra',          description: 'BKC, Santacruz, Bandra — near ATLAS' },
            { id: 'area_south',   title: 'South Bombay',          description: 'Fort, Mahalaxmi — Xaviers, Jai Hind, KC' },
            { id: 'area_navi',    title: 'Navi Mumbai',            description: 'Kharghar — near NMIMS Navi Mumbai' },
        ],
        // Custom routing in processChoice:
        // area_svkm → STAY_TYPE (Vile Parle has both flats & hostels)
        // all others → PG_GENDER (only hostels available)
        next: '_CUSTOM_AREA_ROUTE',
    },

    // ── STAY TYPE (only for Vile Parle / SVKM area) ──
    STAY_TYPE: {
        key: 'stay_type',
        question: "🏠 What's your stay vibe?\n\n" +
            '🏨 *Hostel* — One building, multiple rooms, full community vibe\n' +
            '🛌 *Flat / Serviced Flat* — Independent or premium living with amenities',
        inputType: 'button',
        options: [
            { id: 'stay_hostel', title: 'PG / Hostel' },
            { id: 'stay_flat',   title: 'Flat / Serviced Flat' },
        ],
        nextMap: {
            stay_hostel: 'PG_GENDER',
            stay_flat:   'FLAT_POSSESSION',
        },
    },

    // ── PG / HOSTEL FLOW (only 2 questions) ──
    PG_GENDER: {
        key: 'gender',
        question: '👤 What\'s your preference?',
        inputType: 'list',
        buttonLabel: 'Choose',
        options: [
            { id: 'gender_girls',    title: 'Only Girls' },
            { id: 'gender_boys',     title: 'Only Boys' },
            { id: 'gender_coed_open', title: 'Co-ed (No restrictions)', description: 'Less / no restrictions' },
            { id: 'gender_coed_sep',  title: 'Co-ed (Separate wings)',  description: 'Restrictions apply' },
        ],
        next: 'PG_BUDGET',
    },
    PG_BUDGET: {
        key: 'budget',
        question: '💰 Annual budget?',
        inputType: 'list',
        buttonLabel: 'Choose Budget',
        options: [
            { id: 'pg_bud_u3',     title: 'Less than ₹3,00,000',      description: 'Only Navi Mumbai' },
            { id: 'pg_bud_3_3.5',  title: '₹3,00,000 – ₹3,50,000',   description: 'Only Navi Mumbai' },
            { id: 'pg_bud_4_5.5',  title: '₹4,00,000 – ₹5,50,000' },
            { id: 'pg_bud_5.5_7',  title: '₹5,50,000 – ₹7,00,000' },
            { id: 'pg_bud_7_8.5',  title: '₹7,00,000 – ₹8,50,000' },
            { id: 'pg_bud_8.5_10', title: '₹8,50,000 – ₹10,00,000' },
            { id: 'pg_bud_10p',    title: '₹10,00,000+' },
            { id: 'pg_bud_15p',    title: '₹15L+ (Single sharing)' },
        ],
        next: 'DONE',
    },

    // ── FLAT FLOW ──
    FLAT_POSSESSION: {
        key: 'possession',
        question: '📅 When do you need possession?\n\n_Be a little flexible — flats get sold out very early!_',
        inputType: 'list',
        buttonLabel: 'Choose Month',
        options: [
            { id: 'poss_apr', title: 'April' },
            { id: 'poss_may', title: 'May' },
            { id: 'poss_jun', title: 'June' },
            { id: 'poss_jul', title: 'July' },
            { id: 'poss_aug', title: 'August' },
        ],
        next: 'FLAT_BHK',
    },
    FLAT_BHK: {
        key: 'bhk',
        question: '🏠 How many BHK?',
        inputType: 'list',
        buttonLabel: 'Choose BHK',
        options: [
            { id: 'bhk_1', title: '1 BHK' },
            { id: 'bhk_2', title: '2 BHK' },
            { id: 'bhk_3', title: '3 BHK' },
            { id: 'bhk_4', title: '4 BHK' },
        ],
        // Custom routing in processChoice → dynamic budget based on BHK
        next: '_CUSTOM_BHK_ROUTE',
    },

    // ── FLAT BUDGET (dynamic per BHK) ──
    FLAT_BUDGET_1BHK: {
        key: 'budget',
        question: '💰 Monthly budget for 1 BHK?',
        inputType: 'button',
        options: [
            { id: 'fl1_75_85',  title: '₹75K – ₹85K' },
            { id: 'fl1_85_100', title: '₹85K – ₹1 Lakh' },
            { id: 'fl1_100p',   title: '₹1 Lakh+' },
        ],
        next: 'DONE',
    },
    FLAT_BUDGET_2BHK: {
        key: 'budget',
        question: '💰 Monthly budget for 2 BHK?',
        inputType: 'list',
        buttonLabel: 'Choose Budget',
        options: [
            { id: 'fl2_95_110',  title: '₹95K – ₹1.10 Lakh' },
            { id: 'fl2_110_125', title: '₹1.10L – ₹1.25 Lakh' },
            { id: 'fl2_125_140', title: '₹1.25L – ₹1.40 Lakh' },
            { id: 'fl2_140p',    title: '₹1.40 Lakh+' },
        ],
        next: 'DONE',
    },
    FLAT_BUDGET_3BHK: {
        key: 'budget',
        question: '💰 Monthly budget for 3 BHK?',
        inputType: 'list',
        buttonLabel: 'Choose Budget',
        options: [
            { id: 'fl3_140_160', title: '₹1.40L – ₹1.60 Lakh' },
            { id: 'fl3_160_180', title: '₹1.60L – ₹1.80 Lakh' },
            { id: 'fl3_180_200', title: '₹1.80L – ₹2.00 Lakh' },
            { id: 'fl3_200p',    title: '₹2 Lakh+' },
        ],
        next: 'DONE',
    },
    FLAT_BUDGET_4BHK: {
        key: 'budget',
        question: '💰 Monthly budget for 4 BHK?',
        inputType: 'list',
        buttonLabel: 'Choose Budget',
        options: [
            { id: 'fl4_180_200', title: '₹1.80L – ₹2.00 Lakh' },
            { id: 'fl4_220_250', title: '₹2.20L – ₹2.50 Lakh' },
            { id: 'fl4_250_300', title: '₹2.50L – ₹3.00 Lakh' },
            { id: 'fl4_300p',    title: '₹3 Lakh+' },
        ],
        next: 'DONE',
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// OPTION LABELS — maps option IDs to display text
// ─────────────────────────────────────────────────────────────────────────────

const OPTION_LABELS = {
    // Entry
    entry_college: 'College Group Link', entry_admission: 'Admission Info',
    entry_tickets: 'Tickets', entry_hostels: 'Hostels / Flats',
    // Areas
    area_svkm: 'Vile Parle / Juhu / Andheri W', area_atlas: 'BKC / Santacruz / Bandra',
    area_south: 'Fort / Mahalaxmi (South Bombay)', area_navi: 'Kharghar (Navi Mumbai)',
    // Stay type
    stay_hostel: 'PG / Hostel', stay_flat: 'Flat / Serviced Flat',
    // Gender
    gender_girls: 'Only Girls', gender_boys: 'Only Boys',
    gender_coed_open: 'Co-ed (No restrictions)', gender_coed_sep: 'Co-ed (Separate wings)',
    // PG Annual Budget
    'pg_bud_u3': 'Less than ₹3L/yr', 'pg_bud_3_3.5': '₹3L – ₹3.5L/yr',
    'pg_bud_4_5.5': '₹4L – ₹5.5L/yr', 'pg_bud_5.5_7': '₹5.5L – ₹7L/yr',
    'pg_bud_7_8.5': '₹7L – ₹8.5L/yr', 'pg_bud_8.5_10': '₹8.5L – ₹10L/yr',
    pg_bud_10p: '₹10L+/yr', pg_bud_15p: '₹15L+/yr (Single sharing)',
    // Flat possession months
    poss_apr: 'April', poss_may: 'May', poss_jun: 'June', poss_jul: 'July', poss_aug: 'August',
    // BHK
    bhk_1: '1 BHK', bhk_2: '2 BHK', bhk_3: '3 BHK', bhk_4: '4 BHK',
    // Flat budget — 1 BHK
    fl1_75_85: '₹75K – ₹85K/mo', fl1_85_100: '₹85K – ₹1L/mo', fl1_100p: '₹1L+/mo',
    // Flat budget — 2 BHK
    fl2_95_110: '₹95K – ₹1.10L/mo', fl2_110_125: '₹1.10L – ₹1.25L/mo',
    fl2_125_140: '₹1.25L – ₹1.40L/mo', fl2_140p: '₹1.40L+/mo',
    // Flat budget — 3 BHK
    fl3_140_160: '₹1.40L – ₹1.60L/mo', fl3_160_180: '₹1.60L – ₹1.80L/mo',
    fl3_180_200: '₹1.80L – ₹2L/mo', fl3_200p: '₹2L+/mo',
    // Flat budget — 4 BHK
    fl4_180_200: '₹1.80L – ₹2L/mo', fl4_220_250: '₹2.20L – ₹2.50L/mo',
    fl4_250_300: '₹2.50L – ₹3L/mo', fl4_300p: '₹3L+/mo',
};

// Budget option ID → max numeric value for inventory search
const BUDGET_MAX = {
    // PG annual → monthly equivalent for search
    'pg_bud_u3': 25000, 'pg_bud_3_3.5': 29000, 'pg_bud_4_5.5': 46000,
    'pg_bud_5.5_7': 58000, 'pg_bud_7_8.5': 71000, 'pg_bud_8.5_10': 83000,
    pg_bud_10p: 999999, pg_bud_15p: 999999,
    // Flat 1 BHK
    fl1_75_85: 85000, fl1_85_100: 100000, fl1_100p: 999999,
    // Flat 2 BHK
    fl2_95_110: 110000, fl2_110_125: 125000, fl2_125_140: 140000, fl2_140p: 999999,
    // Flat 3 BHK
    fl3_140_160: 160000, fl3_160_180: 180000, fl3_180_200: 200000, fl3_200p: 999999,
    // Flat 4 BHK
    fl4_180_200: 200000, fl4_220_250: 250000, fl4_250_300: 300000, fl4_300p: 999999,
};

// College group form link (Kanak to update)
const COLLEGE_GROUP_FORM = process.env.COLLEGE_GROUP_FORM_URL || 'https://forms.gle/cEni27LvQ5PKDt229';
const ADMISSION_PHONE = '919769167228';

// ─────────────────────────────────────────────────────────────────────────────
// SESSION MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

function getSession(userId) {
    if (!sessions[userId]) {
        sessions[userId] = { currentStep: 'ENTRY', data: {}, lastActivity: Date.now() };
    } else {
        sessions[userId].lastActivity = Date.now();
    }
    return sessions[userId];
}

function extractInteractiveId(message) {
    if (message?.type === 'interactive') {
        if (message.interactive?.type === 'button_reply') return message.interactive.button_reply.id;
        if (message.interactive?.type === 'list_reply')   return message.interactive.list_reply.id;
    }
    return null;
}

function getNextStep(stepDef, chosenId) {
    if (stepDef.nextMap && chosenId && stepDef.nextMap[chosenId]) return stepDef.nextMap[chosenId];
    return stepDef.next || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

async function processChatMessage(userId, messageText, rawMessage = null) {
    const session       = getSession(userId);
    const interactiveId = rawMessage ? extractInteractiveId(rawMessage) : null;

    const EMPTY = { replyText: null, nextStep: null, leadData: null, searchFilters: null, isHotLead: false, humanHandoff: false };

    // ── Free text handling ──
    if (!interactiveId && messageText) {
        const lower = messageText.trim().toLowerCase();

        // Greetings → send intro then show menu
        const greetings = ['hi', 'hello', 'hey', 'start', 'hii', 'helo', 'namaste', 'namaskar'];
        if (greetings.includes(lower)) {
            delete sessions[userId];
            const fresh = getSession(userId);
            return {
                ...EMPTY,
                replyText: `Hi! Welcome to The Commūn 🏡\n\nFinding a PG or flat near NMIMS shouldn't be stressful — that's exactly why we exist.\n\nHere's what we do:\n✅ Verified PGs & flats near NMIMS / Vile Parle\n✅ Budget options from ₹40K onwards\n✅ Single, double & triple sharing available\n✅ Quick move-ins arranged`,
                nextStep: FLOW_STEPS[fresh.currentStep],
            };
        }

        // Numbered option (for IG users who type 1,2,3)
        const numMatch = messageText.trim().match(/^(\d+)$/);
        if (numMatch && FLOW_STEPS[session.currentStep]) {
            const stepDef    = FLOW_STEPS[session.currentStep];
            const idx        = parseInt(numMatch[1]) - 1;
            if (idx >= 0 && idx < stepDef.options.length) {
                return processChoice(userId, session, stepDef, stepDef.options[idx].id);
            }
        }

        // Search intent
        const searchIntent = await detectSearchIntent(messageText);
        if (searchIntent) return { ...EMPTY, searchFilters: searchIntent };

        // Nudge to tap
        if (FLOW_STEPS[session.currentStep]) {
            return { ...EMPTY, replyText: 'Please tap one of the options below 👇', nextStep: FLOW_STEPS[session.currentStep] };
        }
    }

    // ── Interactive reply: record answer and advance ──
    if (interactiveId && FLOW_STEPS[session.currentStep]) {
        const stepDef  = FLOW_STEPS[session.currentStep];
        const validIds = stepDef.options.map(o => o.id);

        if (!validIds.includes(interactiveId)) {
            return { ...EMPTY, nextStep: FLOW_STEPS[session.currentStep] };
        }

        return processChoice(userId, session, stepDef, interactiveId);
    }

    // Fallback — send current step
    if (FLOW_STEPS[session.currentStep]) {
        return { ...EMPTY, nextStep: FLOW_STEPS[session.currentStep] };
    }

    return EMPTY;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS A CHOICE — save answer, determine next step
// ─────────────────────────────────────────────────────────────────────────────

function processChoice(userId, session, stepDef, chosenId) {
    const EMPTY = { replyText: null, nextStep: null, leadData: null, searchFilters: null, isHotLead: false, humanHandoff: false };

    // Save answer
    session.data[stepDef.key] = OPTION_LABELS[chosenId] || chosenId;

    // Save budget numeric for search
    if (BUDGET_MAX[chosenId]) {
        session.data.budgetMaxNumeric = BUDGET_MAX[chosenId];
    }

    // Track which flow branch
    if (chosenId === 'look_pg')   session.data._flow = 'pg';
    if (chosenId === 'look_flat') session.data._flow = 'flat';
    if (chosenId === 'look_sa')   session.data._flow = 'sa';

    const nextStepName = getNextStep(stepDef, chosenId);

    // ── Terminal states ──

    if (nextStepName === 'END_COLLEGE') {
        delete sessions[userId];
        return {
            ...EMPTY,
            replyText: `📋 Here's the link to join our college community:\n\n👉 ${COLLEGE_GROUP_FORM}\n\nFill it out and we'll add you! 🎓`,
        };
    }

    if (nextStepName === 'END_HUMAN') {
        delete sessions[userId];
        return {
            ...EMPTY,
            replyText: `🙌 For admissions & tickets, please contact our team directly:\n\n📞 +91 97691 67228\n💬 wa.me/${ADMISSION_PHONE}\n\nThey'll help you out!`,
            humanHandoff: true,
        };
    }

    if (nextStepName === 'DONE') {
        return buildLeadCompletion(userId, session, false);
    }

    if (nextStepName === 'DONE_HUMAN') {
        return buildLeadCompletion(userId, session, true);
    }

    // ── Custom routing: Area → Stay type or direct to hostel ──
    if (nextStepName === '_CUSTOM_AREA_ROUTE') {
        if (chosenId === 'area_svkm') {
            // Vile Parle has both flats & hostels → ask stay type
            session.currentStep = 'STAY_TYPE';
            return { ...EMPTY, nextStep: FLOW_STEPS['STAY_TYPE'] };
        } else {
            // All other areas → only hostels available
            session.data.stay_type = 'PG / Hostel';
            session.currentStep = 'PG_GENDER';
            return { ...EMPTY, nextStep: FLOW_STEPS['PG_GENDER'] };
        }
    }

    // ── Custom routing: BHK → dynamic budget step ──
    if (nextStepName === '_CUSTOM_BHK_ROUTE') {
        const bhkMap = {
            bhk_1: 'FLAT_BUDGET_1BHK',
            bhk_2: 'FLAT_BUDGET_2BHK',
            bhk_3: 'FLAT_BUDGET_3BHK',
            bhk_4: 'FLAT_BUDGET_4BHK',
        };
        const budgetStep = bhkMap[chosenId] || 'FLAT_BUDGET_1BHK';
        session.currentStep = budgetStep;
        return { ...EMPTY, nextStep: FLOW_STEPS[budgetStep] };
    }

    // ── Continue flow ──
    session.currentStep = nextStepName;
    return { ...EMPTY, nextStep: FLOW_STEPS[nextStepName] };
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD LEAD COMPLETION — create lead data + search filters
// ─────────────────────────────────────────────────────────────────────────────

function buildLeadCompletion(userId, session, humanHandoff) {
    const d     = session.data;
    const stayType = d.stay_type || 'PG / Hostel';

    // Build lead data for Zoho
    const leadData = {
        property_type: stayType,
        area:          d.area        || 'N/A',
        budget:        d.budget      || 'N/A',
        gender:        d.gender      || '',
        bhk:           d.bhk         || '',
        possession:    d.possession  || '',
    };

    // Build search filters for inventory
    let searchFilters = null;
    if (!humanHandoff) {
        searchFilters = {};
        if (d.area) searchFilters.area = d.area;
        if (d.budgetMaxNumeric) searchFilters.maxBudget = d.budgetMaxNumeric;
        if (d.bhk) searchFilters.bhk = d.bhk;
    }

    // Confirmation message
    let msg = `✅ *Got it! Here's what we found for you:*\n\n`;
    msg += `🏠 Type: *${stayType}*\n`;
    if (d.area)       msg += `📍 Area: *${d.area}*\n`;
    if (d.gender)     msg += `👤 Preference: *${d.gender}*\n`;
    if (d.bhk)        msg += `🏗️ BHK: *${d.bhk}*\n`;
    msg += `💰 Budget: *${d.budget || 'N/A'}*\n`;
    if (d.possession) msg += `📅 Possession: *${d.possession}*\n`;

    msg += `\n🔍 *Searching our inventory for the best matches...*`;

    delete sessions[userId];

    return {
        replyText:     msg,
        nextStep:      null,
        leadData,
        searchFilters,
        isHotLead:     false,
        humanHandoff,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH INTENT DETECTION (free text search, e.g. "show me 2bhk in andheri")
// ─────────────────────────────────────────────────────────────────────────────

// Sanitize user text before putting in prompts — strip injection attempts
function sanitizeForPrompt(text, maxLen = 300) {
    return String(text || '')
        .slice(0, maxLen)
        .replace(/[`"\\]/g, ' ')
        .replace(/\[.*?\]/g, '')
        .trim();
}

async function detectSearchIntent(text) {
    const lower = text.toLowerCase();
    const searchKeywords = ['show', 'available', 'flat', 'pg', 'room', 'bhk', 'search', 'find', 'looking for', 'any', 'options', 'list'];
    if (!searchKeywords.some(kw => lower.includes(kw))) return null;

    try {
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash',
            generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: SchemaType.OBJECT,
                    properties: {
                        is_search:  { type: SchemaType.BOOLEAN },
                        area:       { type: SchemaType.STRING },
                        max_budget: { type: SchemaType.NUMBER },
                        bhk:        { type: SchemaType.STRING },
                    },
                    required: ['is_search'],
                },
            },
        });

        const safeText = sanitizeForPrompt(text);
        const result = await model.generateContent(
            `Is this a property search query? Extract area, max_budget (number in rupees), bhk if present. Text: ${safeText}`
        );
        const parsed = JSON.parse(result.response.text());

        if (parsed.is_search && parsed.area && parsed.max_budget) {
            return { area: parsed.area, maxBudget: parsed.max_budget, bhk: parsed.bhk || null };
        }
        return null;
    } catch (err) {
        logger.error('[Gemini] detectSearchIntent error:', err.message);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// GEMINI LISTING RANKER — ranks all listings by relevance to student filters
// ─────────────────────────────────────────────────────────────────────────────

async function rankListingsWithAI(filters, listings) {
    if (!listings || listings.length === 0) return [];
    try {
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash',
            generationConfig: { responseMimeType: 'application/json' },
        });

        const listingSummaries = listings.map((l, i) => ({
            index: i,
            id: l.listingId,
            status: l.status,
            area: l.area,
            bhk: l.bhk,
            rent: l.rent,
            furnishing: l.furnishing,
            floor: l.floor,
            amenities: l.amenities,
            availableDate: l.availableDate,
        }));

        const prompt = `You are a property matching assistant for a Mumbai student housing platform.

Student requirements:
- Area: ${filters.area || 'Any'}
- Max budget: ${filters.maxBudget ? '₹' + filters.maxBudget + '/month' : 'Any'}
- Property type/BHK: ${filters.bhk || 'Any'}

Available listings (some may be CLOSED/taken):
${JSON.stringify(listingSummaries, null, 2)}

Task: Rank ALL listings by how well they match the student's requirements.
- AVAILABLE listings that match closely → score 80-100
- AVAILABLE listings that partially match → score 50-79
- CLOSED listings that would have matched well → score 20-49 (these are "recently taken" examples)
- Irrelevant listings → score 0-19

Return a JSON array of objects: [{ "index": number, "score": number }]
Sorted by score descending. Include ALL listings.`;

        const result = await model.generateContent(prompt);
        const raw = result.response.text().trim().replace(/```json|```/g, '').trim();
        const ranked = JSON.parse(raw);

        return ranked
            .filter(r => r.score > 15)
            .map(r => ({ ...listings[r.index], score: r.score }));
    } catch (err) {
        logger.warn('[Gemini] Ranking failed, falling back to original order:', err.message);
        return listings;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT SEARCH RESULTS
// ─────────────────────────────────────────────────────────────────────────────

function formatSearchResults(results) {
    if (!results || results.length === 0) {
        return `😔 No matching listings found right now.\n\nWe'll notify you as soon as something comes in! Our team will also manually search for the best options.`;
    }

    const available = results.filter(r => r.status === 'AVAILABLE').slice(0, 4);
    const closed    = results.filter(r => r.status !== 'AVAILABLE').slice(0, 2);

    let msg = '';

    if (available.length > 0) {
        msg += `🏘️ *${available.length} listing${available.length > 1 ? 's' : ''} available for you:*\n\n`;
        available.forEach((r, i) => {
            const title = [r.bhk, r.area].filter(Boolean).join(' — ');
            msg += `*${i + 1}. ${title || 'Property'}*\n`;
            if (r.rent)          msg += `💰 ₹${r.rent}/month\n`;
            if (r.furnishing)    msg += `🛋️ ${r.furnishing}\n`;
            if (r.floor)         msg += `🏢 Floor: ${r.floor}\n`;
            if (r.availableDate) msg += `📅 Available: ${r.availableDate}\n`;
            if (r.amenities)     msg += `✨ ${r.amenities}\n`;
            if (r.photoLinks && r.photoLinks.length > 0) msg += `📸 ${r.photoLinks.length} photo(s) below\n`;
            if (r.videoLinks && r.videoLinks.length > 0) {
                r.videoLinks.forEach((v, vi) => msg += `🎥 Video ${vi + 1}: ${v}\n`);
            }
            msg += `\n`;
        });
    }

    if (closed.length > 0) {
        msg += `🔒 *Similar options (recently taken):*\n`;
        closed.forEach((r) => {
            const title = [r.bhk, r.area].filter(Boolean).join(' — ');
            msg += `• ${title || 'Property'}${r.rent ? ' — ₹' + r.rent + '/mo' : ''} _(taken)_\n`;
        });
        msg += `\n`;
    }

    if (available.length === 0) {
        msg = `😔 No exact matches available right now.\n\n`;
        if (closed.length > 0) {
            msg += `🔒 *Similar options that were recently available:*\n`;
            closed.forEach((r) => {
                const title = [r.bhk, r.area].filter(Boolean).join(' — ');
                msg += `• ${title || 'Property'}${r.rent ? ' — ₹' + r.rent + '/mo' : ''} _(taken)_\n`;
            });
            msg += `\n`;
        }
        msg += `New listings come in daily — our team will reach out as soon as something matches!`;
        return msg;
    }

    msg += `_Questions? Reply anytime — our team will follow up!_`;
    return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROPERTY LISTING PARSER (Module F — Broker bot)
// ─────────────────────────────────────────────────────────────────────────────

async function parsePropertyListing(text) {
    const empty = {
        property_type: '', furnishing: '', location: '', building_name: '',
        nearby_landmark: '', rent_min: '', rent_max: '', security_deposit: '',
        possession_date: '', floor: '', amenities: '', extra_notes: ''
    };
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const result = await model.generateContent(
            `You are a property listing parser for a Mumbai real estate business.\n` +
            `Extract details from this broker message and return ONLY a valid JSON object.\n\n` +
            `STRICT RULES:\n` +
            `- "rent_min" and "rent_max": NUMBERS ONLY (no ₹, no text, no furnishing info). E.g. 30000\n` +
            `  If a single rent is given, put it in rent_min only.\n` +
            `  If a range like "25000-35000", put 25000 in rent_min and 35000 in rent_max.\n` +
            `- "furnishing": ONLY one of "Furnished", "Semi-Furnished", "Unfurnished" — nothing else.\n` +
            `- "amenities": everything else (AC, geyser, parking, gym, etc.) as a short comma-separated string.\n` +
            `- "floor": floor number or description e.g. "3rd floor", "Ground", "Top floor".\n` +
            `- "property_type": e.g. "2BHK", "3BHK", "Studio", "PG", "1RK".\n` +
            `- "location": area name only e.g. "Vile Parle West", "Andheri East".\n` +
            `- "possession_date": e.g. "Immediate", "1st April", "15 May 2025".\n` +
            `- "security_deposit": numbers only.\n` +
            `- "building_name": building/society name if mentioned.\n` +
            `- "extra_notes": anything that doesn't fit above fields.\n\n` +
            `Fields: property_type, furnishing, location, building_name, nearby_landmark, rent_min, rent_max, security_deposit, possession_date, floor, amenities, extra_notes\n\n` +
            `Broker message:\n${sanitizeForPrompt(text, 1000)}\n\n` +
            `Return only JSON, no explanation.`
        );
        const raw = result.response.text().trim().replace(/^```json[\s\S]*?```$|^```[\s\S]*?```$/gm, s => s.replace(/^```json\n?|^```\n?|\n?```$/g, '')).trim();
        const parsed = JSON.parse(raw);
        // Sanitise: rent fields must be numeric strings
        if (parsed.rent_min) parsed.rent_min = String(parsed.rent_min).replace(/[^0-9]/g, '');
        if (parsed.rent_max) parsed.rent_max = String(parsed.rent_max).replace(/[^0-9]/g, '');
        if (parsed.security_deposit) parsed.security_deposit = String(parsed.security_deposit).replace(/[^0-9]/g, '');
        return { ...empty, ...parsed };
    } catch (error) {
        logger.error('[Gemini] parsePropertyListing error:', error.message);
        return { ...empty, extra_notes: text };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LISTING CONFIRMATION (Module F — Broker bot)
// ─────────────────────────────────────────────────────────────────────────────

function generateListingConfirmation(listingId, propertyData, mediaLinks) {
    const type       = propertyData.property_type || 'Property';
    const location   = propertyData.location || 'N/A';
    const rent       = propertyData.rent_min
        ? (propertyData.rent_max && propertyData.rent_max !== propertyData.rent_min
            ? `₹${propertyData.rent_min} – ₹${propertyData.rent_max}`
            : `₹${propertyData.rent_min}`)
        : 'N/A';
    const furnishing = propertyData.furnishing || '';
    const building   = propertyData.building_name || '';
    const possession = propertyData.possession_date || '';

    let msg = `✅ *Listing Saved!*\n\n`;
    msg += `🆔 Listing ID: *${listingId}*\n`;
    msg += `🏠 ${type}${building ? ' — ' + building : ''}\n`;
    msg += `📍 ${location}\n`;
    msg += `💰 Rent: ${rent}`;
    if (furnishing) msg += ` | ${furnishing}`;
    msg += `\n`;
    if (possession) msg += `📅 Available: ${possession}\n`;
    if (propertyData.amenities) msg += `✨ ${propertyData.amenities}\n`;
    if (mediaLinks && mediaLinks.length > 0) msg += `📸 ${mediaLinks.length} photo(s) attached\n`;
    msg += `\n_To close this listing, send: close ${listingId}_`;
    return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// CALL TRANSCRIPTION (Module C — IVR)
// ─────────────────────────────────────────────────────────────────────────────

async function transcribeAndSummarizeCall(audioBuffer, mimeType) {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const base64Audio = audioBuffer.toString('base64');

        const result = await model.generateContent([
            { inlineData: { mimeType, data: base64Audio } },
            {
                text: `You are a call transcription assistant for a property brokerage called The Commūn.\n\n` +
                    `1. Transcribe the entire call in the original language (likely Hindi or English).\n` +
                    `2. Provide a brief English summary (3-5 lines) covering: what the caller wanted, ` +
                    `which area/budget/property type was discussed, and any next steps.\n\n` +
                    `Format:\nTRANSCRIPT:\n[full transcript]\n\nSUMMARY:\n[summary]`,
            },
        ]);

        const responseText = result.response.text();
        const transcriptMatch = responseText.match(/TRANSCRIPT:\s*([\s\S]*?)(?=SUMMARY:|$)/i);
        const summaryMatch    = responseText.match(/SUMMARY:\s*([\s\S]*?)$/i);

        return {
            transcript: transcriptMatch ? transcriptMatch[1].trim() : responseText,
            summary:    summaryMatch    ? summaryMatch[1].trim()    : 'Summary not available.',
        };
    } catch (error) {
        logger.error('[Gemini] transcribeAndSummarizeCall error:', error.message);
        return { transcript: 'Transcription failed: ' + error.message, summary: 'Could not transcribe.' };
    }
}

module.exports = {
    processChatMessage,
    formatSearchResults,
    rankListingsWithAI,
    parsePropertyListing,
    extractInteractiveId,
    generateListingConfirmation,
    transcribeAndSummarizeCall,
};
