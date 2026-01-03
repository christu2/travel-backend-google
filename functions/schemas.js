/**
 * JSON Schema Validation for WanderMint Travel Backend
 *
 * This module provides comprehensive schema validation for all API endpoints
 * to ensure data integrity and prevent malformed data from reaching Firestore.
 *
 * IMPORTANT: This file now uses @wandermint/shared-schemas NPM package
 * These schemas are the single source of truth across iOS, Backend, and Admin.
 */

const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { schemas } = require('@wandermint/shared-schemas');

// Extract schemas from package
const budgetSchema = schemas.budget;
const travelStyleSchema = schemas.travelStyle;
const commonTypesSchema = schemas.commonTypes;

// Initialize AJV with custom options
const ajv = new Ajv({
    allErrors: true,        // Collect all errors, not just the first one
    removeAdditional: true, // Remove additional properties not in schema
    useDefaults: true,      // Apply default values from schema
    coerceTypes: false,     // Don't coerce types - enforce strict validation
    strict: false           // Allow metadata fields like version, changelog
});

// Add format validators (date, email, uri, etc.)
addFormats(ajv);

// Add shared schemas to AJV
ajv.addSchema(budgetSchema, 'budget.schema.json');
ajv.addSchema(travelStyleSchema, 'travel-style.schema.json');
ajv.addSchema(commonTypesSchema, 'common-types.schema.json');

/**
 * Trip Submission Schema
 * Validates data from iOS app when user submits a new trip
 */
const tripSubmissionSchema = {
    type: 'object',
    required: ['destinations', 'startDate', 'endDate', 'travelStyle', 'groupSize'],
    additionalProperties: true, // Allow additional fields for flexibility
    properties: {
        // Required fields
        destinations: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: {
                type: 'string',
                minLength: 1,
                maxLength: 100
            },
            description: 'Array of destination city names'
        },
        startDate: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description: 'Trip start date in YYYY-MM-DD format'
        },
        endDate: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description: 'Trip end date in YYYY-MM-DD format'
        },
        travelStyle: {
            $ref: 'travel-style.schema.json',
            description: 'Travel style preference (pace and type, NOT budget)'
        },
        groupSize: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            description: 'Number of travelers'
        },

        // Optional fields
        departureLocation: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            description: 'City where user departs from'
        },
        flexibleDates: {
            type: 'boolean',
            default: false,
            description: 'Whether dates are flexible'
        },
        tripDuration: {
            type: 'integer',
            minimum: 1,
            maximum: 90,
            description: 'Trip duration in days (for flexible dates)'
        },
        budget: {
            $ref: 'budget.schema.json',
            description: 'Budget preference level (NOT a monetary amount like $1500)'
        },
        specialRequests: {
            type: 'string',
            maxLength: 1000,
            description: 'Special requests or notes'
        },
        interests: {
            type: 'array',
            maxItems: 20,
            items: {
                type: 'string',
                maxLength: 50
            },
            description: 'User interests (Culture, Food, Adventure, etc.)'
        },
        flightClass: {
            type: 'string',
            enum: ['Economy', 'Premium Economy', 'Business', 'First Class'],
            description: 'Preferred flight class'
        },

        // Legacy fields for backward compatibility
        destination: {
            type: 'string',
            maxLength: 100,
            description: 'Legacy single destination field'
        },
        paymentMethod: {
            type: 'string',
            maxLength: 50,
            description: 'Legacy payment method field'
        }
    }
};

/**
 * Destination Recommendation Schema
 * Validates data from admin dashboard when saving trip recommendations
 */
