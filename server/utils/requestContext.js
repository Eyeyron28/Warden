const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('crypto');

const store = new AsyncLocalStorage();

function requestContext(req, res, next) {
  store.run({ requestId: crypto.randomBytes(6).toString('hex') }, next);
}

const currentRequestId = () => store.getStore()?.requestId || null;

module.exports = { requestContext, currentRequestId };
