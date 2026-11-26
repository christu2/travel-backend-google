const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { getMessaging } = require("firebase-admin/messaging");
const { validateTripSubmissionData, validateRecommendationData } = require("./schemas");
const { generateTripDossierAndDraft, formatDossierEmailHtml, handleCopilotChat } = require("./geminiService");

// Initialize Firebase Admin
initializeApp();

const db = getFirestore();
const auth = getAuth();
const messaging = getMessaging();

/**
 * Sends an APNs/FCM push notification to all registered devices for a user,
 * respecting their pushNotificationsEnabled opt-out flag and pruning stale tokens.
 */
async function sendPushToUser(userId, { title, body, data = {} }) {
    if (!userId) return { sent: 0 };
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) return { sent: 0 };
        const userData = userDoc.data() || {};
        if (userData.pushNotificationsEnabled === false) {
            return { sent: 0, skipped: 'opted_out' };
        }
        const tokens = Array.isArray(userData.fcmTokens)
            ? [...new Set(userData.fcmTokens.filter(t => typeof t === 'string' && t.length > 0))]
            : [];
        if (tokens.length === 0) return { sent: 0, skipped: 'no_tokens' };

        const stringData = Object.fromEntries(
            Object.entries(data).map(([k, v]) => [k, String(v ?? '')])
        );

        const response = await messaging.sendEachForMulticast({
            tokens,
            notification: { title, body },
            data: stringData,
            apns: {
                payload: {
                    aps: {
                        sound: 'default',
                        badge: 1
                    }
                }
            }
        });

        const staleTokens = [];
        response.responses.forEach((resp, idx) => {
            if (!resp.success) {
                const code = resp.error?.code || '';
                if (code === 'messaging/registration-token-not-registered' ||
                    code === 'messaging/invalid-registration-token') {
                    staleTokens.push(tokens[idx]);
                }
            }
        });

        if (staleTokens.length > 0) {
            await db.collection('users').doc(userId).update({
                fcmTokens: FieldValue.arrayRemove(...staleTokens)
            });
        }

        console.log(`📲 Push sent to user ${userId}: ${response.successCount}/${tokens.length} succeeded`);
        return { sent: response.successCount, pruned: staleTokens.length };
    } catch (err) {
        console.warn(`Push notification error for user ${userId}:`, err.code || err.message);
        return { sent: 0, error: err.message };
    }
}

// Explicit CORS origin allowlist (native iOS clients ignore CORS; web requests are restricted)
const ALLOWED_CORS_ORIGINS = [
    'https://travel-consulting-app-1.web.app',
    'https://travel-consulting-app-1.firebaseapp.com',
    'http://localhost:8000',
    'http://127.0.0.1:8000'
];

