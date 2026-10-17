# Warden documents

This folder holds the documents for the defense and the notes about how Warden works. Warden is a student project (PHINMA University of
Pangasinan). It is **not end-to-end encrypted**, and its upload scanner is simple rules, not an antivirus.

Where a fact could not be checked in the repo, the document says **[to confirm]**.

## Start here

| File | What it is |
|---|---|
| [RUBRIC-MAP.md](RUBRIC-MAP.md) | Each rubric criterion mapped to code, test, document and honest gap. |
| [DEMO-SCRIPT.md](DEMO-SCRIPT.md) | The 10 minute demo on the live site, with fallbacks and a checklist. |
| [TEST-EVIDENCE.md](TEST-EVIDENCE.md) | How to run every test and check script, what each proves, and what we could not verify live. |

## Defense documents

| File | What it is |
|---|---|
| [DESIGN-JUSTIFICATION.md](DESIGN-JUSTIFICATION.md) | Why a hosted vault, why these choices, what we kept and removed. |
| [SCALABILITY-AND-GOVERNANCE.md](SCALABILITY-AND-GOVERNANCE.md) | Current capacity, 10x and 100x estimates (no load test), future plan, governance. |
| [ROLES-AND-RATE-LIMITS.md](ROLES-AND-RATE-LIMITS.md) | Why there is no admin role, the role matrix, and every rate limiter. |
| [THREAT-MODEL.md](THREAT-MODEL.md) | Assets, actors, threats, what stops each, and the risk that is left. |
| [PRIVACY-AND-DPA.md](PRIVACY-AND-DPA.md) | Personal data, encryption, retention, consent, rights and the Data Privacy Act (RA 10173). Not legal advice. |
| [FUTURE-WORK.md](FUTURE-WORK.md) | Ideas for later. None is built. |
| [PART1-NEEDED.md](PART1-NEEDED.md) | What Part 1 (System Justification) still needs. No survey has been analyzed yet. |

## How the system works (existing documents)

| File | What it is |
|---|---|
| [QUARANTINE.md](QUARANTINE.md) | The upload scanner: rules, weights, verdicts, held files, release, honest limits. |
| [KNOWN-LIMITS.md](KNOWN-LIMITS.md) | Loose ends we know about, including dependency advisories, import behaviour and the upload limits. |
| [DEMO-EMERGENCY.md](DEMO-EMERGENCY.md) | The longer Emergency Access demo. |
| [SCORING-AUDIT.md](SCORING-AUDIT.md) | A read-only audit dated 15 October 2026, with route tables and live probes. Some gaps in it were closed later (see the end of [RUBRIC-MAP.md](RUBRIC-MAP.md)). |
| [screenshots/](screenshots/) | Screenshots from the browser checks. |

## Files outside this folder

| File | What it is |
|---|---|
| [../README.md](../README.md) | How to run the dev servers and the tests. |
| [../DEPLOY.md](../DEPLOY.md) | The Vercel and MongoDB Atlas runbook, environment variable names, cron jobs, the daily mail budget, and security events in the log. |
| [../vercel.json](../vercel.json) | Headers, CSP, cron schedule and function settings. |

## Contact

wardenvaultapp@gmail.com. Source: github.com/Eyeyron28/Warden.
