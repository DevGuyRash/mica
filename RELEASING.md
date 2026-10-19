# Releasing Mica

This guide separates automated GitHub publication from official Community
review and native/device qualification. Record actual results for each stage;
success at one does not establish the others.

## Update delivery

Main pushes run the shared [release contract](docs/RELEASE-CONTRACT.md): official
scanner-rule preflight, source/build/asset validation, exact-byte build
attestation, and immutable publication for a new manifest version. A push that
keeps an already-published version validates without replacing its tag or
assets. Manual dispatch remains available for retries and explicit dry runs.

Viewgram is the canonical release bundle; this repository carries an identical
hash-checked snapshot pinned to a full Viewgram commit. `pnpm run test:release`
tests the protocol, and `pnpm run release:parity` checks local/upstream drift.
`pnpm run release:validate` is the hosted publication gate: production audits,
build, aggregate checks, Obsidian preflight, protocol tests, stress corpus,
Rust format/Clippy/CLI build, asset checks and WASM smoke checks.

`pnpm run release:qualify` additionally runs the native default/minimum/mobile
profiles. `pnpm run release:advisory` runs the moving desktop-latest canary.
Physical-device, two-device Sync, existing-vault storage cutover and official
Community review remain separately recorded acceptance evidence. They are not
implied by a GitHub upload and do not require a manual evidence entry on every
source push. Do not skip unavailable checks and then claim they passed. Never
copy owner credentials into hosted jobs to obtain an unavailable app download.

Only the initial Community directory submission is needed. The directory
periodically detects and reviews each matching GitHub Release. Publication
must not be reported as official acceptance until that actual review completes.
Existing releases, including 0.2.2, are preserved. Installed community plugins
do not update automatically: users select **Settings → Community plugins →
Check for updates**, then **Update** or **Update all**.

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

Qualify the new source independently of a review-fix release. Record the exact
source and separate results for the production WASM/plugin and native CLI
builds, required typecheck, local Obsidian preflight, and decoded asset/notice
review. Existing storage fixtures must use that source's generated WASM and
real store bindings; an older qualified bundle or mocked path policy is not
storage evidence. Do not run checks outside the owner's authorized scope.

Before cutover, verify plain non-Git roots and explicit vault selection,
default and custom nested folders, and conflicting `--store-dir` rejection.
Exercise initialization recovery, whole-folder relocation with unchanged UUID
and history bytes, and refusal of unmarked existing folders or competing
default storage. Verify plugin/CLI snapshot, read and restore interoperability,
gzip objects, stable history after note rename, duplicate identities, and
retained orphan records. Pending/stale routes must block publication and
rollback; bridge outcome retention and native journal recovery need their own
acceptance evidence. Keep every unrun check pending rather than treating source
review as that evidence.

## Review branch and promotion

1. Commit new work to the permanent lowercase `review` branch first. Preserve
   existing work and history. Run the product source validation and official
   scanner-rule preflight before merging.
2. Fix scanner errors. Warnings are advisory: correct defects and explain
   intentional capabilities or literal identifiers. Keep clipboard copy and
   the explicitly invoked clipboard instruction command. A disclosure is not
   a reason to remove an essential feature.
3. When Community access is available, select **Review branch**, enter the
   exact current SHA and select **Run preview scan**. Retain the actual report.
   A changed SHA invalidates the old preview. Local lint and GitHub checks are
   not official preview evidence, and no Obsidian status name is assumed.
4. Merge into `main` after source validation. Main pushes automatically validate
   and publish a new manifest version; an existing version is never replaced.
   The workflow binds the commit, version and asset hashes to verified build
   provenance. Manual preview/qualification reports are optional evidence, not
   invented prerequisites for every push.
5. After publication, inspect the actual full Community release review. The
   portal can request a release check immediately; otherwise periodic checks
   discover it. Record build, publication, review, installation and activation
   separately. Unavailable evidence remains pending.

