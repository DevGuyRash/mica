# Releasing Mica

This is the human decision gate for the Obsidian plugin and CLI. Automation
checks reproducible facts; the release owner records the external evidence that
CI cannot produce.

## Update delivery

This is a manual release process. Source pushes, local builds and CI artifact
uploads do not publish a plugin update. A published GitHub Release with the
matching version tag and runtime attachments is what Obsidian distributes.
The existing workflow files contain verification/artifact jobs, not a GitHub
Release publisher. Use local verification within the user's authorized scope;
this procedure does not require enabling hosted Actions.

Only the initial Community directory submission is needed. Subsequent versions
are delivered through new GitHub Releases. Installed community plugins do not
update automatically: users select **Settings → Community plugins → Check for
updates**, then **Update** or **Update all**.

## Storage format 1 cutover

The 0.3 plugin and CLI use one visible vault-relative store, defaulting to
`mica-data/`. The fixed vault-root `mica.json` is the routing authority shared
by both hosts, including plain directories without Obsidian or Git.
`--store-dir` must agree with an existing locator. Treat this as a coordinated
storage-format change: every participating client must understand the locator,
marker, note bindings and shared object addresses before it writes. Old
note-local sidecars are not an automatic import or fallback path. The release
must not claim existing-vault cutover until an independent backup, writer/Sync
quiescence, exact object/reference verification, and history/restore checks
have succeeded. Preserve old state for rollback outside the live vault. The
one-off owner transfer is external to product code; do not add a permanent
migration framework, dual writes, or shared-object garbage collection.

Custom-folder selection uses **Settings → Mica → Storage → Apply after restart**.
Stop CLI/watch writers before restarting. Startup records a pending route and
moves the whole existing folder before admitting engine or bridge work; the
destination retains the original store UUID and all history bytes. Only a
verified destination becomes active. A pending route prevents ordinary writes
until recovery identifies one matching store; conflicting copies are preserved.
First initialization records its UUID and `initializing:true` before directory
creation, so an interrupted setup can resume only that recorded identity and
clear the intent through an exact locator guard. Existing unrelated contents
remain a conflict. This location change moves the current central store and
does not import old note-local sidecars. Record any unperformed routing,
relocation, or recovery compatibility checks as outstanding; source changes
alone establish none of those outcomes.

## 1. Establish a release candidate

WHEN you prepare a release candidate THEN you SHALL use one commit for every
automated and manual check below.

WHEN you choose the release version THEN you SHALL set the same version in
`package.json`, `manifest.json`, the Rust workspace package metadata, the
`mica-core` and `mica-cli` entries in `Cargo.lock`, and the corresponding
`versions.json` key. Preserve historical released mappings in `versions.json`.
Use `x.y.z` semantic versions. There is no package version lifecycle hook that
synchronizes these files; `npm version` or `pnpm version` alone is insufficient
and may create a tag before the candidate is ready.

WHEN you choose `minAppVersion` THEN you SHALL map that exact value from the
release version in `versions.json`.

WHEN you change the sidecar or ledger format THEN you SHALL document backward
compatibility and test the plugin and CLI from the same candidate against
existing stored histories before tagging.

WHEN the candidate can write `checkpoint`, `move-head`, `version-label`,
`version-visibility`, or `replace-version` events THEN you SHALL upgrade every
plugin and CLI participant in the compatibility test before the first
identity-bearing checkpoint operation or history normalization, because
pre-upgrade readers cannot interpret those events.

WHEN testing typed-ledger compatibility THEN you SHALL verify that an unknown
typed ledger event fails closed, original event lines and objects remain
readable, stale line-union inputs do not expose the unwrapped version, and the
plugin and CLI agree on version order, labels, parents, heads, visibility, and
counts.

## 2. Prove the automated gates

WHEN the candidate is ready for verification THEN you SHALL run:

```sh
pnpm install --frozen-lockfile
pnpm run audit:prod
cargo deny check advisories
pnpm run check
pnpm run test:version-stress
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build --release -p mica-cli --locked
pnpm run build
pnpm run check:release:assets
pnpm run smoke
xvfb-run -a pnpm run e2e
```

WHEN the default gate passes THEN you SHALL run the existing local
`pnpm run e2e:minimum` and `pnpm run e2e:mobile` profiles on the same commit.
`pnpm run e2e:latest` is the existing advisory moving-latest canary. A hosted
workflow definition does not establish that any of these checks ran.

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

WHEN building plugin assets THEN you SHALL use the existing `pnpm run build`,
which rebuilds WASM before the production JavaScript bundle. The build maps
source, user home, Cargo home and Rustup home to fixed WASM paths, including
overridden cache homes, while preserving Rust flag precedence and explicitly
empty encoded flags. Reproduce with the pinned toolchain and locked dependencies
and compare `main.js` bytes with the selected release; path remapping alone does
not establish equality. The public default branch's committed root manifest and
source SHALL match the selected release candidate. Demo files, private settings/evidence and standalone CLI binaries
are separate from the three Obsidian runtime attachments.

WHEN publication finishes THEN you SHALL download the three release attachments
and compare their bytes and SHA-256 hashes with the reviewed candidate; verify
the tag target and public release access. A workflow artifact upload is not a
GitHub Release attachment. Record build, publication, installation, activation
and directory review separately.


WHEN the release assets exist THEN you SHALL install those assets, rather than a
development symlink, into a clean vault and smoke-test block creation, tabs,
grids, editing, the versions timeline, restore, and the CLI against that vault.

## 6. Submit and observe

WHEN submitting the first release THEN you SHALL use the Obsidian Community
directory at <https://community.obsidian.md>, following the current official
[submission instructions](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)
and [account setup instructions](https://docs.obsidian.md/community-directory/set-up-and-claim).

WHEN preparing the submission THEN you SHALL verify that the default branch's
committed `manifest.json` matches the release version and that the matching tag
has the candidate's `main.js`, `manifest.json`, and `styles.css` attachments.

WHEN the release owner signs in THEN they SHALL review and authorize any new
GitHub account connection themselves. Under **Plugins → New plugin**, they
SHALL provide the verified canonical repository URL and choose the maintaining
owner.

WHEN the submission asks for agreement to the Developer policies and continued
support, removal, or transfer commitment THEN the release owner SHALL review
and accept those commitments personally before selecting **Submit**. Automation
SHALL NOT accept them on the owner's behalf.

WHEN review feedback arrives THEN you SHALL address the directory's automated
and human review. Submission does not establish acceptance or installability.

WHEN the community release becomes installable THEN you SHALL repeat the clean
vault smoke test using the community-installed copy.

IF a release check fails after publication THEN you SHALL preserve the failed
artifacts and evidence, publish a corrected version, and SHALL NOT replace assets
under an existing tag.

## Official references

- [Submission and later releases](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)
- [Manifest](https://docs.obsidian.md/Reference/Manifest)
- [Official sample: release metadata and versions.json](https://github.com/obsidianmd/obsidian-sample-plugin#releasing-new-releases)
- [Community plugin updates](https://obsidian.md/help/Extending%2BObsidian/Community%2Bplugins)
