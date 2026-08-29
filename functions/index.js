const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { validateTripSubmissionData, validateRecommendationData } = require("./schemas");
const { generateTripDossierAndDraft, formatDossierEmailHtml } = require("./geminiService");

// Initialize Firebase Admin
initializeApp();

const db = getFirestore();
const auth = getAuth();

// Input sanitization helper
const sanitizeString = (input) => {
    if (typeof input !== 'string') return input;
    return input.trim().replace(/[<>\"'&]/g, '');
};

// Lazy load Nodemailer or SendGrid for email notifications
let mailTransporter = null;
let sgMail = null;

const sendEmail = async (msg) => {
    const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
    const sendGridKey = process.env.SENDGRID_API_KEY;

    if (gmailAppPassword) {
        if (!mailTransporter) {
            const nodemailer = require('nodemailer');
            mailTransporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: 'nchristus93@gmail.com',
                    pass: gmailAppPassword.replace(/\s+/g, '')
                }
            });
            console.log('✅ Nodemailer Gmail transporter initialized successfully');
        }
        return await mailTransporter.sendMail({
            from: msg.from || '"WanderMint" <nchristus93@gmail.com>',
            to: msg.to,
            subject: msg.subject,
            html: msg.html
        });
    } else if (sendGridKey) {
        if (!sgMail) {
            const sg = require('@sendgrid/mail');
            sg.setApiKey(sendGridKey.trim());
            sgMail = sg;
            console.log('✅ SendGrid initialized successfully');
        }
        return await sgMail.send(msg);
    } else {
        console.log('❌ Neither GMAIL_APP_PASSWORD nor SENDGRID_API_KEY found in secrets. Skipping email.');
        return null;
    }
};

// Submit Trip HTTP endpoint
exports.submitTrip = onRequest(
    {
        region: "us-central1",
        memory: "512MiB",
        timeoutSeconds: 60,
        cors: true
    },
    async (req, res) => {
        // Set CORS headers
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
        // Handle preflight OPTIONS request
        if (req.method === 'OPTIONS') {
            res.status(200).send('');
            return;
        }
        
        if (req.method !== 'POST') {
            res.status(405).send('Method Not Allowed');
            return;
        }
        
        try {
            // Get ID token from Authorization header
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.status(401).send('Unauthorized: Missing or invalid token');
                return;
            }
            
            const idToken = authHeader.split('Bearer ')[1];
            const decodedToken = await auth.verifyIdToken(idToken);
            const uid = decodedToken.uid;

            const data = req.body;

            // Schema validation with detailed error reporting
            const validation = validateTripSubmissionData(data);
            if (!validation.valid) {
                console.error('Schema validation failed:', validation.errors);
                const errorMessages = validation.errors.map(err =>
                    `${err.field}: ${err.message}`
                ).join('; ');
                res.status(400).json({
                    error: 'Validation failed',
                    details: validation.errors,
                    message: errorMessages
                });
                return;
            }

            // Sanitize and validate required fields - support both old and new formats
            const destination = sanitizeString(data.destination || (data.destinations && data.destinations[0]));
            const destinations = data.destinations ? data.destinations.map(d => sanitizeString(d)).filter(d => d) : (data.destination ? [sanitizeString(data.destination)] : []);
            const departureLocation = sanitizeString(data.departureLocation) || null;

            // Validate required fields with proper array validation
            if (destinations.length === 0 || !data.startDate || !data.endDate) {
                console.error('Missing required fields:', {
                    destination: !!destination,
                    destinations: destinations.length > 0,
                    destinationsCount: destinations.length,
                    startDate: !!data.startDate,
                    endDate: !!data.endDate,
                    departureLocation: !!departureLocation
                });
                res.status(400).send('Missing required fields: at least one destination, startDate, and endDate are required');
                return;
            }

            // Additional validation: destinations array limit
            if (destinations.length > 5) {
                res.status(400).send('Maximum 5 destinations allowed per trip');
                return;
            }
            
            // Extract and sanitize optional preference fields
            const budget = sanitizeString(data.budget) || null;
            const travelStyle = sanitizeString(data.travelStyle) || 'Comfortable';
            const groupSize = Math.max(1, Math.min(20, parseInt(data.groupSize) || 1)); // Limit group size 1-20
            const specialRequests = sanitizeString(data.specialRequests) || '';
            const interests = data.interests ? data.interests.map(i => sanitizeString(i)).filter(i => i) : [];
            
            // Check rate limiting
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            const userSubmissionsRef = db.collection('userSubmissions').doc(uid);
            const userSubmissionDoc = await userSubmissionsRef.get();
            
            if (userSubmissionDoc.exists) {
                const submissionData = userSubmissionDoc.data();
                const lastSubmissionDate = submissionData.lastSubmissionDate?.toDate();
                const submissionCount = submissionData.submissionCount || 0;
                
                // Check if user has exceeded daily limit
                if (lastSubmissionDate && 
                    lastSubmissionDate.toDateString() === today.toDateString() && 
                    submissionCount >= 10) {
                    res.status(429).send('Daily submission limit reached (10 submissions per day)');
                    return;
                }
            }
            
            // Parse dates from the iOS app - handle date-only strings to preserve calendar dates globally
            let startDate, endDate;
            try {
                // Parse date-only strings (YYYY-MM-DD) as UTC noon to avoid timezone boundary issues
                if (data.startDate && typeof data.startDate === 'string' && data.startDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
                    // Parse as UTC at noon (12:00) to avoid timezone shifts that could change the date
                    const [year, month, day] = data.startDate.split('-').map(Number);
                    startDate = Timestamp.fromDate(new Date(Date.UTC(year, month - 1, day, 12, 0, 0))); // month is 0-indexed, 12:00 UTC
                } else {
                    // Fallback to regular Date parsing for other formats
                    startDate = data.startDate ? Timestamp.fromDate(new Date(data.startDate)) : null;
                }
                
                if (data.endDate && typeof data.endDate === 'string' && data.endDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
                    // Parse as UTC at noon (12:00) to avoid timezone shifts that could change the date
                    const [year, month, day] = data.endDate.split('-').map(Number);
                    endDate = Timestamp.fromDate(new Date(Date.UTC(year, month - 1, day, 12, 0, 0))); // month is 0-indexed, 12:00 UTC
                } else {
                    // Fallback to regular Date parsing for other formats
                    endDate = data.endDate ? Timestamp.fromDate(new Date(data.endDate)) : null;
                }
                
                // Validate dates
                if (!startDate || !endDate) {
                    throw new Error('Invalid date format');
                }
                
                // Check that end date is after start date
                if (endDate.toDate() <= startDate.toDate()) {
                    throw new Error('End date must be after start date');
                }
            } catch (dateError) {
                console.error('Date parsing error:', dateError);
                res.status(400).send(`Invalid date format: ${dateError.message}`);
                return;
            }
            
            // Create trip document with enhanced fields
            const tripData = {
                userId: uid,
                // Support both old and new destination formats
                destination: destination,
                destinations: destinations,
                departureLocation: departureLocation, // Add departure location field
                startDate: startDate,
                endDate: endDate,
                paymentMethod: data.paymentMethod || null, // Optional since we now use flexible costs
                flexibleDates: data.flexibleDates || false,
                status: 'pending',
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
                
                // New enhanced fields
                budget: budget,
                travelStyle: travelStyle,
                groupSize: groupSize,
                petFriendly: Boolean(data.petFriendly || data.isPetFriendly || false),
                optInEmailNotifications: Boolean(data.optInEmailNotifications ?? true),
                specialRequests: specialRequests,
                interests: interests,
                flightClass: data.flightClass || null,
                tripDuration: data.tripDuration || null
            };
            
            // Add flexible date fields if applicable
            if (data.flexibleDates) {
                if (data.earliestStartDate) {
                    tripData.earliestStartDate = Timestamp.fromDate(new Date(data.earliestStartDate));
                }
                if (data.latestEndDate) {
                    tripData.latestEndDate = Timestamp.fromDate(new Date(data.latestEndDate));
                }
                tripData.minTripLength = data.minTripLength || 1;
                tripData.maxTripLength = data.maxTripLength || 14;
            }

            const tripRef = await db.collection('trips').add(tripData);
            
            // Update user submissions tracking
            const newSubmissionCount = userSubmissionDoc.exists && 
                userSubmissionDoc.data().lastSubmissionDate?.toDate()?.toDateString() === today.toDateString() 
                ? (userSubmissionDoc.data().submissionCount || 0) + 1 
                : 1;
                
            await userSubmissionsRef.set({
                lastSubmissionDate: FieldValue.serverTimestamp(),
                submissionCount: newSubmissionCount
            });
            
            res.status(200).json({ tripId: tripRef.id, success: true });
            
        } catch (error) {
            console.error('Error submitting trip:', error);
            if (error.code === 'auth/id-token-expired') {
                res.status(401).send('Token expired');
            } else if (error.code === 'auth/argument-error') {
                res.status(401).send('Invalid token');
            } else {
                res.status(500).send(`Failed to submit trip: ${error.message}`);
            }
        }
    }
);