The official [management guide](https://docs.obsidian.md/community-directory/manage-entry)
states that warnings do not block submission. The official
[FAQ](https://docs.obsidian.md/community-directory/faq) explains the scanner's
build-command selection and preview controls.

## Local preflight boundaries

`pnpm run lint:obsidian` runs the official recommended TypeScript rules, with
native DOM creation promoted to an error, the official scanner's CSS rules via
`pnpm run lint:scanner-css`, then `pnpm run lint:review-css`. The CSS config is
vendored from [obsidian-workflows v1.2.3](https://github.com/obsidianmd/obsidian-workflows/blob/8167caed39664214d82c86fdfa32e06d8d55f61d/src/lint.ts)
with its upstream Electron 39 floor for the declared minimum app. Stylelint
17.6.0 and its unsupported-browser-features plugin 8.1.1 are pinned. Preserve
upstream warning severity; do not use `--max-warnings=0` to turn disclosures
into blocking errors.

The dependency-free CSS tripwires report source locations for priority
overrides, `:has()` and the previously rejected decoration longhands, ignoring
comments and quoted values. They scan the shipping root stylesheet; they are
not a full CSS parser or browser compatibility database. The preflight does not
establish reproducible builds, optional attestations or an official preview
pass. When recording a Community preview, use the exact current SHA; an old
preview cannot be reused after a source change.

Preserve these component contracts without priority overrides:

- Dock `hidden` selectors apply to original controls/groups. Responsive copies
  receive separate packing styles; do not make the two states compete.
- Existing drag body classes own `--mica-drag-cursor`. Owned controls use their
  normal cursor as its fallback; removing the class restores that fallback.
  Scope native-content cursor coverage to Mica and its portals/previews.
- Explicit user style overrides retain ordinary cascade priority. A warning
  count is not an accepted baseline; review each new component finding.

Review sentence-case advisories against the actual text rather than applying
capitalization suggestions to identifiers or names:

- [codeBlockEditor](src/ui/codeBlockEditor.ts) shows the literal fence language
  IDs `markdown`, `md`, and `javascript`; keep those lowercase examples.
  [lightboxSearch](src/ui/lightboxSearch.ts) likewise displays case-sensitive
  regex flag tokens. Neither example list is prose to title-case.
- [toolbarView](src/ui/toolbarView.ts) names the **Enter** key in its language
  placeholder. Preserve the key spelling. Notices in [main](src/main.ts)
  preserve the product names `obsidian-tabs` and Templater, and use the normal
  acronym casing ID/IDs. These names and tokens are intentional; unrelated
  sentence-case findings still need correction or their own reviewed reason.

## 1. Establish a release candidate

WHEN you prepare a release candidate THEN you SHALL put all source and metadata
changes on `review`. Use that candidate for source validation and any preview,
and record the merged `main` commit used for release artifacts.
A changed candidate requires fresh evidence; an unrun gate remains pending.

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

## 2. Validate source and record native acceptance

WHEN publishing from a main push THEN the workflow SHALL run `pnpm run
release:validate` and the official scanner-rule preflight. For full native
qualification, use `pnpm run release:qualify` or the detailed commands below:

```sh
pnpm install --frozen-lockfile
pnpm run audit:prod
cargo deny check advisories
pnpm run build
pnpm run check
pnpm run test:version-stress
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build --release -p mica-cli --locked
pnpm run check:release:assets
pnpm run smoke
xvfb-run -a pnpm run e2e
```

WHEN the default gate passes THEN you SHALL run the existing local
`pnpm run e2e:minimum` and `pnpm run e2e:mobile` profiles on the same commit.
`pnpm run e2e:latest` is the existing advisory moving-latest canary. A hosted
workflow definition does not establish that any of these checks ran.

### Exact app and installer matrix

The default, minimum and mobile-emulation profiles retain app **1.13.0**, the
manifest's intentional minimum. The 0.2.2 review migration raised that minimum
and removed the pre-1.13 settings fallback together; an unavailable old binary
is not evidence that a newer app can replace this acceptance target.

The minimum is an API requirement, not an arbitrary fixture: commit `523cf6e`
removed the legacy `display()` renderer and made `PluginSettingTab.update()`
unconditional alongside `getSettingDefinitions()`. The official
[declarative settings migration guide](https://docs.obsidian.md/plugins/guides/migrate-declarative-settings)
requires 1.13.0 for that API. Keep the manifest and minimum profile unchanged
unless deliberately changing the supported API contract.

The oldest **public stable desktop** release in this supported series is
[1.13.4, published July 30, 2026](https://obsidian.md/changelog/2026-07-30-desktop-v1.13.4/).
Earlier 1.13.0–1.13.3 entries were Catalyst releases. Testing 1.13.4 is a useful
public-release compatibility check, but does not prove the still-declared
1.13.0 lower bound. The launcher index can retain stale beta metadata for a
version later promoted to public; resolve the official release and record the
actual app bytes instead of inferring access from a stale cache.

Their installer pin is **1.6.5**, the oldest compatible installer for that exact
app in the [launcher-maintainer index at b3d917e](https://github.com/jesse-r-s-hines/wdio-obsidian-service/blob/b3d917e33eef09ac65c9550beee8b6f8a85ba6bc/obsidian-versions.json).
This is WDIO-maintained compatibility data, not an Obsidian-owned index. The
recorded range is 1.6.5 through 1.12.7. The former installer 1.5.8 pin belonged
to the previous app 1.12.7 target and is incompatible with app 1.13.0. A cached
1.12.7 installer can supply a separately recorded valid pair, but does not
replace the oldest-installer profile. `pnpm run test:e2e-config` exercises the
actual WDIO capabilities against a small commit-pinned evidence snapshot; it
does not launch Obsidian or establish an E2E pass.

Obsidian's [1.13.0 changelog](https://obsidian.md/changelog/2026-05-28-desktop-v1.13.0/)
labels that release Catalyst early access. Native inspection on 2026-10-19
found no exact local 1.13.0 ASAR and received anonymous HEAD/GET 404 responses
from the listed app download. No installer HTTP result was established. Keep
the exact-app native gates pending until the real artifact is available. The
service supports `appPath` for a verified, legitimately predownloaded exact
ASAR; never substitute another app's bytes under that version. Community
directory sign-in and launcher early-access download authorization are separate.
A current-app run, including an installed 1.14.4 run, is separate QA and cannot
clear minimum-version qualification. Keep the moving latest profile advisory.

IF the minimum-app profile demonstrates an actual compatibility failure THEN
you SHALL fix it or deliberately raise `minAppVersion`. An unavailable download
is not a compatibility failure and does not justify changing the API floor.

IF the mobile-emulation profile demonstrates an actual mobile incompatibility
THEN you SHALL fix it or set `isDesktopOnly` to `true`. An unrun profile remains
unverified; do not claim that it passed.

WHEN `isDesktopOnly` is `false` THEN you SHALL smoke-test the built artifacts on
at least one real Android or iOS device, because desktop mobile emulation does
not exercise Capacitor, WebKit, or native filesystem behavior.

## 3. Verify concurrent storage behavior

WHEN qualifying versioning for real two-device use THEN you SHALL test one real
Obsidian Sync scenario using the candidate artifacts. A GitHub publication alone
does not establish this acceptance.

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

WHEN creating the GitHub release THEN you SHALL first merge the validated
candidate into `main`, verify that its source and root manifest match the
built candidate, and use a tag exactly equal to `manifest.json`'s `x.y.z`
version, without a `v` prefix.

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
the tag target and public release access. Use supported `gh release verify` and
`gh release verify-asset` commands and retain their actual reports. A workflow
artifact upload is not a GitHub Release attachment.

An exact branch preview does not verify the future release's attachments or
attestations. GitHub's immutable `release/v0.2` attestations bind the tag, commit
and asset digests; they do not establish SLSA workflow build provenance. Keep
unverified build-provenance claims explicit.

WHEN installing or activating an update THEN you SHALL first require the
published version's completed full Obsidian release review with zero errors and
every warning fixed or justified by a reviewed necessity, plus passing release
and asset integrity checks.

WHEN these gates pass THEN, within the user's authorized scope, install verified
assets rather than a development symlink into a clean vault and smoke-test block
creation, tabs, grids, editing, the versions timeline, restore, and the CLI.

WHEN GitHub and Obsidian verification disagree THEN you SHALL preserve both
reports, release protections and published assets and stop affected delivery
pending diagnosis. Never fabricate provenance or weaken checks to force agreement.
Record build, publication, installation, activation and directory review separately.

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

IF diagnosis requires source or asset changes after publication THEN you SHALL
preserve the original artifacts and evidence and publish a corrected version;
you SHALL NOT replace assets under an existing tag.

## Official references

- [Preview scans and entry management](https://docs.obsidian.md/community-directory/manage-entry)
- [Community review FAQ](https://docs.obsidian.md/community-directory/faq)
- [Submission and later releases](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)
- [Manifest](https://docs.obsidian.md/Reference/Manifest)
- [Official sample: release metadata and versions.json](https://github.com/obsidianmd/obsidian-sample-plugin#releasing-new-releases)
- [Community plugin updates](https://obsidian.md/help/Extending%2BObsidian/Community%2Bplugins)

Future releases also require the shared [build-provenance gate](docs/RELEASE-CONTRACT.md):
attest the three exact qualified assets and verify repository, source commit,
signing workflow and hashes before publication. Preserve immutable-release
verification afterward as a separate gate. Workflow preparation does not prove
provenance exists; keep activation approval and actual verification explicit.
