import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitNamedTitle } from './namedTitle.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');

test('the search bar shows on My Files and on none of the other app pages', () => {
  // The same test AppLayout uses, applied to each route.
  const layout = read('components/AppLayout.jsx');
  const rule = /const onFilesPage = location\.pathname === '([^']+)';/.exec(layout);
  assert.ok(rule, 'the search bar is gated by one route test');
  const shows = (route) => route === rule[1];
  assert.equal(shows('/files'), true);
  for (const route of ['/overview', '/quarantine', '/emergency-access', '/account', '/devices', '/export', '/shared', '/trash']) {
    assert.equal(shows(route), false, route);
  }
  assert.match(read('components/AppLayout.jsx'), /showSearch=\{onFilesPage\}/);
  assert.match(read('components/Header.jsx'), /\{showSearch && \(/);
});

test('the shared banner has a Dismiss button only when onDismiss is given, and the click calls it', () => {
  const banner = read('components/Banner.jsx');
  assert.match(banner, /if \(!onDismiss\) return/);
  assert.match(banner, /<button type="button" className=\{styles\.close\} aria-label="Dismiss" onClick=\{onDismiss\}>/);
  // The pages that own the message clear it, so the same action can show it again.
  assert.match(read('pages/FilesPage.jsx'), /onDismiss=\{\(\) => setActionError\(''\)\}/);
  assert.match(read('pages/TrashPage.jsx'), /onDismiss=\{\(\) => setError\(''\)\}/);
});

test('the Share folder title is plain text with straight quotes, the name in one plain element', () => {
  const title = 'Share folder "Passport"';
  assert.deepEqual(splitNamedTitle(title), { before: 'Share folder "', name: 'Passport', after: '"' });
  assert.doesNotMatch(read('pages/FilesPage.jsx') + read('components/Modal.jsx'), /„|“.*Share folder|&bdquo;|<q>/);
  const modal = read('components/Modal.jsx');
  assert.match(modal, /<span className=\{styles\.titleName\}>\{named\.name\}<\/span>/);
  assert.doesNotMatch(modal, /FileNameLabel/);
});

test('the wide app pages do not keep a narrow max-width', () => {
  for (const file of ['pages/QuarantinePage.module.css', 'pages/OverviewPage.module.css', 'pages/DevicesPage.module.css', 'pages/ExportPage.module.css', 'components/emergency/emergency.module.css']) {
    const page = /\.page \{[^}]*\}/.exec(read(file))?.[0] ?? '';
    assert.doesNotMatch(page, /max-width/, file);
  }
});