// Admin function to update trip with recommendations
exports.updateTripRecommendation = onRequest(
    {
        region: "us-central1",
        memory: "512MiB",
        timeoutSeconds: 60,
        cors: true
    },
    async (req, res) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
        if (req.method === 'OPTIONS') {
            res.status(200).send('');
            return;
        }
        
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.status(401).send('Unauthorized');
                return;
            }
            
            const idToken = authHeader.split('Bearer ')[1];
            const decodedToken = await auth.verifyIdToken(idToken);
            
            // Only allow admin users to update recommendations
            if (!decodedToken.admin) {
                res.status(403).send('Admin access required');
                return;
            }
            
            const { tripId, recommendation } = req.body;

            if (!tripId || !recommendation) {
                res.status(400).send('Missing tripId or recommendation');
                return;
            }

            // Schema validation for recommendation data
            const validation = validateRecommendationData(recommendation);
            if (!validation.valid) {
                console.error('Recommendation schema validation failed:', validation.errors);
                const errorMessages = validation.errors.map(err =>
                    `${err.field}: ${err.message}`
                ).join('; ');
                res.status(400).json({
                    error: 'Recommendation validation failed',
                    details: validation.errors,
                    message: errorMessages
                });
                return;
            }
            
            // Update trip with your custom recommendation
            await db.collection('trips').doc(tripId).update({
                status: 'completed',
                recommendation: recommendation,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                completedBy: decodedToken.uid,
                completedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            console.log(`Trip ${tripId} completed by admin`);
            res.status(200).json({ success: true });
            
        } catch (error) {
            console.error('Error updating trip:', error);
            res.status(500).send(`Error: ${error.message}`);
        }
    }
);

