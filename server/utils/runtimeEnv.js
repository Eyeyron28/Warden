function isProduction() {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
}

module.exports = { isProduction };
