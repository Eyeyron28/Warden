const scanner = require('./fileScanner');
const { NOT_HELD } = require('./quarantineFilter');

const { describeReasons, SCANNER_VERSION } = scanner;
const { logSecurity } = require('./securityLog');
const { recordEvent } = require('./audit');

/**
 * Quarantine, the rules around the scanner (utils/fileScanner.js).
 *
 * A "held" document is stored encrypted like any other, but is isolated: every list, count, search, preview, thumbnail, download,
 * share and export leaves it out until its owner releases it. A document without a `quarantine` field (everything uploaded before
 * this existed) is not held, so the filter below matches it.
 */


const isHeld = (document) => document?.quarantine?.state === 'held';

function quarantinedError() {
  const error = new Error('This file is held in Quarantine. Release it first if you want to open, download or share it.');
  error.status = 409;
  error.code = 'QUARANTINED';
  return error;
}

/** Throws 409 QUARANTINED for a held document. */
function assertNotHeld(document) {
  if (isHeld(document)) throw quarantinedError();
}

function blockedError(reasons) {
  const error = new Error('This file was not saved: it matches a rule that Warden refuses outright.');
  error.status = 422;
  error.code = 'FILE_BLOCKED';
  error.reasons = describeReasons(reasons);
  return error;
}

/**
 * Scans one upload, never failing it because the scanner failed.
 * @returns {{ verdict: 'clean' | 'suspicious' | 'blocked' | 'unchecked', reasons: string[], score: number, version: number }}
 */
function safeScan({ name, type, buffer }) {
  try {
    return scanner.scanBuffer({ name, type, buffer });
  } catch (error) {
    // One line, no name, no content: just that it happened.
    logSecurity('scan_error', { bucket: String(error?.name || 'Error').slice(0, 40) });
    return { verdict: 'unchecked', reasons: ['SCAN_ERROR'], score: 0, version: SCANNER_VERSION };
  }
}

/** The fields a stored document carries for a scan result. */
function scanFields(result, now = new Date()) {
  const held = result.verdict === 'suspicious';
  return {
    scan: { verdict: result.verdict, reasons: result.reasons, scannerVersion: result.version, scannedAt: now },
    ...(held ? { quarantine: { state: 'held', heldAt: now } } : {}),
  };
}

const codesOf = (reasons) => (Array.isArray(reasons) ? reasons.join(',') : '');

const USE_IMPORT_MESSAGE = 'Zip files go through Export / Import, so every file inside is checked. Use Export / Import to add this zip.';

/** A plain zip is refused before anything is encrypted or stored (422 USE_IMPORT). Audit and security log: the reason code only. */
async function refuseZip(req) {
  logSecurity('file_refused', { bucket: 'PLAIN_ZIP' });
  await recordEvent(req, 'file_refused', { detail: 'PLAIN_ZIP' });
  const error = new Error(USE_IMPORT_MESSAGE);
  error.status = 422;
  error.code = 'USE_IMPORT';
  error.reasons = describeReasons(['PLAIN_ZIP']);
  return error;
}

/** Records a refusal (audit + security log, codes only) and returns the error to throw. */
async function refuse(req, result) {
  logSecurity('file_refused', { bucket: codesOf(result.reasons) });
  await recordEvent(req, 'file_refused', { detail: codesOf(result.reasons) });
  return blockedError(result.reasons);
}

/** The audit and security-log lines for a file that was held. */
async function noteHeld(req, document, result) {
  logSecurity('file_held', { bucket: codesOf(result.reasons) });
  await recordEvent(req, 'file_held', { targetId: document._id, detail: codesOf(result.reasons) });
}

module.exports = { refuseZip, USE_IMPORT_MESSAGE, NOT_HELD, isHeld, assertNotHeld, quarantinedError, blockedError, safeScan, scanFields, refuse, noteHeld, codesOf };