// Process new trip submissions
exports.processNewTrip = onDocumentCreated(
    {
        document: 'trips/{tripId}',
        region: "us-central1",
        secrets: ["GMAIL_APP_PASSWORD", "SENDGRID_API_KEY", "GEMINI_API_KEY"]
    },
    async (event) => {
        const tripId = event.params.tripId;
        const tripData = event.data.data();
        
        console.log(`Processing new trip: ${tripId}`);
        
        try {
            // Fetch user profile and points data
            let pointsData = {
                creditCard: {},
                hotel: {},
                airline: {},
                totalPoints: 0
            };
            try {
                const userPointsDoc = await db.collection('userPoints').doc(tripData.userId).get();
                if (userPointsDoc.exists) {
                    const pointsDoc = userPointsDoc.data();
                    pointsData.creditCard = pointsDoc.creditCardPoints || {};
                    pointsData.hotel = pointsDoc.hotelPoints || {};
                    pointsData.airline = pointsDoc.airlinePoints || {};
                    const creditCardTotal = Object.values(pointsData.creditCard).reduce((sum, p) => sum + (p || 0), 0);
                    const hotelTotal = Object.values(pointsData.hotel).reduce((sum, p) => sum + (p || 0), 0);
                    const airlineTotal = Object.values(pointsData.airline).reduce((sum, p) => sum + (p || 0), 0);
                    pointsData.totalPoints = creditCardTotal + hotelTotal + airlineTotal;
                }
            } catch (pErr) {
                console.warn('Could not fetch points for AI generation:', pErr);
            }

            // Attempt AI Preliminary Generation
            let aiResult = null;
            let aiDossierHtml = '';
            const geminiApiKey = process.env.GEMINI_API_KEY;
            if (geminiApiKey) {
                try {
                    console.log(`🤖 Generating AI preliminary itinerary & dossier for trip ${tripId}...`);
                    aiResult = await generateTripDossierAndDraft(tripData, pointsData, geminiApiKey);
                    if (aiResult) {
                        aiDossierHtml = formatDossierEmailHtml(aiResult);
                        console.log(`✅ AI preliminary draft & dossier generated for trip ${tripId}`);
                    }
                } catch (aiErr) {
                    console.warn(`AI generation failed for trip ${tripId}:`, aiErr.message);
                }
            }

            const updatePayload = {
                status: 'pending',
                updatedAt: FieldValue.serverTimestamp()
            };

            if (aiResult?.recommendation) {
                updatePayload.destinationRecommendation = {
                    id: tripId,
                    ...aiResult.recommendation
                };
                updatePayload.isAiDraft = true;
                updatePayload.aiDossier = aiResult.executiveDossier || null;
            }

            // Update status & draft in Firestore
            await db.collection('trips').doc(tripId).update(updatePayload);
            
            // Send notification email with AI dossier included
            try {
                await sendNewTripNotification(tripId, tripData, pointsData, aiDossierHtml);
            } catch (emailError) {
                console.warn('Failed to send email notification:', emailError);
            }
            
            console.log(`Trip ${tripId} processed successfully (AI draft: ${!!aiResult})`);
            
        } catch (error) {
            console.error(`Error processing trip ${tripId}:`, error);
            
            await db.collection('trips').doc(tripId).update({
                status: 'failed',
                errorMessage: error.message,
                updatedAt: FieldValue.serverTimestamp()
            });
        }
    }
);

// Send email notification with user points and optional AI dossier
async function sendNewTripNotification(tripId, tripData, existingPointsData = null, aiDossierHtml = '') {
    
    // Fetch user profile and points data if not passed
    let userEmail = 'Not available';
    let userName = 'Not available';
    let pointsData = existingPointsData || {
        creditCard: {},
        hotel: {},
        airline: {},
        totalPoints: 0
    };
    
    try {
        const userProfileDoc = await db.collection('users').doc(tripData.userId).get();
        if (userProfileDoc.exists) {
            const userData = userProfileDoc.data();
            userEmail = userData.email || 'Not available';
            userName = userData.name || userData.displayName || 'Not available';
        }
        
        if (!existingPointsData) {
            const userPointsDoc = await db.collection('userPoints').doc(tripData.userId).get();
            if (userPointsDoc.exists) {
                const pointsDoc = userPointsDoc.data();
                pointsData.creditCard = pointsDoc.creditCardPoints || {};
                pointsData.hotel = pointsDoc.hotelPoints || {};
                pointsData.airline = pointsDoc.airlinePoints || {};
                
                const creditCardTotal = Object.values(pointsData.creditCard).reduce((sum, points) => sum + (points || 0), 0);
                const hotelTotal = Object.values(pointsData.hotel).reduce((sum, points) => sum + (points || 0), 0);
                const airlineTotal = Object.values(pointsData.airline).reduce((sum, points) => sum + (points || 0), 0);
                pointsData.totalPoints = creditCardTotal + hotelTotal + airlineTotal;
            }
        }
    } catch (error) {
        console.warn('Could not fetch user data:', error);
    }
    
    // Helper function to format points breakdown
    const formatPointsBreakdown = (pointsCategory, categoryName) => {
        const entries = Object.entries(pointsCategory);
        if (entries.length === 0) return `<p><strong>${categoryName}:</strong> None</p>`;
        
        return `
            <p><strong>${categoryName}:</strong></p>
            <ul style="margin: 0; padding-left: 20px;">
                ${entries.map(([provider, points]) => 
                    `<li>${provider}: ${points.toLocaleString()} pts</li>`
                ).join('')}
            </ul>
        `;
    };
    
    const msg = {
        to: 'nchristus93@gmail.com',
        from: 'noreply@wandermint.io',
        subject: `New Trip Request - ${tripData.destination || tripData.destinations?.[0] || 'Custom Trip'} (${tripData.groupSize || 1} ${(tripData.groupSize || 1) === 1 ? 'traveler' : 'travelers'}) - ${pointsData.totalPoints.toLocaleString()} total pts`,
        html: `
            <h2>🌍 New Trip Request</h2>
            
            <div style="background: #fff3cd; padding: 20px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #ffc107;">
                <h3>👤 Client Info</h3>
                <p><strong>Name:</strong> ${userName}</p>
                <p><strong>Email:</strong> ${userEmail}</p>
                <p><strong>Total Points:</strong> <span style="font-size: 1.2em; color: #28a745; font-weight: bold;">${pointsData.totalPoints.toLocaleString()}</span></p>
                <p><strong>User ID:</strong> ${tripData.userId}</p>
                <p><strong>Trip ID:</strong> ${tripId}</p>
            </div>
            
            <div style="background: #e8f5e8; padding: 20px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #28a745;">
                <h3>💳 Points & Miles Breakdown</h3>
                ${formatPointsBreakdown(pointsData.creditCard, 'Credit Card Points')}
                ${formatPointsBreakdown(pointsData.hotel, 'Hotel Points')}
                ${formatPointsBreakdown(pointsData.airline, 'Airline Miles')}
            </div>
            
            <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 16px 0;">
                <h3>📍 Trip Details</h3>
                <p><strong>Destination(s):</strong> ${tripData.destinations?.join(', ') || tripData.destination || 'Not specified'}</p>
                ${tripData.departureLocation ? `<p><strong>Departing from:</strong> ${tripData.departureLocation}</p>` : ''}
                <p><strong>Dates:</strong> ${tripData.startDate?.toDate?.()?.toLocaleDateString() || 'Not specified'} - ${tripData.endDate?.toDate?.()?.toLocaleDateString() || 'Not specified'}</p>
                <p><strong>Flexible Dates:</strong> ${tripData.flexibleDates ? 'Yes' : 'No'}</p>
                ${tripData.tripDuration ? `<p><strong>Trip Duration:</strong> ${tripData.tripDuration} days</p>` : ''}
                <p><strong>Payment Method:</strong> ${tripData.paymentMethod || 'Not specified'}</p>
                ${tripData.flightClass ? `<p><strong>Flight Class:</strong> ${tripData.flightClass}</p>` : ''}
            </div>
            
            <div style="background: #e3f2fd; padding: 20px; border-radius: 8px; margin: 16px 0;">
                <h3>✨ Client Preferences</h3>
                <p><strong>Budget:</strong> ${tripData.budget || 'Not specified'}</p>
                <p><strong>Travel Style:</strong> ${tripData.travelStyle || 'Not specified'}</p>
                <p><strong>Group Size:</strong> ${tripData.groupSize || 1} ${(tripData.groupSize || 1) === 1 ? 'person' : 'people'}</p>
                <p><strong>Pet-Friendly:</strong> ${tripData.petFriendly ? '🐾 Yes (Requires Pet-Friendly Stays & Activities)' : 'No'}</p>
                <p><strong>Interests:</strong> ${tripData.interests?.join(', ') || 'None specified'}</p>
                ${tripData.specialRequests ? `<p><strong>Special Requests:</strong> ${tripData.specialRequests}</p>` : ''}
            </div>

            ${aiDossierHtml}
            
            <div style="background: #f3e5f5; padding: 20px; border-radius: 8px; margin: 16px 0;">
                <h3>📊 Submission Info</h3>
                <p><strong>Submitted:</strong> ${new Date().toLocaleString()}</p>
                <p><strong>Status:</strong> <span style="color: #ffc107; font-weight: bold;">${aiDossierHtml ? 'AI Draft Pre-Populated (Ready for Review)' : 'Pending Manual Planning'}</span></p>
            </div>
            
            <div style="background: #fff3cd; padding: 20px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #ffc107;">
                <h3>🎯 Next Steps</h3>
                <p>Use the admin dashboard to review and finalize this recommendation:</p>
                <ul style="margin: 8px 0; padding-left: 20px;">
                    <li>Open <strong>Admin Dashboard</strong> to view/edit the pre-populated itinerary</li>
                    <li>Refine hotels, flight times, and curated local activities</li>
                    <li>Mark as completed and send directly to client's iOS app</li>
                </ul>
            </div>
            
            <hr style="margin: 24px 0;">
            <p style="color: #666; font-style: italic;">WanderMint AI Itinerary Engine 🎉</p>
        `
    };

    await sendEmail(msg);
    console.log(`Email notification sent for trip: ${tripId} (User: ${userName}, Total Points: ${pointsData.totalPoints.toLocaleString()})`);
}

