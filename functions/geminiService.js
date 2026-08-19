/**
 * Gemini AI Service for WanderMint
 * 
 * Handles preliminary itinerary generation, logistical airport analysis,
 * TripAdvisor 4.5+ hotel curation, points optimization, and conversational copilot.
 */

const fetch = require('node-fetch');

const DEFAULT_MODEL = 'gemini-3.6-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Call the Gemini API with structured prompt and optional JSON schema enforcement
 */
async function callGemini({ prompt, systemInstruction, apiKey, jsonMode = false, model = DEFAULT_MODEL }) {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) {
        throw new Error('GEMINI_API_KEY is not configured');
    }

    const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${key}`;

    const contents = [
        {
            role: 'user',
            parts: [{ text: prompt }]
        }
    ];

    const requestBody = {
        contents,
        generationConfig: {
            temperature: 0.4,
            topP: 0.95,
            topK: 40,
            maxOutputTokens: 8192
        }
    };

    if (systemInstruction) {
        requestBody.systemInstruction = {
            parts: [{ text: systemInstruction }]
        };
    }

    if (jsonMode) {
        requestBody.generationConfig.responseMimeType = 'application/json';
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    if (!candidate || !candidate.content?.parts?.[0]?.text) {
        throw new Error('Empty response received from Gemini API');
    }

    const text = candidate.content.parts[0].text;
    if (jsonMode) {
        try {
            return JSON.parse(text);
        } catch (e) {
            console.error('Failed to parse JSON response from Gemini:', text);
            throw new Error(`Invalid JSON returned from Gemini: ${e.message}`);
        }
    }

    return text;
}

/**
 * Generates an executive dossier and preliminary JSON recommendation for a trip request
 */
async function generateTripDossierAndDraft(tripData, pointsData = {}, apiKey = null) {
    const systemInstruction = `
You are an expert luxury & boutique travel consultant and points/miles optimizer for WanderMint.
Your goal is to produce a high-value, preliminary itinerary recommendation and executive planning dossier for a human travel consultant.

Consultant's Core Planning Methodology:
1. AIRPORT & LOGISTICAL STRATEGY:
   - Analyze origin and destination to determine the most strategic gateway airport(s) (e.g. fly into PWM vs BGR vs BOS).
   - Evaluate circular loop vs open-jaw (multi-city) routes to minimize redundant driving.
   - Cross-reference points & miles (Chase Ultimate Rewards, Amex Membership Rewards, Capital One, Airline miles, Hotel points) vs cash flights.
2. DESTINATION SPLIT & PACING:
   - Divide the total trip duration logically across 2 to 4 distinct base locations.
   - Avoid overwhelming, hyper-touristy traps; emphasize charming, authentic local bases with strong character.
3. ACCOMMODATION CURATION:
   - Prioritize boutique hotels, unique glamping / luxury camping, historic inns, or lodges with TripAdvisor ratings of 4.5+ (or strong local repute).
   - Provide 2 accommodation options per destination (Priority 1 and Priority 2).
4. TAILORED ACTIVITIES & DINING:
   - Strictly honor negative constraints (e.g., if client gets sea sick, NEVER include boat rides / charters / cruises).
   - Highlight client interests (e.g., craft brewery trails, fresh local seafood shacks, historic walks, scenic hiking trails).
   - Activities & restaurants are curated recommendations for client flexibility (not rigid hour-by-hour schedules).

You must output a single, valid JSON object with the following structure:
{
  "executiveDossier": {
    "logisticsStrategy": "String summarizing flight routes, gateway airports, and points vs cash strategy",
    "destinationSplitSummary": "String summarizing the pacing and bases",
    "accommodationHighlights": "String summarizing the top accommodation picks",
    "activitiesHighlights": "String summarizing highlights and confirmed constraint adherence"
  },
  "recommendation": {
    "tripOverview": "Detailed narrative overview of the trip (1-3 paragraphs)",
    "destinations": [
      {
        "id": "dest-1",
        "cityName": "City/Region Name",
        "arrivalDate": "YYYY-MM-DD",
        "departureDate": "YYYY-MM-DD",
        "numberOfNights": 3,
        "overview": "Destination summary and why it fits client preferences",
        "accommodationOptions": [
          {
            "id": "acc-1-1",
            "priority": 1,
            "hotel": {
              "name": "Hotel Name",
              "rating": 4.8,
              "pricePerNight": 320,
              "pointsPerNight": 0,
              "loyaltyProgram": "Independent / Boutique",
              "location": "Address or neighborhood",
              "detailedDescription": "Description of amenities, atmosphere, and why recommended",
              "bookingUrl": ""
            }
          },
          {
            "id": "acc-1-2",
            "priority": 2,
            "hotel": {
              "name": "Alternative Hotel Name",
              "rating": 4.7,
              "pricePerNight": 260,
              "pointsPerNight": 0,
              "loyaltyProgram": "Independent / Boutique",
              "location": "Address or neighborhood",
              "detailedDescription": "Description of alternative option",
              "bookingUrl": ""
            }
          }
        ],
        "recommendedActivities": [
          {
            "id": "act-1-1",
            "title": "Activity Name",
            "description": "Activity description",
            "category": "Culture / Nature / Food",
            "priority": "Must-See",
            "estimatedCost": { "cashAmount": 0, "currency": "USD" }
          }
        ],
        "recommendedRestaurants": [
          {
            "id": "rest-1-1",
            "name": "Restaurant Name",
            "cuisine": "Seafood / American / Craft Beer",
            "priceRange": "$$",
            "description": "Why recommended and signature dishes",
            "mealType": "Dinner"
          }
        ]
      }
    ],
    "logistics": {
      "transportSegments": [
        {
          "id": "trans-1",
          "originCity": "Origin City",
          "destinationCity": "Destination City",
          "departureDate": "YYYY-MM-DD",
          "transportType": "Flight",
          "transportOptions": [
            {
              "id": "opt-1",
              "priority": 1,
              "provider": "Airline Name",
              "departureTime": "08:00 AM",
              "arrivalTime": "12:30 PM",
              "duration": "4h 30m",
              "cost": {
                "cashAmount": 380,
                "pointsAmount": 0,
                "currency": "USD"
              },
              "description": "Recommended flight route"
            }
          ]
        }
      ]
    },
    "totalCost": {
      "currency": "USD"
    },
    "costNotes": "Notes regarding seasonal pricing, car rental estimates, or points transfer guidelines."
  }
}
`;

    const prompt = `
