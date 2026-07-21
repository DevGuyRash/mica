# Mica — Active State

- WHEN preparing the public release THEN you SHALL complete the physical Android/iOS, real two-device Obsidian Sync, clean-vault artifact install, canonical public-repository, and community-submission gates in `RELEASING.md`.
- The v0.2 rebuild still needs daily-driver use in a real vault; focus on editor feel, pointer drag/drop, folds, the versions timeline, and grid boundary controls.
- The external 46-file legacy migration corpus and sustained 13k-line/60-fps performance claim still need recorded evidence; the PRD marks both as unverified.
- WHEN bumping the externalized CodeMirror/Lezer packages THEN you SHALL run a live-Obsidian highlighting check; TypeScript remains pinned to `~5.9` until its ESLint toolchain supports the next major.
- CLI `watch` and a concurrently running Obsidian instance remain an unverified operating mode; use `watch` with Obsidian closed until that concurrency case is exercised.
