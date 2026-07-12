# Mica task runner. Run `just` to list recipes.

default:
    @just --list

# Install JS deps and ensure the wasm target is present.
bootstrap:
    pnpm install
    rustup target add wasm32-unknown-unknown

# Build the Rust core to WASM (release).
wasm:
    pnpm run wasm

# Full production build: wasm + bundled main.js.
build:
    pnpm run build

# Watch-rebuild main.js for development (run `just wasm` first).
dev:
    pnpm run dev

# Typecheck, lint, format-check, and run Rust tests.
check:
    pnpm run check

# Autoformat TypeScript/JSON/Markdown and Rust.
fmt:
    pnpm run format
    cargo fmt --all

# Run the Rust test suite (core + CLI).
test:
    cargo test --workspace

# End-to-end tests in a real (sandboxed, downloaded) Obsidian under Xvfb.
e2e:
    pnpm run build
    xvfb-run -a pnpm run e2e

# Contract tests via the official Obsidian CLI against the RUNNING app
# (skips with instructions if the CLI isn't activated).
e2e-cli:
    sh tests/e2e-cli/run.sh

# Symlink the built plugin into the vault for live testing.
link:
    ln -sfn "$(pwd)" "$HOME/kingdom/.obsidian/plugins/mica"
    @echo "Linked -> $HOME/kingdom/.obsidian/plugins/mica"

# Build the standalone `mica` CLI (target/release/mica).
cli:
    cargo build --release -p mica-cli

# Remove build artifacts.
clean:
    rm -rf main.js main.js.map src/wasm/pkg
    cargo clean
