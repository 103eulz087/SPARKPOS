---
description: Generate an end-of-day report from today's file changes
---

Generate an end-of-day report for today's work session on this project.

This project is not a git repository — do not run git commands. Instead, find
files modified today (source only, skip build/dependency output):

1. Run this in the Bash tool from the solution root:
   ```
   find src web/src database -type f \
     \( -iname "*.cs" -o -iname "*.jsx" -o -iname "*.js" -o -iname "*.sql" \) \
     -newermt "$(date +%Y-%m-%d)" \
     -not -path "*/node_modules/*" -not -path "*/bin/*" -not -path "*/obj/*" -not -path "*/dist/*"
   ```
   If that returns nothing, today's session made no source changes yet — say so
   plainly rather than inventing content for the report.
2. For each file returned, read enough of it (or diff against memory of the
   conversation, if this report is being generated at the end of the same
   session that made the changes) to briefly note: which module/form/SP was
   touched, what was done (fix / new feature / refactor), and whether it's
   complete or still in progress.
3. Call out any of the known bug patterns from CLAUDE.md that came up today
   so they're visible at a glance.
4. List anything left open or blocked, and anything that needs the user's
   decision before continuing tomorrow.
5. Write the report to `docs/eod-reports/YYYY-MM-DD.md` (create the folder if
   it doesn't exist), using today's date. Keep it under one page — headers:
   "Completed", "In Progress", "Bugs Encountered", "Open Questions / Next Up".

Do not invent work that wasn't actually done — base everything on the modified
files and the actual conversation/session, not assumptions.
