const { buildAccountFields } = require('../../utils/accountCreate');

async function makeUser(User, email, password, { emailVerified = true } = {}) {
  const { fields } = buildAccountFields(password);
  return User.create({ email, emailVerified, ...fields });
}

module.exports = { makeUser };
