const scanner = require('./fileScanner');
const { NOT_HELD } = require('./quarantineFilter');

const { describeReasons, SCANNER_VERSION } = scanner;
const { logSecurity } = require('./securityLog');
const { recordEvent } = require('./audit');


const isHeld = (document) => document?.quarantine?.state === 'held';

function quarantinedError() {
  const error = new Error('This file is held in Quarantine. Release it first if you want to open, download or share it.');
  error.status = 409;
  error.code = 'QUARANTINED';
  return error;
}

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

function safeScan({ name, type, buffer }) {
  try {
    return scanner.scanBuffer({ name, type, buffer });
  } catch (error) {
    logSecurity('scan_error', { bucket: String(error?.name || 'Error').slice(0, 40) });
    return { verdict: 'unchecked', reasons: ['SCAN_ERROR'], score: 0, version: SCANNER_VERSION };
  }
}

function scanFields(result, now = new Date()) {
  const held = result.verdict === 'suspicious';
  return {
    scan: { verdict: result.verdict, reasons: result.reasons, scannerVersion: result.version, scannedAt: now },
    ...(held ? { quarantine: { state: 'held', heldAt: now } } : {}),
  };
}

const codesOf = (reasons) => (Array.isArray(reasons) ? reasons.join(',') : '');

const USE_IMPORT_MESSAGE = 'Zip files go through Export / Import, so every file inside is checked. Use Export / Import to add this zip.';

async function refuseZip(req) {
  logSecurity('file_refused', { bucket: 'PLAIN_ZIP' });
  await recordEvent(req, 'file_refused', { detail: 'PLAIN_ZIP' });
  const error = new Error(USE_IMPORT_MESSAGE);
  error.status = 422;
  error.code = 'USE_IMPORT';
  error.reasons = describeReasons(['PLAIN_ZIP']);
  return error;
}

async function refuse(req, result) {
  logSecurity('file_refused', { bucket: codesOf(result.reasons) });
  await recordEvent(req, 'file_refused', { detail: codesOf(result.reasons) });
  return blockedError(result.reasons);
}

async function noteHeld(req, document, result) {
  logSecurity('file_held', { bucket: codesOf(result.reasons) });
  await recordEvent(req, 'file_held', { targetId: document._id, detail: codesOf(result.reasons) });
}

module.exports = { refuseZip, USE_IMPORT_MESSAGE, NOT_HELD, isHeld, assertNotHeld, quarantinedError, blockedError, safeScan, scanFields, refuse, noteHeld, codesOf };
