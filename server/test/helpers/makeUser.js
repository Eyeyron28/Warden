// An account made directly (no sign-up flow), for tests whose subject is something else. Uses the same key work as sign-up.
const { buildAccountFields } = require('../../utils/accountCreate');

/** @param {*} User the User model (real or fake) */
async function makeUser(User, email, password, { emailVerified = true } = {}) {
  const { fields } = buildAccountFields(password);
  return User.create({ email, emailVerified, ...fields });
}

module.exports = { makeUser };