// Send detailed itinerary completion notification
async function sendDetailedItineraryNotification(tripId, tripData) {
    
    // Get user info
    let userEmail = 'user@example.com';
    let userName = 'Travel Enthusiast';
    
    try {
        const userProfileDoc = await db.collection('users').doc(tripData.userId).get();
        if (userProfileDoc.exists) {
            const userData = userProfileDoc.data();
            userEmail = userData.email || userEmail;
            userName = userData.name || userData.displayName || userName;
        }
    } catch (error) {
        console.warn('Could not fetch user data for itinerary email:', error);
    }
    
    const destRec = tripData.destinationRecommendation || (tripData.recommendation?.destinations ? tripData.recommendation : null);
    const legacyRec = tripData.recommendation;
    const legacyItinerary = legacyRec?.itinerary;
    const destinationsTitle = tripData.destinations?.join(', ') || tripData.destination || 'Your Destination';
    const overviewText = destRec?.tripOverview || legacyRec?.overview || 'Your custom travel itinerary has been crafted and is ready for your trip.';
    
    let contentHtml = '';
    
    if (destRec && Array.isArray(destRec.destinations) && destRec.destinations.length > 0) {
        // Modern Destination-Based Itinerary formatting
        const destinationsHtml = destRec.destinations.map((dest, dIdx) => {
            const hotelsHtml = (dest.accommodationOptions || []).map(acc => {
                const h = acc.hotel || {};
                const mapQuery = encodeURIComponent(`${h.name} ${h.location || dest.cityName}`);
                return `
                    <div style="background: white; border-radius: 8px; padding: 14px; margin: 10px 0; border: 1px solid #e2e8f0; border-left: 4px solid #3b82f6;">
                        <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap;">
                            <strong style="color: #1e3a8a; font-size: 16px;">${h.name || 'Hotel'}</strong>
                            <span style="color: #059669; font-weight: bold;">$${h.pricePerNight || 0}/night ${h.pointsPerNight ? `· ${h.pointsPerNight.toLocaleString()} pts` : ''}</span>
                        </div>
                        <p style="color: #4b5563; margin: 4px 0 6px 0; font-size: 13px;">
                            ⭐ ${h.rating || 4.5}/5 · 📍 <a href="https://www.google.com/maps/search/?api=1&query=${mapQuery}" style="color: #2563eb; text-decoration: none;" target="_blank">${h.location || dest.cityName} 🗺️</a>
                        </p>
                        ${h.detailedDescription ? `<p style="color: #374151; margin: 6px 0; font-size: 14px; line-height: 1.4;">${h.detailedDescription}</p>` : ''}
                        <div style="margin-top: 8px; font-size: 13px;">
                            ${h.bookingUrl ? `<a href="${h.bookingUrl}" style="background: #2563eb; color: white; padding: 4px 10px; border-radius: 4px; text-decoration: none; display: inline-block; margin-right: 8px; font-size: 12px;" target="_blank">Book Hotel</a>` : ''}
                            ${h.tripadvisorUrl ? `<a href="${h.tripadvisorUrl}" style="color: #0284c7; text-decoration: none; margin-right: 8px;" target="_blank">TripAdvisor Reviews</a>` : ''}
                        </div>
                    </div>
                `;
            }).join('');

            const activitiesHtml = (dest.recommendedActivities || []).map(act => {
                const mapQuery = encodeURIComponent(`${act.name} ${act.location || dest.cityName}`);
                return `
                    <div style="background: white; border-radius: 6px; padding: 12px; margin: 8px 0; border: 1px solid #e2e8f0;">
                        <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap;">
                            <strong style="color: #1f2937; font-size: 15px;">${act.name}</strong>
                            ${act.estimatedCost?.cashAmount > 0 || typeof act.estimatedCost === 'number' ? `<span style="color: #059669; font-weight: 600; font-size: 13px;">$${act.estimatedCost?.cashAmount || act.estimatedCost}</span>` : '<span style="color: #6b7280; font-size: 12px;">Free / Included</span>'}
                        </div>
                        <p style="color: #6b7280; margin: 2px 0 6px 0; font-size: 12px;">
                            🏷️ ${act.category || 'Sightseeing'} ${act.estimatedDuration ? `· ⏱️ ${act.estimatedDuration}` : ''} · 📍 <a href="https://www.google.com/maps/search/?api=1&query=${mapQuery}" style="color: #2563eb; text-decoration: none;" target="_blank">${act.location || dest.cityName} 🗺️</a>
                        </p>
                        <p style="color: #4b5563; margin: 4px 0; font-size: 13px;">${act.description || ''}</p>
                        <div style="margin-top: 6px; font-size: 12px;">
                            ${act.website || act.bookingUrl ? `<a href="${act.website || act.bookingUrl}" style="color: #2563eb; text-decoration: none; margin-right: 10px;" target="_blank">🌐 Official Website</a>` : ''}
                            ${act.tripadvisorUrl ? `<a href="${act.tripadvisorUrl}" style="color: #0284c7; text-decoration: none; margin-right: 10px;" target="_blank">🦉 TripAdvisor</a>` : ''}
                        </div>
                    </div>
                `;
            }).join('');

            const restaurantsHtml = (dest.recommendedRestaurants || []).map(rest => {
                const mapQuery = encodeURIComponent(`${rest.name} ${rest.location || dest.cityName}`);
                const yelpSearchUrl = rest.yelpUrl || `https://www.yelp.com/search?find_desc=${encodeURIComponent(rest.name)}&find_loc=${encodeURIComponent(rest.location || dest.cityName)}`;
                return `
                    <div style="background: white; border-radius: 6px; padding: 12px; margin: 8px 0; border: 1px solid #e2e8f0;">
                        <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap;">
                            <strong style="color: #1f2937; font-size: 15px;">${rest.name}</strong>
                            <span style="color: #d97706; font-weight: bold; font-size: 13px;">${rest.priceRange || '$$'}</span>
                        </div>
                        <p style="color: #6b7280; margin: 2px 0 6px 0; font-size: 12px;">
                            🍴 ${rest.cuisine || 'Local Cuisine'} · 📍 <a href="https://www.google.com/maps/search/?api=1&query=${mapQuery}" style="color: #2563eb; text-decoration: none;" target="_blank">${rest.location || dest.cityName} 🗺️</a>
                        </p>
                        <p style="color: #4b5563; margin: 4px 0; font-size: 13px;">${rest.description || ''}</p>
                        <div style="margin-top: 6px; font-size: 12px;">
                            <a href="${yelpSearchUrl}" style="color: #dc2626; text-decoration: none; margin-right: 10px;" target="_blank">🔴 Yelp Reviews</a>
                            ${rest.website ? `<a href="${rest.website}" style="color: #2563eb; text-decoration: none; margin-right: 10px;" target="_blank">🌐 Website</a>` : ''}
                        </div>
                    </div>
                `;
            }).join('');

            return `
                <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 10px; padding: 18px; margin: 18px 0;">
                    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 12px;">
                        <h3 style="color: #1e3a8a; margin: 0; font-size: 20px;">📍 ${dest.cityName}</h3>
                        <span style="background: #e0e7ff; color: #3730a3; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600;">${dest.numberOfNights || 1} ${(dest.numberOfNights || 1) === 1 ? 'Night' : 'Nights'} (${dest.arrivalDate || ''} - ${dest.departureDate || ''})</span>
                    </div>
                    ${dest.overview ? `<p style="color: #475569; font-style: italic; font-size: 14px; margin-bottom: 16px;">${dest.overview}</p>` : ''}
                    
                    ${hotelsHtml ? `
                        <div style="margin: 14px 0;">
                            <h4 style="color: #0369a1; margin: 0 0 8px 0; font-size: 15px;">🏨 Recommended Stays</h4>
                            ${hotelsHtml}
                        </div>
                    ` : ''}

                    ${activitiesHtml ? `
                        <div style="margin: 14px 0;">
                            <h4 style="color: #047857; margin: 0 0 8px 0; font-size: 15px;">🎯 Curated Activities & Sights</h4>
                            ${activitiesHtml}
                        </div>
                    ` : ''}

                    ${restaurantsHtml ? `
                        <div style="margin: 14px 0;">
                            <h4 style="color: #b45309; margin: 0 0 8px 0; font-size: 15px;">🍽️ Recommended Dining & Eateries</h4>
                            ${restaurantsHtml}
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');

        contentHtml = destinationsHtml;
    } else {
        // Fallback for legacy format
        let flightHtml = '';
        if (legacyItinerary?.flights) {
            const flights = legacyItinerary.flights;
            flightHtml = `
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; margin: 20px 0;">
                    <h3 style="color: white; margin-top: 0;">✈️ Your Flights</h3>
                    ${flights.outbound ? `
                        <div style="background: rgba(255,255,255,0.1); padding: 15px; border-radius: 8px; margin: 10px 0;">
                            <h4 style="color: white; margin: 0 0 10px 0;">Outbound: ${flights.outbound.departure?.airportCode || ''} → ${flights.outbound.arrival?.airportCode || ''}</h4>
                            <p style="color: white; margin: 5px 0;"><strong>${flights.outbound.airline || ''} ${flights.outbound.flightNumber || ''}</strong></p>
                        </div>
                    ` : ''}
                </div>
            `;
        }
        contentHtml = flightHtml;
    }
    
    const msg = {
        to: userEmail,
        from: 'noreply@wandermint.io',
        subject: `🎉 Your Personalized Itinerary for ${destinationsTitle} is Ready!`,
        html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: 0 auto; padding: 20px; line-height: 1.6; color: #1f2937;">
                <div style="text-align: center; background: linear-gradient(135deg, #0ea5e9 0%, #3b82f6 100%); color: white; padding: 32px 20px; border-radius: 12px; margin-bottom: 24px;">
                    <h1 style="margin: 0; font-size: 26px; font-weight: 700;">🎉 Your Itinerary is Ready!</h1>
                    <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.95;">Personalized travel recommendations for ${destinationsTitle}</p>
                </div>
                
                <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #e2e8f0;">
                    <h2 style="color: #1e40af; margin-top: 0; font-size: 18px;">Hi ${userName}! 👋</h2>
                    <p style="margin-bottom: 8px;">Your personalized WanderMint travel itinerary is complete! We've handpicked accommodations, curated sights, and mapped out top dining spots for your trip.</p>
                    ${overviewText ? `<p style="font-style: italic; color: #475569; background: white; padding: 12px; border-radius: 6px; border-left: 3px solid #3b82f6; margin-top: 10px;">"${overviewText}"</p>` : ''}
                </div>
                
                ${contentHtml}
                
                <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
                    <h3 style="color: #065f46; margin-top: 0;">📱 View Interactive Itinerary in App</h3>
                    <p style="color: #047857; margin-bottom: 16px; font-size: 14px;">Open WanderMint on your iPhone to access 1-tap navigation, request real-time modifications, and manage your bookings.</p>
                </div>
                
                <div style="text-align: center; padding: 16px; color: #64748b; font-size: 13px;">
                    <p style="margin: 0;">Need to make adjustments? Use the "Request Changes" tab directly in WanderMint or reply to this email.</p>
                    <p style="margin: 6px 0 0 0;">Happy travels! ✈️🌍</p>
                </div>
            </div>
        `
    };

    await sendEmail(msg);
    console.log(`Detailed itinerary email sent for trip: ${tripId} (User: ${userName}, Email: ${userEmail})`);
}

// Handle trip status updates
exports.onTripStatusUpdate = onDocumentUpdated(
    {
        document: 'trips/{tripId}',
        region: "us-central1",
        secrets: ["GMAIL_APP_PASSWORD", "SENDGRID_API_KEY"]
    },
    async (event) => {
        const tripId = event.params.tripId;
        const beforeData = event.data.before.data();
        const afterData = event.data.after.data();
        
        // Send detailed itinerary notification when trip is completed
        if (beforeData.status !== 'completed' && afterData.status === 'completed') {
            console.log(`Trip completed: ${tripId}`);
            
            try {
                // Check if this trip has destinationRecommendation or legacy recommendation
                if (afterData.destinationRecommendation || afterData.recommendation) {
                    await sendDetailedItineraryNotification(tripId, afterData);
                    console.log(`Sent detailed itinerary notification for trip ${tripId}`);
                } else {
                    console.log(`Trip ${tripId} completed but no recommendation data found`);
                }
            } catch (error) {
                console.error(`Failed to send detailed itinerary notification for trip ${tripId}:`, error);
            }
        }
        
        if (beforeData.status !== 'failed' && afterData.status === 'failed') {
            console.error(`Trip failed: ${tripId}, Error: ${afterData.errorMessage || 'Unknown error'}`);
        }
    }
);

// Send conversation notification when user sends feedback
exports.sendConversationNotification = onDocumentCreated(
    {
        document: 'tripConversations/{conversationId}/messages/{messageId}',
        region: "us-central1",
        secrets: ["GMAIL_APP_PASSWORD", "SENDGRID_API_KEY"]
    },
    async (event) => {
        const conversationId = event.params.conversationId;
        const messageId = event.params.messageId;
        const messageData = event.data.data();
        
        // Only send notifications for user messages
        if (messageData.senderType !== 'user') return;
        
        console.log(`New user message in conversation: ${conversationId}`);
        
        try {
            // Get conversation details
            const conversationRef = db.collection('tripConversations').doc(conversationId);
            const conversationDoc = await conversationRef.get();
            
            if (!conversationDoc.exists) {
                console.error(`Conversation not found: ${conversationId}`);
                return;
            }
            
            const conversationData = conversationDoc.data();
            
            // Get trip details
            const tripRef = db.collection('trips').doc(conversationData.tripId);
            const tripDoc = await tripRef.get();
            
            if (!tripDoc.exists) {
                console.error(`Trip not found: ${conversationData.tripId}`);
                return;
            }
            
            const tripData = tripDoc.data();
            
            // Get user details
            let userName = 'Unknown User';
            try {
                const userProfileDoc = await db.collection('users').doc(conversationData.userId).get();
                if (userProfileDoc.exists) {
                    const userData = userProfileDoc.data();
                    userName = userData.name || userData.displayName || 'Unknown User';
                }
            } catch (userError) {
                console.warn('Could not fetch user data:', userError);
            }
            
            await sendConversationEmailNotification(conversationId, messageData, tripData, userName);
            
        } catch (error) {
            console.error(`Error sending conversation notification: ${error.message}`);
        }
    }
);

// Send email notification for user feedback/conversation messages
async function sendConversationEmailNotification(conversationId, messageData, tripData, userName) {
    
    const destination = tripData.destinations ? tripData.destinations.join(' → ') : tripData.destination;
    const isUrgent = messageData.metadata?.urgency === 'high' || messageData.metadata?.urgency === 'urgent';
    
    const msg = {
        to: 'nchristus93@gmail.com',
        from: 'noreply@wandermint.io',
        subject: `${isUrgent ? '🚨 URGENT - ' : '💬 '}Traveler Message: ${destination}`,
        text: `New message from traveler ${userName} for trip to ${destination}: ${messageData.content}`, // Add plain text version
        html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(135deg, #0ea5e9 0%, #3b82f6 100%); padding: 24px; border-radius: 12px 12px 0 0;">
                    <h2 style="color: white; margin: 0; font-size: 20px;">✈️ New Message from Traveler</h2>
                </div>
                
                <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
                    <div style="background: #f8f9fa; padding: 16px; border-radius: 8px; margin-bottom: 20px;">
                        <h3 style="margin: 0 0 8px 0; color: #1f2937;">📍 Trip Details</h3>
                        <p style="margin: 4px 0;"><strong>Destination:</strong> ${destination}</p>
                        <p style="margin: 4px 0;"><strong>Dates:</strong> ${tripData.startDate?.toDate?.()?.toLocaleDateString() || 'Not specified'} - ${tripData.endDate?.toDate?.()?.toLocaleDateString() || 'Not specified'}</p>
                        <p style="margin: 4px 0;"><strong>Traveler:</strong> ${userName}</p>
                        <p style="margin: 4px 0;"><strong>User ID:</strong> ${tripData.userId}</p>
                    </div>
                    
                    <div style="background: #e0f2fe; padding: 16px; border-radius: 8px; border-left: 4px solid #0ea5e9;">
                        <h4 style="margin: 0 0 8px 0; color: #0c4a6e;">💬 Message:</h4>
                        <p style="margin: 0; color: #164e63; font-size: 16px; line-height: 1.5;">${messageData.content}</p>
                        ${messageData.metadata?.category ? `<p style="margin: 8px 0 0 0; color: #0369a1; font-size: 14px;"><strong>Category:</strong> ${messageData.metadata.category}</p>` : ''}
                    </div>
                    
                    ${isUrgent ? `
                        <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 12px; border-radius: 8px; margin-top: 16px;">
                            <p style="margin: 0; color: #dc2626; font-weight: 600;">🚨 High Priority Request</p>
                        </div>
                    ` : ''}
                </div>
                
                <div style="background: #f8f9fa; padding: 20px; border-radius: 0 0 12px 12px; text-align: center;">
                    <p style="margin: 0 0 16px 0; color: #6b7280; font-size: 14px;">
                        💡 <strong>Quick Response:</strong> Access your admin dashboard to respond to this message.
                    </p>
                    <a href="https://travel-consulting-app-1.web.app?conversation=${conversationId}" 
                       style="background: #0ea5e9; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">
                        View Conversation
                    </a>
                </div>
            </div>
        `
    };
    
    try {
        console.log('📧 Attempting to send email:', {
            to: msg.to,
            from: msg.from,
            subject: msg.subject,
            conversationId: conversationId
        });
        
        const result = await sendEmail(msg);
        console.log('✅ Email notification sent:', result);
        console.log(`Conversation email notification sent for: ${conversationId} (${userName})`);
    } catch (error) {
        console.error('❌ Error sending conversation email:', error);
        console.error('📋 SendGrid error code:', error.code);
        if (error.response && error.response.body && error.response.body.errors) {
            console.error('📋 SendGrid error details:', error.response.body.errors);
        }
        console.error('📋 Full error details:', JSON.stringify(error, null, 2));
        throw error;
    }
}

/**
 * Google Places API Proxy
 * Replaces legacy TripAdvisor proxy for hotel, restaurant, and activity search/auto-fill.
 */
exports.googlePlacesProxy = onRequest(
    {
        region: "us-central1",
        memory: "256MiB",
        timeoutSeconds: 30,
        cors: true
    },
    async (req, res) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.status(200).send('');
            return;
        }

        try {
            const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.FIREBASE_API_KEY;
            const { query, placeId, type = 'hotels' } = req.query;

            if (placeId) {
                // Fetch Details for a specific place
                const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=name,rating,formatted_address,photos,editorial_summary,url,user_ratings_total,website,geometry&key=${apiKey}`;
                const response = await fetch(detailsUrl);
                const data = await response.json();

                if (data.status !== 'OK') {
                    return res.status(400).json({ success: false, error: data.error_message || data.status });
                }

                const result = data.result || {};
                const photoReference = result.photos?.[0]?.photo_reference;
                const photoUrl = photoReference 
                    ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=${photoReference}&key=${apiKey}`
                    : null;

                return res.json({
                    success: true,
                    place: {
                        name: result.name,
                        rating: result.rating || 4.5,
                        userRatingsTotal: result.user_ratings_total || 0,
                        address: result.formatted_address || '',
                        description: result.editorial_summary?.overview || `${result.name} - ${type}`,
                        mapsUrl: result.url || `https://www.google.com/maps/place/?q=place_id:${placeId}`,
                        website: result.website || null,
                        photoUrl: photoUrl
                    }
                });
            } else if (query) {
                // Search Places by Text Query
                const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;
                const response = await fetch(searchUrl);
                const data = await response.json();

                if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
                    return res.status(400).json({ success: false, error: data.error_message || data.status });
                }

                const results = (data.results || []).slice(0, 10).map(p => ({
                    placeId: p.place_id,
                    name: p.name,
                    address: p.formatted_address,
                    rating: p.rating,
                    userRatingsTotal: p.user_ratings_total,
                    photoReference: p.photos?.[0]?.photo_reference
                }));

                return res.json({ success: true, results });
            } else {
                return res.status(400).json({ error: 'Missing required parameter: query or placeId' });
            }
        } catch (error) {
            console.error('Google Places Proxy Error:', error);
            return res.status(500).json({ error: 'Failed to process Google Places request', details: error.message });
        }
    }
);

