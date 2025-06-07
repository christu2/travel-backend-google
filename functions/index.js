const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

// Initialize Firebase Admin
initializeApp();

const db = getFirestore();
const auth = getAuth();

// Lazy load SendGrid to avoid initialization timeout
let sgMail = null;
const initSendGrid = () => {
    if (!sgMail && process.env.SENDGRID_API_KEY) {
        sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
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
            
            console.log('Received trip data:', JSON.stringify(data, null, 2));
            
            // Validate required fields
            if (!data.destination || !data.startDate || !data.endDate || !data.paymentMethod) {
                console.error('Missing required fields:', {
                    destination: !!data.destination,
                    startDate: !!data.startDate,
                    endDate: !!data.endDate,
                    paymentMethod: !!data.paymentMethod
                });
                res.status(400).send('Missing required fields: destination, startDate, endDate, paymentMethod');
                return;
            }
            
            // Extract optional preference fields
            const budget = data.budget || null;
            const travelStyle = data.travelStyle || 'Comfortable';
            const groupSize = data.groupSize || 1;
            const specialRequests = data.specialRequests || '';
            const interests = data.interests || [];
            
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
            
            // Parse dates from the iOS app - handle both ISO and simple date formats
            let startDate, endDate;
            try {
                startDate = data.startDate ? Timestamp.fromDate(new Date(data.startDate)) : null;
                endDate = data.endDate ? Timestamp.fromDate(new Date(data.endDate)) : null;
                
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
            
            // Create trip document
            const tripData = {
                userId: uid,
                destination: data.destination,
                startDate: startDate,
                endDate: endDate,
                paymentMethod: data.paymentMethod,
                flexibleDates: data.flexibleDates || false,
                status: 'submitted',
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp()
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
            
            console.log(`Trip submitted successfully: ${tripRef.id}`);
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
            
            // Only allow admin user (your email) to update recommendations
            if (decodedToken.email !== 'nchristus93@gmail.com') {
                res.status(403).send('Admin access required');
                return;
            }
            
            const { tripId, recommendation } = req.body;
            
            if (!tripId || !recommendation) {
                res.status(400).send('Missing tripId or recommendation');
                return;
            }
            
            // Update trip with your custom recommendation
            await db.collection('trips').doc(tripId).update({
                status: 'completed',
                recommendation: recommendation,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                completedBy: decodedToken.email,
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
    },
    async (event) => {
        const tripId = event.params.tripId;
        const tripData = event.data.data();
        
        console.log(`Processing new trip: ${tripId}`);
        
        try {
            // Update status to processing
            await db.collection('trips').doc(tripId).update({
                status: 'processing',
                updatedAt: FieldValue.serverTimestamp()
            });
            
            // Send notification email (if SendGrid is configured)
            try {
                await sendNewTripNotification(tripId, tripData);
            } catch (emailError) {
                console.warn('Failed to send email notification:', emailError);
                // Don't fail the whole process if email fails
            }
            
            // Generate recommendation after a short delay
            setTimeout(async () => {
                try {
                    await generateTripRecommendation(tripId, tripData);
                } catch (recError) {
                    console.error(`Error generating recommendation for trip ${tripId}:`, recError);
                    await db.collection('trips').doc(tripId).update({
                        status: 'failed',
                        errorMessage: recError.message,
                        updatedAt: FieldValue.serverTimestamp()
                    });
                }
            }, 3000); // 3 second delay
            
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

// Generate trip recommendation
async function generateTripRecommendation(tripId, tripData) {
    console.log(`Generating recommendation for trip: ${tripId}`);
    
    const recommendation = generateMockRecommendation(tripData);
    
    await db.collection('trips').doc(tripId).update({
        status: 'completed',
        recommendation: recommendation,
        updatedAt: FieldValue.serverTimestamp()
    });
    
    console.log(`Trip recommendation completed: ${tripId}`);
}

// Mock recommendation generator
function generateMockRecommendation(tripData) {
    const destination = tripData.destination || 'Unknown Destination';
    
    return {
        id: `rec_${Date.now()}`,
        destination: destination,
        overview: `${destination} is a fantastic destination with rich culture, beautiful landscapes, and amazing cuisine. Perfect for travelers seeking adventure and relaxation.`,
        activities: [
            {
                id: 'act_1',
                name: 'City Walking Tour',
                description: 'Explore the historic downtown area with a knowledgeable local guide.',
                category: 'Cultural',
                estimatedDuration: '3 hours',
                estimatedCost: 45.0,
                priority: 1
            },
            {
                id: 'act_2',
                name: 'Local Cuisine Experience',
                description: 'Taste authentic local dishes at highly-rated restaurants.',
                category: 'Food & Dining',
                estimatedDuration: '2 hours',
                estimatedCost: 75.0,
                priority: 2
            },
            {
                id: 'act_3',
                name: 'Museum Visit',
                description: 'Visit the most popular museums showcasing local history and art.',
                category: 'Cultural',
                estimatedDuration: '4 hours',
                estimatedCost: 25.0,
                priority: 3
            }
        ],
        accommodations: [
            {
                id: 'acc_1',
                name: 'Downtown Boutique Hotel',
                type: 'hotel',
                description: 'Modern hotel in the heart of the city with excellent amenities.',
                priceRange: '$150-250/night',
                rating: 4.5,
                amenities: ['Free WiFi', 'Gym', 'Restaurant', 'Concierge']
            },
            {
                id: 'acc_2',
                name: 'Cozy Airbnb Apartment',
                type: 'airbnb',
                description: 'Charming apartment with local neighborhood feel.',
                priceRange: '$80-120/night',
                rating: 4.8,
                amenities: ['Kitchen', 'WiFi', 'Washer/Dryer', 'Local Host']
            }
        ],
        transportation: {
            flightInfo: {
                recommendedAirlines: ['Delta', 'American Airlines', 'United'],
                estimatedFlightTime: '4.5 hours',
                bestBookingTime: '6-8 weeks in advance'
            },
            localTransport: ['Metro/Subway', 'Taxi/Uber', 'Bike Rental', 'Walking'],
            estimatedFlightCost: 450.0,
            localTransportCost: 80.0
        },
        estimatedCost: {
            totalEstimate: 1200.0,
            flights: 450.0,
            accommodation: 500.0,
            activities: 145.0,
            food: 200.0,
            localTransport: 80.0,
            miscellaneous: 125.0,
            currency: 'USD'
        },
        bestTimeToVisit: 'April through October offers the best weather with mild temperatures and minimal rainfall.',
        tips: [
            'Book accommodations early for better rates',
            'Try local public transportation for an authentic experience',
            'Download offline maps before you go',
            'Learn a few basic phrases in the local language',
            'Pack layers as weather can be unpredictable'
        ],
        createdAt: FieldValue.serverTimestamp()
    };
}

// Send email notification
async function sendNewTripNotification(tripId, tripData) {
    const sgMailInstance = initSendGrid();
    
    if (!sgMailInstance) {
        console.log('SendGrid not configured, skipping email notification');
        return;
    }
    
    const msg = {
        to: 'nchristus93@gmail.com',
        from: 'no-reply@em6158.nickstravelconsulting.com',
        subject: `New Trip Request - ${tripData.destination} (${tripData.preferences?.groupSize || 1} ${tripData.preferences?.groupSize === 1 ? 'traveler' : 'travelers'})`,
        html: `
            <h2>🌍 New Trip Request</h2>
            <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 16px 0;">
                <h3>📍 Trip Details</h3>
                <p><strong>Destination:</strong> ${tripData.destination}</p>
                <p><strong>Dates:</strong> ${tripData.startDate?.toDate?.()?.toLocaleDateString() || 'Not specified'} - ${tripData.endDate?.toDate?.()?.toLocaleDateString() || 'Not specified'}</p>
                <p><strong>Flexible Dates:</strong> ${tripData.flexibleDates ? 'Yes' : 'No'}</p>
                <p><strong>Payment Method:</strong> ${tripData.paymentMethod}</p>
            </div>
            
            <div style="background: #e3f2fd; padding: 20px; border-radius: 8px; margin: 16px 0;">
                <h3>✨ Client Preferences</h3>
                <p><strong>Budget:</strong> ${tripData.preferences?.budget || 'Not specified'}</p>
                <p><strong>Travel Style:</strong> ${tripData.preferences?.travelStyle || 'Not specified'}</p>
                <p><strong>Group Size:</strong> ${tripData.preferences?.groupSize || 1} ${tripData.preferences?.groupSize === 1 ? 'person' : 'people'}</p>
                <p><strong>Interests:</strong> ${tripData.preferences?.interests?.join(', ') || 'None specified'}</p>
                ${tripData.preferences?.specialRequests ? `<p><strong>Special Requests:</strong> ${tripData.preferences.specialRequests}</p>` : ''}
            </div>
            
            <div style="background: #f3e5f5; padding: 20px; border-radius: 8px; margin: 16px 0;">
                <h3>👤 Client Info</h3>
                <p><strong>Trip ID:</strong> ${tripId}</p>
                <p><strong>User ID:</strong> ${tripData.userId}</p>
                <p><strong>Submitted:</strong> ${new Date().toLocaleString()}</p>
            </div>
            
            <hr style="margin: 24px 0;">
            <p style="color: #666; font-style: italic;">Ready to plan an amazing trip! 🎉</p>
        `
    };

    await sgMailInstance.send(msg);
    console.log(`Email notification sent for trip: ${tripId}`);
}

// Handle trip status updates
exports.onTripStatusUpdate = onDocumentUpdated(
    {
        document: 'trips/{tripId}',
        region: "us-central1",
    },
    async (event) => {
        const tripId = event.params.tripId;
        const beforeData = event.data.before.data();
        const afterData = event.data.after.data();
        
        if (beforeData.status !== 'completed' && afterData.status === 'completed') {
            console.log(`Trip completed: ${tripId}`);
        }
        
        if (beforeData.status !== 'failed' && afterData.status === 'failed') {
            console.error(`Trip failed: ${tripId}, Error: ${afterData.errorMessage || 'Unknown error'}`);
        }
    }
);