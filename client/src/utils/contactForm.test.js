import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { contactFailureMessage } from '../services/contactService.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');

test('the contact form sends through the server and never opens an email app', () => {
  const form = read('pages/public/ContactSection.jsx');
  assert.doesNotMatch(form, /window\.location|buildMailto|mailto:\$\{CONTACT_EMAIL\}\?/);
  assert.doesNotMatch(form, /Open in my email app|Opens your own email app/);
  assert.match(form, /Send message/);
  assert.match(form, /sendContactMessage\(values\)/);
  assert.match(read('services/contactService.js'), /api\.post\('\/contact'/);
});

test('the form has a sending state, a success state that clears the fields, and an error state with a retry', () => {
  const form = read('pages/public/ContactSection.jsx');
  assert.match(form, /setStatus\('sending'\)/);
  assert.match(form, /Sending…/);
  assert.match(form, /disabled=\{status === 'sending'\}/);
  assert.match(form, /Message sent\./);
  assert.match(form, /We read everything; replies may take a few days\./);
  assert.match(form, /sendContactMessage\(values\);\s*setValues\(\{ name: '', email: '', message: '', website: '' \}\)/);
  assert.match(form, /status === 'error' \? 'Try again'/);
  assert.match(form, /role="alert"/);
});

test('the address on the page is the new one, and the counter matches the server limit', () => {
  assert.match(read('config.js'), /CONTACT_EMAIL = 'warden\.vault\.app@gmail\.com'/);
  assert.match(read('pages/public/ContactSection.jsx'), /const MESSAGE_MAX = 2000;/);
});

test('each way the request can fail gets its own plain message', () => {
  assert.match(contactFailureMessage({ response: { status: 429 } }), /Too many messages/);
  assert.equal(contactFailureMessage({ response: { status: 400, data: { error: { message: 'That email address doesn’t look right.' } } } }), 'That email address doesn’t look right.');
  assert.match(contactFailureMessage({}), /couldn’t reach the server/);
  assert.match(contactFailureMessage({ response: { status: 502 } }), /could not be sent/);
});
