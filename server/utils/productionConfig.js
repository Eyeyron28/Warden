const { isProduction } = require('./runtimeEnv');
const { otpEnabled } = require('./otpConfig');
const { parsePublicAppUrl } = require('./publicAppUrl');
const { auditConfigProblems } = require('./auditConfig');

const SMTP_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];
const MIN_INVITE_CODE_LENGTH = 16;
const MIN_CRON_SECRET_LENGTH = 16;

const read = (name) => (process.env[name] ?? '').trim();

/**
 * What is wrong with the environment for a production deployment, as a list of
 * `{ name, problem }`. Names only: a value is never put in a message, because
 * these are secrets and the message ends up in logs.
 */
function productionConfigProblems() {
  const problems = [];
  const add = (name, problem) => problems.push({ name, problem });

  const mongoUri = read('MONGO_URI');
  if (!mongoUri) add('MONGO_URI', 'missing');
  else if (!/^mongodb(\+srv)?:\/\//.test(mongoUri)) add('MONGO_URI', 'must start with mongodb:// or mongodb+srv://');

  const publicUrl = read('PUBLIC_APP_URL');
  if (!publicUrl) add('PUBLIC_APP_URL', 'missing');
  else {
    try {
      parsePublicAppUrl(publicUrl);
    } catch {
      add('PUBLIC_APP_URL', 'must be an https origin with no path, query or credentials');
    }
  }

  if (!otpEnabled()) add('OTP_ENABLED', 'must not be false in production');

  for (const name of SMTP_VARS) if (!read(name)) add(name, 'missing (login codes could not be delivered)');
  if (read('SMTP_PORT') && !(Number.isInteger(Number(read('SMTP_PORT'))) && Number(read('SMTP_PORT')) > 0)) {
    add('SMTP_PORT', 'must be a port number');
  }

  const mode = read('SIGNUP_MODE').toLowerCase();
  if (!mode) add('SIGNUP_MODE', 'missing (use "invite" or "open")');
  else if (mode !== 'invite' && mode !== 'open') add('SIGNUP_MODE', 'must be "invite" or "open"');
  if (mode === 'invite') {
    const code = read('INVITE_CODE');
    if (!code) add('INVITE_CODE', 'missing (required when SIGNUP_MODE=invite)');
    else if (code.length < MIN_INVITE_CODE_LENGTH) add('INVITE_CODE', `must be at least ${MIN_INVITE_CODE_LENGTH} characters`);
  }

  if (process.env.STORAGE_QUOTA_MB !== undefined && read('STORAGE_QUOTA_MB') !== '') {
    const quota = Number(read('STORAGE_QUOTA_MB'));
    if (!Number.isFinite(quota) || quota <= 0) add('STORAGE_QUOTA_MB', 'must be a positive number');
  }

  // The secret Vercel Cron presents to the daily jobs (reminders, Trash clean-up, Emergency Access upkeep). Without it
  // the routes answer 404 and none of that ever runs, silently - so production refuses to start without a real one.
  const cronSecret = read('CRON_SECRET');
  if (!cronSecret) add('CRON_SECRET', 'missing (the daily reminder and clean-up jobs could not run)');
  else if (cronSecret.length < MIN_CRON_SECRET_LENGTH) add('CRON_SECRET', `must be at least ${MIN_CRON_SECRET_LENGTH} characters`);

  if (read('SESSION_ABSOLUTE_HOURS') !== '') {
    const hours = Number(read('SESSION_ABSOLUTE_HOURS'));
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) add('SESSION_ABSOLUTE_HOURS', 'must be a number of hours from 1 to 168');
  }

  // The key that signs the activity log (a missing or short key must stop the server, not weaken the log).
  for (const { name, problem } of auditConfigProblems()) add(name, problem);

  return problems;
}

/** Throws (naming variables only) when production is misconfigured. No-op outside production. */
function assertProductionConfig() {
  if (!isProduction()) return;
  const problems = productionConfigProblems();
  if (problems.length === 0) return;
  throw new Error(
    `Refusing to start: invalid production configuration.\n${problems.map(({ name, problem }) => `  - ${name}: ${problem}`).join('\n')}`
  );
}

module.exports = { assertProductionConfig, productionConfigProblems, MIN_INVITE_CODE_LENGTH, MIN_CRON_SECRET_LENGTH };
