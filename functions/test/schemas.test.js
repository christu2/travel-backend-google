/**
 * Simplified schema validation tests
 * Tests schema validation functions directly without requiring Firebase emulator
 */

const { describe, test, expect } = require('@jest/globals');
const { validateTripSubmissionData, validateRecommendationData } = require('../schemas');

describe('Trip Submission Schema Validation', () => {
    // MARK: - BUG #1 FIX TESTS - Empty Destinations Validation

    test('rejects empty destinations array', () => {
        const invalidSubmission = {
            destinations: [],
            startDate: '2024-06-15',
            endDate: '2024-06-22',
            travelStyle: 'Comfortable',
            groupSize: 2
        };

        const validation = validateTripSubmissionData(invalidSubmission);

        expect(validation.valid).toBe(false);
        expect(validation.errors).toBeDefined();
        expect(validation.errors.length).toBeGreaterThan(0);
    });

    test('rejects more than 5 destinations', () => {
        const invalidSubmission = {
            destinations: ['Paris', 'Lyon', 'Nice', 'Marseille', 'Bordeaux', 'Toulouse'],
            startDate: '2024-06-15',
            endDate: '2024-06-22',
            travelStyle: 'Comfortable',
            groupSize: 2
        };

        const validation = validateTripSubmissionData(invalidSubmission);
        expect(validation.valid).toBe(false);
    });

    test('accepts valid single destination', () => {
        const validSubmission = {
            destinations: ['Paris'],
            departureLocation: 'New York',
            startDate: '2024-06-15',
            endDate: '2024-06-22',
            flexibleDates: false,
            travelStyle: 'Comfortable',
            groupSize: 2,
            budget: 'Comfortable',
            specialRequests: '',
            interests: ['Culture', 'Food']
        };

        const validation = validateTripSubmissionData(validSubmission);
        expect(validation.valid).toBe(true);
    });

    test('accepts valid multiple destinations', () => {
        const validSubmission = {
            destinations: ['Paris', 'Lyon', 'Nice'],
            departureLocation: 'Boston',
            startDate: '2024-06-15',
            endDate: '2024-06-30',
            travelStyle: 'Comfortable',
            groupSize: 4
        };

        const validation = validateTripSubmissionData(validSubmission);
        expect(validation.valid).toBe(true);
    });

    test('accepts maximum 5 destinations', () => {
        const validSubmission = {
            destinations: ['Paris', 'Lyon', 'Nice', 'Marseille', 'Bordeaux'],
            startDate: '2024-06-15',
            endDate: '2024-06-30',
            travelStyle: 'Comfortable',
            groupSize: 2
        };

        const validation = validateTripSubmissionData(validSubmission);
        expect(validation.valid).toBe(true);
    });

    // MARK: - Date Validation Tests

    test('rejects end date before start date', () => {
        const invalidSubmission = {
            destinations: ['Paris'],
            startDate: '2024-06-22',
            endDate: '2024-06-15',
            travelStyle: 'Comfortable',
            groupSize: 2
        };

        const validation = validateTripSubmissionData(invalidSubmission);
        expect(validation.valid).toBe(false);
        expect(validation.errors.some(e => e.message.includes('after start date'))).toBe(true);
    });

    test('rejects end date same as start date', () => {
        const invalidSubmission = {
            destinations: ['Paris'],
            startDate: '2024-06-15',
            endDate: '2024-06-15',
            travelStyle: 'Comfortable',
            groupSize: 2
        };

        const validation = validateTripSubmissionData(invalidSubmission);
        expect(validation.valid).toBe(false);
    });

    test('rejects invalid date format', () => {
        const invalidSubmission = {
            destinations: ['Paris'],
            startDate: '06/15/2024',
            endDate: '2024-06-22',
            travelStyle: 'Comfortable',
            groupSize: 2
        };

        const validation = validateTripSubmissionData(invalidSubmission);
        expect(validation.valid).toBe(false);
    });

    // MARK: - Group Size Validation Tests

    test('accepts group size of 1', () => {
        const validSubmission = {
            destinations: ['Paris'],
            startDate: '2024-06-15',
            endDate: '2024-06-22',
            travelStyle: 'Comfortable',
            groupSize: 1
        };

        const validation = validateTripSubmissionData(validSubmission);
        expect(validation.valid).toBe(true);
    });

    test('accepts group size of 20', () => {
        const validSubmission = {
            destinations: ['Paris'],
            startDate: '2024-06-15',
            endDate: '2024-06-22',
            travelStyle: 'Comfortable',
            groupSize: 20
        };

        const validation = validateTripSubmissionData(validSubmission);
        expect(validation.valid).toBe(true);
    });

    test('rejects group size of 0', () => {
        const invalidSubmission = {
            destinations: ['Paris'],
            startDate: '2024-06-15',
            endDate: '2024-06-22',
            travelStyle: 'Comfortable',
            groupSize: 0
        };

        const validation = validateTripSubmissionData(invalidSubmission);
        expect(validation.valid).toBe(false);
    });

    test('rejects group size over 20', () => {
        const invalidSubmission = {
            destinations: ['Paris'],
            startDate: '2024-06-15',
            endDate: '2024-06-22',
            travelStyle: 'Comfortable',
            groupSize: 21
        };

        const validation = validateTripSubmissionData(invalidSubmission);
        expect(validation.valid).toBe(false);
    });

    // MARK: - Optional Fields Validation

    test('accepts valid budget enum value', () => {
        const validSubmission = {
            destinations: ['Paris'],
            startDate: '2024-06-15',
            endDate: '2024-06-22',
            travelStyle: 'Comfortable',
            groupSize: 2,
            budget: 'Luxury'
        };

        const validation = validateTripSubmissionData(validSubmission);
        expect(validation.valid).toBe(true);
    });

    test('rejects invalid budget enum value', () => {
        const invalidSubmission = {
            destinations: ['Paris'],
            startDate: '2024-06-15',
            endDate: '2024-06-22',
            travelStyle: 'Comfortable',
            groupSize: 2,
            budget: 'Super Cheap'
        };

        const validation = validateTripSubmissionData(invalidSubmission);
        expect(validation.valid).toBe(false);
    });

    test('accepts valid flight class', () => {
        const validSubmission = {
            destinations: ['Paris'],
            startDate: '2024-06-15',
            endDate: '2024-06-22',
            travelStyle: 'Comfortable',
            groupSize: 2,
            flightClass: 'Business'
        };

        const validation = validateTripSubmissionData(validSubmission);
        expect(validation.valid).toBe(true);
    });

    test('rejects invalid flight class', () => {
        const invalidSubmission = {
            destinations: ['Paris'],
            startDate: '2024-06-15',
            endDate: '2024-06-22',
            travelStyle: 'Comfortable',
            groupSize: 2,
            flightClass: 'Super Deluxe'
        };

        const validation = validateTripSubmissionData(invalidSubmission);
        expect(validation.valid).toBe(false);
    });

    // MARK: - Edge Cases

    test('handles missing required fields', () => {
        const invalidSubmission = {
            destinations: ['Paris']
        };

        const validation = validateTripSubmissionData(invalidSubmission);
        expect(validation.valid).toBe(false);
        expect(validation.errors.length).toBeGreaterThan(0);
    });

    test('handles special requests with max length', () => {
        const longRequest = 'A'.repeat(1500);
        const invalidSubmission = {
            destinations: ['Paris'],
            startDate: '2024-06-15',
            endDate: '2024-06-22',
            travelStyle: 'Comfortable',
            groupSize: 2,
            specialRequests: longRequest
        };

        const validation = validateTripSubmissionData(invalidSubmission);
        expect(validation.valid).toBe(false);
    });
});
