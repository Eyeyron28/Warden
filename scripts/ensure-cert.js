#!/usr/bin/env node
// Runs automatically before every `npm run dev` (see the root package.json
// "predev" script). Keeps certs/localhost+3.pem valid for localhost, 127.0.0.1
// and any extra hosts listed (comma separated) in DEV_CERT_HOSTS. Nothing is
// detected from the network: to open the dev site from another device, list its
// address in DEV_CERT_HOSTS; to try a real phone, use the deployed HTTPS URL.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const forge = require('node-forge');

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
  const wanted = (process.env.DEV_CERT_HOSTS || '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z0-9.:-]+$/.test(name));
  if (wanted.length === 0) return;

  const existingSans = readExistingSans();
  if (existingSans !== null && wanted.every((name) => existingSans.includes(name))) return;

  if (!mkcertAvailable()) {
    console.error(
      '[ensure-cert] DEV_CERT_HOSTS lists hosts the current certificate does not cover, but mkcert is not ' +
        'installed (or not on PATH). Install mkcert (https://github.com/FiloSottile/mkcert) and run `npm run dev` ' +
        'again; continuing with the existing certificate, which will show a browser warning on those hosts.'
    );
    return;
  }

  const names = Array.from(new Set([...(existingSans ?? BASE_NAMES), ...BASE_NAMES, ...wanted]));
  if (regenerateCert(names)) console.log(`[ensure-cert] Certificate updated to include ${wanted.join(', ')}`);
}

main();
