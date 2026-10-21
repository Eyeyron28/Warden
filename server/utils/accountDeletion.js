const User = require('../models/User');
const Document = require('../models/Document');
const DocumentVersion = require('../models/DocumentVersion');
const Folder = require('../models/Folder');
const BackupLog = require('../models/BackupLog');
const Device = require('../models/Device');
const AuditEvent = require('../models/AuditEvent');
const Session = require('../models/Session');
const TrustedDevice = require('../models/TrustedDevice');
const OtpChallenge = require('../models/OtpChallenge');
const ResetTicket = require('../models/ResetTicket');
const RateLimit = require('../models/RateLimit');
const TrashFolder = require('../models/TrashFolder');
const ReminderLog = require('../models/ReminderLog');
const EmergencyAccess = require('../models/EmergencyAccess');
const EmergencyRequest = require('../models/EmergencyRequest');
const { runInTransaction } = require('./folders');
const { removeShares } = require('./shareCleanup');

async function deleteAccountData(userId, { email = null, transaction = true } = {}) {
  const run = async (session) => {
    const opts = session ? { session } : {};
    const deleted = {};
    const del = async (label, model, filter) => {
      const result = await model.deleteMany(filter, opts);
      deleted[label] = result?.deletedCount ?? 0;
    };

    Object.assign(deleted, await removeShares({ ownerUserId: userId }, { session }));
    await del('otpchallenges', OtpChallenge, { userId });
    await del('resettickets', ResetTicket, { userId });
    await del('sessions', Session, { userId });
    await del('trusteddevices', TrustedDevice, { userId });
    await del('devices', Device, { userId });
    await del('auditevents', AuditEvent, { userId });
    await del('reminderlogs', ReminderLog, { userId });
    await del('emergencyrequests', EmergencyRequest, { userId });
    await del('emergencyaccesses', EmergencyAccess, { userId });
    await del('documents', Document, { userId });
    await del('documentversions', DocumentVersion, { userId });
    await del('trashfolders', TrashFolder, { userId });
    await del('folders', Folder, { userId });
    await del('backuplogs', BackupLog, { userId });
    const keys = [String(userId)];
    if (email) keys.push(String(email).trim().toLowerCase());
    await del('ratelimits', RateLimit, { key: { $in: keys } });
    await del('users', User, { _id: userId });
    return deleted;
  };

  if (!transaction) return run(null);
  return runInTransaction(run);
}

module.exports = { deleteAccountData };
