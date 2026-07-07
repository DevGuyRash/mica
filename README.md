# Mica

**Versioned, structured content blocks for Obsidian.** Fast nested tabs and grids, first-class per-block version history, and Meld-class diffing — markdown-native, drivable by API, and built so the old `obsidian-tabs` corruption bug is impossible by construction.

> Status: early development (M0 scaffold). See [`PRD.md`](PRD.md) (vision), [`ARCHITECTURE.md`](ARCHITECTURE.md) (how it works), [`DESIGN.md`](DESIGN.md) (UX & syntax), and [`state.md`](state.md) (in-flight work).

## Develop

```sh
just bootstrap   # pnpm install + add the wasm32 target
just build       # wasm-pack + bundled main.js
just link        # symlink into your vault for live testing
just dev         # watch-rebuild main.js
just check       # typecheck, lint, format-check, rust tests
```

Requirements: Node + pnpm, the Rust toolchain with `wasm-pack` and the `wasm32-unknown-unknown` target, and `just`.

## Architecture in one line

A pure **Rust → WASM** core (fence scanner, CST, diff, hashing, ids) behind a **TypeScript / CodeMirror 6** shell, following one discipline everywhere: _derive state, never cache it._

## License

MIT
