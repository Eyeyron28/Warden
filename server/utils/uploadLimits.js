const Document = require('../models/Document');
const createRateLimiter = require('../middleware/rateLimit');
const { logSecurity } = require('./securityLog');

/**
 * Per-account limits on how fast and how many files one signed-in account can create. They sit next to the 4 MB file cap and the
 * storage quota, which do not limit how MANY small files there are.
 *
 *   - speed: UPLOAD_MINUTE_LIMIT per minute (default 120, a burst cap) and UPLOAD_HOURLY_LIMIT per hour (default 600), counted
 *     per account by the shared Mongo-backed limiter (middleware/rateLimit.js), so every serverless instance sees the same count.
 *     Every request counts, including ones refused later by the scan or the zip rule. A repeated uploadKey also counts: the key
 *     is inside the multipart body, which is only read after this check (so the limit runs before any body is held in memory).
 *   - count: MAX_DOCUMENTS_PER_ACCOUNT documents (default 2000) of every kind: held files and files in Trash included. A new
 *     version of a file is not a new document.
 *
 * An env value that is not a positive whole number is ignored (the default applies).
 */
const DEFAULT_HOURLY = 600;
const DEFAULT_MINUTE = 120;
const DEFAULT_MAX_DOCUMENTS = 2000;

function positiveInteger(raw, fallback) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const hourlyLimit = () => positiveInteger(process.env.UPLOAD_HOURLY_LIMIT, DEFAULT_HOURLY);
const minuteLimit = () => positiveInteger(process.env.UPLOAD_MINUTE_LIMIT, DEFAULT_MINUTE);
const maxDocuments = () => positiveInteger(process.env.MAX_DOCUMENTS_PER_ACCOUNT, DEFAULT_MAX_DOCUMENTS);

const perAccountKey = (req) => (req.userId ? String(req.userId) : null);
const TOO_MANY = 'Too many uploads at once. Please try again shortly.';

const uploadMinuteLimit = createRateLimiter({ name: 'docs-upload-minute', max: minuteLimit, windowMs: 60 * 1000, keyFn: perAccountKey, code: 'UPLOAD_RATE_LIMITED', message: TOO_MANY });
const uploadHourLimit = createRateLimiter({ name: 'docs-upload-hour', max: hourlyLimit, windowMs: 60 * 60 * 1000, keyFn: perAccountKey, code: 'UPLOAD_RATE_LIMITED', message: TOO_MANY });

/** The two speed limits, in order: the burst cap first, then the hour. */
const uploadRateLimit = [uploadMinuteLimit, uploadHourLimit];

/** The plain sentence the person sees when the document cap is reached. */
const documentLimitMessage = (cap) => `You have reached the limit of ${cap} files. Delete some files or empty the Trash.`;

/**
 * Throws a 409 DOCUMENT_LIMIT error when the account already holds the cap. One indexed count ({ userId } uses the
 * { userId, ... } indexes of the Document model), stopped at the cap so it never walks more than that many index entries.
 */
async function assertRoomForDocument(userId) {
  const cap = maxDocuments();
  const held = await Document.countDocuments({ userId }, { limit: cap });
  if (held < cap) return;
  logSecurity('document_limit', { bucket: 'documents', count: cap, subject: String(userId) });
  const error = new Error(documentLimitMessage(cap));
  error.status = 409;
  error.code = 'DOCUMENT_LIMIT';
  throw error;
}

module.exports = { uploadRateLimit, assertRoomForDocument, documentLimitMessage, hourlyLimit, minuteLimit, maxDocuments, positiveInteger };