function applyCorsHeaders(req, res, methods = 'POST, OPTIONS') {
    const origin = req.headers.origin;
    if (origin && ALLOWED_CORS_ORIGINS.includes(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
    }
    res.set('Access-Control-Allow-Methods', methods);
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Input sanitization helper (for stored plain text)
const sanitizeString = (input) => {
    if (typeof input !== 'string') return input;
    return input.trim().replace(/[<>\"'&]/g, '');
};

// HTML-escaping helper (prevents HTML/XSS injection in outbound emails)
const escapeHtml = (input) => {
    if (input === null || input === undefined) return '';
    return String(input)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

// Safe external URL validator (blocks javascript:, data:, file:, etc. in email hrefs)
const safeHttpUrl = (input) => {
    if (typeof input !== 'string' || !input.trim()) return '';
    try {
        const parsed = new URL(input.trim());
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            return escapeHtml(parsed.href);
        }
        return '';
    } catch {
        return '';
    }
};

// Strict Google Places identifier patterns (SSRF / path traversal protection)
const PLACE_ID_REGEX = /^[A-Za-z0-9_-]{10,200}$/;
const PHOTO_NAME_REGEX = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

/**
 * Resolves a Google Places photo reference to a public keyless CDN URL (lh3.googleusercontent.com)
 * so the server-side GOOGLE_PLACES_API_KEY is never exposed to clients or stored in Firestore.
 */
async function resolvePublicPhotoUrl(photoName, apiKey) {
    if (!photoName || !PHOTO_NAME_REGEX.test(photoName) || !apiKey) {
        return '';
    }
    try {
        const mediaEndpoint = `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=800&maxWidthPx=800&skipHttpRedirect=true`;
        const resp = await fetch(mediaEndpoint, {
            headers: {
                'X-Goog-Api-Key': apiKey
            }
        });
        if (!resp.ok) return '';
        const data = await resp.json();
        return typeof data.photoUri === 'string' && data.photoUri.startsWith('https://') ? data.photoUri : '';
    } catch (err) {
        console.warn('Could not resolve public photo URI:', err.message);
        return '';
    }
}

/**
 * Verifies Firebase ID token from Authorization: Bearer <token> with revocation checking enabled.
 * Optionally enforces `admin: true` custom claim.
 * Returns decodedToken on success, or writes 401/403 response and returns null.
 */
async function verifyAuthRequest(req, res, { requireAdmin = false } = {}) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ success: false, error: 'Unauthorized: Missing Bearer token' });
        return null;
    }

    try {
        const idToken = authHeader.split('Bearer ')[1].trim();
        const decodedToken = await auth.verifyIdToken(idToken, true);
        if (requireAdmin && !decodedToken.admin) {
            res.status(403).json({ success: false, error: 'Forbidden: Admin access required' });
            return null;
        }
        return decodedToken;
    } catch (err) {
        console.warn('Auth token verification failed:', err.code || 'invalid_token');
        res.status(401).json({ success: false, error: 'Unauthorized: Invalid, expired, or revoked token' });
        return null;
    }
}

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
        cors: ALLOWED_CORS_ORIGINS
    },
    async (req, res) => {
        applyCorsHeaders(req, res, 'POST, OPTIONS');
        
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
            const decodedToken = await verifyAuthRequest(req, res, { requireAdmin: false });
            if (!decodedToken) return;
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
            
            // Transactional daily rate limit check & increment (prevents concurrent burst bypass)
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const userSubmissionsRef = db.collection('userSubmissions').doc(uid);

            const rateLimitAllowed = await db.runTransaction(async (tx) => {
                const doc = await tx.get(userSubmissionsRef);
                let newCount = 1;
                if (doc.exists) {
                    const submissionData = doc.data();
                    const lastSubmissionDate = submissionData.lastSubmissionDate?.toDate();
                    const submissionCount = submissionData.submissionCount || 0;
                    if (lastSubmissionDate && lastSubmissionDate.toDateString() === today.toDateString()) {
                        if (submissionCount >= 10) {
                            return false;
                        }
                        newCount = submissionCount + 1;
                    }
                }
                tx.set(userSubmissionsRef, {
                    lastSubmissionDate: FieldValue.serverTimestamp(),
                    submissionCount: newCount
                });
                return true;
            });

            if (!rateLimitAllowed) {
                res.status(429).send('Daily submission limit reached (10 submissions per day)');
                return;
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
            
            res.status(200).json({ tripId: tripRef.id, success: true });
            
        } catch (error) {
            console.error('Error submitting trip:', error);
            res.status(500).json({ success: false, error: 'Failed to submit trip' });
        }
    }
);

// Admin function to update trip with recommendations
exports.updateTripRecommendation = onRequest(
    {
        region: "us-central1",
        memory: "512MiB",
        timeoutSeconds: 60,
        cors: ALLOWED_CORS_ORIGINS
    },
    async (req, res) => {
        applyCorsHeaders(req, res, 'POST, OPTIONS');
        
        if (req.method === 'OPTIONS') {
            res.status(200).send('');
            return;
        }
        
        if (req.method !== 'POST') {
            res.status(405).send('Method Not Allowed');
            return;
        }
        
        try {
            const decodedToken = await verifyAuthRequest(req, res, { requireAdmin: true });
            if (!decodedToken) return;
            
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
                destinationRecommendation: recommendation,
                updatedAt: FieldValue.serverTimestamp(),
                completedBy: decodedToken.uid,
                completedAt: FieldValue.serverTimestamp()
            });
            
            console.log(`Trip ${tripId} completed by admin`);
            res.status(200).json({ success: true });
            
        } catch (error) {
            console.error('Error updating trip:', error);
            res.status(500).json({ success: false, error: 'Failed to update trip recommendation' });
        }
    }
);

