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
