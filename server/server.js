require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');

const connectDB = require('./config/db');
const { isDatabaseReachable } = require('./config/db');
const { assertProductionConfig } = require('./utils/productionConfig');
const corsOptions = require('./config/cors');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { assertPublicAppUrlConfig, describePublicAppUrl } = require('./utils/publicAppUrl');
const { assertOtpConfig, otpEnabled, otpTtlMinutes } = require('./utils/otpConfig');

const authRoutes = require('./routes/auth.routes');
const documentsRoutes = require('./routes/documents.routes');
const removedRoutes = require('./routes/removed.routes');
const securityRoutes = require('./routes/security.routes');
const insightsRoutes = require('./routes/insights.routes');
const { documentSharesRoutes, shareTokenRoutes } = require('./routes/shares.routes');
const sharedViewRoutes = require('./routes/sharedView.routes');
const accountRoutes = require('./routes/account.routes');
const trashRoutes = require('./routes/trash.routes');
const cronRoutes = require('./routes/cron.routes');
const { publicRouter: emergencyPublicRoutes, ownerRouter: emergencyOwnerRoutes } = require('./routes/emergency.routes');
const { assertEmergencyConfig } = require('./utils/emergency/config');

const app = express();

// In production, refuse to start unless every setting that matters is present
// and valid. Reports variable NAMES only, never values.
assertProductionConfig();

// Fail at startup, not on the first share, if PUBLIC_APP_URL is missing in
// production or malformed anywhere (https origin only: no path, no userinfo).
assertPublicAppUrlConfig();
// The emailed login code cannot be turned off in production, and its lifetime
// must be a sane number: refuse to start otherwise.
assertOtpConfig();
// EMERGENCY_CLAIM_DAYS must be sane; EMERGENCY_DEMO_MODE on a production deployment is warned about.
assertEmergencyConfig();

// Fired at module load (not inside the require.main guard below) so a
// Vercel serverless instance starts warming up its connection the moment
// this module is first required, not only once a request arrives. Local
// dev awaits this same promise explicitly before calling .listen() - see
// the bottom of this file - so a misconfigured/unreachable Atlas cluster
// still fails loudly there.
// The rejection is handled per request (see the gate below); catching it here
// only stops a failed first attempt from being an unhandled rejection.
connectDB().catch(() => {});

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
// configured here: nothing needs one.
app.use(helmet());
app.use(cors(corsOptions));
// Vercel caps request AND response bodies at 4.5MB. Documents are sent as
// multipart (4MB file cap, see routes/documents.routes.js and sync.routes.js),
// never as base64 in JSON, so every JSON body in this app is tiny: 100kb is
// generous, and a larger one is rejected with a clean 413.
app.use(express.json({ limit: '100kb' }));
// NoSQL operator-injection guard: strips keys starting with "$" (or containing
// ".") from req.body, req.query and req.params before any route sees them, so
// {"$ne": null} in place of a string can never reach a Mongoose filter. It
// has to sit after express.json (it sanitizes the PARSED body) and before the
// routes. Multipart fields are parsed later, by multer inside the document
// upload route, so that handler type-checks its own fields. Every handler
// that takes user input also checks its expected type explicitly - see the
// typeof checks in the controllers - as a second layer behind this one.
app.use(mongoSanitize());

// Nothing under /api may be cached by the browser, a proxy or the CDN: it is
// all per-account, session-gated data.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Liveness plus database reachability. No version, no host, no error text.
app.get('/api/health', async (req, res) => {
  const database = await isDatabaseReachable();
  res.status(database ? 200 : 503).json({
    success: database,
    status: database ? 'ok' : 'degraded',
    database: database ? 'reachable' : 'unreachable',
  });
});

// Every other route needs the database. Wait for the (cached) connection once
// per instance instead of leaning on Mongoose's command buffering, and answer a
// clean 503 when Atlas cannot be reached.
app.use('/api', async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch {
    res.status(503).json({ success: false, error: { message: 'The service is temporarily unavailable. Please try again.' } });
  }
});

// Removed features answer 410 (before the real routers, so nothing else handles them).
app.use('/api', removedRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/documents', documentSharesRoutes);
app.use('/api/shares', shareTokenRoutes);
// Deliberately mounted with no requireSession anywhere in its chain -
// see routes/sharedView.routes.js.
app.use('/api/shared', sharedViewRoutes);
app.use('/api/account', accountRoutes);
// Emergency Access: the contact's endpoints have no session (public router first), the owner's need a normal one.
app.use('/api/emergency/public', emergencyPublicRoutes);
app.use('/api/emergency', emergencyOwnerRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/trash', trashRoutes);
app.use('/api/cron', cronRoutes);

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
  // mkcert-generated cert (scripts/ensure-cert.js): localhost and 127.0.0.1,
  // plus any hosts listed in DEV_CERT_HOSTS. To try a real phone on the local
  // network, use the deployed HTTPS URL instead (see DEPLOY.md).
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

      });
    })
    .catch(() => {
      // connectDB() already logged the reason.
      process.exit(1);
    });
}
