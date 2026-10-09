// What Warden does not protect against. One list, shown on the About
// section and in the Privacy page (and therefore in the signup dialog), so
// the copy can't drift between them. Every line has to match the code:
// see server/utils/sessionStore.js, controllers/shares.controller.js
// (share links).
export const LIMITS = [
  {
    title: 'A compromised server while you are signed in',
    body:
      'While you are signed in, the server unlocks your vault key for each request so it can encrypt uploads and decrypt downloads. Anyone who controls the running server, or can change its code, could read what you open during that time. Warden is not end-to-end encrypted.',
  },
  {
    title: 'Losing both your password and your recovery key',
    body:
      'With neither, your vault cannot be recovered, by you or by us. An email reset only starts a new, empty vault.',
  },
  {
    title: 'A compromised or shared device',
    body:
      'Anyone using your unlocked browser can open your documents. Your session is only in that tab, but a computer you share can still be used while you are signed in, so sign out when you are done. Devices & activity shows every browser signed in to your account and lets you sign any of them out.',
  },
  {
    title: 'Weak or reused passwords',
    body:
      'Your password is what locks the vault key. Failed log-ins are limited to 3 attempts, then a 5-minute lockout, but that does not slow someone trying guesses against a stolen copy of the database. Use a long, unique password.',
  },
  {
    title: 'Your email account',
    body:
      'Login, password-reset and account-deletion codes are sent to your email address. Whoever can read your mailbox can receive them, so keep your email account as well protected as your vault.',
  },
  {
    title: 'Share links',
    body:
      "A share link contains a key after the # symbol; if you add a password, the key is locked by the password instead. Anyone who has the full link, and any password or emailed code you asked for, can open the shared files until it expires, reaches its download limit or you stop sharing. The server stores only encrypted copies of the shared files and never stores the link's key or the password. A password, a download limit or an email restriction controls who the server will hand the encrypted copies to; it is not end-to-end encryption, and the link is still a secret to send over a trusted channel. A password is only as strong as you make it: someone who copied our database could try guesses against it offline. A share is a snapshot: editing the original file does not change existing shared copies, but moving the original to Trash stops every share that includes it right away; stop sharing to remove copies yourself.",
  },
  {
    title: 'Storage and size limits',
    body:
      'A single file can be at most 4 MB. Each account can store 25 MB in total (this server can set a different quota), counting everything in your vault and everything waiting in Trash; emptying Trash, permanent deletion and the 30-day clean-up free the space, and an upload that would go over is refused with a message. Share links have their own separate limits: up to 20 MB in one link, 60 MB across your active links, and 20 active links, for at most 30 days.',
  },
  {
    title: 'File names and sizes',
    body: 'File and folder names, file types and dates are stored as plain text. Encrypted data is the same size as the file, so file sizes are visible to anyone with access to the database. Only file contents and previews are encrypted (and, inside a share, the names too).',
  },
];
