# Quarantine

Warden checks every upload with a few simple rules. A file that looks risky is **held** (saved, encrypted, but isolated) until its
owner decides; a file that matches the rules Warden refuses outright is **not saved**. This is a set of simple rules over a file's
bytes. It is **not an antivirus**, and the page says so in its first sentence.

## What is checked, and why

The scanner is one pure function (`server/utils/fileScanner.js`, `scanBuffer({ name, type, buffer })`). It reads the bytes of the
upload before they are encrypted, and nothing else: it makes no network call, touches no file, starts no process, never opens,
renders, runs or decompresses what it reads (a zip is read through its list of names and sizes at the end of the file only), and
keeps nothing. Every rule has a code, a weight and a plain sentence, kept in one table (`REASONS`) that the server sends with the
codes, so the browser has no second copy of the wording.

| Code | Weight | What it looks for | Why |
|---|---|---|---|
| `TYPE_MISMATCH` | 30 | The name (or the claimed type) says one kind of file, the first bytes say another: a `.pdf` that is not a PDF, a `.txt` that is a picture. | A disguised file is a common way to get something opened that would not be opened otherwise. Alone it is only noted (below the threshold). |
| `DOUBLE_EXTENSION` | 45 | A name that ends like a program or script (`exe dll scr bat cmd com msi js jse vbs vbe wsf ps1 lnk jar hta apk`), hides one behind a document ending (`report.pdf.exe`, `invoice.docx.js`, `report.exe.txt`), or uses a right-to-left override character to reverse what the ending looks like. | The name is what a person trusts. |
| `PDF_ACTIVE` | 45 | A PDF that contains `/JavaScript`, `/JS`, `/OpenAction`, `/AA`, `/Launch`, `/RichMedia` or `/EmbeddedFile` (searched as bytes, as whole names). | Active content is what a malicious PDF uses. Many honest forms have it too, which is why this is a hold, not a refusal. |
| `OFFICE_MACRO` | 60 | An Office Open XML zip with `vbaProject.bin`, `vbaData.xml` or macro sheets (names in the zip directory), or an old OLE Office file with VBA streams or auto-open markers. | Macros are small programs that run when the file is opened. |
| `ACTIVE_MARKUP` | 45 | Text, SVG or HTML with `<script`, `javascript:` or (in markup) an `on…=` event attribute. | A browser would run it. |
| `ARCHIVE_ABUSE` | 50 | A zip with more than 1000 entries, a declared expansion ratio above 100 (for entries over 1 MB), more than 64 MB declared in all, another archive inside it, `../` or absolute paths, encrypted entries, or sizes it cannot read (zip64). The limits are the zip importer's own. | A zip can hide a bomb or something it will not let us look at. Encrypted entries cannot be inspected at all, so they are held. |
| `EXECUTABLE_CONTENT` | 100, **blocked** | The bytes are a Windows program (an `MZ` header with a real `PE` header), an ELF program or a Mach-O program, whatever the name says. | There is no honest reason to keep a program in a document vault disguised as something else. |
| `KNOWN_TEST_SIGNATURE` | 100, **blocked** | The standard antivirus test string, anywhere in the file. | It proves the rule works without any real malware. The string is joined from parts at run time: no file of the project holds it whole. |
| `SCAN_ERROR` | 0 | The scanner itself failed. | See below. |

**Verdicts.** `blocked` only for `EXECUTABLE_CONTENT` and `KNOWN_TEST_SIGNATURE`. Otherwise the score is the sum of the weights of
the rules that matched (capped at 100): at or above **40** the verdict is `suspicious`; below it, `clean`. A normal PDF form with
JavaScript is therefore suspicious, never blocked, so a false positive costs one click.

**Limits.** At most 1 MB from the start and 1 MB from the end of a file are searched (a 4 MB upload is scanned in about 3 ms; a test
fails above 50 ms). If the scanner throws, the file is saved as normal with `scan.verdict = "unchecked"` and the reason
`SCAN_ERROR`, one security-log line is written (no name, no content), and the upload does not fail: a scanner bug never costs
anyone a file.

## What happens to each verdict

- **clean / unchecked**: normal.
- **blocked**: refused with `422 FILE_BLOCKED` and the reasons. Nothing is stored and nothing counts against the quota. Sending the
  same upload again (same `uploadKey`) is refused the same way. The tray says **Not saved**.
