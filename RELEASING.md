# Releasing Mica

This is the human decision gate for the Obsidian plugin and CLI. Automation
checks reproducible facts; the release owner records the external evidence that
CI cannot produce.

## 1. Establish a release candidate

WHEN you prepare a release candidate THEN you SHALL use one commit for every
automated and manual check below.

WHEN you choose the release version THEN you SHALL set the same version in
`package.json`, `manifest.json`, the Rust workspace package metadata, and the
corresponding `versions.json` key.

WHEN you choose `minAppVersion` THEN you SHALL map that exact value from the
release version in `versions.json`.

WHEN you change the sidecar or ledger format THEN you SHALL document backward
compatibility and test the plugin and CLI from the same candidate against
existing sidecars before tagging.

## 2. Prove the automated gates

WHEN the candidate is ready for verification THEN you SHALL run:

```sh
pnpm install --frozen-lockfile
pnpm audit --audit-level high
cargo deny check advisories
pnpm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build --release -p mica-cli --locked
pnpm run build
pnpm run check:release:assets
pnpm run smoke
xvfb-run -a pnpm run e2e
```

WHEN the default gate passes THEN you SHALL run the GitHub `Compatibility`
workflow for both the `minimum` and `mobile` profiles on the same commit.

IF the minimum-app profile fails THEN you SHALL fix compatibility or raise
`minAppVersion` before release.

IF the mobile-emulation profile fails THEN you SHALL fix it or set
`isDesktopOnly` to `true` before release.

WHEN `isDesktopOnly` is `false` THEN you SHALL smoke-test the built artifacts on
at least one real Android or iOS device, because desktop mobile emulation does
not exercise Capacitor, WebKit, or native filesystem behavior.

## 3. Verify concurrent storage behavior

WHEN versioning is included in the release THEN you SHALL test one real
two-device Obsidian Sync scenario using the candidate artifacts.

The Sync scenario covers concurrent edits, snapshots on both devices, Sync
settling, ledger folding, version restore, and `mica doctor` against the settled
vault.

IF the devices disagree on the live note, ledger, object integrity, or restored
content THEN you SHALL stop the release and preserve both vault copies for
diagnosis.

## 4. Verify the public repository

WHEN preparing the first public release THEN you SHALL publish or select the
canonical public repository before creating the GitHub release.

WHEN the canonical repository exists THEN you SHALL add only its verified URL
to package metadata and generated-bundle source metadata.

WHEN submitting to Obsidian community plugins THEN you SHALL confirm that the
public repository root contains `README.md`, `LICENSE`, `manifest.json`, and the
source used to produce the release.

You SHALL NOT publish placeholder, private, or unverified repository URLs.

## 5. Build and publish artifacts

WHEN creating the GitHub release THEN you SHALL use a tag exactly equal to
`manifest.json`'s version, without a `v` prefix.

WHEN attaching plugin assets THEN you SHALL attach exactly the candidate's
non-empty `main.js`, `manifest.json`, and `styles.css`. The WASM remains inlined
in `main.js`.

WHEN publishing the CLI from the same tag THEN you SHALL build it from the same
commit and SHALL NOT combine it with plugin artifacts built from another
revision.

WHEN the release assets exist THEN you SHALL install those assets, rather than a
development symlink, into a clean vault and smoke-test block creation, tabs,
grids, editing, the versions timeline, restore, and the CLI against that vault.

## 6. Submit and observe

WHEN submitting the first release THEN you SHALL open a pull request against
`obsidianmd/obsidian-releases` and address its automated and human review.

WHEN the community release becomes installable THEN you SHALL repeat the clean
vault smoke test using the community-installed copy.

IF a release check fails after publication THEN you SHALL preserve the failed
artifacts and evidence, publish a corrected version, and SHALL NOT replace assets
under an existing tag.
