#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const forge = require('node-forge');

const CERTS_DIR = path.join(__dirname, '..', 'certs');
const CERT_PATH = path.join(CERTS_DIR, 'localhost+3.pem');
const KEY_PATH = path.join(CERTS_DIR, 'localhost+3-key.pem');

const BASE_NAMES = ['localhost', '127.0.0.1'];

function readExistingSans() {
  if (!fs.existsSync(CERT_PATH)) return null;

  const pem = fs.readFileSync(CERT_PATH, 'utf8');
  const cert = forge.pki.certificateFromPem(pem);
  const sanExtension = cert.getExtension('subjectAltName');
  if (!sanExtension) return [];

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
