// What Warden does not protect against. One list, shown on the About
// section and in the Privacy page (and therefore in the signup dialog), so
// the copy can't drift between them. Every line has to match the code:
// see server/utils/sessionStore.js, controllers/shares.controller.js and
// services/localVault.js.
export const LIMITS = [
  {
    title: 'A compromised server while you are signed in',
    body:
      'While you are signed in, the server unlocks your vault key for each request so it can encrypt uploads and decrypt downloads. Anyone who controls the running server, or can change its code, could read what you open during that time. Warden is not end-to-end encrypted.',
  },
  {
    title: 'Losing both your password and your recovery key',
    body:
      'With neither, and no paired phone, your vault cannot be recovered, by you or by us. An email reset only starts a new, empty vault.',
  },
  {
    title: 'A compromised or shared device',
    body:
      'Anyone using your unlocked browser can open your documents. A paired phone keeps encrypted copies of your files and a copy of your vault key locked only by its PIN, so a short PIN on a lost phone is a weak lock.',
  },
  {
    title: 'Weak or reused passwords',
    body:
      'Your password is what locks the vault key. Failed log-ins are limited to 3 attempts, then a 5-minute lockout, but that does not slow someone trying guesses against a stolen copy of the database. Use a long, unique password.',
  },
  {
    title: 'Share links you leave active',
    body:
      "Anyone holding a share link can open what it shares until it expires or you revoke it. The link's secret is stored in the database beside a copy of your vault key that it unlocks, so while a link is active a leaked database could open more than the shared files. Revoke links you no longer need.",
  },
  {
    title: 'File names and details',
    body: 'File and folder names, file types, sizes and dates are stored as plain text. Only file contents and previews are encrypted.',
  },
];
