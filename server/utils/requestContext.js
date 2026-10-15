const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('crypto');

/**
 * One short id per request, available anywhere below it (even deep inside a helper that never sees `req`), so a log line
 * written while handling a request can be matched with the "[request ...]" line of a failure or with another event of the
 * same request. It is random, not derived from anything about the caller.
 */
const store = new AsyncLocalStorage();

function requestContext(req, res, next) {
  store.run({ requestId: crypto.randomBytes(6).toString('hex') }, next);
}

const currentRequestId = () => store.getStore()?.requestId || null;

module.exports = { requestContext, currentRequestId };
