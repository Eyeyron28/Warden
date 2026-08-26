// Restricts CORS to local network origins only (no wildcard/open CORS).
// Configure allowed origins via CORS_ORIGINS in .env (comma-separated).
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. curl, same-machine tools)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
  // Content-Disposition isn't in the CORS response-header safelist, so
  // without this, frontend code reading response.headers['content-
  // disposition'] (documents/:id/view, shared/:token) silently gets
  // nothing back whenever the frontend and API are on different origins
  // (e.g. separate dev ports) - the filename parsing then falls back to
  // a generic name instead of the real one, with no error to notice.
  exposedHeaders: ['Content-Disposition'],
};

module.exports = corsOptions;