// Process new trip submissions (Clean blank canvas waiting for admin dictation in the Copilot)
exports.processNewTrip = onDocumentCreated(
    {
        document: 'trips/{tripId}',
        region: "us-central1"
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
                console.warn('Could not fetch points for trip notification:', pErr);
            }

            // Keep new trip as a clean blank canvas waiting for consultant dictation in the AI Copilot
            await db.collection('trips').doc(tripId).update({
                status: 'pending',
                updatedAt: FieldValue.serverTimestamp()
            });
            
            // Send notification email with client points & miles breakdown
            try {
                await sendNewTripNotification(tripId, tripData, pointsData, '');
            } catch (emailError) {
                console.warn('Failed to send email notification:', emailError);
            }
            
            console.log(`Trip ${tripId} processed successfully (ready for Copilot dictation)`);
            
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
    
    // Helper function to format points breakdown (HTML-escaped)
    const formatPointsBreakdown = (pointsCategory, categoryName) => {
        const entries = Object.entries(pointsCategory);
        if (entries.length === 0) return `<p><strong>${escapeHtml(categoryName)}:</strong> None</p>`;
        
        return `
            <p><strong>${escapeHtml(categoryName)}:</strong></p>
            <ul style="margin: 0; padding-left: 20px;">
                ${entries.map(([provider, points]) => 
                    `<li>${escapeHtml(provider)}: ${Number(points || 0).toLocaleString()} pts</li>`
                ).join('')}
            </ul>
        `;
    };
    
    const safeUserName = escapeHtml(userName);
    const safeUserEmail = escapeHtml(userEmail);
    const safeTripId = escapeHtml(tripId);
    const safeUserId = escapeHtml(tripData.userId);
    const safeDestinations = escapeHtml(tripData.destinations?.join(', ') || tripData.destination || 'Not specified');
    const safeDepartureLocation = escapeHtml(tripData.departureLocation);
    const safePaymentMethod = escapeHtml(tripData.paymentMethod || 'Not specified');
    const safeFlightClass = escapeHtml(tripData.flightClass);
    const safeBudget = escapeHtml(tripData.budget || 'Not specified');
    const safeTravelStyle = escapeHtml(tripData.travelStyle || 'Not specified');
    const safeInterests = escapeHtml(tripData.interests?.join(', ') || 'None specified');
    const safeSpecialRequests = escapeHtml(tripData.specialRequests);

    const msg = {
        to: 'nchristus93@gmail.com',
        from: 'noreply@wandermint.io',
        subject: `New Trip Request - ${tripData.destination || tripData.destinations?.[0] || 'Custom Trip'} (${tripData.groupSize || 1} ${(tripData.groupSize || 1) === 1 ? 'traveler' : 'travelers'}) - ${pointsData.totalPoints.toLocaleString()} total pts`,
        html: `
            <h2>🌍 New Trip Request</h2>
            
            <div style="background: #fff3cd; padding: 20px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #ffc707;">
                <h3>👤 Client Info</h3>
                <p><strong>Name:</strong> ${safeUserName}</p>
                <p><strong>Email:</strong> ${safeUserEmail}</p>
                <p><strong>Total Points:</strong> <span style="font-size: 1.2em; color: #28a745; font-weight: bold;">${pointsData.totalPoints.toLocaleString()}</span></p>
                <p><strong>User ID:</strong> ${safeUserId}</p>
                <p><strong>Trip ID:</strong> ${safeTripId}</p>
            </div>
            
            <div style="background: #e8f5e8; padding: 20px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #28a745;">
                <h3>💳 Points & Miles Breakdown</h3>
                ${formatPointsBreakdown(pointsData.creditCard, 'Credit Card Points')}
                ${formatPointsBreakdown(pointsData.hotel, 'Hotel Points')}
                ${formatPointsBreakdown(pointsData.airline, 'Airline Miles')}
            </div>
            
            <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 16px 0;">
                <h3>📍 Trip Details</h3>
                <p><strong>Destination(s):</strong> ${safeDestinations}</p>
                ${tripData.departureLocation ? `<p><strong>Departing from:</strong> ${safeDepartureLocation}</p>` : ''}
                <p><strong>Dates:</strong> ${escapeHtml(tripData.startDate?.toDate?.()?.toLocaleDateString() || 'Not specified')} - ${escapeHtml(tripData.endDate?.toDate?.()?.toLocaleDateString() || 'Not specified')}</p>
                <p><strong>Flexible Dates:</strong> ${tripData.flexibleDates ? 'Yes' : 'No'}</p>
                ${tripData.tripDuration ? `<p><strong>Trip Duration:</strong> ${Number(tripData.tripDuration)} days</p>` : ''}
                <p><strong>Payment Method:</strong> ${safePaymentMethod}</p>
                ${tripData.flightClass ? `<p><strong>Flight Class:</strong> ${safeFlightClass}</p>` : ''}
            </div>
            
            <div style="background: #e3f2fd; padding: 20px; border-radius: 8px; margin: 16px 0;">
                <h3>✨ Client Preferences</h3>
                <p><strong>Budget:</strong> ${safeBudget}</p>
                <p><strong>Travel Style:</strong> ${safeTravelStyle}</p>
                <p><strong>Group Size:</strong> ${Number(tripData.groupSize || 1)} ${(tripData.groupSize || 1) === 1 ? 'person' : 'people'}</p>
                <p><strong>Pet-Friendly:</strong> ${tripData.petFriendly ? '🐾 Yes (Requires Pet-Friendly Stays & Activities)' : 'No'}</p>
                <p><strong>Interests:</strong> ${safeInterests}</p>
                ${tripData.specialRequests ? `<p><strong>Special Requests:</strong> ${safeSpecialRequests}</p>` : ''}
            </div>

            ${aiDossierHtml}
            
            <div style="background: #f3e5f5; padding: 20px; border-radius: 8px; margin: 16px 0;">
                <h3>📊 Submission Info</h3>
                <p><strong>Submitted:</strong> ${escapeHtml(new Date().toLocaleString())}</p>
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
    console.log(`Email notification sent for trip: ${tripId} (Total Points: ${pointsData.totalPoints.toLocaleString()})`);
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
                const mapQuery = encodeURIComponent(`${h.name || ''} ${h.location || dest.cityName || ''}`);
                const bookingHref = safeHttpUrl(h.bookingUrl);
                const tripAdvisorHref = safeHttpUrl(h.tripadvisorUrl);
                return `
                    <div style="background: white; border-radius: 8px; padding: 14px; margin: 10px 0; border: 1px solid #e2e8f0; border-left: 4px solid #3b82f6;">
                        <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap;">
                            <strong style="color: #1e3a8a; font-size: 16px;">${escapeHtml(h.name || 'Hotel')}</strong>
                            <span style="color: #059669; font-weight: bold;">$${Number(h.pricePerNight || 0)}/night ${h.pointsPerNight ? `· ${Number(h.pointsPerNight).toLocaleString()} pts` : ''}</span>
                        </div>
                        <p style="color: #4b5563; margin: 4px 0 6px 0; font-size: 13px;">
                            ⭐ ${escapeHtml(h.rating || 4.5)}/5 · 📍 <a href="https://www.google.com/maps/search/?api=1&query=${mapQuery}" style="color: #2563eb; text-decoration: none;" target="_blank">${escapeHtml(h.location || dest.cityName)} 🗺️</a>
                        </p>
                        ${h.detailedDescription ? `<p style="color: #374151; margin: 6px 0; font-size: 14px; line-height: 1.4;">${escapeHtml(h.detailedDescription)}</p>` : ''}
                        <div style="margin-top: 8px; font-size: 13px;">
                            ${bookingHref ? `<a href="${bookingHref}" style="background: #2563eb; color: white; padding: 4px 10px; border-radius: 4px; text-decoration: none; display: inline-block; margin-right: 8px; font-size: 12px;" target="_blank">Book Hotel</a>` : ''}
                            ${tripAdvisorHref ? `<a href="${tripAdvisorHref}" style="color: #0284c7; text-decoration: none; margin-right: 8px;" target="_blank">TripAdvisor Reviews</a>` : ''}
                        </div>
                    </div>
                `;
            }).join('');

            const activitiesHtml = (dest.recommendedActivities || []).map(act => {
                const mapQuery = encodeURIComponent(`${act.name || ''} ${act.location || dest.cityName || ''}`);
                const actHref = safeHttpUrl(act.website || act.bookingUrl);
                const actTaHref = safeHttpUrl(act.tripadvisorUrl);
                return `
                    <div style="background: white; border-radius: 6px; padding: 12px; margin: 8px 0; border: 1px solid #e2e8f0;">
                        <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap;">
                            <strong style="color: #1f2937; font-size: 15px;">${escapeHtml(act.name)}</strong>
                            ${act.estimatedCost?.cashAmount > 0 || typeof act.estimatedCost === 'number' ? `<span style="color: #059669; font-weight: 600; font-size: 13px;">$${Number(act.estimatedCost?.cashAmount || act.estimatedCost)}</span>` : '<span style="color: #6b7280; font-size: 12px;">Free / Included</span>'}
                        </div>
                        <p style="color: #6b7280; margin: 2px 0 6px 0; font-size: 12px;">
                            🏷️ ${escapeHtml(act.category || 'Sightseeing')} ${act.estimatedDuration ? `· ⏱️ ${escapeHtml(act.estimatedDuration)}` : ''} · 📍 <a href="https://www.google.com/maps/search/?api=1&query=${mapQuery}" style="color: #2563eb; text-decoration: none;" target="_blank">${escapeHtml(act.location || dest.cityName)} 🗺️</a>
                        </p>
                        <p style="color: #4b5563; margin: 4px 0; font-size: 13px;">${escapeHtml(act.description || '')}</p>
                        <div style="margin-top: 6px; font-size: 12px;">
                            ${actHref ? `<a href="${actHref}" style="color: #2563eb; text-decoration: none; margin-right: 10px;" target="_blank">🌐 Official Website</a>` : ''}
                            ${actTaHref ? `<a href="${actTaHref}" style="color: #0284c7; text-decoration: none; margin-right: 10px;" target="_blank">🦉 TripAdvisor</a>` : ''}
                        </div>
                    </div>
                `;
            }).join('');

            const restaurantsHtml = (dest.recommendedRestaurants || []).map(rest => {
                const mapQuery = encodeURIComponent(`${rest.name || ''} ${rest.location || dest.cityName || ''}`);
                const yelpSearchUrl = safeHttpUrl(rest.yelpUrl) || `https://www.yelp.com/search?find_desc=${encodeURIComponent(rest.name || '')}&find_loc=${encodeURIComponent(rest.location || dest.cityName || '')}`;
                const restWebsiteHref = safeHttpUrl(rest.website);
                return `
                    <div style="background: white; border-radius: 6px; padding: 12px; margin: 8px 0; border: 1px solid #e2e8f0;">
                        <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap;">
                            <strong style="color: #1f2937; font-size: 15px;">${escapeHtml(rest.name)}</strong>
                            <span style="color: #d97706; font-weight: bold; font-size: 13px;">${escapeHtml(rest.priceRange || '$$')}</span>
                        </div>
                        <p style="color: #6b7280; margin: 2px 0 6px 0; font-size: 12px;">
                            🍴 ${escapeHtml(rest.cuisine || 'Local Cuisine')} · 📍 <a href="https://www.google.com/maps/search/?api=1&query=${mapQuery}" style="color: #2563eb; text-decoration: none;" target="_blank">${escapeHtml(rest.location || dest.cityName)} 🗺️</a>
                        </p>
                        <p style="color: #4b5563; margin: 4px 0; font-size: 13px;">${escapeHtml(rest.description || '')}</p>
                        <div style="margin-top: 6px; font-size: 12px;">
                            <a href="${yelpSearchUrl}" style="color: #dc2626; text-decoration: none; margin-right: 10px;" target="_blank">🔴 Yelp Reviews</a>
                            ${restWebsiteHref ? `<a href="${restWebsiteHref}" style="color: #2563eb; text-decoration: none; margin-right: 10px;" target="_blank">🌐 Website</a>` : ''}
                        </div>
                    </div>
                `;
            }).join('');

            return `
                <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 10px; padding: 18px; margin: 18px 0;">
                    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 12px;">
                        <h3 style="color: #1e3a8a; margin: 0; font-size: 20px;">📍 ${escapeHtml(dest.cityName)}</h3>
                        <span style="background: #e0e7ff; color: #3730a3; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600;">${Number(dest.numberOfNights || 1)} ${(dest.numberOfNights || 1) === 1 ? 'Night' : 'Nights'} (${escapeHtml(dest.arrivalDate || '')} - ${escapeHtml(dest.departureDate || '')})</span>
                    </div>
                    ${dest.overview ? `<p style="color: #475569; font-style: italic; font-size: 14px; margin-bottom: 16px;">${escapeHtml(dest.overview)}</p>` : ''}
                    
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
                    <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.95;">Personalized travel recommendations for ${escapeHtml(destinationsTitle)}</p>
                </div>
                
                <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #e2e8f0;">
                    <h2 style="color: #1e40af; margin-top: 0; font-size: 18px;">Hi ${escapeHtml(userName)}! 👋</h2>
                    <p style="margin-bottom: 8px;">Your personalized WanderMint travel itinerary is complete! We've handpicked accommodations, curated sights, and mapped out top dining spots for your trip.</p>
                    ${overviewText ? `<p style="font-style: italic; color: #475569; background: white; padding: 12px; border-radius: 6px; border-left: 3px solid #3b82f6; margin-top: 10px;">"${escapeHtml(overviewText)}"</p>` : ''}
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
    console.log(`Detailed itinerary email sent for trip: ${tripId}`);
}

// Handle trip status updates
exports.onTripStatusUpdate = onDocumentUpdated(
    {
        document: 'trips/{tripId}',
        region: "us-central1"
    },
    async (event) => {
        const tripId = event.params.tripId;
        const beforeData = event.data.before.data();
        const afterData = event.data.after.data();
        
        // Send detailed itinerary notification & push when trip is completed (respecting user preferences)
        if (beforeData.status !== 'completed' && afterData.status === 'completed') {
            console.log(`Trip completed: ${tripId}`);
            
            const destinationsTitle = afterData.destinations?.join(', ') || afterData.destination || 'your trip';
            await sendPushToUser(afterData.userId, {
                title: 'Your Itinerary is Ready! ✈️',
                body: `Your personalized ${destinationsTitle} plan is ready to view in WanderMint.`,
                data: {
                    type: 'trip_ready',
                    tripId,
                    action: 'open_trip'
                }
            });

            if (afterData.optInEmailNotifications === false) {
                console.log(`Skipping itinerary completion email for trip ${tripId}: user opted out of email notifications.`);
            } else {
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
        }
        
        if (beforeData.status !== 'failed' && afterData.status === 'failed') {
            console.error(`Trip failed: ${tripId}, Error: ${afterData.errorMessage || 'Unknown error'}`);
        }
    }
);

// Send email notification to admin on user messages, and push notification to user on admin replies
exports.sendConversationNotification = onDocumentCreated(
    {
        document: 'tripConversations/{conversationId}/messages/{messageId}',
        region: "us-central1"
    },
    async (event) => {
        const conversationId = event.params.conversationId;
        const messageData = event.data.data();

        // Admin reply → send FCM push notification to the traveler
        if (messageData.senderType === 'admin') {
            try {
                const convDoc = await db.collection('tripConversations').doc(conversationId).get();
                if (!convDoc.exists) return;
                const convData = convDoc.data();
                const preview = String(messageData.content || 'You have a new message from your travel planner.').slice(0, 120);
                await sendPushToUser(convData.userId, {
                    title: 'New Message from Your Travel Planner',
                    body: preview,
                    data: {
                        type: 'admin_message',
                        tripId: convData.tripId || '',
                        conversationId,
                        action: 'open_conversation'
                    }
                });
            } catch (err) {
                console.warn(`Error sending admin reply push for conversation ${conversationId}:`, err.message);
            }
            return;
        }
        
        // Only send admin email notifications for user messages
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
    
    const safeDestination = escapeHtml(destination);
    const safeUserName = escapeHtml(userName);
    const safeUserId = escapeHtml(tripData.userId);
    const safeContent = escapeHtml(messageData.content);
    const safeCategory = escapeHtml(messageData.metadata?.category);
    const safeConversationParam = encodeURIComponent(conversationId);

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
                        <p style="margin: 4px 0;"><strong>Destination:</strong> ${safeDestination}</p>
                        <p style="margin: 4px 0;"><strong>Dates:</strong> ${escapeHtml(tripData.startDate?.toDate?.()?.toLocaleDateString() || 'Not specified')} - ${escapeHtml(tripData.endDate?.toDate?.()?.toLocaleDateString() || 'Not specified')}</p>
                        <p style="margin: 4px 0;"><strong>Traveler:</strong> ${safeUserName}</p>
                        <p style="margin: 4px 0;"><strong>User ID:</strong> ${safeUserId}</p>
                    </div>
                    
                    <div style="background: #e0f2fe; padding: 16px; border-radius: 8px; border-left: 4px solid #0ea5e9;">
                        <h4 style="margin: 0 0 8px 0; color: #0c4a6e;">💬 Message:</h4>
                        <p style="margin: 0; color: #164e63; font-size: 16px; line-height: 1.5;">${safeContent}</p>
                        ${messageData.metadata?.category ? `<p style="margin: 8px 0 0 0; color: #0369a1; font-size: 14px;"><strong>Category:</strong> ${safeCategory}</p>` : ''}
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
                    <a href="https://travel-consulting-app-1.web.app?conversation=${safeConversationParam}" 
                       style="background: #0ea5e9; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">
                        View Conversation
                    </a>
                </div>
            </div>
        `
    };
    
    try {
        console.log(`📧 Sending conversation notification email for conversation ${conversationId}`);
        await sendEmail(msg);
        console.log(`✅ Conversation email notification sent for: ${conversationId}`);
    } catch (error) {
        console.error('❌ Error sending conversation email:', error.code || error.message);
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
        cors: ALLOWED_CORS_ORIGINS
    },
    async (req, res) => {
        applyCorsHeaders(req, res, 'GET, POST, OPTIONS');

        if (req.method === 'OPTIONS') {
            res.status(200).send('');
            return;
        }

        const decodedAdmin = await verifyAuthRequest(req, res, { requireAdmin: true });
        if (!decodedAdmin) return;

        try {
            const apiKey = process.env.GOOGLE_PLACES_API_KEY;
            const { query, placeId, type = 'hotels' } = req.query;

            if (placeId) {
                if (typeof placeId !== 'string' || !PLACE_ID_REGEX.test(placeId)) {
                    return res.status(400).json({ success: false, error: 'Invalid placeId format' });
                }

                // Fetch Details for a specific place using Places API (New)
                const fieldMask = [
                    'id',
                    'displayName',
                    'formattedAddress',
                    'rating',
                    'userRatingCount',
                    'websiteUri',
                    'googleMapsUri',
                    'editorialSummary',
                    'photos',
                    'nationalPhoneNumber'
                ].join(',');

                const detailsUrl = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=en`;
                const response = await fetch(detailsUrl, {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Goog-Api-Key': apiKey,
                        'X-Goog-FieldMask': fieldMask
                    }
                });
                const place = await response.json();

                if (!response.ok) {
                    return res.status(response.status).json({ success: false, error: 'Place details request failed' });
                }

                let photoUrl = null;
                if (place.photos && place.photos.length > 0) {
                    photoUrl = await resolvePublicPhotoUrl(place.photos[0].name, apiKey) || null;
                }

                return res.json({
                    success: true,
                    place: {
                        id: place.id,
                        name: place.displayName?.text || '',
                        rating: place.rating || 4.5,
                        userRatingsTotal: place.userRatingCount || 0,
                        address: place.formattedAddress || '',
                        location: place.formattedAddress || '',
                        description: place.editorialSummary?.text || `${place.displayName?.text || ''} - ${type}`,
                        mapsUrl: place.googleMapsUri || `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`,
                        website: place.websiteUri || null,
                        photoUrl: photoUrl,
                        phone: place.nationalPhoneNumber || ''
                    }
                });
            } else if (query) {
                if (typeof query !== 'string' || query.trim().length === 0 || query.length > 200) {
                    return res.status(400).json({ success: false, error: 'Invalid search query' });
                }

                // Search Places by Text Query using Places API (New)
                const fieldMask = [
                    'places.id',
                    'places.displayName',
                    'places.formattedAddress',
                    'places.rating',
                    'places.userRatingCount',
                    'places.websiteUri',
                    'places.googleMapsUri',
                    'places.editorialSummary',
                    'places.photos'
                ].join(',');

                const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Goog-Api-Key': apiKey,
                        'X-Goog-FieldMask': fieldMask
                    },
                    body: JSON.stringify({
                        textQuery: query.trim(),
                        languageCode: 'en'
                    })
                });

                const data = await response.json();

                if (!response.ok) {
                    return res.status(response.status).json({ success: false, error: 'Places search request failed' });
                }

                const topPlaces = (data.places || []).slice(0, 10);
                const results = await Promise.all(topPlaces.map(async (p) => {
                    let photoUrl = '';
                    if (p.photos && p.photos.length > 0) {
                        photoUrl = await resolvePublicPhotoUrl(p.photos[0].name, apiKey);
                    }
                    return {
                        id: p.id,
                        placeId: p.id,
                        name: p.displayName?.text || '',
                        address: p.formattedAddress || '',
                        location: p.formattedAddress || '',
                        rating: p.rating || 4.5,
                        userRatingsTotal: p.userRatingCount || 0,
                        numReviews: p.userRatingCount || 0,
                        photoUrl,
                        bookingUrl: p.websiteUri || p.googleMapsUri || '',
                        googleMapsUrl: p.googleMapsUri || ''
                    };
                }));

                return res.json({ status: 'success', data: results, success: true, results });
            } else {
                return res.status(400).json({ error: 'Missing required parameter: query or placeId' });
            }
        } catch (error) {
            console.error('Google Places Proxy Error:', error);
            return res.status(500).json({ success: false, error: 'Failed to process Google Places request' });
        }
    }
);

/**
 * AI Dictation & Consulting Copilot Chat Endpoint
 * Powers voice dictation & natural language recommendation population in travelAdmin.
 */
exports.copilotChat = onRequest(
    {
        cors: ALLOWED_CORS_ORIGINS,
        region: "us-central1",
        memory: "512MiB",
        timeoutSeconds: 60
    },
    async (req, res) => {
        applyCorsHeaders(req, res, 'POST, OPTIONS');

        if (req.method === 'OPTIONS') {
            return res.status(200).send('');
        }

        if (req.method !== 'POST') {
            return res.status(405).json({ success: false, error: 'Method not allowed. Use POST.' });
        }

        const decodedAdmin = await verifyAuthRequest(req, res, { requireAdmin: true });
        if (!decodedAdmin) return;

        try {
            const { message, history = [], tripContext = {}, currentRecommendation = null, apiKey } = req.body || {};
            if (!message || typeof message !== 'string') {
                return res.status(400).json({ success: false, error: 'Message is required' });
            }

            const result = await handleCopilotChat({
                message,
                history,
                tripContext,
                currentRecommendation,
                apiKey: apiKey || process.env.GEMINI_API_KEY
            });

            return res.status(200).json(result);
        } catch (error) {
            console.error('copilotChat error:', error);
            return res.status(500).json({
                success: false,
                error: 'Copilot processing failed',
                reply: 'Sorry, I encountered a temporary error processing your request. Please try again.'
            });
        }
    }
);

// On-demand AI Trip Recommendation & Dossier Generation Endpoint
exports.generateTripRecommendation = onRequest(
    {
        cors: ALLOWED_CORS_ORIGINS,
        region: "us-central1"
    },
    async (req, res) => {
        applyCorsHeaders(req, res, 'POST, OPTIONS');
        try {
            if (req.method === 'OPTIONS') {
                return res.status(200).send('');
            }
            if (req.method !== 'POST') {
                return res.status(405).json({ error: 'Method not allowed. Use POST.' });
            }

            const decodedAdmin = await verifyAuthRequest(req, res, { requireAdmin: true });
            if (!decodedAdmin) return;

            const { tripId, tripData: customTripData, pointsData: customPointsData } = req.body || {};
            const geminiApiKey = process.env.GEMINI_API_KEY;

            if (!geminiApiKey) {
                return res.status(500).json({ error: 'AI service is not configured on the server.' });
            }

            let tripData = customTripData;
            let pointsData = customPointsData || { creditCard: {}, hotel: {}, airline: {}, totalPoints: 0 };

            // If tripId provided, fetch trip and userPoints from Firestore
            if (tripId && !tripData) {
                const tripDoc = await db.collection('trips').doc(tripId).get();
                if (!tripDoc.exists) {
                    return res.status(404).json({ error: 'Trip document not found.' });
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

            console.log(`🤖 On-demand AI itinerary generation requested for trip ${tripId || 'custom'}`);
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
            return res.status(500).json({ success: false, error: 'AI generation failed' });
        }
    }
);

/**
 * Authenticated Account & Data Deletion Endpoint (Apple App Store Guideline 5.1.1(v))
 * Permanently deletes all Firestore data owned by the authenticated user and removes their Firebase Auth account.
 */
exports.deleteUserAccount = onRequest(
    {
        cors: ALLOWED_CORS_ORIGINS,
        region: "us-central1",
        memory: "512MiB",
        timeoutSeconds: 60
    },
    async (req, res) => {
        applyCorsHeaders(req, res, 'POST, DELETE, OPTIONS');

        if (req.method === 'OPTIONS') {
            return res.status(200).send('');
        }

        if (req.method !== 'POST' && req.method !== 'DELETE') {
            return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const decodedToken = await verifyAuthRequest(req, res, { requireAdmin: false });
        if (!decodedToken) return;

        const uid = decodedToken.uid;

        try {
            const deleteDocsInChunks = async (docRefs) => {
                const chunkSize = 400;
                for (let i = 0; i < docRefs.length; i += chunkSize) {
                    const batch = db.batch();
                    docRefs.slice(i, i + chunkSize).forEach(ref => batch.delete(ref));
                    await batch.commit();
                }
            };

            const refsToDelete = [
                db.collection('users').doc(uid),
                db.collection('userPoints').doc(uid),
                db.collection('userSubmissions').doc(uid)
            ];

            // Collect all user's trips
            const tripsSnap = await db.collection('trips').where('userId', '==', uid).get();
            tripsSnap.forEach(doc => refsToDelete.push(doc.ref));

            // Collect all user's conversations and nested messages
            const convSnap = await db.collection('tripConversations').where('userId', '==', uid).get();
            for (const convDoc of convSnap.docs) {
                const msgsSnap = await convDoc.ref.collection('messages').get();
                msgsSnap.forEach(msgDoc => refsToDelete.push(msgDoc.ref));
                refsToDelete.push(convDoc.ref);
            }

            await deleteDocsInChunks(refsToDelete);

            // Delete Firebase Authentication record last
            await auth.deleteUser(uid);

            console.log(`Account and all Firestore data deleted for user ${uid}`);
            return res.status(200).json({ success: true });
        } catch (error) {
            console.error(`Error deleting account for user ${uid}:`, error);
            return res.status(500).json({ success: false, error: 'Failed to delete account' });
        }
    }
);