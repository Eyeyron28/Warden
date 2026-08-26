require('dotenv').config();

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

const app = express();

connectDB();

app.use(cors(corsOptions));
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.status(200).json({ success: true, status: 'ok' });
});

app.use('/api/auth', authRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/documents', documentSharesRoutes);
app.use('/api/shares', shareTokenRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/backup', backupRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Warden server running on port ${PORT}`);
});
