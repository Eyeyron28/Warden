const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

try {
  const own = (process.env.PUBLIC_APP_URL || '').trim();
  if (own) allowedOrigins.push(new URL(own).origin);
} catch {
}

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
  exposedHeaders: ['Content-Disposition'],
};

module.exports = corsOptions;