const destinationRecommendationSchema = {
    type: 'object',
    required: ['id', 'tripOverview', 'destinations', 'logistics', 'totalCost'],
    properties: {
        id: {
            type: 'string',
            minLength: 1,
            description: 'Unique recommendation ID'
        },
        tripOverview: {
            type: 'string',
            maxLength: 5000,
            description: 'Overview of the entire trip'
        },
        destinations: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: {
                type: 'object',
                required: ['id', 'cityName', 'arrivalDate', 'departureDate', 'numberOfNights'],
                properties: {
                    id: {
                        type: 'string',
                        description: 'Destination ID'
                    },
                    cityName: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 100,
                        description: 'City name'
                    },
                    arrivalDate: {
                        type: 'string',
                        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
                        description: 'Arrival date in YYYY-MM-DD'
                    },
                    departureDate: {
                        type: 'string',
                        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
                        description: 'Departure date in YYYY-MM-DD'
                    },
                    numberOfNights: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 90,
                        description: 'Number of nights in this city'
                    },
                    accommodationOptions: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['id', 'priority', 'hotel'],
                            properties: {
                                id: {
                                    type: 'string'
                                },
                                priority: {
                                    type: 'integer',
                                    minimum: 1,
                                    maximum: 10
                                },
                                hotel: {
                                    type: 'object',
                                    required: ['name', 'rating', 'pricePerNight', 'location', 'bookingUrl'],
                                    properties: {
                                        name: {
                                            type: 'string',
                                            minLength: 1,
                                            maxLength: 200
                                        },
                                        rating: {
                                            type: 'number',
                                            minimum: 1,
                                            maximum: 5
                                        },
                                        pricePerNight: {
                                            type: 'number',
                                            minimum: 0,
                                            maximum: 100000
                                        },
                                        pointsPerNight: {
                                            type: 'integer',
                                            minimum: 0
                                        },
                                        loyaltyProgram: {
                                            type: 'string',
                                            maxLength: 100
                                        },
                                        location: {
                                            type: 'string',
                                            minLength: 1,
                                            maxLength: 500
                                        },
                                        bookingUrl: {
                                            type: 'string',
                                            format: 'uri',
                                            maxLength: 2000
                                        },
                                        detailedDescription: {
                                            type: 'string',
                                            maxLength: 5000
                                        },
                                        tripadvisorId: {
                                            type: 'string',
                                            maxLength: 50
                                        },
                                        tripadvisorUrl: {
                                            type: 'string',
                                            format: 'uri',
                                            maxLength: 2000
                                        }
                                    }
                                }
                            }
                        }
                    },
                    recommendedActivities: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['id', 'name', 'description', 'location', 'estimatedCost', 'estimatedDuration', 'category'],
                            properties: {
                                id: {
                                    type: 'string'
                                },
                                name: {
                                    type: 'string',
                                    minLength: 1,
                                    maxLength: 200
                                },
                                description: {
                                    type: 'string',
                                    maxLength: 2000
                                },
                                location: {
                                    type: 'string',
                                    minLength: 1,
                                    maxLength: 500
                                },
                                estimatedCost: {
                                    type: 'number',
                                    minimum: 0,
                                    maximum: 100000
                                },
                                estimatedDuration: {
                                    type: 'string',
                                    maxLength: 100
                                },
                                category: {
                                    type: 'string',
                                    maxLength: 50
                                }
                            }
                        }
                    },
                    recommendedRestaurants: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['id', 'name', 'cuisine', 'location', 'priceRange', 'description'],
                            properties: {
                                id: {
                                    type: 'string'
                                },
                                name: {
                                    type: 'string',
                                    minLength: 1,
                                    maxLength: 200
                                },
                                cuisine: {
                                    type: 'string',
                                    maxLength: 100
                                },
                                location: {
                                    type: 'string',
                                    minLength: 1,
                                    maxLength: 500
                                },
                                priceRange: {
                                    type: 'string',
                                    pattern: '^\\$+$',
                                    maxLength: 10
                                },
                                description: {
                                    type: 'string',
                                    maxLength: 2000
                                }
                            }
                        }
                    },
                    selectedAccommodationId: {
                        type: 'string'
                    }
                }
            }
        },
        logistics: {
            type: 'object',
            properties: {
                transportSegments: {
                    type: 'array',
                    items: {
                        type: 'object'
                    }
                },
                bookingDeadlines: {
                    type: 'array',
                    items: {
                        type: 'object'
                    }
                },
                generalInstructions: {
                    type: 'string',
                    maxLength: 5000
                }
            }
        },
        totalCost: {
            type: 'object',
            required: ['totalEstimate', 'flights', 'accommodation', 'activities', 'food', 'localTransport', 'miscellaneous', 'currency'],
            properties: {
                totalEstimate: {
                    type: 'number',
                    minimum: 0,
                    maximum: 1000000
                },
                flights: {
                    type: 'number',
                    minimum: 0
                },
                accommodation: {
                    type: 'number',
                    minimum: 0
                },
                activities: {
                    type: 'number',
                    minimum: 0
                },
                food: {
                    type: 'number',
                    minimum: 0
                },
                localTransport: {
                    type: 'number',
                    minimum: 0
                },
                miscellaneous: {
                    type: 'number',
                    minimum: 0
                },
                currency: {
                    type: 'string',
                    pattern: '^[A-Z]{3}$',
                    description: 'ISO 4217 currency code (e.g., USD, EUR)'
                }
            }
        },
        createdAt: {
            description: 'Timestamp field (handled by Firestore)'
        }
    }
};

