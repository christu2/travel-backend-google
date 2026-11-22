/**
 * Security Tests: Auth Enforcement & Endpoint Hardening
 *
 * Ensures admin-only Cloud Functions reject unauthenticated (401) and non-admin (403) callers,
 * and that deleteUserAccount requires a valid Bearer token.
 */

const { describe, test, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

describe('Backend Security Hardening Checks', () => {
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const rulesSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8');

    test('All admin-only HTTP Cloud Functions enforce verifyAuthRequest with requireAdmin: true', () => {
        const adminFunctions = ['googlePlacesProxy', 'copilotChat', 'generateTripRecommendation'];
        adminFunctions.forEach(fnName => {
            const fnIdx = indexSrc.indexOf(`exports.${fnName}`);
            expect(fnIdx).toBeGreaterThan(-1);
            const snippet = indexSrc.slice(fnIdx, fnIdx + 1200);
            expect(snippet).toContain('verifyAuthRequest(req, res, { requireAdmin: true })');
        });
    });

    test('deleteUserAccount Cloud Function exists and requires authenticated Bearer token', () => {
        const fnIdx = indexSrc.indexOf('exports.deleteUserAccount');
        expect(fnIdx).toBeGreaterThan(-1);
        const snippet = indexSrc.slice(fnIdx);
        expect(snippet).toContain('verifyAuthRequest(req, res, { requireAdmin: false })');
        expect(snippet).toContain('auth.deleteUser(uid)');
    });

    test('Firestore rules prevent users from tampering with trip status or spoofing admin messages', () => {
        expect(rulesSrc).toContain('request.resource.data.status == resource.data.status');
        expect(rulesSrc).toContain("resource.data.status in ['completed', 'cancelled', 'failed']");
        expect(rulesSrc).toContain("request.resource.data.senderType == 'user'");
        expect(rulesSrc).toContain("request.resource.data.senderId == request.auth.uid");
        expect(rulesSrc).toContain("affectedKeys().hasOnly(['isRead'])");
    });

    test('Firestore rules restrict userSubmissions writes to Admin SDK / admins', () => {
        const matchIdx = rulesSrc.indexOf('match /userSubmissions/{userId}');
        expect(matchIdx).toBeGreaterThan(-1);
        const block = rulesSrc.slice(matchIdx, matchIdx + 200);
        expect(block).toContain('allow write: if isAdmin();');
    });
});
