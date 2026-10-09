<!-- markdownlint-disable-file MD041 -->
<!--
PR title format: `#<issue> <short summary>`, for example `#40 Add governance templates`.
One task = one branch = one PR. Agents branch as `claude/<issue-number>-<short-slug>`.
Definition of Done: https://github.com/batkomahno2008/httpenv/blob/main/CONTRIBUTING.md#definition-of-done
-->

Closes #

## Summary

<!-- What changed and why, in a few bullets. Link the contract clause or decision it implements. -->

-

## Verification evidence

<!--
Paste the commands you ran locally and their results (lint, typecheck, unit tests + coverage,
docker build, e2e). Trim long output, but keep the pass/fail lines and coverage numbers.
Say plainly what you could NOT verify locally (e.g. arm/v7 without QEMU) and how CI covers it.
-->

```text
$ <command>
<result>
```

Not verified locally:

## Multi-arch impact

<!-- Does this affect the image on linux/amd64, linux/arm64 or linux/arm/v7? How was each checked? -->

- [ ] No image or runtime change
- [ ] Image changes; verified on: <!-- amd64 / arm64 / arm/v7 -->

## Risks and rollback

<!-- What could break, who would notice, and how to revert. "Low: docs only" is a valid answer. -->

## Needs from the repository owner

<!-- Admin settings, secrets, branch protection, rulesets, package visibility. Write "None" if nothing. -->

None

## Checklist

- [ ] PR title is `#<issue> <summary>` and the body says `Closes #<issue>`
- [ ] Only files in this task's scope are changed; no unrelated refactors
- [ ] Tests added or updated for the changed behaviour (or not applicable, with a reason above)
- [ ] No test is skipped, disabled or quarantined to make CI green
- [ ] Coverage stays at or above 90% lines and branches
- [ ] No runtime dependencies added (`node:` built-ins only)
- [ ] Every GitHub Action is pinned to a full commit SHA (with a version comment)
- [ ] Images publish to GHCR only, and only after tests pass; no Docker Hub references
- [ ] No secrets, tokens or credentials committed
- [ ] Docs updated (README, CONTRIBUTING, `docs/`) if behaviour, usage or process changed
- [ ] Meets the [Definition of Done](https://github.com/batkomahno2008/httpenv/blob/main/CONTRIBUTING.md#definition-of-done)
