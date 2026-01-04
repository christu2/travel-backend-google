/**
 * Contract Tests: Backend Schema Validation
 *
 * These tests ensure the Backend's schemas stay compatible with iOS and Admin.
 * If these tests fail, it means a schema change has broken the contract.
 */

const { describe, test, expect } = require('@jest/globals');
const { validators, constants, schemas } = require('@wandermint/shared-schemas');

describe('Backend Contract: Must Accept Valid iOS Submissions', () => {
  test('Backend accepts Budget + Adventure submission (most common)', () => {
    const iosSubmission = {
      destinations: ['Paris'],
      startDate: '2026-06-15',
      endDate: '2026-06-22',
      budget: 'Budget',
      travelStyle: 'Adventure',
      groupSize: 2
    };

    const isValid = validators.tripSubmission(iosSubmission);
    expect(isValid).toBe(true);
  });

  test('Backend accepts all Budget enum values', () => {
    constants.BUDGET_VALUES.forEach(budgetValue => {
      const submission = {
        destinations: ['Tokyo'],
        startDate: '2026-07-01',
        endDate: '2026-07-10',
        budget: budgetValue,
        travelStyle: 'Comfortable',
        groupSize: 2
      };

      const isValid = validators.tripSubmission(submission);
      expect(isValid).toBe(true);
    });
  });

  test('Backend accepts all TravelStyle enum values', () => {
    constants.TRAVEL_STYLE_VALUES.forEach(travelStyleValue => {
      const submission = {
        destinations: ['London'],
        startDate: '2026-08-01',
        endDate: '2026-08-15',
        budget: 'Comfortable',
        travelStyle: travelStyleValue,
        groupSize: 2
      };

      const isValid = validators.tripSubmission(submission);
      expect(isValid).toBe(true);
    });
  });

  test('Backend accepts submission without optional budget', () => {
    const submission = {
      destinations: ['Rome'],
      startDate: '2026-09-01',
      endDate: '2026-09-10',
      travelStyle: 'Luxury',
      groupSize: 2
    };

    const isValid = validators.tripSubmission(submission);
    expect(isValid).toBe(true);
  });
});

describe('Backend Contract: Must Reject Invalid Data', () => {
  test('Backend rejects budget="$1500" (THE BUG that started it all)', () => {
    const invalidSubmission = {
      destinations: ['Paris'],
      startDate: '2026-06-15',
      endDate: '2026-06-22',
      budget: '$1500',  // INVALID: Monetary amount instead of enum
      travelStyle: 'Adventure',
      groupSize: 2
    };

    const isValid = validators.tripSubmission(invalidSubmission);
    expect(isValid).toBe(false);
    expect(validators.tripSubmission.errors).toBeDefined();
  });

  test('Backend rejects travelStyle="Mid-range" (budget-only value)', () => {
    const invalidSubmission = {
      destinations: ['Paris'],
      startDate: '2026-06-15',
      endDate: '2026-06-22',
      budget: 'Comfortable',
      travelStyle: 'Mid-range',  // INVALID: Budget-only value
      groupSize: 2
    };

    const isValid = validators.tripSubmission(invalidSubmission);
    expect(isValid).toBe(false);
  });

  test('Backend rejects budget="Adventure" (travelStyle-only value)', () => {
    const invalidSubmission = {
      destinations: ['Paris'],
      startDate: '2026-06-15',
      endDate: '2026-06-22',
      budget: 'Adventure',  // INVALID: TravelStyle-only value
      travelStyle: 'Comfortable',
      groupSize: 2
    };

    const isValid = validators.tripSubmission(invalidSubmission);
    expect(isValid).toBe(false);
  });

  test('Backend rejects empty destinations array (BUG #1)', () => {
    const invalidSubmission = {
      destinations: [],  // INVALID: Empty array
      startDate: '2026-06-15',
      endDate: '2026-06-22',
      travelStyle: 'Adventure',
      groupSize: 2
    };

    const isValid = validators.tripSubmission(invalidSubmission);
    expect(isValid).toBe(false);
  });
});

describe('Backend Contract: Enum Consistency', () => {
  test('Budget enum has exactly 5 values', () => {
    expect(constants.BUDGET_VALUES).toHaveLength(5);
    expect(constants.BUDGET_VALUES).toEqual([
      'Budget',
      'Comfortable',
      'Mid-range',
      'Luxury',
      'Ultra-Luxury'
    ]);
  });

  test('TravelStyle enum has exactly 5 values', () => {
    expect(constants.TRAVEL_STYLE_VALUES).toHaveLength(5);
    expect(constants.TRAVEL_STYLE_VALUES).toEqual([
      'Budget',
      'Comfortable',
      'Luxury',
      'Adventure',
      'Relaxation'
    ]);
  });

  test('Budget schema is accessible', () => {
    expect(schemas.budget).toBeDefined();
    expect(schemas.budget.enum).toEqual(constants.BUDGET_VALUES);
  });

  test('TravelStyle schema is accessible', () => {
    expect(schemas.travelStyle).toBeDefined();
    expect(schemas.travelStyle.enum).toEqual(constants.TRAVEL_STYLE_VALUES);
  });
});
