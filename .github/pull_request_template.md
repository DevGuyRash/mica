## Change

Describe the problem and resulting behavior.

## Exact Community Review evidence

- Full current `review` HEAD SHA:
- **Review branch → Run preview scan** report link or retained evidence:
- Scan completion time and result:
- Official preview result and error count (required: pass, zero errors):
- Warning count and disposition for each: fixed, or intentional necessity with
  reviewed reason (keep unsuppressed DOM/CSS boundary cases visible):
- Recommendations and optional capabilities/attestations still unverified:

- [ ] This PR is `review` → `main`, and the report covers its exact current head.
- [ ] The official preview passed with zero errors. Every warning is fixed or
      has an explicit reviewed reason for intentional necessity; none is
      unreviewed. Any new commit requires a fresh preview on its full SHA before
      merge, tagging or publication.

GitHub PR checks are separate from the Obsidian preview; identify each result
by its actual source rather than assuming an Obsidian status check exists.

## Local preflight and qualification

- `pnpm run lint:obsidian` actual result and visible warnings:
- Warning dispositions: exact component/rule, fix or reviewed necessity; use
  the scoped DOM/CSS reasons in `RELEASING.md`, not a numeric baseline:
- Other checks actually completed, and gates still pending:

## Promotion and delivery

Preserve the scanned candidate's source and root manifest during merge. Content
changes return through `review` and a fresh preview. After merge, follow
[RELEASING.md](../RELEASING.md) for the exact `x.y.z` tag, three runtime assets,
download/hash verification and separate installation/activation outcomes.
