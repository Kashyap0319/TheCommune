const { OpenAI } = require('openai');

const openai = new OpenAI({ apiKey: process.env.AI_API_KEY });

// A simple in-memory store for session histories.
// In a real app, use a database like Redis or MongoDB.
const sessions = {};

// The specific tools we give to the AI so it can signal when it has all the data
const tools = [
    {
        type: "function",
        function: {
            name: "submit_lead",
            description: "Call this when you have successfully collected ALL 5 mandatory details from the user: Area, Budget, Sharing vs Family, Timeline, and Contract duration. Do NOT call this if any of the 5 are missing.",
            parameters: {
                type: "object",
                properties: {
                    area: { type: "string", description: "The preferred area or location" },
                    budget: { type: "string", description: "The budget range (e.g., '10k - 15k')" },
                    sharing: { type: "string", description: "Whether they are looking for shared accommodation or family setup" },
                    timeline: { type: "string", description: "When they want to move in (e.g., 'next month', 'immediately')" },
                    contract: { type: "string", description: "The duration of the lease contract (e.g., '1 year', '6 months')" },
                },
                required: ["area", "budget", "sharing", "timeline", "contract"],
            },
        },
    },
];

const SYSTEM_PROMPT = `You are a professional real estate assistant for 'The Commun'. 
Your goal is to provide a seamless and premium experience across WhatsApp and Instagram.

You must qualify every lead by asking for these 5 details:
1. Preferred Area
2. Budget Range
3. Occupancy Type (Sharing or Family)
4. Move-in Timeline
5. Lease Duration (Contract)

Maintain a friendly, professional, and consistent tone. 
Ask questions conversationally, one by one.
DO NOT call 'submit_lead' until ALL 5 pieces are provided.`;

/**
 * Handle an incoming message from a user, using OpenAI to decide the next response.
 * @param {string} userId - The unique identifier for the user (e.g., their phone number)
 * @param {string} messageText - The message sent by the user
 * @returns {object} { reply: string, leadData: object | null }
 */
async function processChatMessage(userId, messageText) {
    // ... (existing logic)
}

/**
 * AI function to parse a property listing text sent by Kanak.
 * @param {string} text - The raw text of the property listing
 * @returns {object} Parsed property details
 */
async function parsePropertyListing(text) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are an expert real estate data extractor. Extract property details from the provided text. If a detail is missing, use 'N/A'."
                },
                {
                    role: "user",
                    content: `Extract the following details from this listing:\n- Area\n- BHK\n- Rent\n- Furnishing\n- Available Date\n\nListing Text: "${text}"`
                }
            ],
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "property_extraction",
                    strict: true,
                    schema: {
                        type: "object",
                        properties: {
                            area: { type: "string" },
                            bhk: { type: "string" },
                            rent: { type: "string" },
                            furnishing: { type: "string" },
                            available_date: { type: "string" }
                        },
                        required: ["area", "bhk", "rent", "furnishing", "available_date"],
                        additionalProperties: false
                    }
                }
            }
        });

        return JSON.parse(response.choices[0].message.content);
    } catch (error) {
        console.error("Error parsing property listing with OpenAI:", error);
        throw error;
    }
}

module.exports = {
    processChatMessage,
    parsePropertyListing,
};