/**
 * Custom validation function for dates
 * Ensures endDate is after startDate
 */
function validateDateRange(data) {
    if (data.startDate && data.endDate) {
        const start = new Date(data.startDate);
        const end = new Date(data.endDate);

        if (end <= start) {
            return {
                valid: false,
                errors: [{
                    field: 'endDate',
                    message: 'End date must be after start date'
                }]
            };
        }
    }
    return { valid: true };
}

/**
 * Custom validation for destination dates in recommendations
 * Ensures each destination's departureDate is after arrivalDate
 */
function validateDestinationDates(recommendation) {
    const errors = [];

    if (recommendation.destinations && Array.isArray(recommendation.destinations)) {
        recommendation.destinations.forEach((dest, index) => {
            if (dest.arrivalDate && dest.departureDate) {
                const arrival = new Date(dest.arrivalDate);
                const departure = new Date(dest.departureDate);

                if (departure <= arrival) {
                    errors.push({
                        field: `destinations[${index}].departureDate`,
                        message: `Destination ${dest.cityName || index + 1}: Departure date must be after arrival date`
                    });
                }
            }
        });
    }

    return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

// Compile schemas
const validateTripSubmission = ajv.compile(tripSubmissionSchema);
const validateDestinationRecommendation = ajv.compile(destinationRecommendationSchema);

/**
 * Validate trip submission data with custom validations
 * @param {Object} data - Trip submission data from iOS app
 * @returns {Object} { valid: boolean, errors: Array }
 */
function validateTripSubmissionData(data) {
    const schemaValid = validateTripSubmission(data);

    if (!schemaValid) {
        return {
            valid: false,
            errors: validateTripSubmission.errors.map(err => ({
                field: err.instancePath || err.params.missingProperty,
                message: err.message,
                value: err.data
            }))
        };
    }

    // Custom date range validation
    const dateValidation = validateDateRange(data);
    if (!dateValidation.valid) {
        return dateValidation;
    }

    return { valid: true };
}

/**
 * Validate recommendation data with custom validations
 * @param {Object} data - Recommendation data from admin dashboard
 * @returns {Object} { valid: boolean, errors: Array }
 */
function validateRecommendationData(data) {
    const schemaValid = validateDestinationRecommendation(data);

    if (!schemaValid) {
        return {
            valid: false,
            errors: validateDestinationRecommendation.errors.map(err => ({
                field: err.instancePath || err.params.missingProperty,
                message: err.message,
                value: err.data
            }))
        };
    }

    // Custom destination date validation
    const dateValidation = validateDestinationDates(data);
    if (!dateValidation.valid) {
        return dateValidation;
    }

    return { valid: true };
}

module.exports = {
    validateTripSubmissionData,
    validateRecommendationData,
    tripSubmissionSchema,
    destinationRecommendationSchema
};
