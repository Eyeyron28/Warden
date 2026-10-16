# Known limits

Things we know about and have decided to live with for now, with the evidence that backs each decision. The security limits of the
product itself (not end-to-end encrypted, the server sees file names, and so on) are on the Privacy page and in
`client/src/pages/public/limits.js`; this file is about the project's own loose ends.

## Dependency advisories (client, `npm audit --omit=dev`)

Checked 2026-10-15. The server has no advisories. The client has two, both in `react-router` / `react-router-dom` 6.30.6 (the
newest 6.x). npm's only fix is `react-router-dom@7.18.4`, a major upgrade, which is out of scope until after the course
deadline. Both advisories cover every 6.x release, so no patch or minor update inside version 6 resolves them.

| Advisory | What it is | Affects this app? |
|---|---|---|
| [GHSA-wrjc-x8rr-h8h6](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6) (moderate, a bypass of CVE-2025-68470) | An open redirect: a link or `navigate()` target that starts with `/\` is read by the router as a path but by a browser as `//host`, so it can leave the site. It needs a navigation target that a person controls. | No (see below) |
| [GHSA-337j-9hxr-rhxg](https://github.com/advisories/GHSA-337j-9hxr-rhxg) (moderate) | `deserializeErrors()` can construct an unexpected object from server-rendered hydration data. It needs server-side rendering with a data router. | No (see below) |

### Why the app is not exposed, and how that was checked

**GHSA-wrjc-x8rr-h8h6 (backslash redirect).**

1. Every navigation target in `client/src` was listed (`<Link to>`, `<NavLink to>`, `<Navigate to>` and `navigate()`):
   `grep -rnE "navigate\(|<Navigate|<Link to=|<NavLink to=" client/src`. All but a handful are string literals starting with
   `/` and a letter, `/#` or `/?`, which cannot start with `//` or `/\`.
2. The ones that are computed, and why each is safe:
   - `LoginPage.jsx`: the only place an address comes from outside (the page you were sent from, kept in router state). It goes
     through `safeRedirectPath()` (`client/src/utils/safeRedirect.js`), which accepts only a same-origin path, rejects a backslash,
     `//`, any scheme and control characters, also after percent-decoding, and falls back to `/files`.
   - `FilesPage.jsx` and `FolderTree.jsx`: `` `/files?path=${encodeURIComponent(path)}` ``, which always starts with the fixed text
     `/files`.
   - `OverviewPage.jsx` and `DriveList.jsx` (the Starred and Recent lists): `openLink(doc)`, the same fixed `/files?path=` start.
   - `ExportPage.jsx` (the import report): `filesLink(job.destination)`, the same helper.
   - `TransferTray.jsx` (the transfer tray): `row.actions.show`, built by `utils/trayModel.js` from `filesLink()` or `/export` only.
   - `ImportCard.jsx` (the former import card, now part of the tray): `navigate(view.target)`, where `utils/importCard.js` returns only `/export` or `filesLink()`, which
     is `/files` with an encoded `?path=`.
   - `VaultHealthCard.jsx`: `item.actionPath`, fixed paths written by the server in `server/utils/vaultHealth.js`.
   - `SiteHeader.jsx`, `EmergencyShell.jsx`: constant lists, and `emergencyRedirect()` returns one of the app's own fixed paths.
3. `client/src/utils/router-advisory.test.js` fails when a new computed navigation target appears that is not on that reviewed list,
   so this analysis cannot quietly go stale. `client/src/utils/safeRedirect.test.js` covers the guard itself.

**GHSA-337j-9hxr-rhxg (`deserializeErrors`).** It is reached only through server-side rendering with a data router.

1. The app is a client-only single-page app. `client/src/main.jsx` uses `<BrowserRouter>` and `createRoot`; there is no
   `createBrowserRouter`, `RouterProvider`, `StaticRouter`, `hydrateRoot` or `window.__staticRouterHydrationData` anywhere in
   `client/src` (the same test checks this).
2. The production build confirms it: `grep -c "__staticRouterHydrationData" client/dist/assets/index-*.js` finds nothing, and
   `deserializeErrors` does not appear in any built file.

**When to remove this entry:** upgrade to react-router-dom 7.18 or later, run `npm audit --omit=dev`, and delete the two rows. The
upgrade is a major version, so the routing code (`App.jsx`, `main.jsx`) and the tests that read it need to be re-checked.

## Same-name files and double uploads

- A file whose name is already used in the folder is saved with a counter ("report (1).pdf", "report (2).pdf"; `server/utils/uniqueName.js`).
  The same helper names renames and files restored from Trash. Move and batch Move keep their older rule (a taken name is a reported
  conflict, nothing moves).
- **The remaining race:** the counter is chosen by reading the folder's names and then saving; nothing locks between the two, and there
  is deliberately no unique index on file names (older data may already contain duplicates, and the index migration must never fail
  on it). Two *different* uploads of the same name that reach the database at the same instant can therefore both be given the same
  number. It is harmless: each is its own document, nothing is overwritten, and either can be renamed.
- An upload sent twice (a double click, a retry after a slow answer) is a different matter and is handled exactly: the browser puts a
  random UUID on every upload attempt (`uploadKey`), a partial unique index on `{ userId, uploadKey }` lets only one document have it,
  and the second request answers with the first document without storing or charging anything. Uploads from older clients or scripts
  that send no key are not protected against being sent twice.
- Previews are drawn after an upload has been saved (the upload no longer waits for pdf.js). If the browser is closed in that moment the
  file has no preview until "Background previews" or opening the file makes one.

## Zip import as a background job

The import runs as an app-level job (`client/src/services/importJob.js`), not inside the Import page, so changing page does not touch
it. The card at the bottom right (`components/ImportCard.jsx`) follows it on every signed-in page.

- **It is not atomic.** Every file is its own upload. Cancelling, a stop because the session ended, a closed tab or a failure part-way
  leaves the files already imported in the vault; nothing is rolled back. The Import page and the card say so.
- **It lives in this tab's memory only.** A reload or a closed tab ends it (the browser warns while one runs, with its own generic
  "leave this page?" text, which a page cannot customise). The zip's bytes and the per-file report are never written to localStorage,
  sessionStorage, IndexedDB or a cache; the zip bytes are dropped as soon as the job ends, and the report is dropped on sign-out,
  Lock vault, a session that ended, another account signing in, a reload, or the next import.