/**
 * SerpAPI Google Flights Proxy
 * Proxies live flight search requests securely.
 */
exports.serpapiFlightsProxy = onRequest(
    {
        region: "us-central1",
        memory: "256MiB",
        timeoutSeconds: 30,
        cors: true
    },
    async (req, res) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.status(200).send('');
            return;
        }

        try {
            const serpApiKey = process.env.SERPAPI_KEY;
            const { departure_id, arrival_id, outbound_date, currency = 'USD' } = req.query;

            if (!departure_id || !arrival_id || !outbound_date) {
                return res.status(400).json({ error: 'Missing required parameters: departure_id, arrival_id, outbound_date' });
            }

            if (!serpApiKey) {
                return res.status(500).json({ error: 'SERPAPI_KEY is not configured in server environment' });
            }

            const apiUrl = new URL('https://serpapi.com/search.json');
            apiUrl.searchParams.set('engine', 'google_flights');
            apiUrl.searchParams.set('departure_id', departure_id);
            apiUrl.searchParams.set('arrival_id', arrival_id);
            apiUrl.searchParams.set('outbound_date', outbound_date);
            apiUrl.searchParams.set('type', '2'); // One-way
            apiUrl.searchParams.set('currency', currency);
            apiUrl.searchParams.set('hl', 'en');
            apiUrl.searchParams.set('api_key', serpApiKey);

            const response = await fetch(apiUrl.toString());
            if (!response.ok) {
                const errorText = await response.text();
                return res.status(response.status).json({ error: 'SerpAPI request failed', details: errorText });
            }

            const data = await response.json();
            return res.json({
                success: true,
                search_parameters: data.search_parameters,
                best_flights: data.best_flights || [],
                other_flights: data.other_flights || [],
                price_insights: data.price_insights
            });
        } catch (error) {
            console.error('SerpAPI Flights Proxy Error:', error);
            return res.status(500).json({ error: 'SerpAPI search failed', details: error.message });
        }
    }
);

