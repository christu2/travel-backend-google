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

    test('OWASP A01/A05: No wildcard Access-Control-Allow-Origin * in Cloud Functions', () => {
        expect(indexSrc).not.toContain("Access-Control-Allow-Origin', '*'");
        expect(indexSrc).toContain('ALLOWED_CORS_ORIGINS');
    });

    test('OWASP A02/A10: googlePlacesProxy never embeds server API key in returned photoUrl and validates IDs', () => {
        expect(indexSrc).not.toContain('&key=${apiKey}');
        expect(indexSrc).toContain('skipHttpRedirect=true');
        expect(indexSrc).toContain('PLACE_ID_REGEX');
        expect(indexSrc).toContain('PHOTO_NAME_REGEX');
    });

    test('OWASP A03: Outbound HTML emails escape user-controlled content and validate URL schemes', () => {
        expect(indexSrc).toContain('const escapeHtml =');
        expect(indexSrc).toContain('const safeHttpUrl =');
        expect(indexSrc).toContain('${safeContent}');
        expect(indexSrc).toContain('${escapeHtml(userName)}');
    });

    test('OWASP A04: submitTrip daily rate limiting uses atomic Firestore transaction', () => {
        const fnIdx = indexSrc.indexOf('exports.submitTrip');
        const nextFnIdx = indexSrc.indexOf('exports.updateTripRecommendation');
        const submitBody = indexSrc.slice(fnIdx, nextFnIdx);
        expect(submitBody).toContain('db.runTransaction');
    });

    test('OWASP A07: Token verification enforces revocation checking (checkRevoked: true)', () => {
        expect(indexSrc).toContain('auth.verifyIdToken(idToken, true)');
    });

    test('OWASP A09: Error handlers do not dump full serialized error objects or raw user emails to logs', () => {
        expect(indexSrc).not.toContain('JSON.stringify(error');
        expect(indexSrc).not.toContain('Email: ${userEmail}');
    });
});