Generate a preliminary travel dossier and draft recommendation for this client trip request:

Client Details:
- Destination(s): ${tripData.destinations?.join(', ') || tripData.destination || 'Not specified'}
- Departure Location: ${tripData.departureLocation || 'Not specified'}
- Dates: ${tripData.startDate ? (tripData.startDate.toDate ? tripData.startDate.toDate().toISOString().split('T')[0] : tripData.startDate) : 'Not specified'} to ${tripData.endDate ? (tripData.endDate.toDate ? tripData.endDate.toDate().toISOString().split('T')[0] : tripData.endDate) : 'Not specified'}
- Flexible Dates: ${tripData.flexibleDates ? 'Yes' : 'No'}
- Trip Duration: ${tripData.tripDuration || 10} days
- Group Size: ${tripData.groupSize || 2} travelers
- Budget: ${tripData.budget || 'Mid-range'}
- Travel Style: ${tripData.travelStyle || 'Relaxation'}
- Interests: ${tripData.interests?.join(', ') || 'None specified'}
- Special Requests & Constraints: ${tripData.specialRequests || 'None'}

Client Loyalty Points & Miles Balances:
- Credit Card Points: ${JSON.stringify(pointsData.creditCard || {})}
- Hotel Points: ${JSON.stringify(pointsData.hotel || {})}
- Airline Miles: ${JSON.stringify(pointsData.airline || {})}
- Total Points: ${pointsData.totalPoints || 0}
`;

    return await callGemini({
        prompt,
        systemInstruction,
        apiKey,
        jsonMode: true
    });
}

/**
 * Format executive dossier into clean HTML for email notifications
 */
function formatDossierEmailHtml(dossierData) {
    if (!dossierData || !dossierData.executiveDossier) return '';

    const { logisticsStrategy, destinationSplitSummary, accommodationHighlights, activitiesHighlights } = dossierData.executiveDossier;

    return `
        <div style="background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); color: #ffffff; padding: 20px; border-radius: 12px; margin: 20px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <h3 style="color: #ffffff; margin-top: 0; display: flex; align-items: center;">
                🤖 AI Preliminary Planning Dossier & Draft Ready
            </h3>
            <p style="color: #e0e7ff; font-size: 14px; margin-bottom: 16px;">
                Gemini AI has analyzed this request, evaluated airport logistics, vetted TripAdvisor 4.5+ stays, and generated an initial draft recommendation in your Admin Dashboard.
            </p>

            <div style="background: rgba(255, 255, 255, 0.12); padding: 14px; border-radius: 8px; margin-bottom: 12px;">
                <h4 style="color: #93c5fd; margin: 0 0 6px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">✈️ Flight & Logistics Strategy</h4>
                <p style="color: #ffffff; margin: 0; font-size: 14px; line-height: 1.5;">${logisticsStrategy || 'Logistical routing calculated.'}</p>
            </div>

            <div style="background: rgba(255, 255, 255, 0.12); padding: 14px; border-radius: 8px; margin-bottom: 12px;">
                <h4 style="color: #93c5fd; margin: 0 0 6px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">🗺️ Curated Destination Split & Pacing</h4>
                <p style="color: #ffffff; margin: 0; font-size: 14px; line-height: 1.5;">${destinationSplitSummary || 'Regional pacing generated.'}</p>
            </div>

            <div style="background: rgba(255, 255, 255, 0.12); padding: 14px; border-radius: 8px; margin-bottom: 12px;">
                <h4 style="color: #93c5fd; margin: 0 0 6px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">🏨 Accommodations & TripAdvisor 4.5+ Picks</h4>
                <p style="color: #ffffff; margin: 0; font-size: 14px; line-height: 1.5;">${accommodationHighlights || 'Top options identified.'}</p>
            </div>

            <div style="background: rgba(255, 255, 255, 0.12); padding: 14px; border-radius: 8px;">
                <h4 style="color: #93c5fd; margin: 0 0 6px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">🌲 Activities, Dining & Constraint Checks</h4>
                <p style="color: #ffffff; margin: 0; font-size: 14px; line-height: 1.5;">${activitiesHighlights || 'Constraints applied and activities curated.'}</p>
            </div>
        </div>
    `;
}

module.exports = {
    callGemini,
    generateTripDossierAndDraft,
    formatDossierEmailHtml
};
