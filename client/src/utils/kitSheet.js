import { describeWait } from './emergencyWizard.js';
import { kitRows } from './kitHolder.js';

/**
 * What the printed "Warden Emergency Kit" sheet says. The sheet is made from EXACTLY these inputs, so it cannot
 * carry anything else: not the owner's password, recovery key or email.
 *
 * Honest wording: a stolen kit alone cannot open the vault, but anyone who has the kit AND a copy of Warden's
 * database could, and the owner can deny a request during the waiting period. Folder limits are enforced by the
 * server. The sheet says to keep it private and does not claim more.
 */

export const SHEET_TITLE = 'Warden Emergency Kit';

export function buildKitSheet({ contactName, address, waitMinutes, kit, date = new Date() }) {
  const wait = describeWait(waitMinutes);
  const who = String(contactName || '').trim();
  return {
    title: SHEET_TITLE,
    contactLine: who ? `For: ${who}` : 'For: the person you named as your trusted contact',
    address,
    waitText: `Waiting period: ${wait}`,
    steps: [
      `Go to ${address} and choose “Request access”. Enter the owner’s email and your own, then the code we email you.`,
      'Enter that code and the kit code below. The owner is told right away and can deny the request during the waiting period.',
      `After the waiting period (${wait}), come back to the same page, choose “Open the vault”, get a new code and enter the kit again. You get read-only access.`,
    ],
    kitRows: kitRows(kit),
    kit,
    privacyLine: 'Keep this sheet private. Anyone who has it and a copy of Warden’s database could open the vault; the owner can deny a request during the waiting period.',
    dateLine: `Printed ${new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
  };
}
