// Checks that the SMTP settings in server/.env actually work, without
// sending anything: opens a connection and authenticates (nodemailer's
// transport.verify()).
//
//   cd server && npm run verify-smtp
//
// Prints only whether it worked and the host/port it tried - never the
// username, password, or any other value from .env.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { verifySmtp } = require('../utils/email');

verifySmtp()
  .then(() => {
    console.log(`OK: authenticated with ${process.env.SMTP_HOST}:${process.env.SMTP_PORT}.`);
  })
  .catch((err) => {
    console.error(`FAILED: ${err.message}`);
    process.exitCode = 1;
  });
