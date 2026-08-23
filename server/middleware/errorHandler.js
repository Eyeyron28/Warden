// Consistent JSON error format for all routes.
// Usage: pass errors to next(err), or let thrown errors in async handlers bubble up.
const notFound = (req, res, next) => {
  const error = new Error(`Route not found: ${req.originalUrl}`);
  error.status = 404;
  next(error);
};

const errorHandler = (err, req, res, next) => {
  const status = err.status || (res.statusCode !== 200 ? res.statusCode : 500);

  res.status(status).json({
    success: false,
    error: {
      message: err.message || 'Internal Server Error',
      status,
    },
  });
};

module.exports = { notFound, errorHandler };
