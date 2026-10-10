import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEMO_CHOICE,
  KIT_ACK_TEXT,
  LABEL_MAX,
  STEPS,
  canLeaveKitScreen,
  describeWait,
  folderTree,
  initialWizardState,
  nextStep,
  previousStep,
  setupBody,
  stepValidation,
  summaryLines,
  toggleFolder,
  validateContact,
  validateScope,
  validateWait,
  waitChoices,
} from './emergencyWizard.js';
import { createKitHolder, isCompleteKit, kitGroups, kitRows, normalizeKitInput } from './kitHolder.js';
import { SHEET_TITLE, buildKitSheet } from './kitSheet.js';
import {
  EMERGENCY_CONTROLS,
  EMERGENCY_MENU,
  EMERGENCY_NAV,
  EMERGENCY_ROUTES,
  emergencyRedirect,
  isUnavailable,
  sessionBannerText,
  UNAVAILABLE_MESSAGE,
} from './emergencyMode.js';
import { bannerFor, dismissKey, formatCountdown, openRequestOf } from './emergencyBanner.js';
import { GENERIC_FAILURE, NEUTRAL_CODE_MESSAGE, ONLY_IF_SETUP_NOTE, publicFailureMessage, requestSentText } from './emergencyMessages.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const KIT = 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567-ABCD-EFGH-IJKL-MNOP-QRST';

// ---------- the wizard ----------
test('wizard: five screens in order, one step at a time, and Back goes back', () => {
  assert.deepEqual([...STEPS], ['contact', 'wait', 'scope', 'confirm', 'kit']);
  assert.equal(nextStep('contact'), 'wait');
  assert.equal(nextStep('wait'), 'scope');
  assert.equal(nextStep('scope'), 'confirm');
  assert.equal(nextStep('confirm'), 'kit');
  assert.equal(nextStep('kit'), 'kit');
  assert.equal(previousStep('wait'), 'contact');
  assert.equal(previousStep('contact'), 'contact');
});

test('wizard step a: the label is at most 60 characters and the email is one address that is not your own', () => {
  assert.equal(validateContact({ label: '', email: 'sam@example.com' }).ok, true, 'the name is optional');
  assert.equal(validateContact({ label: 'x'.repeat(LABEL_MAX), email: 'sam@example.com' }).ok, true);
  assert.ok(validateContact({ label: 'x'.repeat(LABEL_MAX + 1), email: 'sam@example.com' }).errors.label);
  assert.ok(validateContact({ label: '🙂'.repeat(LABEL_MAX + 1), email: 'sam@example.com' }).errors.label, 'counted in characters');
  assert.equal(validateContact({ label: '🙂'.repeat(LABEL_MAX), email: 'sam@example.com' }).ok, true);
  for (const bad of ['', '   ', 'sam', 'sam@', '@example.com', 'sam@example', 'a@example.com, b@example.com', 'a b@example.com', '<sam@example.com>']) {
    assert.ok(validateContact({ email: bad }).errors.email, JSON.stringify(bad));
  }
  assert.match(validateContact({ email: 'Me@Example.com' }, 'me@example.com').errors.email, /someone other than you/);
  assert.equal(validateContact({ email: 'me@example.com' }, '').ok, true, 'no own address known: nothing to compare');
});

test('wizard step b: the 2-minute demo wait appears ONLY when the server says demo mode is on', () => {
  assert.deepEqual(waitChoices(false).map((c) => c.minutes), [4320, 10080, 20160]);
  assert.deepEqual(waitChoices(undefined).map((c) => c.minutes), [4320, 10080, 20160]);
  assert.deepEqual(waitChoices('true').map((c) => c.minutes), [4320, 10080, 20160], 'only a real boolean true counts');
  assert.deepEqual(waitChoices(true).map((c) => c.minutes), [2, 4320, 10080, 20160]);
  assert.equal(waitChoices(true)[0], DEMO_CHOICE);
  assert.equal(DEMO_CHOICE.demo, true, 'it carries the demo badge');
  assert.match(DEMO_CHOICE.label, /demo/i);
  assert.ok(waitChoices(false).every((c) => !c.demo));
  assert.equal(validateWait(2, false).ok, false);
  assert.equal(validateWait(2, true).ok, true);
  assert.equal(validateWait(60, true).ok, false);
  assert.equal(validateWait(null, true).ok, false);
  for (const days of [4320, 10080, 20160]) assert.equal(validateWait(days, false).ok, true);
  assert.equal(describeWait(4320), '3 days');
  assert.equal(describeWait(10080), '7 days');
  assert.equal(describeWait(20160), '14 days');
  assert.equal(describeWait(2), '2 minutes (demo)');
});

