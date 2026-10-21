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
const { requestContext } = require('./utils/requestContext');
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
const quarantineRoutes = require('./routes/quarantine.routes');
const cronRoutes = require('./routes/cron.routes');
const contactRoutes = require('./routes/contact.routes');
const { publicRouter: emergencyPublicRoutes, ownerRouter: emergencyOwnerRoutes } = require('./routes/emergency.routes');
const { assertEmergencyConfig } = require('./utils/emergency/config');
const { mailFromWarning } = require('./utils/email');

const app = express();

assertProductionConfig();

assertPublicAppUrlConfig();
assertOtpConfig();
assertEmergencyConfig();
{
  const warning = mailFromWarning();
  if (warning) console.warn(warning);
}

connectDB().catch(() => {});

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

app.set('trust proxy', trustProxyHops());

app.use(requestContext);
app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: '100kb' }));
app.use(mongoSanitize());

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/api/health', async (req, res) => {
  const database = await isDatabaseReachable();
  res.status(database ? 200 : 503).json({
    success: database,
    status: database ? 'ok' : 'degraded',
    database: database ? 'reachable' : 'unreachable',
  });
});

app.use('/api', async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch {
    res.status(503).json({ success: false, error: { message: 'The service is temporarily unavailable. Please try again.' } });
  }
});

app.use('/api', removedRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/documents', documentSharesRoutes);
app.use('/api/shares', shareTokenRoutes);
app.use('/api/shared', sharedViewRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/emergency/public', emergencyPublicRoutes);
app.use('/api/emergency', emergencyOwnerRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/trash', trashRoutes);
app.use('/api/quarantine', quarantineRoutes);
app.use('/api/cron', cronRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

module.exports = app;

if (require.main === module) {
  const httpsOptions = {
    key: fs.readFileSync(path.join(__dirname, '..', 'certs', 'localhost+3-key.pem')),
    cert: fs.readFileSync(path.join(__dirname, '..', 'certs', 'localhost+3.pem')),
  };

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
      process.exit(1);
    });
}
