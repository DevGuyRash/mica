# Releasing Mica

This is the human decision gate for the Obsidian plugin and CLI. Local checks
establish reproducible facts; the release owner records external review and
qualification evidence.

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

## Review branch and promotion gate

1. Commit and push all new work to the permanent lowercase `review` branch
   first. Isolated work branches may integrate there. Preserve existing work
   and history; branch setup is not permission to reset or discard them.
2. Run `pnpm run lint:obsidian` as the separate official local source preflight
   within the authorized scope and record its actual result. Errors must be
   zero. Keep warnings visible; fix each or document its reviewed necessity
   without suppressing review rules. Use the component reasons below. Local
   lint does not establish CSS coverage or an official preview pass.
3. On the Obsidian Community entry, select **Review branch**, enter the full
   current `review` HEAD commit SHA, then select **Run preview scan**. The
   official control accepts any branch, tag, or SHA; `review` is this
   repository's permanent branch convention. Use the SHA so the evidence is
   fixed to one candidate.
4. Obtain an actual passing preview with zero errors before opening the
   `review` → `main` PR. Fix every warning or document its intentional necessity
   with a reviewed reason; unreviewed warnings block promotion. Record the SHA,
   report evidence, warning dispositions, and remaining recommendations or
   unverified optional capabilities/attestations in the PR template. Official
   warnings are advisory; this repository requires their reviewed disposition
   before merge. Recommendations remain separately reported outcomes.
5. Any change to `review` HEAD invalidates its earlier pass. Stop and rerun the
   preview on the new full SHA before opening or merging the PR, tagging, or
   publishing. GitHub PR checks are separate evidence; they do not automatically
   represent the Obsidian preview, and no named GitHub status is assumed.
6. After the clean preview, merge the PR into `main` and record the resulting
   main commit. The release source and root manifest must match the scanned
   candidate. Resolve any merge content changes through `review` and a fresh
   preview. Create the version tag and public release only after merge and the
   release gates below.

The owner handles Community access and account authorization as described
below. An unavailable scan or missing report leaves this gate pending; do not
infer a pass from local checks, a source push, or an earlier candidate.

## Local preflight boundaries

`pnpm run lint:obsidian` is a separate local source preflight. Its errors must
be zero; warnings remain visible and need a fix or reviewed necessity. It does
not lint CSS or establish reproducible builds, optional attestations, or an
official preview pass.

Review the narrow priority rules in [styles.css](styles.css) by component:

- `.mica-long-travel [hidden]` and `.mica-source-dock [hidden]` keep `hidden`
  authoritative while [blockShell](src/ui/blockShell.ts) and
  [Live Preview](src/cm/micaLivePreview.ts) move actions into responsive
  overflow. Their priority defeats authored `inline-flex` display rules.
- `body.mica-dnd-active` and `body.mica-handle-dragging` apply the drag cursor
  only during gestures owned by [dnd](src/ui/dnd.ts) and
  [blockShell](src/ui/blockShell.ts). Priority covers authored inline cursors;
  outside those gesture classes the content keeps its own cursor.

These reasons are scoped warning dispositions, not permission to add broad
priority rules. Review each actual warning against its component and record
its outcome in the PR; a warning count is not an accepted baseline.

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
changes on `review` before its exact-SHA preview. Use that candidate for the
checks below and record the merged `main` commit used for release artifacts.
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
existing sidecars before tagging.

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

WHEN creating the GitHub release THEN you SHALL first merge the reviewed
candidate into `main`, verify that its source and root manifest match the
scanned candidate, and use a tag exactly equal to `manifest.json`'s `x.y.z`
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

- [Preview scans and entry management](https://docs.obsidian.md/community-directory/manage-entry)
- [Community review FAQ](https://docs.obsidian.md/community-directory/faq)
- [Submission and later releases](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)
- [Manifest](https://docs.obsidian.md/Reference/Manifest)
- [Official sample: release metadata and versions.json](https://github.com/obsidianmd/obsidian-sample-plugin#releasing-new-releases)
- [Community plugin updates](https://obsidian.md/help/Extending%2BObsidian/Community%2Bplugins)
