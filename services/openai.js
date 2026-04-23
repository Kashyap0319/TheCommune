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
            { id: 'area_svkm',    title: 'Vile Parle & nearby',  description: 'VP, Juhu, Andheri West — near SVKM' },
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
        next: '_CUSTOM_BUDGET_ROUTE',
    },
    // ── PG BUDGET — Vile Parle (wider range, no single sharing) ──
    PG_BUDGET_VP: {
        key: 'budget',
        question: '💰 Annual budget?',
        inputType: 'list',
        buttonLabel: 'Choose Budget',
        options: [
            { id: 'pg_bud_4_5',   title: '₹4,00,000 – ₹5,00,000' },
            { id: 'pg_bud_5_6',   title: '₹5,00,000 – ₹6,00,000' },
            { id: 'pg_bud_6_7',   title: '₹6,00,000 – ₹7,00,000' },
            { id: 'pg_bud_7_8',   title: '₹7,00,000 – ₹8,00,000' },
            { id: 'pg_bud_8_9',   title: '₹8,00,000 – ₹9,00,000' },
            { id: 'pg_bud_9p',    title: '₹9,00,000+' },
        ],
        next: 'DONE',
    },

    // ── PG BUDGET — BKC / South Bombay / Navi Mumbai (compact, no single sharing) ──
    PG_BUDGET_BKC: {
        key: 'budget',
        question: '💰 Annual budget?',
        inputType: 'list',
        buttonLabel: 'Choose Budget',
        options: [
            { id: 'pg_bud_3_4',   title: '₹3,00,000 – ₹4,00,000' },
            { id: 'pg_bud_4_5',   title: '₹4,00,000 – ₹5,00,000' },
            { id: 'pg_bud_5p',    title: '₹5,00,000+' },
        ],
        next: 'DONE',
    },

    // ── FLAT FLOW ──
    FLAT_POSSESSION: {
        key: 'possession',
        question: '📅 When do you need possession?\n\n_Be a little flexible — flats get sold out very early!_',
        inputType: 'list',
        buttonLabel: 'Choose Month',
        get options() {
            const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
            const now = new Date();
            return Array.from({ length: 6 }, (_, i) => {
                const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
                const name = MONTHS[d.getMonth()];
                return { id: `poss_${name.toLowerCase().slice(0,3)}`, title: name };
            });
        },
        next: 'FLAT_BHK',
    },
    FLAT_BHK: {
        key: 'bhk',
        question: '🏠 How many BHK?',
        inputType: 'list',
        buttonLabel: 'Choose BHK',
        options: [
            { id: 'bhk_1',   title: '1 BHK' },
            { id: 'bhk_2',   title: '2 BHK' },
            { id: 'bhk_3',   title: '3 BHK' },
            { id: 'bhk_4',   title: '4 BHK' },
            { id: 'bhk_2_3', title: '2 & 3 BHK',  description: 'Show both 2 BHK & 3 BHK' },
            { id: 'bhk_3_4', title: '3 & 4 BHK',  description: 'Show both 3 BHK & 4 BHK' },
            { id: 'bhk_any', title: 'Any BHK',     description: 'Show all available flats' },
        ],
        next: '_CUSTOM_BHK_ROUTE',
    },

    // ── FLAT BUDGET (dynamic per BHK) ──
    FLAT_BUDGET_1BHK: {
        key: 'budget',
        question: '💰 Monthly budget for 1 BHK?',
        inputType: 'list',
        buttonLabel: 'Choose Budget',
        options: [
            { id: 'fl1_75_85',  title: '₹75K – ₹85K' },
            { id: 'fl1_85_100', title: '₹85K – ₹1 Lakh' },
            { id: 'fl1_100p',   title: '₹1 Lakh+' },
            { id: 'fl_any',     title: 'Any budget', description: 'Show all price ranges' },
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
            { id: 'fl_any',      title: 'Any budget', description: 'Show all price ranges' },
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
            { id: 'fl_any',      title: 'Any budget', description: 'Show all price ranges' },
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
            { id: 'fl_any',      title: 'Any budget', description: 'Show all price ranges' },
        ],
        next: 'DONE',
    },
    // ── COMBINED BHK BUDGETS ──
    FLAT_BUDGET_2_3BHK: {
        key: 'budget',
        question: '💰 Monthly budget for 2 & 3 BHK?',
        inputType: 'list',
        buttonLabel: 'Choose Budget',
        options: [
            { id: 'fl23_95_140',  title: '₹95K – ₹1.40 Lakh' },
            { id: 'fl23_140_200', title: '₹1.40L – ₹2 Lakh' },
            { id: 'fl23_200p',    title: '₹2 Lakh+' },
            { id: 'fl_any',       title: 'Any budget', description: 'Show all price ranges' },
        ],
        next: 'DONE',
    },
    FLAT_BUDGET_3_4BHK: {
        key: 'budget',
        question: '💰 Monthly budget for 3 & 4 BHK?',
        inputType: 'list',
        buttonLabel: 'Choose Budget',
        options: [
            { id: 'fl34_140_200', title: '₹1.40L – ₹2 Lakh' },
            { id: 'fl34_200_300', title: '₹2L – ₹3 Lakh' },
            { id: 'fl34_300p',    title: '₹3 Lakh+' },
            { id: 'fl_any',       title: 'Any budget', description: 'Show all price ranges' },
        ],
        next: 'DONE',
    },
    FLAT_BUDGET_ANY: {
        key: 'budget',
        question: '💰 Monthly budget?',
        inputType: 'list',
        buttonLabel: 'Choose Budget',
        options: [
            { id: 'fla_u100',    title: 'Under ₹1 Lakh' },
            { id: 'fla_100_200', title: '₹1L – ₹2 Lakh' },
            { id: 'fla_200_300', title: '₹2L – ₹3 Lakh' },
            { id: 'fla_300p',    title: '₹3 Lakh+' },
            { id: 'fl_any',      title: 'Any budget', description: 'Show all price ranges' },
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
    area_svkm: 'Vile Parle / Juhu / Andheri West', area_atlas: 'BKC / Santacruz / Bandra',
    area_south: 'Fort / Mahalaxmi (South Bombay)', area_navi: 'Kharghar (Navi Mumbai)',
    // Stay type
    stay_hostel: 'PG / Hostel', stay_flat: 'Flat / Serviced Flat',
    // Gender
    gender_girls: 'Only Girls', gender_boys: 'Only Boys',
    gender_coed_open: 'Co-ed (No restrictions)', gender_coed_sep: 'Co-ed (Separate wings)',
    // PG Annual Budget — Vile Parle
    'pg_bud_4_5': '₹4L – ₹5L/yr', 'pg_bud_5_6': '₹5L – ₹6L/yr',
    'pg_bud_6_7': '₹6L – ₹7L/yr', 'pg_bud_7_8': '₹7L – ₹8L/yr',
    'pg_bud_8_9': '₹8L – ₹9L/yr', 'pg_bud_9p': '₹9L+/yr',
    // PG Annual Budget — BKC / South / Navi
    'pg_bud_3_4': '₹3L – ₹4L/yr', 'pg_bud_5p': '₹5L+/yr',
    // Flat possession months (dynamic — label resolved via option title at runtime)
    poss_jan: 'January', poss_feb: 'February', poss_mar: 'March',
    poss_apr: 'April',   poss_may: 'May',       poss_jun: 'June',
    poss_jul: 'July',    poss_aug: 'August',    poss_sep: 'September',
    poss_oct: 'October', poss_nov: 'November',  poss_dec: 'December',
    // BHK
    bhk_1: '1 BHK', bhk_2: '2 BHK', bhk_3: '3 BHK', bhk_4: '4 BHK',
    bhk_2_3: '2 & 3 BHK', bhk_3_4: '3 & 4 BHK', bhk_any: 'Any BHK',
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
    // Flat budget — combined
    fl23_95_140: '₹95K – ₹1.40L/mo', fl23_140_200: '₹1.40L – ₹2L/mo', fl23_200p: '₹2L+/mo',
    fl34_140_200: '₹1.40L – ₹2L/mo', fl34_200_300: '₹2L – ₹3L/mo', fl34_300p: '₹3L+/mo',
    fla_u100: 'Under ₹1L/mo', fla_100_200: '₹1L – ₹2L/mo', fla_200_300: '₹2L – ₹3L/mo', fla_300p: '₹3L+/mo',
    fl_any: 'Any budget',
};

// Budget option ID → { min, max } numeric range for inventory search
// Hostels: show selected range + everything above as "above budget"
// Flats: selected range + next range as "in budget", rest as "above budget"
const BUDGET_RANGE = {
    // PG annual → monthly equivalent (Vile Parle budgets)
    'pg_bud_4_5':   { min: 33333,  max: 41667 },
    'pg_bud_5_6':   { min: 41667,  max: 50000 },
    'pg_bud_6_7':   { min: 50000,  max: 58333 },
    'pg_bud_7_8':   { min: 58333,  max: 66667 },
    'pg_bud_8_9':   { min: 66667,  max: 75000 },
    'pg_bud_9p':    { min: 75000,  max: 999999 },
    // PG annual → monthly equivalent (BKC / South / Navi budgets)
    'pg_bud_3_4':   { min: 25000,  max: 33333 },
    'pg_bud_5p':    { min: 41667,  max: 999999 },
    // Flat 1 BHK (selected + next range combined as "in budget")
    fl1_75_85:  { min: 75000,  max: 100000 },
    fl1_85_100: { min: 85000,  max: 999999 },
    fl1_100p:   { min: 100000, max: 999999 },
    // Flat 2 BHK
    fl2_95_110:  { min: 95000,  max: 125000 },
    fl2_110_125: { min: 110000, max: 140000 },
    fl2_125_140: { min: 125000, max: 999999 },
    fl2_140p:    { min: 140000, max: 999999 },
    // Flat 3 BHK
    fl3_140_160: { min: 140000, max: 180000 },
    fl3_160_180: { min: 160000, max: 200000 },
    fl3_180_200: { min: 180000, max: 999999 },
    fl3_200p:    { min: 200000, max: 999999 },
    // Flat 4 BHK
    fl4_180_200: { min: 180000, max: 250000 },
    fl4_220_250: { min: 220000, max: 300000 },
    fl4_250_300: { min: 250000, max: 999999 },
    fl4_300p:    { min: 300000, max: 999999 },
    // Flat combined BHK
    fl23_95_140:  { min: 95000,  max: 140000 },
    fl23_140_200: { min: 140000, max: 200000 },
    fl23_200p:    { min: 200000, max: 999999 },
    fl34_140_200: { min: 140000, max: 200000 },
    fl34_200_300: { min: 200000, max: 300000 },
    fl34_300p:    { min: 300000, max: 999999 },
    fla_u100:     { min: 0,      max: 100000 },
    fla_100_200:  { min: 100000, max: 200000 },
    fla_200_300:  { min: 200000, max: 300000 },
    fla_300p:     { min: 300000, max: 999999 },
    fl_any:       { min: 0,      max: 999999 },
};

// BHK option ID → search variants (include half-BHK above)
const BHK_VARIANTS = {
    bhk_1:   ['1 bhk', '1bhk', '1.5 bhk', '1.5bhk'],
    bhk_2:   ['2 bhk', '2bhk', '2.5 bhk', '2.5bhk'],
    bhk_3:   ['3 bhk', '3bhk', '3.5 bhk', '3.5bhk'],
    bhk_4:   ['4 bhk', '4bhk', '4.5 bhk', '4.5bhk'],
    bhk_2_3: ['2 bhk', '2bhk', '2.5 bhk', '2.5bhk', '3 bhk', '3bhk', '3.5 bhk', '3.5bhk'],
    bhk_3_4: ['3 bhk', '3bhk', '3.5 bhk', '3.5bhk', '4 bhk', '4bhk', '4.5 bhk', '4.5bhk'],
    // bhk_any → no entry = no BHK filter applied
};

// Possession month → months to search
// First available month: selected + next; others: prev + selected + next
function getPossessionMonths(selectedMonth, availableOptions) {
    const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    const sel = selectedMonth.toLowerCase();
    const idx = MONTHS.indexOf(sel);
    if (idx === -1) return [selectedMonth];

    const firstAvailable = availableOptions?.[0]?.title?.toLowerCase();
    const result = [MONTHS[idx]];
    if (sel !== firstAvailable && idx > 0) result.push(MONTHS[idx - 1]);
    if (idx < 11) result.push(MONTHS[idx + 1]);
    return result.map(m => m.charAt(0).toUpperCase() + m.slice(1));
}

// College group form link (Kanak to update)
const COLLEGE_GROUP_FORM = process.env.COLLEGE_GROUP_FORM_URL || 'https://forms.gle/cEni27LvQ5PKDt229';
const ADMISSION_PHONE = '918169056576';

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

    // Save budget range for search (min = don't show below, max = "in budget" upper limit)
    if (BUDGET_RANGE[chosenId]) {
        session.data.budgetMinNumeric = BUDGET_RANGE[chosenId].min;
        session.data.budgetMaxNumeric = BUDGET_RANGE[chosenId].max;
    }

    // Save BHK search variants (1 BHK → also search 1.5 BHK, etc.)
    if (BHK_VARIANTS[chosenId]) {
        session.data.bhkVariants = BHK_VARIANTS[chosenId];
    }

    // Compute possession months for search (May → May+June, June → May+June+July, etc.)
    if (stepDef.key === 'possession' && session.data.possession) {
        session.data.possessionMonths = getPossessionMonths(
            session.data.possession,
            FLOW_STEPS.FLAT_POSSESSION.options
        );
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
            replyText: `🙌 For admissions & tickets, please contact our team directly:\n\n📞 +91 8169056576\n💬 wa.me/${ADMISSION_PHONE}\n\nThey'll help you out!`,
            humanHandoff: true,
        };
    }

    if (nextStepName === 'DONE') {
        return buildLeadCompletion(userId, session, false);
    }

    if (nextStepName === 'DONE_HUMAN') {
        return buildLeadCompletion(userId, session, true);
    }

    // ── Custom routing: Area → Gender (flats paused for VP) ──
    if (nextStepName === '_CUSTOM_AREA_ROUTE') {
        // All areas go directly to PG flow (Vile Parle flats paused)
        session.data.stay_type = 'PG / Hostel';
        session.currentStep = 'PG_GENDER';
        return { ...EMPTY, nextStep: FLOW_STEPS['PG_GENDER'] };
    }

    // ── Custom routing: Gender → area-specific PG budget ──
    if (nextStepName === '_CUSTOM_BUDGET_ROUTE') {
        const area = session.data.area || '';
        if (area.includes('Vile Parle') || area.includes('Juhu') || area.includes('Andheri')) {
            session.currentStep = 'PG_BUDGET_VP';
            return { ...EMPTY, nextStep: FLOW_STEPS['PG_BUDGET_VP'] };
        } else {
            session.currentStep = 'PG_BUDGET_BKC';
            return { ...EMPTY, nextStep: FLOW_STEPS['PG_BUDGET_BKC'] };
        }
    }

    // ── Custom routing: BHK → dynamic budget step ──
    if (nextStepName === '_CUSTOM_BHK_ROUTE') {
        const bhkMap = {
            bhk_1:   'FLAT_BUDGET_1BHK',
            bhk_2:   'FLAT_BUDGET_2BHK',
            bhk_3:   'FLAT_BUDGET_3BHK',
            bhk_4:   'FLAT_BUDGET_4BHK',
            bhk_2_3: 'FLAT_BUDGET_2_3BHK',
            bhk_3_4: 'FLAT_BUDGET_3_4BHK',
            bhk_any: 'FLAT_BUDGET_ANY',
        };
        const budgetStep = bhkMap[chosenId] || 'FLAT_BUDGET_ANY';
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

    const timeline   = d.timeline   || '';
    const possession = d.possession || '';

    // Hot lead: all PG leads (no timeline step) OR flat possession is current or next month
    const now = new Date();
    const thisMonth = now.toLocaleString('en-US', { month: 'long' });
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleString('en-US', { month: 'long' });
    const isPG = stayType.includes('PG') || stayType.includes('Hostel');
    const isHotLead = isPG ||
                      possession === thisMonth || possession === nextMonth;

    // Build lead data for Zoho
    const leadData = {
        property_type: stayType,
        area:          d.area || 'N/A',
        budget:        d.budget      || 'N/A',
        gender:        d.gender      || '',
        bhk:           d.bhk         || '',
        possession,
        timeline:      timeline || possession, // use whichever is set
    };

    // Build search filters for inventory
    let searchFilters = null;
    if (!humanHandoff) {
        searchFilters = {};
        if (d.area) searchFilters.area = d.area;
        if (d.budgetMinNumeric !== undefined) searchFilters.minBudget = d.budgetMinNumeric;
        if (d.budgetMaxNumeric) searchFilters.maxBudget = d.budgetMaxNumeric;
        if (d.bhkVariants) searchFilters.bhkVariants = d.bhkVariants;
        else if (d.bhk) searchFilters.bhk = d.bhk;
        if (d.possessionMonths) searchFilters.possessionMonths = d.possessionMonths;
        if (d.gender) searchFilters.gender = d.gender;
        if (d.stay_type) searchFilters.stayType = d.stay_type;
    }

    // Confirmation message
    let msg = `✅ *Got it! Here's what we found for you:*\n\n`;
    msg += `🏠 Type: *${stayType}*\n`;
    if (d.area)       msg += `📍 Area: *${d.area}*\n`;
    if (d.gender)     msg += `👤 Preference: *${d.gender}*\n`;
    if (d.bhk)        msg += `🏗️ BHK: *${d.bhk}*\n`;
    msg += `💰 Budget: *${d.budget || 'N/A'}*\n`;
    if (timeline)     msg += `📅 Move-in: *${timeline}*\n`;
    if (d.possessionMonths) msg += `📅 Showing for: *${d.possessionMonths.join(', ')}*\n`;
    else if (possession)    msg += `📅 Possession: *${possession}*\n`;

    // Vile Parle: note that more options will be shared personally
    const areaStr = d.area || '';
    if (areaStr.includes('Vile Parle') || areaStr.includes('Juhu') || areaStr.includes('Andheri')) {
        msg += `\n💡 *We have more options — our team will send them once they contact you personally.*`;
    }

    msg += `\n🔍 *Searching our inventory for the best matches...*`;

    delete sessions[userId];

    return {
        replyText:     msg,
        nextStep:      null,
        leadData,
        searchFilters,
        isHotLead,
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

        // Keep all AI-scored listings (no threshold filter).
        // The search filter in searchInventory already ensures area/budget/bhk match;
        // AI ranking only reorders them. Filtering here was causing valid matches to be dropped.
        return ranked.map(r => ({ ...listings[r.index], score: r.score }));
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

    // Filter out garbage listings — must have at least area + rent OR bhk + rent
    const valid = results.filter(r => r.rent && (r.area || r.bhk));

    const inBudget    = valid.filter(r => r.status === 'AVAILABLE' && !r.aboveBudget).slice(0, 5);
    const aboveBudget = valid.filter(r => r.status === 'AVAILABLE' && r.aboveBudget).slice(0, 3);
    const closed      = valid.filter(r => r.status !== 'AVAILABLE').slice(0, 2);

    // Format rent as annual (numbers > 100000 are annual; smaller = monthly, convert)
    function formatRent(rent) {
        const n = Number(String(rent).replace(/[^0-9]/g, ''));
        if (!n) return '';
        // If under 1 lakh, assume monthly — convert to annual
        const annual = n < 100000 ? n * 12 : n;
        // Pretty format: ₹6,78,000/yr
        return `₹${annual.toLocaleString('en-IN')}/yr`;
    }

    function formatListing(r, num) {
        let s = '';
        const isPG = /pg|hostel/i.test(r.propertyCategory || '') || /pg|hostel/i.test(r.bhk || '');
        const isSA = /serviced/i.test(r.propertyCategory || '');

        // Title
        const titleParts = [r.propertyName, r.bhk, r.area].filter(Boolean);
        const title = titleParts.length ? titleParts.join(' — ') : 'Property';
        s += `*${num}. ${title}*\n`;

        // Category-specific display
        if (isSA) {
            if (r.bhk && !titleParts.includes(r.bhk)) s += `🛏️ ${r.bhk}\n`;
            if (r.sharing)        s += `👥 Sharing: ${r.sharing}\n`;
            if (r.rent)           s += `💰 ${formatRent(r.rent)}\n`;
            if (r.restrictions)   s += `⚠️ ${r.restrictions}\n`;
            if (r.amenities)      s += `✨ ${r.amenities}\n`;
            if (r.exclusions)     s += `❌ Exclusions: ${r.exclusions}\n`;
        } else if (isPG) {
            if (r.sharing)        s += `👥 Sharing: ${r.sharing}\n`;
            if (r.rent)           s += `💰 ${formatRent(r.rent)}\n`;
            if (r.restrictions)   s += `⚠️ ${r.restrictions}\n`;
            if (r.amenities)      s += `✨ ${r.amenities}\n`;
        } else {
            if (r.rent)           s += `💰 ${formatRent(r.rent)}\n`;
            if (r.furnishing)     s += `🛋️ ${r.furnishing}\n`;
            if (r.amenities)      s += `✨ ${r.amenities}\n`;
        }

        if (r.availableDate) s += `📅 Available: ${r.availableDate}\n`;
        if (r.photoLinks && r.photoLinks.length > 0) s += `📸 ${r.photoLinks.length} photo(s) below\n`;
        if (r.videoLinks && r.videoLinks.length > 0) {
            r.videoLinks.forEach((v, vi) => s += `🎥 Video ${vi + 1}: ${v}\n`);
        }
        s += `\n`;
        return s;
    }

    let msg = '';

    if (inBudget.length > 0) {
        msg += `🏘️ *${inBudget.length} listing${inBudget.length > 1 ? 's' : ''} in your budget:*\n\n`;
        inBudget.forEach((r, i) => { msg += formatListing(r, i + 1); });
    }

    if (aboveBudget.length > 0) {
        msg += `💡 *These are above your budget but you can still check out:*\n\n`;
        aboveBudget.forEach((r, i) => { msg += formatListing(r, inBudget.length + i + 1); });
    }

    function shortRent(rent) {
        const n = Number(String(rent || '').replace(/[^0-9]/g, ''));
        if (!n) return '';
        const annual = n < 100000 ? n * 12 : n;
        return `₹${annual.toLocaleString('en-IN')}/yr`;
    }

    if (closed.length > 0) {
        msg += `🔒 *Similar options (recently taken):*\n`;
        closed.forEach((r) => {
            const titleParts = [r.propertyName, r.bhk, r.area].filter(Boolean);
            const title = titleParts.join(' — ') || 'Property';
            msg += `• ${title}${r.rent ? ' — ' + shortRent(r.rent) : ''} _(taken)_\n`;
        });
        msg += `\n`;
    }

    if (inBudget.length === 0 && aboveBudget.length === 0) {
        msg = `😔 No exact matches available right now.\n\n`;
        if (closed.length > 0) {
            msg += `🔒 *Similar options that were recently available:*\n`;
            closed.forEach((r) => {
                const titleParts = [r.propertyName, r.bhk, r.area].filter(Boolean);
                const title = titleParts.join(' — ') || 'Property';
                msg += `• ${title}${r.rent ? ' — ' + shortRent(r.rent) : ''} _(taken)_\n`;
            });
            msg += `\n`;
        }
        msg += `New listings come in daily — our team will reach out as soon as something matches!`;
        return msg;
    }

    return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROPERTY LISTING PARSER (Module F — Broker bot)
// ─────────────────────────────────────────────────────────────────────────────

// Regex-based fallback parser for structured "Key: Value" format
// Works when Gemini is unavailable or returns bad data
function parseListingRegex(text) {
    const extract = (pattern) => {
        const m = text.match(pattern);
        return m ? m[1].trim().replace(/^["'\s]+|["'\s]+$/g, '') : '';
    };
    const number = (s) => String(s || '').replace(/[^0-9]/g, '');

    const propertyName = extract(/Property\s*Name\s*:\s*([^\n]+)/i);
    const typeRaw = extract(/(?:^|\n)Type\s*:\s*([^\n]+)/i);
    const bhk = extract(/BHK\s*:\s*([^\n]+)/i);
    const sharing = extract(/Sharing\s*:\s*([^\n]+)/i);
    const location = extract(/Location\s*:\s*([^\n]+)/i);
    const rentStr = extract(/(?:Annual\s*)?Rent\s*:\s*([^\n]+)/i);
    const restrictions = extract(/Restrictions?(?:\s*Level)?\s*:\s*([^\n]+)/i);
    const services = extract(/(?:Services|Inclusions|Amenities)\s*:\s*([^\n]+)/i);
    const exclusions = extract(/Exclusions?\s*:\s*([^\n]+)/i);
    const possession = extract(/Possession(?:\s*Date)?\s*:\s*([^\n]+)/i);
    const furnishing = extract(/Furnishing\s*:\s*([^\n]+)/i);

    // Determine category
    let category = '';
    const typeLower = (typeRaw + ' ' + text).toLowerCase();
    if (/serviced\s*apartment|\bsa\b/i.test(typeLower)) category = 'Serviced Apartment';
    else if (/\b(pg|hostel|paying guest)\b/i.test(typeLower)) category = 'PG/Hostel';
    else if (typeRaw) category = 'Flat';

    return {
        property_category: category,
        property_type: bhk || typeRaw || '',
        property_name: propertyName,
        building_name: propertyName,
        sharing,
        location,
        rent_min: number(rentStr),
        rent_max: '',
        restrictions,
        services,
        amenities: services,
        exclusions,
        possession_date: possession,
        furnishing,
        floor: '',
        security_deposit: '',
        nearby_landmark: '',
        extra_notes: '',
    };
}

async function parsePropertyListing(text) {
    const empty = {
        property_category: '', property_type: '', property_name: '',
        furnishing: '', location: '', building_name: '',
        sharing: '', restrictions: '', services: '', exclusions: '',
        nearby_landmark: '', rent_min: '', rent_max: '', security_deposit: '',
        possession_date: '', floor: '', amenities: '', extra_notes: ''
    };

    // Quick-check: if text has structured "Key: Value" lines, use regex parser first
    const hasStructuredFormat = /(Property\s*Name|Annual\s*Rent|Location|BHK|Type)\s*:/i.test(text);
    if (hasStructuredFormat) {
        const regexResult = parseListingRegex(text);
        // If regex extracted key fields, use that (more reliable than AI for structured input)
        if (regexResult.property_name || regexResult.location || regexResult.rent_min) {
            logger.info('[Parser] Used regex parser (structured format detected)');
            return { ...empty, ...regexResult };
        }
    }
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const result = await model.generateContent(
            `You are a property listing parser for a Mumbai real estate business.\n` +
            `Extract details from this broker message and return ONLY a valid JSON object.\n\n` +
            `CATEGORIES:\n` +
            `- "property_category": MUST be one of: "Serviced Apartment", "PG/Hostel", "Flat".\n` +
            `   * If text mentions "Serviced Apartment" or "SA" → "Serviced Apartment"\n` +
            `   * If text mentions "PG", "Hostel", "paying guest" → "PG/Hostel"\n` +
            `   * Otherwise → "Flat"\n\n` +
            `FIELDS:\n` +
            `- "property_type": Specific BHK if mentioned (e.g. "3 BHK", "2 BHK", "1 BHK"). Only use "Studio"/"1RK" if no BHK given.\n` +
            `- "property_name": Extract the SPECIFIC named building/property. If text says "at Insignia by Hive" extract "Insignia by Hive". If text says "Terra by Union" extract "Terra by Union". If text says "Property: 2 BHK at ABC Society" extract "ABC Society". Look for patterns like "at <Name>", "by <Name>", "<Name> building", "<Name> society".\n` +
            `- "building_name": Same as property_name if present.\n` +
            `- "sharing": One of "Single", "Double", "Triple" if mentioned.\n` +
            `- "location": Area name only (e.g. "Vile Parle West", "Santacruz West").\n` +
            `- "rent_min" and "rent_max": NUMBERS ONLY. Keep EXACTLY as given — if "annually"/"/year" keep annual number, if "monthly"/"/month" keep monthly. DO NOT convert.\n` +
            `- "furnishing": ONLY "Furnished", "Semi-Furnished", or "Unfurnished".\n` +
            `- "restrictions": Restrictions mentioned (e.g. "No restrictions", "Girls only", "No non-veg", "No couples").\n` +
            `- "services": Inclusions/services as comma-separated string (e.g. "Gym, Wi-Fi, Housekeeping, Breakfast, Laundry").\n` +
            `- "exclusions": Things NOT included if mentioned (e.g. "Electricity extra, Dinner not included").\n` +
            `- "amenities": Same as services (for backward compat).\n` +
            `- "possession_date": e.g. "Immediate", "1st June", "15 May 2025".\n` +
            `- "floor": Floor number if mentioned.\n` +
            `- "security_deposit": Numbers only.\n` +
            `- "extra_notes": Anything not covered above.\n\n` +
            `Return only JSON. Broker message:\n${sanitizeForPrompt(text, 1500)}`
        );
        const raw = result.response.text().trim().replace(/^```json[\s\S]*?```$|^```[\s\S]*?```$/gm, s => s.replace(/^```json\n?|^```\n?|\n?```$/g, '')).trim();
        const parsed = JSON.parse(raw);
        if (parsed.rent_min) parsed.rent_min = String(parsed.rent_min).replace(/[^0-9]/g, '');
        if (parsed.rent_max) parsed.rent_max = String(parsed.rent_max).replace(/[^0-9]/g, '');
        if (parsed.security_deposit) parsed.security_deposit = String(parsed.security_deposit).replace(/[^0-9]/g, '');
        // Back-compat: if services set but amenities empty, copy
        if (parsed.services && !parsed.amenities) parsed.amenities = parsed.services;
        if (parsed.amenities && !parsed.services) parsed.services = parsed.amenities;
        // property_name fallback
        if (!parsed.property_name && parsed.building_name) parsed.property_name = parsed.building_name;
        if (!parsed.building_name && parsed.property_name) parsed.building_name = parsed.property_name;
        return { ...empty, ...parsed };
    } catch (error) {
        logger.error('[Gemini] parsePropertyListing error:', error.message);
        return { ...empty, extra_notes: text };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LISTING CONFIRMATION (Module F — Broker bot)
// ─────────────────────────────────────────────────────────────────────────────

function formatRentDisplay(rentMin, rentMax) {
    const toAnnual = (v) => {
        const n = Number(String(v || '').replace(/[^0-9]/g, ''));
        if (!n) return null;
        return n < 100000 ? n * 12 : n;
    };
    const a = toAnnual(rentMin);
    const b = toAnnual(rentMax);
    if (!a) return 'N/A';
    if (b && b !== a) return `₹${a.toLocaleString('en-IN')} – ₹${b.toLocaleString('en-IN')}/year`;
    return `₹${a.toLocaleString('en-IN')}/year`;
}

function generateListingConfirmation(listingId, propertyData, mediaLinks, mediaMimeTypes = []) {
    const category   = propertyData.property_category || '';
    const propType   = propertyData.property_type || '';
    const isPG       = /pg|hostel/i.test(category) || /pg|hostel/i.test(propType);
    const isSA       = /serviced/i.test(category) || /serviced/i.test(propType);

    const name       = propertyData.property_name || propertyData.building_name || '';
    const bhk        = propertyData.property_type || '';
    const sharing    = propertyData.sharing || '';
    const location   = propertyData.location || 'N/A';
    const rent       = formatRentDisplay(propertyData.rent_min, propertyData.rent_max);
    const restrictions = propertyData.restrictions || '';
    const services   = propertyData.services || propertyData.amenities || '';
    const exclusions = propertyData.exclusions || '';
    const possession = propertyData.possession_date || '';
    const furnishing = propertyData.furnishing || '';

    // Count photos vs videos separately
    let photoCount = 0, videoCount = 0;
    (mediaLinks || []).forEach((_, i) => {
        const mime = (mediaMimeTypes[i] || '').toLowerCase();
        if (mime.startsWith('video/')) videoCount++;
        else photoCount++;
    });

    let msg = `✅ *Listing Saved!*\n\n`;
    msg += `🆔 Listing ID: *${listingId}*\n`;

    if (isSA) {
        msg += `🏠 *Serviced Apartment*${name ? ' — ' + name : ''}\n`;
        if (bhk)        msg += `🛏️ ${bhk}\n`;
        if (sharing)    msg += `👥 Sharing: ${sharing}\n`;
        msg += `📍 ${location}\n`;
        msg += `💰 ${rent}\n`;
        if (restrictions) msg += `⚠️ Restrictions: ${restrictions}\n`;
        if (services)     msg += `✨ Services: ${services}\n`;
        if (exclusions)   msg += `❌ Exclusions: ${exclusions}\n`;
    } else if (isPG) {
        msg += `🏠 *PG/Hostel*${name ? ' — ' + name : ''}\n`;
        if (sharing)    msg += `👥 Sharing: ${sharing}\n`;
        msg += `📍 ${location}\n`;
        msg += `💰 ${rent}\n`;
        if (restrictions) msg += `⚠️ Restrictions: ${restrictions}\n`;
        if (services)     msg += `✨ Services: ${services}\n`;
    } else {
        // Flat / generic
        msg += `🏠 ${bhk || 'Property'}${name ? ' — ' + name : ''}\n`;
        msg += `📍 ${location}\n`;
        msg += `💰 ${rent}${furnishing ? ' | ' + furnishing : ''}\n`;
        if (services) msg += `✨ ${services}\n`;
    }

    if (possession)  msg += `📅 Available: ${possession}\n`;

    // Media counts — always show, even 0
    msg += `📸 Photos: *${photoCount}*`;
    if (photoCount < 4) msg += ` (max 4)`;
    msg += `\n`;
    msg += `🎥 Videos: *${videoCount}*`;
    if (videoCount < 2) msg += ` (max 2)`;
    msg += `\n`;

    // If media missing, show instruction to add
    if (photoCount === 0 || videoCount === 0) {
        msg += `\n💡 *Add more media?*\n`;
        msg += `Send photos/videos in the next 60 seconds — they'll auto-attach to this listing.\n`;
        msg += `Or use: *attach ${listingId}* then send media anytime.\n`;
    }

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
