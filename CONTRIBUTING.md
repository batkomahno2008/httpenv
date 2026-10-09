# Contributing to httpenv

`httpenv` is a tiny HTTP server that returns its environment variables as JSON on port 8080.
The project is migrating from Go to a strictly typed Node.js/TypeScript implementation with a fully gated CI pipeline.
The plan, fixed decisions and work breakdown live in the master issue, batkomahno2008/httpenv#41.

## How work is organised

- Every change starts from an issue. Use the **Task** or **Bug report** issue form.
- One task = one branch = one pull request. Agents name branches `claude/<issue-number>-<short-slug>`.
- Each task has an owner role and, optionally, a reviewer role (`role:*` labels).
- Stay inside the files your task owns (see the ownership table in batkomahno2008/httpenv#41, section 7).
  [`.github/CODEOWNERS`](.github/CODEOWNERS) mirrors that table.
- Do not push to `main`. Do not merge your own pull request.

## Pull requests

- Title: `#<issue> <short summary>`. Body: `Closes #<issue>`.
- Fill in every section of the [pull request template](.github/pull_request_template.md), including
  the commands you ran and their results.
- If the change needs a repository-admin action (branch protection, rulesets, secrets, package settings),
  write the exact steps in the "Needs from the repository owner" section. Contributors do not change these settings.

## Definition of Done

A task is done only when **all** of the following are true:

1. **Scope:** every item in the issue's Tasks list and acceptance criteria is met, and nothing else was changed.
2. **Tests:** changed behaviour is covered by unit and/or e2e tests. No test was skipped, disabled or quarantined.
3. **Coverage:** unit coverage is at least 90% for lines and branches.
4. **Quality gates:** lint, type checks and every required CI check pass on the pull request.
5. **Multi-arch:** if the image changed, it builds and runs on `linux/amd64`, `linux/arm64` and `linux/arm/v7`.
6. **Supply chain:** no runtime dependencies were added; every GitHub Action is pinned to a full commit SHA;
   images publish to GHCR only, and only after tests pass; no secrets are committed.
7. **Behaviour:** the response still matches the behaviour contract, unless the change is an intentional, documented fix.
8. **Docs:** README, CONTRIBUTING or `docs/` are updated when usage, behaviour or process changed.
9. **Evidence:** the pull request lists the verification commands and their results, plus anything that could not be verified locally.
10. **Review:** the reviewer role named in the issue and a code owner have reviewed the pull request, and the linked issue closes on merge.
