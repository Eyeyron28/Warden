const Document = require('../models/Document');
const createRateLimiter = require('../middleware/rateLimit');
const { logSecurity } = require('./securityLog');

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

const uploadRateLimit = [uploadMinuteLimit, uploadHourLimit];

const documentLimitMessage = (cap) => `You have reached the limit of ${cap} files. Delete some files or empty the Trash.`;

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
