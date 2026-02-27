const axios = require('axios');

const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = process.env;

// In a real app, you should securely store and refresh the access token. 
// For simplicity, we'll keep it in memory and refresh when it expires or is missing.
let currentAccessToken = null;

async function refreshZohoToken() {
    try {
        const response = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
            // Use zoho.in if your account is in Indian DC. Otherwise use zoho.com
            params: {
                refresh_token: ZOHO_REFRESH_TOKEN,
                client_id: ZOHO_CLIENT_ID,
                client_secret: ZOHO_CLIENT_SECRET,
                grant_type: 'refresh_token'
            }
        });

        if (response.data.access_token) {
            currentAccessToken = response.data.access_token;
            console.log("Successfully refreshed Zoho access token.");
        } else {
            throw new Error("Failed to get access token from response.");
        }
    } catch (error) {
        console.error("Error refreshing Zoho token:", error.response?.data || error.message);
        throw error;
    }
}

/**
 * Creates a Lead in Zoho CRM.
 * @param {object} leadData - The data extracted by the chatbot
 * @param {string} phoneNumber - The user's phone number
 */
async function createLead(leadData, phoneNumber) {
    if (!currentAccessToken) {
        await refreshZohoToken();
    }

    // Create the payload for Zoho CRM.
    // Note: These field names (e.g., 'Preferred_Area') must match your exact 
    // Custom Field API names in Zoho CRM.
    const payload = {
        data: [
            {
                Last_Name: `Lead from WhatsApp (${phoneNumber})`, // Last_Name is mandatory in Zoho standard
                Phone: phoneNumber,
                Lead_Source: "WhatsApp Chatbot",
                // Map your AI generated data to custom fields here
                Desired_Area: leadData.area,      // Example custom field API Name
                Budget_Range: leadData.budget,    // Example custom field API Name
                Occupancy_Type: leadData.sharing, // Example custom field API Name
                Move_In_Timeline: leadData.timeline,
                Contract_Duration: leadData.contract
            }
        ]
    };

    try {
        const response = await axios.post(
            'https://www.zohoapis.in/crm/v3/Leads', // Use .in or .com depending on your DC
            payload,
            {
                headers: {
                    'Authorization': `Zoho-oauthtoken ${currentAccessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log("Successfully created lead in Zoho:", response.data);
        return response.data;

    } catch (error) {
        // If unauthorized, token might have expired. Try refreshing once.
        if (error.response && error.response.status === 401) {
            console.log("Zoho token expired. Attempting to refresh and retry...");
            await refreshZohoToken();
            // Retry the request
            const retryResponse = await axios.post(
                'https://www.zohoapis.in/crm/v3/Leads',
                payload,
                {
                    headers: {
                        'Authorization': `Zoho-oauthtoken ${currentAccessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            console.log("Successfully created lead in Zoho on retry:", retryResponse.data);
            return retryResponse.data;
        }

        console.error("Error creating lead in Zoho:", error.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    createLead
};
