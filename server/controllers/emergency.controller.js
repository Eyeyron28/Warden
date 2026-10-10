const service = require('../utils/emergency/service');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

const text = (value, max = 500) => (typeof value === 'string' && value.length <= max ? value : '');
const codeBody = (body) => ({ challengeToken: text(body?.challengeToken, 200), code: text(body?.code, 20) });

// ---------------- the owner (a signed-in, normal session; emergency sessions are refused by the guard) ----------------

/** POST /api/emergency/challenge { action } - emails the owner the fresh code needed for ONE kind of change. */
const startCode = asyncHandler(async (req, res) => {
  const action = text(req.body?.action, 30);
  if (!service.ACTIONS.includes(action)) throw badRequest('Choose what you want to change.');
  res.status(200).json(await service.startOwnerCode(req, action));
});

const resendCode = asyncHandler(async (req, res) => {
  res.status(200).json(await service.resendOwnerCode(req, text(req.body?.challengeToken, 200)));
});

/** POST /api/emergency/setup - the kit comes back ONCE in this response and is stored nowhere. */
const setup = asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json(await service.setup(req, req.body || {}, codeBody(req.body)));
});

const regenerateKit = asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(await service.regenerateKit(req, codeBody(req.body)));
});

const revoke = asyncHandler(async (req, res) => {
  res.status(200).json(await service.revoke(req, codeBody(req.body)));
});

const status = asyncHandler(async (req, res) => {
  res.status(200).json(await service.status(req));
});

const denyRequest = asyncHandler(async (req, res) => {
  res.status(200).json(await service.ownerDeny(req, req.params.id));
});

const approveNow = asyncHandler(async (req, res) => {
  res.status(200).json(await service.approveNow(req, req.params.id, codeBody(req.body)));
});

// ---------------- the contact (public: no account, same answers whoever asks) ----------------

const contactFields = (body) => ({
  ownerEmail: text(body?.ownerEmail, 254),
  contactEmail: text(body?.contactEmail, 254),
  code: text(body?.code, 20),
  kit: text(body?.kit, 200),
});

/** POST /api/emergency/public/request-code - ALWAYS the same message. */
const requestCode = asyncHandler(async (req, res) => {
  const { ownerEmail, contactEmail } = contactFields(req.body);
  res.status(200).json(await service.requestCode({ ownerEmail, contactEmail }));
});

const request = asyncHandler(async (req, res) => {
  res.status(201).json(await service.submitRequest({ ...contactFields(req.body), req }));
});

const startSession = asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(await service.startSession({ ...contactFields(req.body), req }));
});

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Warden</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:48px 20px;background:#f6f2f4;color:#21181f}main{max-width:480px;margin:0 auto;background:#fff;border:1px solid #e3dbe0;border-radius:12px;padding:28px}h1{font-size:20px;margin:0 0 12px}p{line-height:1.6;margin:0}</style></head><body><main><h1>Thank you</h1><p>If that link was still valid, the request has been denied and nobody was given access. You can close this page.</p></main></body></html>`;

/** GET /api/emergency/public/deny/:token - one click from the owner's email. One generic page whatever happened. */
const denyByToken = asyncHandler(async (req, res) => {
  await service.denyByToken(req.params.token);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  res.status(200).send(PAGE);
});

module.exports = { startCode, resendCode, setup, regenerateKit, revoke, status, denyRequest, approveNow, requestCode, request, startSession, denyByToken };
