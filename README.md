# Mica

**Versioned, structured content blocks for Obsidian.** Fast nested tabs and grids, first-class per-block version history, and Meld-class diffing — markdown-native, drivable by API, and built so the old `obsidian-tabs` corruption bug is impossible by construction.

Built on a pure **Rust → WebAssembly** core (fence scanner, CST, diff, hashing, ids) behind a **TypeScript / CodeMirror 6** shell, following one discipline everywhere: _derive state, never cache it._

## Syntax

A block is a fenced code block tagged `mica` carrying a stable id; structure uses colon-fence directives, so nesting adds colons — never backticks:

````
```mica id=0192…7c name="Review Instruments"
::::tabs
:::tab Kernel
> [!success] Review Kernel

your markdown here…
:::
:::tab Frame Gate
…
:::
::::
```
````

`:::tabs` / `:::tab`, `:::grid {cols=3}` / `:::cell`, and native Obsidian callouts all nest freely. Mica auto-sizes the outer fence above any inner code fence, so you never count backticks.

## Three modes

- **Reading view** — interactive, read-only tabs/grids.
- **Live Preview** — rendered tabs with inline per-tab editing (✎ Edit); click into a block to reveal raw source.
- **Source mode** — plain markdown, byte-exact round-trip.

## Versioning

Every save snapshots changed blocks into a visible, co-located `<Note>.mica/` sidecar (content-addressed BLAKE3 objects + an append-only `ledger.jsonl`). Compare versions Meld-style (inline / side-by-side, char / word / line, swap base, copy patch) and revert losslessly. History survives renames and moves — identity is a UUID carried in the content, not the path — and self-heals via **Repair**.

## Commands

- **Prepare note for Mica (add ids)** — add `mica-id` frontmatter + block ids.
- **Snapshot versions now** · **Compare block versions** · **Repair history (reconcile)**.
- **Migrate tabs → Mica (active note)** — convert legacy `obsidian-tabs` blocks.
- **Run instruction (JSON from clipboard)** — drive the API manually.

## Scripting API

Everything is reachable headlessly via `window.mica` (dev console, js-engine / customjs / templater) or the **file-bridge**: drop `{ "verb": "versions.diff", "args": [...] }` into `mica-bridge/inbox/<id>.json`; Mica executes it and writes `mica-bridge/outbox/<id>.json`. Verbs: `block.list/read/update`, `versions.list/snapshot/revert/diff/patch`, `prepare`, `repair`.

## Develop

```sh
just bootstrap   # pnpm install + add the wasm32 target
just build       # wasm-pack + bundled main.js
just link        # symlink into your vault for live testing
just check       # typecheck, lint, format-check, rust tests
pnpm smoke       # WASM boundary test in Node (no Obsidian needed)
just e2e         # full contract + rendering suite in a REAL sandboxed Obsidian (Xvfb)
just e2e-cli     # contract checks via the official Obsidian CLI (skips if not activated)
```

Requirements: Node + pnpm, the Rust toolchain with `wasm-pack` and the `wasm32-unknown-unknown` target, and `just`.

## Docs

[`PRD.md`](PRD.md) (vision) · [`ARCHITECTURE.md`](ARCHITECTURE.md) (how it works) · [`DESIGN.md`](DESIGN.md) (UX & syntax) · [`state.md`](state.md) (in-flight work).

## License

MIT