/**
 * Seats.aero Award Flights Search Proxy
 * Searches award flight availability and points costs across major loyalty programs.
 */
exports.seatsAeroProxy = onRequest(
    {
        region: "us-central1",
        memory: "256MiB",
        timeoutSeconds: 30,
        cors: true
    },
    async (req, res) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.status(200).send('');
            return;
        }

        try {
            const seatsAeroApiKey = process.env.SEATS_AERO_API_KEY;
            const { origin, destination, date } = req.query;

            if (!origin || !destination) {
                return res.status(400).json({ error: 'Missing required parameters: origin and destination' });
            }

            // Mock / Real Seats.aero integration endpoint
            if (seatsAeroApiKey) {
                const searchUrl = `https://seats.aero/partnerapi/search?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`;
                const response = await fetch(searchUrl, {
                    headers: { 'Partner-Authorization': seatsAeroApiKey, 'Accept': 'application/json' }
                });

                if (response.ok) {
                    const data = await response.json();
                    return res.json({ success: true, data: data.data || [] });
                }
            }

            // Fallback / Helper award response structure if API key is in setup
            return res.json({
                success: true,
                source: 'Seats.aero Integration Helper',
                data: [
                    {
                        id: 'seats-1',
                        airline: 'Virgin Atlantic',
                        flightNumber: 'VS4',
                        origin: origin,
                        destination: destination,
                        pointsAmount: 50000,
                        pointsProgram: 'Virgin Atlantic Flying Blue / Amex MR',
                        taxCashAmount: 150.00,
                        cabinClass: 'Business / Upper Class',
                        departureTime: '18:30',
                        arrivalTime: '06:30 (+1)',
                        bookingUrl: `https://seats.aero/search?origin=${origin}&destination=${destination}`
                    },
                    {
                        id: 'seats-2',
                        airline: 'Air Canada Aeroplan',
                        flightNumber: 'AC854',
                        origin: origin,
                        destination: destination,
                        pointsAmount: 60000,
                        pointsProgram: 'Aeroplan / Chase UR',
                        taxCashAmount: 75.00,
                        cabinClass: 'Business Class',
                        departureTime: '21:00',
                        arrivalTime: '09:15 (+1)',
                        bookingUrl: `https://seats.aero/search?origin=${origin}&destination=${destination}`
                    }
                ]
            });
        } catch (error) {
            console.error('Seats.aero Proxy Error:', error);
            return res.status(500).json({ error: 'Seats.aero search failed', details: error.message });
        }
    }
);

