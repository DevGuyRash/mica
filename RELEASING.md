# Releasing mica

The checklist for shipping the plugin and the CLI. Everything here is a
human decision gate — automation covers the verification, not the judgment.

## Plugin → Obsidian community plugins

1. **Gate green** (see `AGENTS.md` for the full command set): Rust tests,
   clippy `-D warnings`, fmt, typecheck, lint, build, full e2e under Xvfb.
2. **Version bump**: `manifest.json` + `package.json` versions agree;
   `versions.json` maps the plugin version to `minAppVersion`.
3. **Artifacts**: a release build produces `main.js`, `manifest.json`,
   `styles.css` (that's the whole distribution — the WASM is inlined).
4. **manifest.json review**: id (`mica`), name, description, author,
   `minAppVersion` honest (CSS relative color syntax needs a recent
   Electron — verify against the oldest supported installer).
5. **Docs pass**: README screenshots current; `ARCHITECTURE.md` and
   `DESIGN.md` match shipped behavior; PRD claims still true.
6. **GitHub release**: tag `x.y.z` with the three artifacts attached.
7. **Community submission** (first release only): PR against
   `obsidianmd/obsidian-releases` adding the repo to
   `community-plugins.json`; respond to automated checks (no
   `innerHTML`, no remote code, sample vault review).
8. **Post-release smoke**: install from the release artifacts into a
   clean vault (not the dev symlink) and run through: create block, tabs,
   grid, versions timeline, CLI against the same vault.

## CLI packaging

- `cargo install --path crates/mica-cli` works today; packaging beyond
  that (cargo-dist for prebuilt binaries, AUR for Arch) is worth doing
  when the plugin ships publicly — one release pipeline, both artifacts.
- The CLI and plugin share the sidecar format (including the 4 KB
  compression gate) — ship them from the same tag so formats never skew.

## Known constraints to re-verify at release time

- `typescript` pinned `~5.9` until typescript-eslint supports 7.x.
- The bundled `@codemirror/lang-markdown` must keep importing Obsidian's
  externalized `@codemirror/*`/`@lezer/*` (highlight tag identity).
- Obsidian Sync vs `ledger.jsonl` appends: reasoned-safe (append-only,
  order-independent fold) — worth one real two-device test before 1.0.
