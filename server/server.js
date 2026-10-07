require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');

const connectDB = require('./config/db');
const corsOptions = require('./config/cors');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { detectLanIp } = require('./utils/lanIp');
const { assertPublicAppUrlConfig, describePublicAppUrl } = require('./utils/publicAppUrl');
const { assertOtpConfig, otpEnabled, otpTtlMinutes } = require('./utils/otpConfig');

const authRoutes = require('./routes/auth.routes');
const documentsRoutes = require('./routes/documents.routes');
const syncRoutes = require('./routes/sync.routes');
const backupRoutes = require('./routes/backup.routes');
const { documentSharesRoutes, shareTokenRoutes } = require('./routes/shares.routes');
const sharedViewRoutes = require('./routes/sharedView.routes');
const pairingRoutes = require('./routes/pairing.routes');
const pairCompleteRoutes = require('./routes/pairComplete.routes');
const devicesRoutes = require('./routes/devices.routes');
const accountRoutes = require('./routes/account.routes');

const app = express();

// Fail at startup, not on the first share, if PUBLIC_APP_URL is missing in
// production or malformed anywhere (https origin only: no path, no userinfo).
assertPublicAppUrlConfig();
// The emailed login code cannot be turned off in production, and its lifetime
// must be a sane number: refuse to start otherwise.
assertOtpConfig();

// Fired at module load (not inside the require.main guard below) so a
// Vercel serverless instance starts warming up its connection the moment
// this module is first required, not only once a request arrives. Local
// dev awaits this same promise explicitly before calling .listen() - see
// the bottom of this file - so a misconfigured/unreachable Atlas cluster
// still fails loudly there.
connectDB();

// How many reverse proxies sit in front of this app and set
// X-Forwarded-For. This must match reality in BOTH directions:
//   - too low behind a proxy: req.ip is the proxy's address, so every
//     visitor shares one rate-limit bucket;
//   - too high (or any trust at all) with NO proxy: a client can send its
//     own X-Forwarded-For and Express believes it, so a client chooses the
//     IP that every per-IP rate limit keys on and can dodge all of them.
// So: 1 on Vercel (its edge proxy is the single hop, and it sets the header
// itself), 0 everywhere else - local dev, where mkcert's https.createServer
// is reached directly. TRUST_PROXY_HOPS overrides this for another
// deployment (e.g. 1 behind nginx, 2 behind a CDN plus nginx).
function trustProxyHops() {
  const configured = process.env.TRUST_PROXY_HOPS;
  if (configured !== undefined && configured !== '') {
    const hops = Number(configured);
    if (!Number.isInteger(hops) || hops < 0 || hops > 5) {
      throw new Error('TRUST_PROXY_HOPS must be a whole number from 0 to 5.');
    }
    return hops;
  }
  return process.env.VERCEL ? 1 : 0;
}

// A hop COUNT (not `true`) trusts only that many proxies from the right of
// X-Forwarded-For, so entries a client prepended are ignored.
app.set('trust proxy', trustProxyHops());

// Standard security headers (X-Content-Type-Options, X-Frame-Options,
// removing X-Powered-By, CSP, etc), on defaults. First in the chain so even
// requests CORS goes on to reject carry them. Helmet only sets response
// headers - it doesn't touch the CORS handshake below. No origin or IP is
// configured here: nothing needs one, and this PC's LAN address changes
// between networks (see utils/lanIp.js).
app.use(helmet());
app.use(cors(corsOptions));
// Vercel Hobby caps request bodies at 4.5MB, and documents.routes.js now
// caps a single upload at 4MB (see MAX_FILE_SIZE_BYTES there) to stay
// under that with room for the surrounding multipart overhead. This
// limit covers the OTHER body-heavy path, POST /api/sync/push, which
// receives an encrypted document as base64 inside a JSON body - base64
// inflates raw bytes by ~4/3, so a 4MB document arrives as roughly 5.3MB
// of base64 alone. 6mb covers that with headroom while still rejecting a
// genuinely oversized body with a clean 413 (via this same errorHandler)
// rather than accepting anything without limit. Applied globally rather
// than scoped per-route since every other JSON body in this app (auth,
// document metadata edits, share/pairing/device actions) is tiny by
// comparison and a 6mb ceiling on them is generous, not risky.
app.use(express.json({ limit: '6mb' }));
// NoSQL operator-injection guard: strips keys starting with "$" (or containing
// ".") from req.body, req.query and req.params before any route sees them, so
// {"$ne": null} in place of a string can never reach a Mongoose filter. It
// has to sit after express.json (it sanitizes the PARSED body) and before the
// routes. Multipart fields are parsed later, by multer inside the document
// upload route, so that handler type-checks its own fields. Every handler
// that takes user input also checks its expected type explicitly - see the
// typeof checks in the controllers - as a second layer behind this one.
app.use(mongoSanitize());

