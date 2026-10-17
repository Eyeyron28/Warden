# What Part 1 still needs

Part 1 is the System Justification (30 percent of the grade, no code). Parts 2 and 3 (the system and its security) are mostly covered by
the code, the tests and the other files in `docs/`. Part 1 is not.

**No survey has been analyzed yet.** The repository holds no survey data, no results, no interview notes and no problem statement.
We did not invent any numbers, quotes or percentages in these documents, and we must not add any here. Everything in this file is
a list of what is missing, not an answer.

## What we have that Part 1 can use

- A working system with a clear security design (`docs/DESIGN-JUSTIFICATION.md`, `docs/THREAT-MODEL.md`).
- A list of what the system cannot do (`docs/KNOWN-LIMITS.md`).
- The Data Privacy Act mapping (`docs/PRIVACY-AND-DPA.md`).
- Future ideas (`docs/FUTURE-WORK.md`).

These show how we built the system. They do not show that anyone needs it. Part 1 has to show that.

## What Part 1 needs from us

| # | Item | What it must contain | Status |
|---|---|---|---|
| 1 | **Problem statement** | One clear paragraph: who has the problem, what the problem is, and why existing tools do not solve it well enough. | Not written |
| 2 | **Evidence of the problem** | Real evidence from real people or real sources: survey answers, interviews, reports about lost or leaked documents, local news, school or office cases. Each piece needs a source. | Not collected in the repo |
| 3 | **Research questions** | Three to five questions the survey and the system can answer. For example, how do students and staff store private documents now, what makes them stop trusting a tool, and would they use a vault like this. These are only examples to start from, not our questions. | Not written |
| 4 | **Method** | Quantitative method (survey), sample (who and how many), how respondents were chosen, the questions, the dates, and how we protect respondents' privacy. Say how the survey follows the Data Privacy Act. | Not written |
| 5 | **Survey instrument** | The exact questionnaire, and the consent text shown to respondents. | A Google Form, kept outside the repo. Copy the questions and the consent text into the paper. |
| 6 | **Survey results and analysis** | Raw counts, percentages, a table or chart for each question, and a short plain reading of each. State the sample size and the limits (a small sample of classmates is not the public). | **No survey has been analyzed yet.** |
| 7 | **Stakeholders** | Who uses it (owners, emergency contacts, people who receive share links), who runs it (us), who is affected (family members, schools, the National Privacy Commission as regulator). What each group needs from the system. | Not written. The role list in `docs/ROLES-AND-RATE-LIMITS.md` can help as a start. |
| 8 | **Related systems** | A short comparison with tools people already use (cloud drives, messaging apps, password managers). What they do, what they do not, and where Warden is different or weaker. Be honest about where it is weaker. | Not written |
| 9 | **Justification of the solution** | A link from each finding in the survey to a feature (for example, a finding about shared computers to the idle timeout). A feature with no finding behind it should be listed as our own idea. | Cannot be written until the survey is analyzed |
| 10 | **Limits of the study** | Sample size, who was left out, possible bias, and what the survey cannot tell us. | Not written |
| 11 | **References** | Cited sources in the format the course asks for. | Not written |

## Suggested order of work

1. Write the problem statement and the research questions (items 1 and 3). Do this first, because the survey questions follow from them.
2. Finish the survey instrument and its consent text (item 5). Run it if it has not been run.
3. Analyze the answers (item 6) and write what they say, even if they do not support the system.
4. Write stakeholders, related systems and the justification (items 7 to 9) using the real results.
5. Add limits and references (items 10 and 11).

## Warnings

- Do not copy numbers from other documents in this folder into Part 1 as if they were survey results. Test counts, bundle sizes and rate
  limits are system facts, not evidence of need.
- Do not describe Warden in Part 1 as end-to-end encrypted, as an antivirus, or as free of risk. It is none of those.
- Keep respondents' names and answers private. The survey is personal data too.
