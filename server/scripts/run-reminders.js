/**
 * Runs the daily expiry-reminder job once, by hand (the same code /api/cron/reminders runs).
 *
 *   cd server && node scripts/run-reminders.js
 *
 * It sends real emails (through the SMTP settings in the environment / .env) to accounts that have documents due
 * a reminder, so run it against the database you mean to. It is safe to run twice: a reminder already sent is
 * never sent again. Prints counts and the database NAME only: never the URI, an email address or a file name.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');

const { runReminders } = require('../utils/reminders');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(`Connected to database "${mongoose.connection.name}".`);
  try {
    const result = await runReminders();
    console.log(JSON.stringify(result));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Reminder run failed:', err.message);
  process.exit(1);
});
