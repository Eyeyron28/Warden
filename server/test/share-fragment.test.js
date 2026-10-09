// Run with: cd server && npm test
//
// The share key lives after the # in a link. Browsers never send a fragment, and nothing on the
// server may log, parse or store it. These tests pin that down.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const net = require('node:net');

const root = path.join(__dirname, '..');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sources = () => {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'test'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push([path.relative(root, full).replace(/\\/g, '/'), strip(fs.readFileSync(full, 'utf8'))]);
    }
  };
  walk(root);
  return out;
};

test('no request logging, and no code reads a URL fragment or parses the #k= part of an address', () => {
  for (const [name, text] of sources()) {
    assert.doesNotMatch(text, /require\(['"]morgan['"]\)|app\.use\(morgan/, `${name}: no access log middleware`);
    assert.doesNotMatch(text, /console\.(log|info|warn|error)\([^)]*\b(req\.(url|originalUrl|path|headers|body|query|params))/, `${name}: never logs a request`);
    assert.doesNotMatch(text, /location\.hash|\breq\.[\w.]*hash|new URL\(req\./, `${name}: no fragment handling`);
  }
  // the only place the key appears in a link is when the owner's share is created, in the response to that owner
  const withKey = sources().filter(([, text]) => /#k=/.test(text)).map(([name]) => name);
  assert.deepEqual(withKey, ['controllers/shares.controller.js']);
});

test('a request that carries a fragment-looking path is just an unknown route: it is not logged, stored or echoed beyond the 404', async () => {
  // Real clients strip the fragment before sending. If a raw client sends one anyway, the server treats it as ordinary path text.
  const express = require('express');
  const { notFound, errorHandler } = require('../middleware/errorHandler');
  const app = express();
  const logged = [];
  const original = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  app.use(notFound);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const key = 'A'.repeat(43);
    // a standards-following client (fetch) drops the fragment before it sends the request line
    let seenByServer = null;
    const probe = net.createServer((socket) => {
      socket.once('data', (buffer) => {
        seenByServer = buffer.toString('latin1').split('\r\n')[0];
        socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
      });
    });
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    await fetch(`http://127.0.0.1:${probe.address().port}/shared/0123456789abcdef#k=${key}`);
    probe.close();
    assert.equal(seenByServer, 'GET /shared/0123456789abcdef HTTP/1.1', 'the fragment never leaves the browser');
    assert.ok(!seenByServer.includes(key));

    const response = await fetch(`http://127.0.0.1:${port}/api/shared/0123456789abcdef#k=${key}`);
    assert.equal(response.status, 404);
    assert.ok(!(await response.text()).includes(key));
    assert.equal(logged.length, 0, 'nothing was logged');
  } finally {
    console.log = original;
    server.close();
  }
});
