#!/usr/bin/env node
// Runs automatically before every `npm run dev` (see the root package.json
// "predev" script). Keeps certs/localhost+3.pem valid for whatever network
// this PC is on right now, without anyone having to remember to re-run
// mkcert by hand after switching Wi-Fi networks or tethering to a phone -
// the exact failure mode documented in server/server.js's cert comment
// (a request to an IP outside the cert's SAN list fails TLS validation,
// which makes the frontend wrongly show first-run setup instead of
// unlock, even though the vault itself is fine).
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const forge = require('node-forge');

const { detectLanIp } = require('../server/utils/lanIp');

const CERTS_DIR = path.join(__dirname, '..', 'certs');
const CERT_PATH = path.join(CERTS_DIR, 'localhost+3.pem');
const KEY_PATH = path.join(CERTS_DIR, 'localhost+3-key.pem');

// Always present regardless of what's already in the cert - losing
// "localhost" or "127.0.0.1" from a regenerated cert would break the most
// common dev case (opening the app on the same machine it's running on).
const BASE_NAMES = ['localhost', '127.0.0.1'];

/**
 * Reads the existing cert (if any) and returns every Subject Alternative
 * Name it already covers - both DNS entries (e.g. "localhost") and IP
 * entries (e.g. "192.168.100.115") - as one flat list of strings, exactly
 * as mkcert itself takes them as arguments. Returns null if the cert
 * doesn't exist yet (first run, before any cert has ever been generated).
 */
function readExistingSans() {
  if (!fs.existsSync(CERT_PATH)) return null;

  const pem = fs.readFileSync(CERT_PATH, 'utf8');
  const cert = forge.pki.certificateFromPem(pem);
  const sanExtension = cert.getExtension('subjectAltName');
  if (!sanExtension) return [];

  // forge's parsed altNames: type 2 is a DNS name (in `.value`), type 7
  // is an IP address (forge additionally decodes the raw bytes into a
  // human-readable dotted-quad string in `.ip`).
  return sanExtension.altNames.map((entry) => (entry.type === 7 ? entry.ip : entry.value));
}

function mkcertAvailable() {
  const result = spawnSync('mkcert', ['-CAROOT'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function regenerateCert(names) {
  const args = ['-key-file', KEY_PATH, '-cert-file', CERT_PATH, ...names];
  const result = spawnSync('mkcert', args, { stdio: 'inherit' });

  if (result.error || result.status !== 0) {
    console.error(
      '[ensure-cert] mkcert failed to regenerate the certificate. ' +
        'HTTPS on the new address will show a certificate warning until this is fixed by hand:\n' +
        `  mkcert -key-file "${KEY_PATH}" -cert-file "${CERT_PATH}" ${names.join(' ')}`
    );
    return false;
  }
  return true;
}

function main() {
  const detected = detectLanIp();
  if (!detected) {
    // Nothing to ensure coverage for - not this script's problem to solve
    // (server.js already logs and fails loudly at request time if a LAN
    // address is genuinely needed and none can be found).
    return;
  }

  const existingSans = readExistingSans();

  if (existingSans !== null && existingSans.includes(detected.ip)) {
    // Already covered - exit quietly, no output, nothing to do.
    return;
  }

  if (!mkcertAvailable()) {
    console.error(
      `[ensure-cert] Detected LAN IP ${detected.ip} is not covered by the current certificate, ` +
        'but mkcert is not installed (or not on PATH), so it cannot be regenerated automatically. ' +
        'Install mkcert (https://github.com/FiloSottile/mkcert) and run `npm run dev` again, or ' +
        'regenerate the cert by hand - continuing with the existing certificate for now, which ' +
        `will show a browser warning on ${detected.ip}.`
    );
    return;
  }

  const namesToRequest = Array.from(
    new Set([...(existingSans ?? BASE_NAMES), ...BASE_NAMES, detected.ip])
  );

  const ok = regenerateCert(namesToRequest);
  if (ok) {
    console.log(`[ensure-cert] Certificate updated to include ${detected.ip}`);
  }
}

main();
