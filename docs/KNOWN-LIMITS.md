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
   - `OverviewPage.jsx`: `openLink(doc)`, the same fixed `/files?path=` start.
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

## Lint

`npm run lint` exists in `client` and `server` (ESLint, recommended rules only, no style rules). Both exit 0. The remaining
warnings are unused variables and arguments in older code, left alone on purpose: clearing them would touch many files that
this change had no reason to open.
