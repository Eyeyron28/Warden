// Vercel serverless entry point. Vercel's Node.js runtime treats a
// default-exported Express app under /api as a request handler directly -
// no app.listen() needed (or wanted: server/server.js guards its own
// https.createServer()+mkcert local-dev server behind
// `require.main === module`, so requiring it here never starts one).
//
// UNVERIFIED: written from Vercel's documented conventions, not exercised
// against an actual Vercel deployment - see the task's final report for
// what to check before relying on this.
module.exports = require('../server/server.js');
