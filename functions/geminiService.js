/**
 * Gemini AI Service for WanderMint
 *
 * Powers the AI Dictation Copilot (turning consultant voice/text shorthand into
 * full AdminDestinationBasedRecommendation JSON) and on-demand itinerary drafts.
 */

const fetch = require('node-fetch');

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const ADMIN_RECOMMENDATION_SCHEMA_GUIDE = `
CRITICAL: Whenever you return a recommendation or "updatedRecommendation", it MUST conform strictly to the WanderMint AdminDestinationBasedRecommendation schema consumed by the iOS app and travelAdmin dashboard:

{
  "tripOverview": "High-level executive overview of the itinerary and why it fits the traveler",
  "costNotes": "Step-by-step points transfer strategy and booking notes (e.g., 'Transfer 100k Chase UR to Air France/KLM Flying Blue (instant) for outbound biz class; transfer 135k Chase UR to World of Hyatt for 3 nights at Park Hyatt Paris')",
  "destinations": [
    {
      "id": "dest_1",
      "cityName": "Paris, France",
      "arrivalDate": "YYYY-MM-DD",
      "departureDate": "YYYY-MM-DD",
      "numberOfNights": 3,
      "overview": "Neighborhood and pacing overview for this stop",
      "recommendedOption": 1,
      "accommodationOptions": [
        {
          "id": "acc_1",
          "priority": 1,
          "bookingInstructions": "Transfer 45,000 Chase Ultimate Rewards per night to World of Hyatt and book standard king room via hyatt.com",
          "selectedForBooking": false,
          "notes": "Why you picked this hotel",
          "hotel": {
            "id": "hotel_1",
            "name": "Park Hyatt Paris-Vendôme",
            "rating": 4.8,
            "pricePerNight": 1100,
            "pointsPerNight": 45000,
            "loyaltyProgram": "World of Hyatt",
            "location": "5 Rue de la Paix, 75002 Paris, France",
            "bookingUrl": "https://www.hyatt.com",
            "bookingInstructions": "Transfer 45,000 Chase UR/night to Hyatt",
            "detailedDescription": "2-3 sentence rich description of property, vibe, and location.",
            "whyRecommended": "Unbeatable value on Hyatt points in central Place Vendôme.",
            "photoUrl": "",
            "tripadvisorUrl": "",
            "amenities": ["Spa", "Concierge", "Fitness Center"],
            "cancellationPolicy": "Free cancellation up to 48h prior",
            "contactInfo": "+33 1 58 71 12 34"
          }
        }
      ],
      "recommendedActivities": [
        {
          "id": "act_1",
          "name": "Louvre Evening Tour",
          "description": "Guided small-group evening tour when crowds thin out.",
          "category": "Culture",
          "duration": "3 hours",
          "estimatedDuration": "3 hours",
          "estimatedCost": 85,
          "priority": 1,
          "bestTimeToVisit": "Wednesday or Friday evening",
          "location": "Rue de Rivoli, 75001 Paris",
          "bookingRequired": true,
          "bookingUrl": "https://www.louvre.fr/en",
          "bookingInstructions": "Book timed-entry tickets at least 3 weeks in advance",
          "tips": "Enter via the Carrousel du Louvre underground entrance to skip the Pyramid line."
        }
      ],
      "recommendedRestaurants": [
        {
          "id": "rest_1",
          "name": "Le Comptoir du Relais",
          "cuisine": "French Bistro",
          "description": "Classic Saint-Germain bistro by Yves Camdeborde.",
          "priceRange": "$$$",
          "estimatedCost": 75,
          "mealType": "Dinner",
          "priority": 1,
          "location": "9 Carrefour de l'Odéon, 75006 Paris",
          "reservationRequired": true,
          "reservationUrl": "",
          "reservationInstructions": "Walk-ins for lunch terrace; book 2 weeks ahead for dinner",
          "specialties": ["Duck Confit", "Terrine de Campagne"],
          "tips": "Arrive by 12:00 PM for lunch seating."
        }
      ]
    }
  ],
  "logistics": {
    "generalInstructions": "Overall transit & points transfer reminders",
    "recommendedBookingOrder": ["Book award flights first while space is open", "Transfer points to hotel partners and reserve stays"],
    "transportSegments": [
      {
        "id": "segment_1",
        "fromCity": "New York (JFK)",
        "toCity": "Paris (CDG)",
        "departureDate": "YYYY-MM-DD",
        "segmentType": "outbound",
        "selectedOption": 1,
        "transportOptions": [
          {
            "id": "option_1",
            "transportType": "flight",
            "priority": 1,
            "duration": "7h 15m",
            "bookingUrl": "https://www.airfrance.us",
            "notes": "Transfer 50,000 Chase UR / Amex MR per person to Air France/KLM Flying Blue. Taxes $210.",
            "isRoundTrip": false,
            "returnLegFor": "",
            "cost": {
              "paymentType": "points",
              "cashAmount": 210,
              "totalCashValue": 210,
              "pointsAmount": 50000,
              "pointsProgram": "Air France/KLM Flying Blue"
            },
            "details": {
              "flightNumber": "AF 11",
              "airline": "Air France",
              "departureAirportName": "John F. Kennedy International Airport",
              "arrivalAirportName": "Charles de Gaulle Airport",
              "class": "Business",
              "aircraft": "Boeing 777-300ER",
              "details": {
                "departure": {
                  "airportCode": "JFK",
                  "time": "19:30",
                  "date": "YYYY-MM-DD"
                },
                "arrival": {
                  "airportCode": "CDG",
                  "time": "08:45",
                  "date": "YYYY-MM-DD"
                },
                "route": "Direct",
                "showDateChange": "+1 day"
              }
            }
          }
        ]
      }
    ]
  },
  "totalCost": {
    "totalEstimate": 370,
    "flights": 210,
    "accommodation": 0,
    "activities": 85,
    "food": 75,
    "localTransport": 0,
    "miscellaneous": 0,
    "currency": "USD",
    "pointsUsed": {
      "Air France/KLM Flying Blue": 50000,
      "World of Hyatt": 135000
    }
  }
}

DICTATION AUTO-COMPLETION RULES:
1. The user is an expert points & miles consultant dictating or typing shorthand after picking flights/hotels manually.
2. When the user dictates shorthand (e.g. "Fly JFK-CDG on AF 11 May 12 7:30pm-8:45am+1 in biz for 50k Flying Blue + $210, stay at Park Hyatt Paris May 13-16 for 45k Hyatt pts/night"), YOU must automatically fill in ALL tedious boilerplate fields:
   - Full airport names ("John F. Kennedy International Airport", "Charles de Gaulle Airport")
   - Airport 3-letter IATA codes ("JFK", "CDG") inside details.details.departure.airportCode and arrival.airportCode
   - 24-hour or clear times ("19:30", "08:45"), estimated flight duration ("7h 15m"), aircraft type if known, and showDateChange ("+1 day" for overnight flights)
   - Accurate cost object: if both points and taxes/fees are mentioned, set paymentType to "points" (or "hybrid"), pointsAmount to the points number, pointsProgram to the program name, and cashAmount / totalCashValue to the taxes/fees dollar amount!
   - Full hotel details: official property name, street address in "location", estimated rating (e.g. 4.8), estimated cash pricePerNight, pointsPerNight, loyaltyProgram, bookingUrl, rich 2-3 sentence detailedDescription, and clear bookingInstructions explaining how to transfer points and book.
   - Preserve any existing destinations, hotels, activities, restaurants, or transport segments in Current Recommendation State unless the user asked to replace or remove them.
`;