// On-demand AI Trip Recommendation & Dossier Generation Endpoint
exports.generateTripRecommendation = onRequest(
    {
        cors: true,
        region: "us-central1",
        secrets: ["GEMINI_API_KEY"]
    },
    async (req, res) => {
        try {
            if (req.method !== 'POST') {
                return res.status(405).json({ error: 'Method not allowed. Use POST.' });
            }

            const { tripId, tripData: customTripData, pointsData: customPointsData } = req.body || {};
            const geminiApiKey = process.env.GEMINI_API_KEY;

            if (!geminiApiKey) {
                return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
            }

            let tripData = customTripData;
            let pointsData = customPointsData || { creditCard: {}, hotel: {}, airline: {}, totalPoints: 0 };

            // If tripId provided, fetch trip and userPoints from Firestore
            if (tripId && !tripData) {
                const tripDoc = await db.collection('trips').doc(tripId).get();
                if (!tripDoc.exists) {
                    return res.status(404).json({ error: `Trip document ${tripId} not found.` });
                }
                tripData = tripDoc.data();

                if (tripData.userId && !customPointsData) {
                    try {
                        const userPointsDoc = await db.collection('userPoints').doc(tripData.userId).get();
                        if (userPointsDoc.exists) {
                            const pData = userPointsDoc.data();
                            pointsData.creditCard = pData.creditCardPoints || {};
                            pointsData.hotel = pData.hotelPoints || {};
                            pointsData.airline = pData.airlinePoints || {};
                            const creditCardTotal = Object.values(pointsData.creditCard).reduce((sum, p) => sum + (p || 0), 0);
                            const hotelTotal = Object.values(pointsData.hotel).reduce((sum, p) => sum + (p || 0), 0);
                            const airlineTotal = Object.values(pointsData.airline).reduce((sum, p) => sum + (p || 0), 0);
                            pointsData.totalPoints = creditCardTotal + hotelTotal + airlineTotal;
                        }
                    } catch (pErr) {
                        console.warn('Could not fetch user points for generateTripRecommendation:', pErr);
                    }
                }
            }

            if (!tripData) {
                return res.status(400).json({ error: 'Either tripId or tripData must be provided.' });
            }

            console.log(`🤖 On-demand AI itinerary generation requested for: ${tripData.destination || tripData.destinations?.[0]}`);
            const aiResult = await generateTripDossierAndDraft(tripData, pointsData, geminiApiKey);

            // If tripId was passed, save the draft recommendation back to Firestore
            if (tripId && aiResult?.recommendation) {
                await db.collection('trips').doc(tripId).update({
                    destinationRecommendation: {
                        id: tripId,
                        ...aiResult.recommendation
                    },
                    isAiDraft: true,
                    aiDossier: aiResult.executiveDossier || null,
                    updatedAt: FieldValue.serverTimestamp()
                });
            }

            return res.json({
                success: true,
                dossier: aiResult.executiveDossier,
                recommendation: aiResult.recommendation
            });

        } catch (error) {
            console.error('generateTripRecommendation error:', error);
            return res.status(500).json({ error: 'AI generation failed', details: error.message });
        }
    }
);