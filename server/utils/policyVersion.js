/**
 * Which version of the Privacy policy (and Terms) a sign-up agreed to.
 *
 * Bump this only when the text of client/src/pages/public/PrivacyPage.jsx (or the limits list it shows) changes, and bump the
 * same value in client/src/config.js (PRIVACY_POLICY) so the page shows it. A test in the client fails when the page text
 * changes without a bump, and another fails when the two constants differ.
 *
 * The version is written to a new account as `consent: { acceptedAt, policyVersion }` (controllers/signup.controller.js).
 * Accounts created before this existed have no `consent` field.
 */
const PRIVACY_POLICY_VERSION = '2026-10-15.2'; // the 2nd text of 15 October 2026 (the contact address changed); existing consents keep their own version

module.exports = { PRIVACY_POLICY_VERSION };