app.get('/api/health', (req, res) => {
  res.status(200).json({ success: true, status: 'ok' });
});

app.use('/api/auth', authRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/documents', documentSharesRoutes);
app.use('/api/shares', shareTokenRoutes);
// Deliberately mounted with no requireSession anywhere in its chain -
// see routes/sharedView.routes.js.
app.use('/api/shared', sharedViewRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/pair', pairingRoutes);
// Deliberately mounted with no requireSession anywhere in its chain -
// see routes/pairComplete.routes.js.
app.use('/api/pair', pairCompleteRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/account', accountRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

// Exported unconditionally so a Vercel serverless entry point (api/
// index.js at the repo root) can require this same app without this file
// ever calling .listen() itself under that runtime - Vercel's own
// platform terminates TLS and invokes the exported app per-request; it
// has no use for (and no filesystem access to) the mkcert certs below.
module.exports = app;

// Everything past this point - the local HTTPS dev server - only runs
// when this file is executed directly (`node server.js` / `npm run dev`
// via nodemon), never when required as a module (by a test, or by the
// Vercel entry point above).
if (require.main === module) {
  // mkcert-generated cert, valid only for the SANs it was issued with:
  // localhost, 127.0.0.1, 192.168.100.115, 10.58.146.172, 192.168.1.38
  // (added when the LAN IP changed after switching Wi-Fi networks - a
  // request to an IP outside this list fails TLS validation with
  // SEC_E_WRONG_PRINCIPAL/ERR_CERT_COMMON_NAME_INVALID, which then makes
  // GET /api/auth/me look "unreachable" to the frontend, even though the
  // account itself is untouched).
  //
  // Auto-detecting the LAN IP (utils/lanIp.js) fixes the frontend/pairing/
  // sharing side of this going stale on a network change, but it does NOT
  // fix certificate coverage - mkcert still only trusts the exact IPs
  // listed when it was generated. If a genuinely new IP is ever used,
  // regenerate with `mkcert -key-file localhost+3-key.pem -cert-file
  // localhost+3.pem localhost 127.0.0.1 <every LAN IP still in use, plus
  // the new one>` (run from certs/) and update CORS_ORIGINS to match.
  const httpsOptions = {
    key: fs.readFileSync(path.join(__dirname, '..', 'certs', 'localhost+3-key.pem')),
    cert: fs.readFileSync(path.join(__dirname, '..', 'certs', 'localhost+3.pem')),
  };

  // Local dev gets the explicit "fail loudly" behavior a standalone
  // process should have (process.exit(1) is wrong inside a serverless
  // invocation, which is why connectDB() itself no longer calls it - see
  // config/db.js) - awaited here, once, before the server starts
  // accepting connections at all.
  connectDB()
    .then(() => {
      https.createServer(httpsOptions, app).listen(PORT, () => {
        console.log(`Warden server running on port ${PORT} (https)`);
        console.log(describePublicAppUrl());
        console.log(
          otpEnabled()
            ? `Login: email one-time code required (expires after ${otpTtlMinutes()} min)`
            : 'Login: email one-time code is DISABLED (OTP_ENABLED=false, development only)'
        );

        // Diagnostic only - pairing/sharing resolve this fresh per-request
        // (resolveLanIp), not from this snapshot. Logged once here so a
        // stale network or an unexpected adapter pick is obvious from
        // startup output alone, without needing to trigger a pairing/
        // share request to check.
        if (process.env.LAN_IP) {
          console.log(`LAN IP: ${process.env.LAN_IP} (manual override via LAN_IP in .env)`);
        } else {
          const detected = detectLanIp();
          if (detected) {
            console.log(`LAN IP: ${detected.ip} (auto-detected, adapter: "${detected.adapter}")`);
          } else {
            console.log(
              'LAN IP: could not auto-detect one - phone pairing and network share links will fail until LAN_IP is set in .env.'
            );
          }
        }
      });
    })
    .catch(() => {
      // connectDB() already logged the reason.
      process.exit(1);
    });
}