- **suspicious**: saved encrypted like any file, with `quarantine.state = "held"`. The answer says `held: true` with the reasons. The
  tray says **Held for review**. A held file gets no preview image.
- **a new version** of a file that is suspicious or blocked is refused (the current version stays); the message says to upload it as
  a separate file if the person wants it held. A held file cannot receive, restore or download versions.
- **zip import**: every file in the zip goes through the same upload, so each is judged on its own, and the import report counts
  imported, held and not saved.

## What "isolated" means

A held file is not in Files, Recent, Starred, Photos, Shared, search, or the folder tree's file list (every read that builds a list
leaves out `quarantine.state = "held"`; a file with no such field, everything uploaded before this existed, is not held). It is only
in `GET /api/quarantine`, for its owner.

- Preview, thumbnail, download, recording a download, share creation and any new version: **`409 QUARANTINED`**.
- The zip export is built from the file list, so it leaves held files out, and the result says how many were left out.
- An Emergency Access session never lists or reads a held file (it gets the same 404 as for a file that is not there), cannot call
  `/api/quarantine` or release anything (403, read-only), and the allowlist is unchanged.
- Moving, renaming, starring, notes, trashing and permanent delete still work. Delete moves it to Trash as usual and the held state
  stays on it (a restored file is still held).
- A held file still counts toward the storage quota: it is stored.
- Another account's held file is never listed, read or released (the same 404 as everywhere else).

## Release

`POST /api/documents/:id/quarantine/release` with `{ "confirm": "RELEASE" }`, owner only. Without the exact word the answer is
`400 RELEASE_CONFIRM` and nothing changes. With it the file becomes `quarantine.state = "released"` and behaves like any other.
`scan.verdict` stays `suspicious`, so the Details panel says **Released after review** and stays honest. No email is sent (the mail
budget is untouched). The route has its own per-account rate limit. The page asks for the word in a dialog that explains the risk;
the button stays off until the word matches.

## Audit and logs

The activity log has three events: `file_held`, `file_released`, `file_refused`. Each carries **reason codes only** in an optional
`detail` field, signed in the same hash chain as the rest of the event (only when set, so every older event still verifies). The
security log (the operator's log) has `file_held`, `file_refused`, `file_released` and `scan_error`, one JSON line each with the
codes as the bucket. Neither ever holds a file name, content, an email address, a token or an IP address.

## Where it lives

- `server/utils/fileScanner.js`: the rules, weights and sentences.
- `server/utils/quarantine.js`, `quarantineFilter.js`: the held filter, the 409/422 errors, the never-fail wrapper.
- `server/controllers/quarantine.controller.js`, `server/routes/quarantine.routes.js`: the list and the release.
- `Document.scan` and `Document.quarantine` in `server/models/Document.js`, with a partial index for the held list.
- Browser: `pages/QuarantinePage.jsx`, `components/QuarantineList.jsx`, `components/ReleaseDialog.jsx` (all loaded on demand), the
  sidebar badge, the tray's *Held for review* and *Not saved* rows, the Details line.

## Honest limits

- It is **simple rules, not an antivirus**. It does not know what a file does. A harmful file that matches none of the rules is
  clean; a harmless one that matches a rule is held.
- It cannot inspect **encrypted archives** (it holds them, because it cannot look), and cannot see inside archives it only lists.
- It detects **very little malware**: obfuscated PDF names, packed scripts, formats it does not list, and anything new all pass.
- It **runs no code at all**: it never opens or executes a file, so it cannot observe what a file would do. That is also why it is
  safe to run on anything.
- It checks only **what the server receives**, which is the allowed file types and sizes (up to 4 MB). Files uploaded **before this
  feature existed were not scanned** (they show as "Not scanned" in Details).
- A file held is still stored and still counts toward the quota until its owner deletes it.
- The test string only proves the pipeline works; it says nothing about real malware.

## Demo

`node scripts/make-demo-samples.mjs` (from the repository root) writes harmless files that the rules hold into `demo-samples/`
(ignored by git): a PDF with a JavaScript marker, an SVG with a script tag, a picture-named file that is really a PDF with active
content, and a text file with a program-looking double extension. Upload them to see **Held for review**, the **Quarantine** page,
**Release**, and the Details line. It creates no antivirus test file; to see **Not saved**, the browser check
(`npm run check:quarantine`, from `client`) builds the test string in memory while it runs.
