const dns = require('dns').promises;

const LOOKUP_TIMEOUT_MS = 3000;
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

class LookupTimeout extends Error {
  constructor() {
    super('DNS lookup timed out');
    this.code = 'ETIMEOUT';
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new LookupTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const CLEAR_NO = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

async function tryLookup(fn, domain, timeoutMs) {
  try {
    return { records: await withTimeout(fn(domain), timeoutMs) };
  } catch (err) {
    return { error: err };
  }
}

async function lookupDomain(domain, timeoutMs, state) {
  const mx = await tryLookup((d) => dns.resolveMx(d), domain, timeoutMs);
  if (mx.records) {
    if (mx.records.length === 0) return lookupAddresses(domain, timeoutMs, state);
    if (mx.records.every((record) => !record.exchange || record.exchange === '.')) return false;
    return true;
  }
  if (CLEAR_NO.has(mx.error?.code)) return lookupAddresses(domain, timeoutMs, state);
  state.flaky = true;
  return true;
}

async function lookupAddresses(domain, timeoutMs, state) {
  const a = await tryLookup((d) => dns.resolve4(d), domain, timeoutMs);
  if (a.records?.length) return true;
  if (a.error && !CLEAR_NO.has(a.error.code)) {
    state.flaky = true;
    return true;
  }
  const aaaa = await tryLookup((d) => dns.resolve6(d), domain, timeoutMs);
  if (aaaa.records?.length) return true;
  if (aaaa.error && !CLEAR_NO.has(aaaa.error.code)) {
    state.flaky = true;
    return true;
  }
  return false;
}

async function domainCanReceiveMail(address, { timeoutMs = LOOKUP_TIMEOUT_MS, now = Date.now() } = {}) {
  const domain = String(address).split('@')[1]?.toLowerCase();
  if (!domain) return false;
  const hit = cache.get(domain);
  if (hit && now - hit.at < CACHE_MS) return hit.ok;
  const state = { flaky: false };
  const ok = await lookupDomain(domain, timeoutMs, state);
  if (!state.flaky) {
    if (cache.size > 500) cache.clear();
    cache.set(domain, { at: now, ok });
  }
  return ok;
}

const forgetDomains = () => cache.clear();

module.exports = { domainCanReceiveMail, forgetDomains, LOOKUP_TIMEOUT_MS };
