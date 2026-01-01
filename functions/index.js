const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { validateTripSubmissionData, validateRecommendationData } = require("./schemas");

// Initialize Firebase Admin
initializeApp();

const db = getFirestore();
const auth = getAuth();

// Input sanitization helper
const sanitizeString = (input) => {
    if (typeof input !== 'string') return input;
    return input.trim().replace(/[<>\"'&]/g, '');
};

// Lazy load SendGrid to avoid initialization timeout
let sgMail = null;
const initSendGrid = () => {
    // Firebase Functions v2 uses environment variables
    let sendGridKey = process.env.SENDGRID_API_KEY;
    
    if (!sgMail && sendGridKey) {
        // Clean the API key - remove any whitespace/newlines that might cause header issues
        sendGridKey = sendGridKey.trim();
        
        sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(sendGridKey);
        console.log('✅ SendGrid initialized successfully');
    } else if (!sendGridKey) {
        console.log('❌ SendGrid API key not found in environment variables');
    }
    return sgMail;
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
        secrets: ["SENDGRID_API_KEY"]
    },
    async (event) => {
        const tripId = event.params.tripId;
        const tripData = event.data.data();
        
        console.log(`Processing new trip: ${tripId}`);
        
        try {
            // Update status to pending (waiting for manual planning)
            await db.collection('trips').doc(tripId).update({
                status: 'pending',
                updatedAt: FieldValue.serverTimestamp()
            });
            
            // Send notification email (if SendGrid is configured)
            try {
                await sendNewTripNotification(tripId, tripData);
            } catch (emailError) {
                console.warn('Failed to send email notification:', emailError);
                // Don't fail the whole process if email fails
            }
            
            console.log(`Trip ${tripId} is now pending manual planning via admin interface`);
            
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

// Send email notification
// Send email notification with user points
async function sendNewTripNotification(tripId, tripData) {
    const sgMailInstance = initSendGrid();
    
    if (!sgMailInstance) {
        console.log('SendGrid not configured, skipping email notification');
        return;
    }
    
    // Fetch user profile and points data
    let userEmail = 'Not available';
    let userName = 'Not available';
    let pointsData = {
        creditCard: {},
        hotel: {},
        airline: {},
        totalPoints: 0
    };
    
    try {
        // Get user profile from Firestore (for basic user info)
        const userProfileDoc = await db.collection('users').doc(tripData.userId).get();
        if (userProfileDoc.exists) {
            const userData = userProfileDoc.data();
            userEmail = userData.email || 'Not available';
            userName = userData.name || userData.displayName || 'Not available';
        }
        
        // Get user points from separate collection
        const userPointsDoc = await db.collection('userPoints').doc(tripData.userId).get();
        if (userPointsDoc.exists) {
            const pointsDoc = userPointsDoc.data();
            pointsData.creditCard = pointsDoc.creditCardPoints || {};
            pointsData.hotel = pointsDoc.hotelPoints || {};
            pointsData.airline = pointsDoc.airlinePoints || {};
            
            // Calculate total points across all categories
            const creditCardTotal = Object.values(pointsData.creditCard).reduce((sum, points) => sum + (points || 0), 0);
            const hotelTotal = Object.values(pointsData.hotel).reduce((sum, points) => sum + (points || 0), 0);
            const airlineTotal = Object.values(pointsData.airline).reduce((sum, points) => sum + (points || 0), 0);
            pointsData.totalPoints = creditCardTotal + hotelTotal + airlineTotal;
        }
        
    } catch (error) {
        console.warn('Could not fetch user data:', error);
        // Continue with email sending even if we can't get user data
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
        subject: `New Trip Request - ${tripData.destination} (${tripData.groupSize || 1} ${(tripData.groupSize || 1) === 1 ? 'traveler' : 'travelers'}) - ${pointsData.totalPoints.toLocaleString()} total pts`,
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
                <p><strong>Interests:</strong> ${tripData.interests?.join(', ') || 'None specified'}</p>
                ${tripData.specialRequests ? `<p><strong>Special Requests:</strong> ${tripData.specialRequests}</p>` : ''}
            </div>
            
            <div style="background: #f3e5f5; padding: 20px; border-radius: 8px; margin: 16px 0;">
                <h3>📊 Submission Info</h3>
                <p><strong>Submitted:</strong> ${new Date().toLocaleString()}</p>
                <p><strong>Status:</strong> <span style="color: #ffc107; font-weight: bold;">Pending Manual Planning</span></p>
            </div>
            
            <div style="background: #fff3cd; padding: 20px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #ffc107;">
                <h3>🎯 Next Steps</h3>
                <p>This trip is ready for your personal touch! Use the admin dashboard to:</p>
                <ul style="margin: 8px 0; padding-left: 20px;">
                    <li>Create a custom itinerary</li>
                    <li>Add personalized recommendations</li>
                    <li>Optimize points and miles usage</li>
                    <li>Mark as completed when ready</li>
                </ul>
            </div>
            
            <hr style="margin: 24px 0;">
            <p style="color: #666; font-style: italic;">Ready to plan an amazing trip! 🎉</p>
        `
    };

    await sgMailInstance.send(msg);
    console.log(`Email notification sent for trip: ${tripId} (User: ${userName}, Total Points: ${pointsData.totalPoints.toLocaleString()})`);
}

// Send detailed itinerary completion notification
async function sendDetailedItineraryNotification(tripId, tripData) {
    const sgMailInstance = initSendGrid();
    
    if (!sgMailInstance) {
        console.log('SendGrid not configured, skipping detailed itinerary email');
        return;
    }
    
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
    
    const destinations = tripData.destinations?.join(', ') || tripData.destination || 'Your Destination';
    const recommendation = tripData.recommendation;
    const itinerary = recommendation?.itinerary;
    
    // Build flight information HTML
    let flightHtml = '';
    if (itinerary?.flights) {
        const flights = itinerary.flights;
        flightHtml = `
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; margin: 20px 0;">
                <h3 style="color: white; margin-top: 0;">✈️ Your Flights</h3>
                ${flights.outbound ? `
                    <div style="background: rgba(255,255,255,0.1); padding: 15px; border-radius: 8px; margin: 10px 0;">
                        <h4 style="color: white; margin: 0 0 10px 0;">Outbound: ${flights.outbound.departure?.airportCode || ''} → ${flights.outbound.arrival?.airportCode || ''}</h4>
                        <p style="color: white; margin: 5px 0;"><strong>${flights.outbound.airline || ''} ${flights.outbound.flightNumber || ''}</strong></p>
                        <p style="color: white; margin: 5px 0;">${flights.outbound.departure?.date || ''} at ${flights.outbound.departure?.time || ''} → ${flights.outbound.arrival?.date || ''} at ${flights.outbound.arrival?.time || ''}</p>
                        <p style="color: white; margin: 5px 0;">Duration: ${flights.outbound.duration || 'N/A'} | Cost: $${flights.outbound.cost || 0}</p>
                    </div>
                ` : ''}
                ${flights.return ? `
                    <div style="background: rgba(255,255,255,0.1); padding: 15px; border-radius: 8px; margin: 10px 0;">
                        <h4 style="color: white; margin: 0 0 10px 0;">Return: ${flights.return.departure?.airportCode || ''} → ${flights.return.arrival?.airportCode || ''}</h4>
                        <p style="color: white; margin: 5px 0;"><strong>${flights.return.airline || ''} ${flights.return.flightNumber || ''}</strong></p>
                        <p style="color: white; margin: 5px 0;">${flights.return.departure?.date || ''} at ${flights.return.departure?.time || ''} → ${flights.return.arrival?.date || ''} at ${flights.return.arrival?.time || ''}</p>
                        <p style="color: white; margin: 5px 0;">Duration: ${flights.return.duration || 'N/A'} | Cost: $${flights.return.cost || 0}</p>
                    </div>
                ` : ''}
                <div style="background: rgba(255,255,255,0.2); padding: 10px; border-radius: 6px; margin-top: 15px;">
                    <p style="color: white; margin: 0; font-size: 16px;"><strong>Total Flight Cost: $${flights.totalFlightCost || 0}</strong></p>
                    ${flights.bookingDeadline ? `<p style="color: #ffd700; margin: 5px 0 0 0;">🕒 Book by: ${flights.bookingDeadline}</p>` : ''}
                </div>
            </div>
        `;
    }
    
    // Build daily itinerary HTML
    let dailyHtml = '';
    if (itinerary?.dailyPlans && itinerary.dailyPlans.length > 0) {
        dailyHtml = `
            <div style="margin: 20px 0;">
                <h3 style="color: #2563eb;">📅 Your Daily Itinerary</h3>
                ${itinerary.dailyPlans.map(day => `
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 12px 0;">
                        <h4 style="color: #1e40af; margin: 0 0 12px 0;">Day ${day.dayNumber}: ${day.title || ''}</h4>
                        ${day.date ? `<p style="color: #64748b; margin: 0 0 12px 0; font-weight: 500;">${day.date}</p>` : ''}
                        ${day.activities && day.activities.length > 0 ? day.activities.map(activity => `
                            <div style="background: white; border-radius: 6px; padding: 12px; margin: 8px 0; border-left: 4px solid #3b82f6;">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                    <strong style="color: #1e40af;">${activity.time || ''} - ${activity.title || ''}</strong>
                                    ${activity.cost > 0 ? `<span style="color: #059669; font-weight: bold;">$${activity.cost}</span>` : ''}
                                </div>
                                <p style="color: #4b5563; margin: 0; font-size: 14px;">${activity.description || ''}</p>
                                ${activity.duration ? `<p style="color: #6b7280; margin: 4px 0 0 0; font-size: 12px;">Duration: ${activity.duration}</p>` : ''}
                                ${activity.bookingRequired ? `<p style="color: #d97706; margin: 4px 0 0 0; font-size: 12px; font-weight: 500;">⚠️ Advance booking required</p>` : ''}
                            </div>
                        `).join('') : ''}
                        ${day.estimatedCost > 0 ? `<p style="margin: 12px 0 0 0; padding: 8px; background: #ecfdf5; border-radius: 4px; color: #059669; font-weight: bold;">Day Total: $${day.estimatedCost}</p>` : ''}
                    </div>
                `).join('')}
            </div>
        `;
    }
    
    // Build accommodations HTML
    let accommodationsHtml = '';
    if (itinerary?.accommodations && itinerary.accommodations.length > 0) {
        accommodationsHtml = `
            <div style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 20px; margin: 20px 0;">
                <h3 style="color: #0369a1; margin-top: 0;">🏨 Your Accommodations</h3>
                ${itinerary.accommodations.map(acc => `
                    <div style="background: white; border-radius: 6px; padding: 15px; margin: 10px 0;">
                        <h4 style="color: #1e40af; margin: 0 0 8px 0;">${acc.name || 'Hotel'}</h4>
                        <p style="margin: 4px 0; color: #4b5563;"><strong>Check-in:</strong> ${acc.checkIn || 'TBD'} | <strong>Check-out:</strong> ${acc.checkOut || 'TBD'}</p>
                        <p style="margin: 4px 0; color: #4b5563;"><strong>Room:</strong> ${acc.roomType || 'Standard'} | <strong>Nights:</strong> ${acc.nights || 1}</p>
                        <p style="margin: 4px 0; color: #059669; font-weight: bold;">$${acc.cost || 0}/night</p>
                        ${acc.bookingInstructions ? `<p style="margin: 8px 0 0 0; padding: 8px; background: #fef3c7; border-radius: 4px; font-size: 14px;">${acc.bookingInstructions}</p>` : ''}
                    </div>
                `).join('')}
            </div>
        `;
    }
    
    // Build cost summary
    let costHtml = '';
    if (itinerary?.totalCost && itinerary.totalCost.totalEstimate > 0) {
        const cost = itinerary.totalCost;
        costHtml = `
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px; margin: 20px 0;">
                <h3 style="color: #166534; margin-top: 0;">💰 Cost Breakdown</h3>
                <div style="display: grid; gap: 8px;">
                    ${cost.flights > 0 ? `<div style="display: flex; justify-content: space-between;"><span>Flights:</span><span>$${cost.flights}</span></div>` : ''}
                    ${cost.accommodation > 0 ? `<div style="display: flex; justify-content: space-between;"><span>Accommodation:</span><span>$${cost.accommodation}</span></div>` : ''}
                    ${cost.activities > 0 ? `<div style="display: flex; justify-content: space-between;"><span>Activities:</span><span>$${cost.activities}</span></div>` : ''}
                    ${cost.food > 0 ? `<div style="display: flex; justify-content: space-between;"><span>Food:</span><span>$${cost.food}</span></div>` : ''}
                    ${cost.localTransport > 0 ? `<div style="display: flex; justify-content: space-between;"><span>Local Transport:</span><span>$${cost.localTransport}</span></div>` : ''}
                    ${cost.miscellaneous > 0 ? `<div style="display: flex; justify-content: space-between;"><span>Miscellaneous:</span><span>$${cost.miscellaneous}</span></div>` : ''}
                </div>
                <hr style="margin: 15px 0; border: none; border-top: 2px solid #16a34a;">
                <div style="display: flex; justify-content: space-between; font-size: 18px; font-weight: bold; color: #166534;">
                    <span>Total Estimated Cost:</span>
                    <span>$${cost.totalEstimate} ${cost.currency || 'USD'}</span>
                </div>
            </div>
        `;
    }
    
    const msg = {
        to: userEmail,
        from: 'noreply@wandermint.io',
        subject: `🎉 Your Detailed Itinerary for ${destinations} is Ready!`,
        html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; line-height: 1.6;">
                <div style="text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 12px; margin-bottom: 30px;">
                    <h1 style="margin: 0; font-size: 28px;">🎉 Your Detailed Itinerary is Ready!</h1>
                    <p style="margin: 10px 0 0 0; font-size: 18px; opacity: 0.9;">Get ready for an amazing trip to ${destinations}</p>
                </div>
                
                <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                    <h2 style="color: #1e40af; margin-top: 0;">Hi ${userName}! 👋</h2>
                    <p>Your personalized travel itinerary is complete and ready for booking! This comprehensive plan includes everything you need for an incredible trip.</p>
                    ${recommendation?.overview ? `<p style="font-style: italic; color: #4b5563;">"${recommendation.overview}"</p>` : ''}
                </div>
                
                ${flightHtml}
                ${dailyHtml}
                ${accommodationsHtml}
                ${costHtml}
                
                <div style="background: #fef3c7; border: 1px solid #fbbf24; border-radius: 8px; padding: 20px; margin: 20px 0;">
                    <h3 style="color: #92400e; margin-top: 0;">📋 Next Steps</h3>
                    <ol style="color: #92400e; margin: 0; padding-left: 20px;">
                        <li><strong>Review</strong> your complete itinerary in the app</li>
                        <li><strong>Book flights</strong> as soon as possible for best availability</li>
                        <li><strong>Reserve accommodations</strong> and activities that require advance booking</li>
                        <li><strong>Check</strong> passport/visa requirements if traveling internationally</li>
                        <li><strong>Consider</strong> travel insurance for peace of mind</li>
                    </ol>
                </div>
                
                <div style="text-align: center; padding: 20px; background: #f1f5f9; border-radius: 8px; margin-top: 30px;">
                    <p style="margin: 0; color: #64748b;">Questions about your itinerary? Reply to this email!</p>
                    <p style="margin: 10px 0 0 0; color: #64748b; font-size: 14px;">Happy travels! ✈️🌟</p>
                </div>
            </div>
        `
    };

    await sgMailInstance.send(msg);
    console.log(`Detailed itinerary email sent for trip: ${tripId} (User: ${userName})`);
}

// Handle trip status updates
exports.onTripStatusUpdate = onDocumentUpdated(
    {
        document: 'trips/{tripId}',
        region: "us-central1",
        secrets: ["SENDGRID_API_KEY"]
    },
    async (event) => {
        const tripId = event.params.tripId;
        const beforeData = event.data.before.data();
        const afterData = event.data.after.data();
        
        // Send detailed itinerary notification when trip is completed
        if (beforeData.status !== 'completed' && afterData.status === 'completed') {
            console.log(`Trip completed: ${tripId}`);
            
            try {
                // Check if this is a detailed itinerary (has itinerary data)
                if (afterData.recommendation?.itinerary) {
                    await sendDetailedItineraryNotification(tripId, afterData);
                    console.log(`Sent detailed itinerary notification for trip ${tripId}`);
                } else {
                    console.log(`Trip ${tripId} completed but no detailed itinerary found`);
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
        secrets: ["SENDGRID_API_KEY"]
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
    const sgMailInstance = initSendGrid();
    
    if (!sgMailInstance) {
        console.log('SendGrid not configured, skipping conversation email notification');
        return;
    }
    
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
        
        const result = await sgMailInstance.send(msg);
        console.log('✅ SendGrid response:', result);
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