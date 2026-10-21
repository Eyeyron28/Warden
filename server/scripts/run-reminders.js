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
