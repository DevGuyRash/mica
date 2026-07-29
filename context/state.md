# Mica — Active State

- WHEN preparing the public release THEN you SHALL complete the physical Android/iOS, real two-device Obsidian Sync, clean-vault artifact install, canonical public-repository, and community-submission gates in `RELEASING.md`.
- The v0.2 rebuild still needs daily-driver use in a real vault; focus on editor feel, pointer drag/drop, folds, the versions timeline, and grid boundary controls.
- The external 46-file legacy migration corpus and sustained 13k-line/60-fps performance claim still need recorded evidence; the PRD marks both as unverified.
- WHEN bumping the externalized CodeMirror/Lezer packages THEN you SHALL run a live-Obsidian highlighting check; TypeScript remains pinned to `~5.9` until its ESLint toolchain supports the next major.
- CLI `watch` and a concurrently running Obsidian instance remain an unverified operating mode; use `watch` with Obsidian closed until that concurrency case is exercised.
- Permanent checkpoint purging remains undecided: Sync-safe removal needs a durable tombstone and shared-object reachability rules; timeline removal is the only supported deletion path for now.
- Icon packs are the plugin's only network use and have not been exercised in a
  real vault. Every manifest URL was verified live, but enabling a pack,
  browsing its catalog, and rendering a chosen icon end to end has only been
  checked by unit tests. Twemoji and Iconoir have no name index, so they are
  reachable by typing `pack:name` and are not browsable.
- Legacy lineage inference is new: a ledger with no recorded parents now derives
  them when its head progression proves linearity. Vaults with older ledgers
  should confirm Auto resolves to the checkpoint they expect before trusting a
  comparison.
- Blocks written before 2026-07-12 may contain closers serialized onto a leaf
  (`a:::`). No current path produces this and diffs report it faithfully, but
  there is no repair command; deciding whether to offer one is open, since it
  would rewrite stored history.
- The Jul 2026 `brace-expansion` OOM advisory remains in WDIO/ESLint's dev-only transitive graph: v5 fixes the issue but is export-incompatible with their pinned `minimatch` branches. Production dependencies audit clean; remove this risk when those tools accept the patched major.
