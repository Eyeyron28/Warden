# Future work

**None of these is built.** This is a list of ideas, with the reason for each and the main problem we expect. We wrote them down so the
panel can see what we would do next. Please do not read any of them as a feature that exists.

| # | Idea | What it would be | Why | Main problem | Status |
|---|---|---|---|---|---|
| 1 | Request access | A person who has a share or folder link can ask the owner for access. The owner approves or says no. | Today a viewer who is refused can only email the owner by hand. | It needs a new public route, more email, and its own rate limits. Spam is the risk. | Not built |
| 2 | Labels and links | Free text labels on files, and links between related files. | Folders alone are not enough when one file belongs to two topics. | Labels would be file metadata that the server can read, unless they are encrypted like notes. | Not built |
| 3 | Rule-based tagging | Suggest a label from simple rules, for example a file name or a type. | Saves typing. | Simple rules will be wrong sometimes. It must only suggest. | Not built |
| 4 | Local ML scanner | A model that runs in the browser and reads a file before upload. | The current scanner only uses fixed rules. | A model in the browser adds size and can still be wrong. We would not call it an antivirus. | Not built |
| 5 | Encrypted backup file | The user downloads one file that holds the whole vault, still encrypted, and can load it later. | Atlas M0 has no automatic backups. Today Export gives a plain zip. | Key handling. A backup is only as safe as the key the user keeps. | Not built |
| 6 | QR sign-in with approval | Sign in on a new device by scanning a code from a device that is already signed in, and approving it. | Faster than waiting for an email code. | It needs a safe way to bind the two devices. Phishing is the risk. | Not built |
| 7 | Proof receipts | A signed receipt that a file existed at a time, with its hash. | Useful for documents that must be shown later. | A receipt from our own key proves little to an outsider. Time stamping from a third party would be better. | Not built |
| 8 | Canary documents | A fake file that sends an alert to the owner when someone opens it. | An early sign that a session or a share was misused. | Alerts must not leak names. False alarms from our own previews. | Not built |
| 9 | Safe send | Send a file to one person with the email gate, a password and a short expiry set by default. | Fewer mistakes than a loose link. | It is mostly a new screen over the share feature that exists. | Not built |
| 10 | Social recovery | Trusted people each hold a piece of a recovery secret. A few of them together can recover the vault. | Losing both the password and the recovery key now loses the vault. | Hard to explain to users. It adds a new attack path. | Not built |
| 11 | Passkeys | Sign in with a passkey instead of the emailed code. | A stronger second factor than email. | Browser support, recovery when a device is lost, and how the passkey interacts with the key that wraps the vault key. | Not built |
| 12 | Per-file permissions | Share a single file with different people at different levels. | Today access is by folder scope (Emergency) or by link. | A bigger permission model means more tests like `cross-user.test.js`. | Not built |
| 13 | Totals-only admin page | A page for the operator that shows counts only, such as accounts, storage used and mail sent today. It would show no names and no content. | We have no admin role. The operator cannot see how full the free database is without opening Atlas. | Even totals need a way to sign in as the operator. That is a new high-value account. | Not built |

## Smaller fixes we know about

These are also **not done**:

- Use object storage for file bytes (see `docs/SCALABILITY-AND-GOVERNANCE.md`).
- Add paging for the file list.
- Add a central validation helper for request bodies.
- Add HTTP-level tests that send hostile input to every owner route.
- Upgrade `react-router-dom` to version 7 and remove the two advisories listed in `docs/KNOWN-LIMITS.md`.
- Use a mail service on a domain we own, with SPF, DKIM and DMARC.
- Write a breach notification procedure and name a data protection officer (see `docs/PRIVACY-AND-DPA.md`).
- Test in Firefox and Safari, and on real phones.
- Run a load test.