- **The session:** every upload slides the 30-minute idle timer (`server/utils/sessionStore.js`), so a busy import does not idle out. The
  12-hour absolute limit (SESSION_ABSOLUTE_HOURS) still applies: an import that outlasts it stops cleanly, keeps what was imported and
  says so on the card (with no file names).
- **One at a time, one tab.** A second import in the same tab is refused. Two tabs each have their own job and their own memory; nothing
  coordinates them, and each upload counts toward the same storage quota.
- **Not tested:** a run that crosses the 12-hour session limit, closing a real tab (the warning was verified through a reload; browsers
  show their own wording and some mobile browsers show none), and sign-out from another device while an import runs in a tab (the
  server's 401 stops the job the same way an expiry does, covered by a unit test but not a second browser).

## Private notes and version history

Both are encrypted **by the server with the vault key**, the same way a file or a share's purpose label is. They are **not end-to-end
encrypted**: while you are signed in the server holds the vault key for each request, so a compromised running server could read a
note or an earlier version at that moment, exactly as it could read a file you open. At rest the database holds only ciphertext
(a note is `noteCipher` / `noteIv` / `noteAuthTag` on the document; a version is a `DocumentVersion` record with its own IV, auth tag and
bytes).

What the code guarantees, each with a test (`server/test/notes-versions.test.js`):

- A note is plain text, at most 2000 characters, never in a share, never in an Emergency Access answer (not even whether one exists),
  never searched, and never in the activity log (the log records only that one was set, changed or cleared).
- Notes and earlier versions are **not in the zip export** (it holds each file as it is now), and the Export / Import page says so.
- Up to 3 earlier versions per file, each kept 30 days (a TTL index on `expiresAt`, as for Trash). Version bytes count against the
  account's storage quota; a new version that does not fit is refused with the normal upload error.
- A file purged from Trash, a version past its date, and an account deletion each remove the version records, which hold their own
  bytes (there is no other copy). When the database's own TTL removes a *file*, no code runs, so its versions are removed by the next
  purge sweep (`pruneOrphanVersions`, run with every purge and on the account's own list request); they would in any case expire
  by their own 30 days.

Not covered:

- Preview thumbnails (at most 40 KB each, kept with the file and with each version) are not counted in the quota. That was already
  true of the current file's thumbnail; a version adds at most one more per version.
- The quota check is not atomic: two uploads racing can each pass it, as before.
- Two people cannot edit a note together; the last save wins.
- Restoring a version does not bring back share links that were stopped, and does not change ones that are active (a share holds its
  own encrypted copy of what was shared).

## Lint

`npm run lint` exists in `client` and `server` (ESLint, recommended rules only, no style rules). Both exit 0. The remaining
warnings are unused variables and arguments in older code, left alone on purpose: clearing them would touch many files that
this change had no reason to open.