/**
 * Call the Gemini API with structured prompt and optional JSON schema enforcement
 */
async function callGemini({ prompt, contents = null, systemInstruction, apiKey, jsonMode = false, model = DEFAULT_MODEL, temperature = 0.25 }) {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) {
        throw new Error('GEMINI_API_KEY is not configured');
    }

    const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${key}`;

    const messageContents = contents || [
        {
            role: 'user',
            parts: [{ text: prompt }]
        }
    ];

    const requestBody = {
        contents: messageContents,
        generationConfig: {
            temperature,
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
 * Interactive AI Copilot Chat & Voice Dictation Extraction Handler
 */
async function handleCopilotChat({ message, history = [], tripContext = {}, currentRecommendation = null, apiKey = null }) {
    const systemInstruction = `
You are the WanderMint AI Dictation & Travel Consulting Copilot.
Your primary role is to turn the travel consultant's voice dictation or typed shorthand into a 100% complete, deeply enriched WanderMint recommendation JSON so the consultant never has to manually fill out tedious form fields.

${ADMIN_RECOMMENDATION_SCHEMA_GUIDE}

Current Trip Intake Context (including client's Points & Miles balances if available):
${JSON.stringify(tripContext, null, 2)}

Current Recommendation State in Dashboard:
${JSON.stringify(currentRecommendation, null, 2)}

Response Format Instructions:
Always output valid JSON with keys:
1. "reply": Concise, helpful confirmation of every field you populated or updated (e.g., flights, points transfer notes, hotels, activities).
2. "updatedRecommendation": (Optional) Whenever the user dictates or asks to add/modify/remove any trip overview, cost/points strategy notes, destinations, hotels, activities, restaurants, or flights/transport segments, provide the FULL updated recommendation JSON matching the schema above. Omit or set to null only if the user is asking a pure question without changing the recommendation.
3. "actionSummary": (Optional) A brief 1-line summary badge describing the update (e.g., "Populated AF 11 Business Class flight + Park Hyatt Paris").
`;

    const contents = [];
    if (Array.isArray(history)) {
        history.slice(-8).forEach(h => {
            if (h.role && h.text) {
                contents.push({
                    role: h.role === 'user' ? 'user' : 'model',
                    parts: [{ text: h.text }]
                });
            }
        });
    }
    contents.push({
        role: 'user',
        parts: [{ text: message }]
    });

    const parsed = await callGemini({
        contents,
        systemInstruction,
        apiKey,
        jsonMode: true,
        temperature: 0.2
    });

    return {
        success: true,
        reply: parsed.reply || 'Changes processed.',
        updatedRecommendation: parsed.updatedRecommendation || null,
        actionSummary: parsed.actionSummary || null
    };
}

/**
 * Generates an on-demand executive dossier and JSON recommendation for a trip request
 */
async function generateTripDossierAndDraft(tripData, pointsData = {}, apiKey = null) {
    const systemInstruction = `
You are an expert luxury & boutique travel consultant and points/miles optimizer for WanderMint.
Produce an executive planning dossier and a complete recommendation conforming to the WanderMint AdminDestinationBasedRecommendation schema.

${ADMIN_RECOMMENDATION_SCHEMA_GUIDE}

Output a single valid JSON object with keys:
{
  "executiveDossier": {
    "logisticsStrategy": "String summarizing flight routes, gateway airports, and points vs cash strategy",
    "destinationSplitSummary": "String summarizing the pacing and bases",
    "accommodationHighlights": "String summarizing the top accommodation picks",
    "activitiesHighlights": "String summarizing highlights and confirmed constraint adherence"
  },
  "recommendation": { ... full AdminDestinationBasedRecommendation ... }
}
`;

    const prompt = `
Generate a travel dossier and draft recommendation for this client trip request:

Client Details:
- Destination(s): ${tripData.destinations?.join(', ') || tripData.destination || 'Not specified'}
- Departure Location: ${tripData.departureLocation || 'Not specified'}
- Dates: ${tripData.startDate ? (tripData.startDate.toDate ? tripData.startDate.toDate().toISOString().split('T')[0] : tripData.startDate) : 'Not specified'} to ${tripData.endDate ? (tripData.endDate.toDate ? tripData.endDate.toDate().toISOString().split('T')[0] : tripData.endDate) : 'Not specified'}
- Flexible Dates: ${tripData.flexibleDates ? 'Yes' : 'No'}
- Trip Duration: ${tripData.tripDuration || 10} days
- Group Size: ${tripData.groupSize || 2} travelers
- Budget: ${tripData.budget || 'Mid-range'}
- Travel Style: ${tripData.travelStyle || 'Relaxation'}
- Pet Friendly: ${tripData.petFriendly ? 'YES (All accommodations and activities/restaurants MUST accommodate pets)' : 'No'}
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
                🤖 AI Planning Dossier
            </h3>
            <div style="background: rgba(255, 255, 255, 0.12); padding: 14px; border-radius: 8px; margin-bottom: 12px;">
                <h4 style="color: #93c5fd; margin: 0 0 6px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">✈️ Flight & Logistics Strategy</h4>
                <p style="color: #ffffff; margin: 0; font-size: 14px; line-height: 1.5;">${logisticsStrategy || 'Logistical routing calculated.'}</p>
            </div>
            <div style="background: rgba(255, 255, 255, 0.12); padding: 14px; border-radius: 8px; margin-bottom: 12px;">
                <h4 style="color: #93c5fd; margin: 0 0 6px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">🗺️ Curated Destination Split & Pacing</h4>
                <p style="color: #ffffff; margin: 0; font-size: 14px; line-height: 1.5;">${destinationSplitSummary || 'Regional pacing generated.'}</p>
            </div>
            <div style="background: rgba(255, 255, 255, 0.12); padding: 14px; border-radius: 8px; margin-bottom: 12px;">
                <h4 style="color: #93c5fd; margin: 0 0 6px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">🏨 Accommodations</h4>
                <p style="color: #ffffff; margin: 0; font-size: 14px; line-height: 1.5;">${accommodationHighlights || 'Top options identified.'}</p>
            </div>
            <div style="background: rgba(255, 255, 255, 0.12); padding: 14px; border-radius: 8px;">
                <h4 style="color: #93c5fd; margin: 0 0 6px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">🌲 Activities & Dining</h4>
                <p style="color: #ffffff; margin: 0; font-size: 14px; line-height: 1.5;">${activitiesHighlights || 'Constraints applied and activities curated.'}</p>
            </div>
        </div>
    `;
}

module.exports = {
    DEFAULT_MODEL,
    ADMIN_RECOMMENDATION_SCHEMA_GUIDE,
    callGemini,
    handleCopilotChat,
    generateTripDossierAndDraft,
    formatDossierEmailHtml
};
