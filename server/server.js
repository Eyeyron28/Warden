require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const cors = require('cors');

const connectDB = require('./config/db');
const corsOptions = require('./config/cors');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth.routes');
const documentsRoutes = require('./routes/documents.routes');
const syncRoutes = require('./routes/sync.routes');
const backupRoutes = require('./routes/backup.routes');
const { documentSharesRoutes, shareTokenRoutes } = require('./routes/shares.routes');
const sharedViewRoutes = require('./routes/sharedView.routes');
const pairingRoutes = require('./routes/pairing.routes');
const pairCompleteRoutes = require('./routes/pairComplete.routes');
const devicesRoutes = require('./routes/devices.routes');

const app = express();

connectDB();

app.use(cors(corsOptions));
// Express's default JSON body limit (100kb) is far too small for
// POST /api/sync/push: it receives an entire encrypted document as base64
// inside the JSON body, and base64 inflates raw bytes by ~4/3. The PC
// upload route already caps a document at 20MB (MAX_FILE_SIZE_BYTES in
// documents.routes.js, enforced by multer - unaffected by this setting,
// which only applies to JSON bodies), so a full-size document arrives
// here as roughly 20MB * 4/3 ≈ 26.7MB of base64 alone, before the small
// surrounding JSON envelope (filename, iv, authTag, checksum, etc). 30mb
// covers that real worst case with headroom - anchored to the actual
// upload cap, not an arbitrary large number - while still rejecting a
// genuinely oversized body with a clean 413 (via this same errorHandler)
// rather than accepting anything without limit. Applied globally rather
// than scoped per-route since every other JSON body in this app (auth,
// document metadata edits, share/pairing/device actions) is tiny by
// comparison and a 30mb ceiling on them is generous, not risky.
app.use(express.json({ limit: '30mb' }));

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

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

// mkcert-generated cert, valid only for the SANs it was issued with:
// localhost, 127.0.0.1, 192.168.100.115, 10.58.146.172. If this PC's LAN
// IP ever changes to something outside that list, regenerate with
// `mkcert localhost 127.0.0.1 <new-lan-ip>` and update the paths below
// (and CORS_ORIGINS / VITE_API_BASE_URL) to match.
const httpsOptions = {
  key: fs.readFileSync(path.join(__dirname, '..', 'certs', 'localhost+3-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, '..', 'certs', 'localhost+3.pem')),
};

https.createServer(httpsOptions, app).listen(PORT, () => {
  console.log(`Warden server running on port ${PORT} (https)`);
});
