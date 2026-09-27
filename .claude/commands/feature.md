---
description: Implement a feature/fix described in module/overview/scenario/task format, with plan-first workflow and automatic review
argument-hint: <module>...</module> <overview>...</overview> <task>...</task>
---

The user will describe a feature or fix using this format:

<module>which form/module this touches</module>
<overview>context — what exists today, why it's structured this way</overview>
<task>what to build or change</task>

Their request for this invocation:
$ARGUMENTS

Follow this workflow:

1. **Plan first.** Before writing any code, lay out your plan: what tables/
   columns change, what SPs you'll add or alter, what UI changes are needed,
   and how the pieces connect. If the task touches schema, UI, AND stored
   procedures (like most of these requests do), this step is mandatory —
   don't skip to implementation. Post the plan and proceed only once it's
   clear you're not making a silent wrong assumption about scope.

2. **Check CLAUDE.md's known bug patterns and conventions** against the plan
   before implementing.

3. **Implement.**

4. **Review before declaring done:**
   - If the task touched any stored procedure: dispatch the `sp-reviewer`
     subagent against it.
   - If the task touched any form/UserControl: dispatch the
     `ui-form-reviewer` subagent against it.
   - Report what each review found. Don't silently auto-fix everything it
     flags — surface it and confirm before changing anything not explicitly
     part of the original task.

5. **Summarize** what changed, what's still open/unbuilt (e.g. flagged as a
   deliberate follow-up), and any question that came up during the plan that
   still needs an answer.