test('wizard step c: everything, or 1 to 50 chosen folders', () => {
  assert.equal(validateScope({ mode: 'all' }).ok, true);
  assert.equal(validateScope({ mode: 'folders', folderIds: ['a'] }).ok, true);
  assert.ok(validateScope({ mode: 'folders', folderIds: [] }).errors.scope);
  assert.ok(validateScope({ mode: 'folders', folderIds: Array.from({ length: 51 }, (_, i) => String(i)) }).errors.scope);
  assert.equal(validateScope({ mode: 'folders', folderIds: Array.from({ length: 50 }, (_, i) => String(i)) }).ok, true);
  assert.ok(validateScope({}).errors.scope);
  assert.deepEqual(toggleFolder(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleFolder(['a', 'b'], 'a'), ['b']);
  const tree = folderTree([{ id: '2', path: 'Taxes/2024' }, { id: '1', path: 'Taxes' }, { id: '3', path: 'Medical' }]);
  assert.deepEqual(tree.map((f) => [f.path, f.depth, f.name]), [['Medical', 0, 'Medical'], ['Taxes', 0, 'Taxes'], ['Taxes/2024', 1, '2024']]);
});

test('wizard: Next is gated by each screen’s own validation, and the confirm summary and request body match', () => {
  const state = initialWizardState();
  assert.equal(stepValidation('contact', state).ok, false);
  assert.equal(stepValidation('wait', state, { demoMode: true }).ok, false);
  assert.equal(stepValidation('scope', state).ok, false);
  const filled = { ...state, label: ' Sam ', email: ' sam@example.com ', waitMinutes: 4320, scopeMode: 'folders', folderIds: ['f1'] };
  for (const step of ['contact', 'wait', 'scope']) assert.equal(stepValidation(step, filled, { demoMode: false, ownEmail: 'me@example.com' }).ok, true, step);
  assert.equal(stepValidation('wait', { ...filled, waitMinutes: 2 }, { demoMode: false }).ok, false, '2 minutes without demo mode');
  assert.deepEqual(setupBody(filled), { contactEmail: 'sam@example.com', contactLabel: 'Sam', waitMinutes: 4320, scope: { mode: 'folders', folderIds: ['f1'] } });
  assert.deepEqual(setupBody({ ...filled, scopeMode: 'all' }).scope, { mode: 'all' });
  const lines = Object.fromEntries(summaryLines(filled, [{ id: 'f1', path: 'Taxes/2024' }]));
  assert.match(lines['Your contact'], /Sam <sam@example.com>/);
  assert.equal(lines['Waiting period'], '3 days');
  assert.match(lines['They can see'], /1 folder: Taxes\/2024/);
  assert.match(lines['What they can do'], /Read and download only/);
  // the body never carries the code or any secret: the caller adds the code fields
  assert.deepEqual(Object.keys(setupBody(filled)).sort(), ['contactEmail', 'contactLabel', 'scope', 'waitMinutes']);
});

test('the kit screen cannot be left until the owner confirms they saved it', () => {
  assert.equal(canLeaveKitScreen({ acknowledged: false }), false);
  assert.equal(canLeaveKitScreen({}), false);
  assert.equal(canLeaveKitScreen({ acknowledged: 'yes' }), false);
  assert.equal(canLeaveKitScreen({ acknowledged: true }), true);
  assert.equal(KIT_ACK_TEXT, 'I’ve saved or printed the kit. I understand it cannot be shown again.');
  const screen = read('components/emergency/KitScreen.jsx');
  assert.match(screen, /disabled=\{!canLeaveKitScreen\(\{ acknowledged \}\)\}/);
  const wizard = read('components/emergency/EmergencyWizard.jsx');
  assert.ok(!/onCreated\(.*\)\s*;?\s*onCancel/.test(wizard));
});

// ---------- the kit is held in memory only ----------
test('the kit holder keeps the code in a variable, hands it out, and forgets it', () => {
  const holder = createKitHolder();
  assert.equal(holder.has(), false);
  holder.set(KIT);
  assert.equal(holder.get(), KIT);
  assert.equal(holder.has(), true);
  holder.clear();
  assert.equal(holder.get(), null);
  assert.equal(holder.has(), false);
  holder.set('');
  assert.equal(holder.has(), false, 'an empty value is no kit');
  holder.set(null);
  assert.equal(holder.has(), false);
  assert.equal(kitGroups(KIT).length, 13);
  assert.deepEqual(kitRows(KIT).map((row) => row.length), [4, 4, 4, 1]);
  assert.equal(kitRows(KIT)[0].join('-'), 'ABCD-EFGH-IJKL-MNOP');
});

test('typed or pasted kit codes are normalised (any case, spaces, dashes) and checked for length', () => {
  const typed = 'abcd efgh-ijkl mnop  qrst-uvwx yz23 4567-abcd efgh ijkl mnop qrst';
  assert.equal(normalizeKitInput(typed), KIT);
  assert.equal(isCompleteKit(typed), true);
  assert.equal(isCompleteKit('ABCD-EFGH'), false);
  assert.equal(isCompleteKit(KIT + 'AAAA'), false, 'extra characters are cut by normalising, not accepted raw');
  assert.equal(normalizeKitInput(KIT + 'AAAA'), KIT);
  assert.equal(normalizeKitInput('0189 !?'), '', 'characters outside the kit alphabet are dropped');
  assert.equal(normalizeKitInput(null), '');
});

test('the kit never reaches browser storage, the address bar, a cookie or a log: no persistence in any file that touches it', () => {
  const files = [
    'utils/kitHolder.js',
    'utils/kitSheet.js',
    'components/emergency/KitScreen.jsx',
    'components/emergency/KitSheet.jsx',
    'components/emergency/EmergencyWizard.jsx',
    'pages/EmergencyAccessPage.jsx',
    'pages/EmergencyContactPage.jsx',
  ];
  for (const file of files) {
    const text = stripComments(read(file));
    assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|document\.cookie|caches\.|history\.(push|replace)State|navigator\.serviceWorker/, `${file} must not persist anything`);
    assert.doesNotMatch(text, /console\.(log|info|warn|error|debug)/, `${file} must not log`);
    assert.doesNotMatch(text, /location\.(hash|search|href)\s*=(?!=)|navigate\([^)]*kit|to=\{[^}]*kit|setSearchParams|setParams\([^)]*kit/i, `${file} must not put the kit in a URL`);
  }
  // the kit travels only in the setup/regenerate RESPONSE and the contact's POST body; the service never stores it
  const service = stripComments(read('services/emergencyService.js'));
  assert.doesNotMatch(service, /localStorage|sessionStorage|console\./);
  // the page clears it when it is left, and the holder is the only home it has
  const page = read('pages/EmergencyAccessPage.jsx');
  assert.match(page, /createKitHolder\(\)/);
  assert.match(page, /holder\.clear\(\)/);
  assert.match(page, /return \(\) => \{[\s\S]*holder\.clear\(\);/, 'cleared on unmount');
  const screen = read('components/emergency/KitScreen.jsx');
  assert.match(screen, /beforeunload/, 'a refresh or closed tab asks first');
  assert.match(screen, /QRCode\.toDataURL\(kit/, 'the QR is drawn in the browser');
  assert.doesNotMatch(screen, /https?:\/\/[^'"`\s]*(qr|chart\.googleapis|api\.qrserver)/i, 'no external QR service');
  // kit inputs (public page) do not autofill or spell-check
  const contact = read('pages/EmergencyContactPage.jsx');
  assert.match(contact, /id="ec-kit"[\s\S]*autoComplete="off"[\s\S]*spellCheck=\{false\}/);
});

// ---------- the printed sheet ----------
test('the printed sheet: contact name, address, wait, three steps, kit and QR place, privacy line and date; no owner secrets', () => {
  const sheet = buildKitSheet({ contactName: 'Sam Reyes', address: 'https://warden.example.com/emergency', waitMinutes: 10080, kit: KIT, date: new Date('2026-10-09T08:00:00Z') });
  assert.equal(sheet.title, SHEET_TITLE);
  assert.equal(SHEET_TITLE, 'Warden Emergency Kit');
  assert.equal(sheet.contactLine, 'For: Sam Reyes');
  assert.equal(sheet.address, 'https://warden.example.com/emergency');
  assert.equal(sheet.waitText, 'Waiting period: 7 days');
  assert.equal(sheet.steps.length, 3);
  assert.ok(sheet.steps[0].includes('https://warden.example.com/emergency'));
  assert.ok(sheet.steps[2].includes('7 days'));
  assert.equal(sheet.kit, KIT);
  assert.deepEqual(sheet.kitRows.flat(), kitGroups(KIT));
  assert.match(sheet.privacyLine, /Keep this sheet private/);
  assert.match(sheet.dateLine, /^Printed October 9, 2026$/);
  // the sheet is built from exactly these inputs: anything else a caller passes cannot appear on it
  const withSecrets = buildKitSheet({ contactName: 'Sam', address: 'https://w.example/emergency', waitMinutes: 4320, kit: KIT, ownerPassword: 'hunter2-PASSWORD', recoveryKey: 'RECOVERY-KEY-XXXX', ownerEmail: 'owner@private.example', date: new Date() });
  const everything = JSON.stringify(withSecrets);
  for (const secret of ['hunter2-PASSWORD', 'RECOVERY-KEY-XXXX', 'owner@private.example']) assert.ok(!everything.includes(secret), secret);
  assert.deepEqual(Object.keys(withSecrets).sort(), ['address', 'contactLine', 'dateLine', 'kit', 'kitRows', 'privacyLine', 'steps', 'title', 'waitText']);
  assert.equal(buildKitSheet({ address: 'a', waitMinutes: 4320, kit: KIT }).contactLine, 'For: the person you named as your trusted contact');
  // honest wording: no end-to-end claim, and what a leak means
  assert.doesNotMatch(everything, /end-to-end/i);
  assert.match(sheet.privacyLine, /copy of Warden’s database/);
});

test('the print stylesheet shows ONLY the sheet, on A4, and the sheet is invisible on screen', () => {
  const css = read('components/emergency/kitPrint.css');
  assert.match(css, /@page\s*\{[^}]*size:\s*A4/);
  assert.match(css, /@media screen\s*\{\s*#kit-print-root\s*\{\s*display:\s*none/);
  assert.match(css, /@media print[\s\S]*body > \*:not\(#kit-print-root\)\s*\{\s*display:\s*none !important/);
  assert.match(css, /#kit-print-root\s*\{\s*display:\s*block !important/);
  const sheet = read('components/emergency/KitSheet.jsx');
  assert.match(sheet, /createPortal\([\s\S]*document\.body/, 'rendered into the body so the rest can be hidden');
  assert.match(sheet, /id="kit-print-root"/);
  assert.doesNotMatch(stripComments(sheet), /password|recovery|ownerEmail|email/i, 'the sheet component knows nothing about the owner’s secrets or address');
});

// ---------- emergency mode ----------
test('emergency mode: every client route but Files goes to Files', () => {
  assert.deepEqual([...EMERGENCY_ROUTES], ['/files']);
  assert.equal(emergencyRedirect('/files'), null);
  assert.equal(emergencyRedirect('/files/'), null);
  for (const path of ['/trash', '/account', '/overview', '/photos', '/shared', '/export', '/devices', '/emergency-access', '/', '/vault', '/files/x', '/anything-else', '']) {
    assert.equal(emergencyRedirect(path), '/files', path);
  }
});

test('emergency mode: every write or account control is off, the sidebar is just Files, menus keep two items', () => {
  const on = Object.entries(EMERGENCY_CONTROLS).filter(([, shown]) => shown);
  assert.deepEqual(on, [], 'nothing that changes anything is shown');
  for (const control of ['upload', 'newFolder', 'rename', 'move', 'delete', 'restore', 'share', 'bulkSelect', 'dragAndDrop', 'frequentlyUsed', 'expiryBanner', 'overview', 'trash', 'photos', 'export', 'devices', 'account', 'emergencySetup', 'searchOutsideScope']) {
    assert.ok(control in EMERGENCY_CONTROLS, `${control} is accounted for`);
  }
  assert.deepEqual(EMERGENCY_NAV.map((item) => item.label), ['Files']);
  assert.deepEqual([...EMERGENCY_MENU], ['Open / Preview', 'Download']);
});

test('emergency mode: the contact’s screens are built from only read-only parts', () => {
  const page = stripComments(read('pages/EmergencyFilesPage.jsx'));
  assert.match(page, /selectable=\{false\}/);
  assert.match(page, /readOnly/);
  for (const forbidden of ['NewMenu', 'UploadForm', 'SelectionBar', 'ContextMenu', 'MoveModal', 'ShareModal', 'EditDocumentModal', 'NewFolderModal', 'RenameFolderModal', 'FrequentFiles', 'ExpiringBanner', 'ExpiryModal', 'PreviewsNotice', 'usePreviewGenerator', 'deleteDocument', 'uploadDocument', 'moveItems', 'createFolder', 'renameFolder', 'updateDocument', 'putThumbnail', 'recordDownload', 'getStorage', 'onDropOnFolder', 'draggable']) {
    assert.ok(!page.includes(forbidden), `the contact's Files must not use ${forbidden}`);
  }
  // only these two menu actions
  const menu = page.slice(page.indexOf('const menuFor'), page.indexOf('if (unavailable)'));
  assert.deepEqual([...menu.matchAll(/label: '([^']+)'/g)].map((m) => m[1]).sort(), ['Download', 'Open', 'Open / Preview']);
  const shell = stripComments(read('components/emergency/EmergencyShell.jsx'));
  assert.match(shell, /emergencyRedirect\(location\.pathname\)/);
  assert.doesNotMatch(shell, /<Sidebar|<Header|FolderTree|'\/trash'|'\/account'|'\/overview'|'\/devices'|type="search"/);
  // the preview hides Share, Rename and Move to trash, and downloads through the server so it is logged
  const preview = read('components/FilePreview.jsx');
  assert.match(preview, /\{!readOnly && \(/);
  assert.match(preview, /if \(!bytes \|\| readOnly\)/);
  // the app picks the shell from the server's answer
  const app = read('App.jsx');
  assert.match(app, /mode\.emergency \? <EmergencyShell \/> : <AppLayout/);
  assert.match(app, /verify: async \(\) => setModeFromMe\(await getMe\(\)\)/);
  assert.match(app, /wasEmergencyTab\(\)[\s\S]*\/emergency\?ended=1/);
});

test('a 403 or 404 is "not available", never a broken page', () => {
  assert.equal(isUnavailable({ response: { status: 403 } }), true);
  assert.equal(isUnavailable({ response: { status: 404 } }), true);
  assert.equal(isUnavailable({ status: 404 }), true);
  assert.equal(isUnavailable({ response: { status: 500 } }), false);
  assert.equal(isUnavailable({ response: { status: 401 } }), false);
  assert.equal(isUnavailable(null), false);
  assert.equal(UNAVAILABLE_MESSAGE, 'This item isn’t available.');
  const page = read('pages/EmergencyFilesPage.jsx');
  assert.match(page, /UNAVAILABLE_MESSAGE/);
  assert.match(page, /Back to Files/);
  assert.match(page, /isUnavailable\(err\)/);
});

test('the session banner says read-only and when it ends', () => {
  assert.equal(sessionBannerText('2026-10-09T12:00:00Z', () => '8:00 PM PHT'), 'Emergency access: read-only. This session ends at 8:00 PM PHT.');
  assert.equal(sessionBannerText(null, () => 'x'), 'Emergency access: read-only.');
});

// ---------- the owner's banner and countdown ----------
test('the owner’s banner comes from the server status, so a reload shows it; dismissing is per request and per tab session', () => {
  const when = (iso) => `at ${iso}`;
  const pending = { request: { id: 'r1', status: 'pending', releaseAt: '2999-01-01T00:00:00Z' } };
  const shown = bannerFor(pending, { formatWhen: when });
  assert.equal(shown.show, true);
  assert.equal(shown.text, 'Someone requested emergency access. It will be granted on at 2999-01-01T00:00:00Z unless you deny it.');
  assert.equal(shown.requestId, 'r1');
  // the same status gives the same banner after a reload (nothing but the server's answer is needed)
  assert.deepEqual(bannerFor(pending, { formatWhen: when }), shown);
  assert.equal(bannerFor(pending, { dismissedId: 'r1', formatWhen: when }).show, false, 'dismissed in this session');
  assert.equal(bannerFor(pending, { dismissedId: 'r0', formatWhen: when }).show, true, 'a different request is not dismissed');
  const released = bannerFor({ request: { id: 'r2', status: 'released', releaseAt: '2000-01-01T00:00:00Z' } }, { formatWhen: when });
  assert.equal(released.released, true);
  assert.match(released.text, /can now open your vault/);
  assert.equal(bannerFor({ request: { id: 'r3', status: 'pending', releaseAt: '2000-01-01T00:00:00Z' } }, { formatWhen: when }).released, true, 'the wait is over by the clock');
  for (const none of [null, undefined, {}, { request: null }, { request: { id: 'x', status: 'denied' } }, { request: { id: 'x', status: 'expired' } }, { request: { id: 'x', status: 'cancelled' } }]) {
    assert.equal(bannerFor(none, { formatWhen: when }).show, false, JSON.stringify(none));
  }
  assert.equal(openRequestOf(pending).id, 'r1');
  assert.equal(dismissKey('r1'), 'warden.emergencyBanner.r1');

  const component = read('components/EmergencyBanner.jsx');
  assert.match(component, /getEmergencyStatus\(\)/, 'read from the server on every load');
  assert.match(component, /useEffect\(\(\) => \{\s*load\(\);\s*\}, \[load, location\.pathname\]\)/, 'and on every page change');
  assert.match(component, /setInterval\(load, POLL_MS\)/);
  const stored = [...stripComments(component).matchAll(/sessionStorage\.(getItem|setItem)\(([^)]*)\)/g)].map((m) => m[2]);
  assert.ok(stored.every((arg) => /dismissKey\(/.test(arg)), 'the only thing kept is which request was dismissed');
  const layout = read('components/AppLayout.jsx');
  assert.match(layout, /<EmergencyBanner \/>/);
  assert.match(read('components/Sidebar.jsx'), /to="\/emergency-access"/);
});

test('the countdown reads naturally', () => {
  assert.equal(formatCountdown(0), 'now');
  assert.equal(formatCountdown(-5), 'now');
  assert.equal(formatCountdown(NaN), 'now');
  assert.equal(formatCountdown(42 * 1000), '42 seconds');
  assert.equal(formatCountdown(1000), '1 second');
  assert.equal(formatCountdown(5 * 60 * 1000 + 8000), '5 minutes 8 seconds');
  assert.equal(formatCountdown(3 * 3600 * 1000 + 12 * 60 * 1000), '3 hours 12 minutes');
  assert.equal(formatCountdown(3 * 3600 * 1000), '3 hours');
  assert.equal(formatCountdown(2 * 86400 * 1000 + 4 * 3600 * 1000), '2 days 4 hours');
  assert.equal(formatCountdown(86400 * 1000), '1 day');
  const card = read('components/emergency/RequestCard.jsx');
  assert.match(card, /setInterval\(\(\) => setNow\(Date\.now\(\)\), intervalMs\)/, 'live');
  assert.match(card, /formatManila\(request\.releaseAt\)/, 'in Asia/Manila');
  assert.match(card, />\s*Deny\s*</);
  assert.match(card, />\s*Approve now\s*</);
  assert.match(read('utils/activityText.js'), /timeZone: 'Asia\/Manila'/);
});

test('approve-now and turn-off ask for confirmation and a fresh code first', () => {
  const page = read('pages/EmergencyAccessPage.jsx');
  assert.match(page, /type: 'confirmApprove'/);
  assert.match(page, /action="approve-now"/);
  assert.match(page, /action="revoke"/);
  assert.match(page, /action="regenerate"/);
  assert.match(page, /type: 'confirmReplace'/);
  assert.match(page, /This replaces your current setup/);
  assert.match(page, /replace=\{replaceMode\}/);
  // the demo badge only when the server says so
  assert.match(page, /status\?\.demoMode && <span className=\{styles\.demoBadge\} data-testid="demo-badge">Demo mode: short waits are enabled\.<\/span>/);
  const wizard = read('components/emergency/EmergencyWizard.jsx');
  assert.match(wizard, /waitChoices\(demoMode\)/);
});

// ---------- the public page ----------
test('the public page speaks in one voice: the same neutral confirmation, the same generic failure', () => {
  assert.equal(NEUTRAL_CODE_MESSAGE, 'If these details match an active setup, we sent a code to the contact’s email.');
  assert.equal(GENERIC_FAILURE, 'That didn’t work. Check the details and try again.');
  assert.equal(ONLY_IF_SETUP_NOTE, 'This only works if the owner set up Emergency Access for you.');
  for (const status of [400, 401, 403, 404, 409, 500, 502]) {
    assert.equal(publicFailureMessage({ response: { status } }), GENERIC_FAILURE, String(status));
  }
  assert.equal(publicFailureMessage(new Error('Network Error')), GENERIC_FAILURE);
  assert.equal(publicFailureMessage(undefined), GENERIC_FAILURE);
  assert.match(publicFailureMessage({ response: { status: 429, data: { error: { message: 'Too many attempts. Please try again later.' } } } }), /Too many attempts/);
  assert.equal(publicFailureMessage({ response: { status: 429, data: {} } }), 'Too many attempts. Please wait a while and try again.');
  // answers given only to a contact who proved who they are
  assert.match(publicFailureMessage({ response: { status: 429, data: { error: { message: 'The owner denied the last request. You can ask again 24 hours after that.' } } } }), /24 hours/);
  assert.match(publicFailureMessage({ response: { status: 409, data: { error: { code: 'NOT_YET' } } } }), /waiting period has not ended/);
  assert.match(publicFailureMessage({ response: { status: 410 } }), /time to open the vault has passed/);
  assert.equal(requestSentText('2026-10-12T01:00:00Z', (v) => `<${v}>`), 'Your request was sent. Access can be available on <2026-10-12T01:00:00Z>. Come back to this page then.');
});

test('the public page: three steps, neutral messages, one failure sentence, no account details, token like a sign-in', () => {
  const page = read('pages/EmergencyContactPage.jsx');
  const code = stripComments(page);
  for (const title of ['Request access', 'Confirm', 'Open the vault']) assert.ok(page.includes(`title: '${title}'`), title);
  assert.match(code, /setMessage\(NEUTRAL_CODE_MESSAGE\)/);
  assert.equal((code.match(/publicFailureMessage\(err\)/g) || []).length, (code.match(/\} catch \(err\) \{/g) || []).length, 'every catch uses the one failure message');
  assert.ok((code.match(/publicFailureMessage\(err\)/g) || []).length >= 3);
  assert.doesNotMatch(code, /err\.response|extractErrorMessage|error\.message/, 'nothing from the server is shown as it is');
  assert.match(code, /ONLY_IF_SETUP_NOTE/);
  assert.match(code, /requestSentText\(sent\.releaseAt, formatManila\)/);
  assert.match(code, /setToken\(result\.sessionToken\)/);
  assert.match(code, /enterEmergencyMode\(/);
  assert.match(code, /navigate\('\/files'/);
  assert.match(page, /Send me a code/);
  assert.match(page, /Open the vault/);
  // success does not echo the owner's address or name
  assert.doesNotMatch(code, /result\.(ownerEmail|email|owner)/);
  // the footer links of the landing and sign-in pages reach it
  const footer = read('components/site/SiteFooter.jsx');
  assert.equal((footer.match(/to="\/emergency"/g) || []).length, 2, 'full footer and the compact one on the sign-in page');
  assert.match(read('App.jsx'), /path="emergency" element=\{<EmergencyContactPage \/>\}/);
  assert.match(read('App.jsx'), /path="\/emergency-access" element=\{<EmergencyAccessPage \/>\}/);
});

test('the activity timeline labels a contact’s events "Trusted contact" with its own icon', () => {
  const devices = read('pages/DevicesPage.jsx');
  assert.match(devices, /event\.actor === 'emergency' \? 'Trusted contact'/);
  assert.match(devices, /emergency: Lifebuoy/);
});
