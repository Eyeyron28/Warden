import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(src, 'components/Sidebar.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

let render;
test.before(async () => {
  const entry = `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import Sidebar from './components/Sidebar.jsx';
    export const render = (props, at = '/files') =>
      renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [at] }, createElement(Sidebar, { onClose: () => {}, onToggleCollapsed: () => {}, version: 0, ...props })));`;
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: src, loader: 'jsx' },
    bundle: true,
    write: false,
    outdir: 'out',
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.module.css': 'local-css', '.css': 'css' },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    logLevel: 'silent',
  });
  const js = built.outputFiles.find((file) => file.path.endsWith('.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-sidebar-'));
  const file = path.join(dir, 'sidebar.cjs');
  fs.writeFileSync(file, js.text);
  render = createRequire(import.meta.url)(file).render;
  fs.rmSync(dir, { recursive: true, force: true });
});

const ORDER = [
  ['/files', 'My files'],
  ['/photos', 'Photos'],
  ['/recent', 'Recent'],
  ['/starred', 'Starred'],
  ['/shared', 'Shared'],
  ['/overview', 'Overview'],
  ['/devices', 'Devices &amp; activity'],
  ['/export', 'Export / Import'],
  ['/emergency-access', 'Emergency Access'],
  ['/quarantine', 'Quarantine'],
  ['/trash', 'Trash'],
  ['/account', 'Account'],
];
const links = (html) => [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>[\s\S]*?<span class="[^"]*">([^<]+)<\/span><\/a>/g)].map((m) => [m[1], m[2]]);
const groups = (html) => [...html.matchAll(/role="group" aria-labelledby="([^"]+)"[^>]*data-group="([^"]+)"/g)].map((m) => ({ id: m[1], name: m[2] }));

for (const [label, props] of [
  ['expanded', {}],
  ['collapsed (icon rail)', { collapsed: true }],
  ['drawer (phone and tablet)', { drawer: true, open: true }],
]) {
  test(`${label}: the same items in the same order, each to the same path, with Account last`, () => {
    const html = render(props);
    assert.deepEqual(links(html), ORDER);
    assert.deepEqual(groups(html).map((g) => g.name), ['Main', 'Management', 'System']);
    for (const group of groups(html)) assert.match(html, new RegExp(`<span id="${group.id}" class="[^"]*">${group.name}</span>`), 'each group is named by its label');
    assert.equal((html.match(/<nav /g) || []).length, 1, 'one nav landmark');
    const footer = html.indexOf('data-testid="sidebar-footer"');
    assert.ok(footer > html.indexOf('href="/trash"'), 'the footer comes after Trash');
    assert.equal(html.slice(footer).match(/href="([^"]+)"/)[1], '/account');
    assert.doesNotMatch(html.slice(footer), /role="group"/, 'the footer has no label');
  });
}

test('Trash is the last item of System, after Emergency Access and Quarantine; Overview, Devices and Export / Import are Management', () => {
  const html = render({});
  const system = html.slice(html.indexOf('data-group="System"'), html.indexOf('data-testid="sidebar-footer"'));
  assert.deepEqual([...system.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ['/emergency-access', '/quarantine', '/trash']);
  const management = html.slice(html.indexOf('data-group="Management"'), html.indexOf('data-group="System"'));
  assert.deepEqual([...management.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ['/overview', '/devices', '/export']);
});

test('the rail keeps names for screen readers (labels hidden visually) and the folder tree toggle is gone; expanded shows it', () => {
  const rail = render({ collapsed: true });
  assert.match(rail, /class="[^"]*groupLabelRail[^"]*">Main</);
  assert.match(rail, /class="[^"]*srOnly[^"]*">My files</);
  assert.doesNotMatch(rail, /Collapse folders/);
  assert.match(render({}), /aria-label="Collapse folders"/);
});

test('the active page is highlighted', () => {
  assert.match(render({}, '/trash'), /<a aria-current="page" class="[^"]*itemActive[^"]*" href="\/trash"/);
});

test('styles: the middle scrolls, the footer is pinned, small uppercase labels, rail dividers, 44 px tap targets, tokens only', () => {
  assert.match(css, /\.nav \{[^}]*overflow: hidden;/);
  assert.match(css, /\.scroll \{[^}]*flex: 1;[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  assert.match(css, /\.footer \{[^}]*flex-shrink: 0;/);
  assert.match(css, /\.groupLabel \{[^}]*text-transform: uppercase;/);
  assert.match(css, /\.rail \.navGroup \+ \.navGroup \{[^}]*border-top: 1px solid var\(--color-border\);/);
  assert.match(css, /\.item \{[^}]*min-height: 46px;/);
  assert.match(css, /\(pointer: fine\)[\s\S]*\.item \{[^}]*min-height: clamp\(/);
  const added = css.slice(css.indexOf('.scroll {'), css.indexOf('.footer {') + 200);
  assert.doesNotMatch(added, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});
