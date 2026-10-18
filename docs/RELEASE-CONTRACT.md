# Shared Obsidian release contract

Viewgram is the canonical home of this small release bundle. Mica vendors the
same workflow, dependency-free publisher, tests and this contract. No third
repository, shared credentials or independently versioned release framework is
needed. `.github/release-bundle.json` records exact file hashes; Mica's
`.github/release-source.json` pins the full Viewgram commit containing those
bytes. `node scripts/release.mjs parity --upstream` rejects local drift and
checks Mica against that immutable upstream snapshot. To update the bundle,
change and test Viewgram first, copy those files and the hash manifest to Mica,
pin the resulting Viewgram commit, then review both candidates. Do not follow a
mutable upstream branch or fix drift by merely regenerating consumer hashes.

## Product authority

The root manifest owns the unprefixed `x.y.z` version and minimum Obsidian
version. Package/lock/Cargo metadata and `versions.json` must agree. Existing
package scripts own the build and qualification commands. The only product
adapter is `.github/obsidian-release.json`: repository identity, built-asset
directory and whether additional qualification evidence is required. Toolchain
versions come from `packageManager` and `rust-toolchain.toml`; common action and
GitHub CLI pins live in the shared bundle. There is no second version field or
separate plugin source in the release setup.

## Invocation and activation

The only workflow trigger is `workflow_dispatch`, from `main`. Pushes to main,
PRs, tag pushes and schedules start no hosted job. The default is a dry run:
build, qualify and stage an artifact; it creates no tag or GitHub Release.
Publication is automated after an explicit dispatch with `publish=true`. This
is an automated release procedure with a manual start, not an automatic release
cadence. Enabling qualified-tag publication later requires an explicit trigger
change plus an authenticated source of exact-SHA preview/qualification evidence;
a tag alone must never stand in for those reports.

Before the first hosted run, the owner must verify repository Actions is
available and the workflow is on qualified main. Before publication, verify
immutable releases are enabled in GitHub's repository release settings and set
the non-secret repository Actions variable
`OBSIDIAN_IMMUTABLE_RELEASES_CONFIRMED=true`. Reuse current verified setting
evidence; no repeat approval is required just because this workflow exists.
This variable is a declaration, not a live settings check: an administrator
could later change the setting. The normal repository-scoped workflow token
cannot read that admin-only endpoint. Never add an admin PAT to work around it.
A published non-immutable result or failed attestation verification stops
delivery and requires diagnosis without rewriting the published assets.

An optional GitHub protected environment can add a reviewer before the
write-capable job, if the owner wants that additional safeguard. It is not part
of this default contract and does not create a new per-release approval gate.
No new environment, credential, permission grant or Actions setting is created
by committing these files.

## Candidate and evidence

Dispatch with the full merged main SHA, full passing Community preview SHA,
HTTPS preview-report evidence, and any required qualification-report evidence.
The preview must have zero errors and reviewed warning dispositions. The two
commits must have identical Git trees. The checkout must be clean and the exact
current main HEAD; main is checked again immediately before publication.
Evidence links are recorded, not authenticated or interpreted by this script.
The repository's existing review-before-merge policy and product qualification
requirements remain the authority. Do not dispatch publication with missing,
failed, stale or invented reports. Mica's device, Sync and storage-cutover gates
are not replaced by a workflow run; private vault content is never an asset.

## Assets, permissions and failure recovery

The read-only qualification job builds from the exact source. It stages only
`main.js`, `manifest.json` and `styles.css`, all nonempty regular files. The built
manifest must equal the root manifest byte-for-byte. A separate workflow
receipt binds repository, source/preview SHAs, tree, version, external evidence
and all three SHA-256 hashes. It is a workflow artifact, not a public plugin
asset. The write-capable job downloads that same run's artifact by ID and
revalidates the bindings and bytes. It installs no product dependencies and
runs no product build with a write token. Default permissions are contents-read;
only this job receives repository-scoped contents-write. Actions are pinned to
full commits. No PAT, signing key, OIDC or inherited secret is required.

The publisher refuses every existing release, including ambiguous leftover
drafts. It never overwrites assets, deletes releases, retags, or uses `--clobber`.
A new exact-version tag points at the qualified source. A new draft receives
exactly the three assets; their names, sizes and hashes are checked before
publication. The result must be immutable. The publisher downloads all assets,
compares their hashes, then runs supported `gh release verify` and
`gh release verify-asset` with a checksum-pinned official CLI. A partial failure
in verification gets a three-minute read-only attestation propagation window;
no create/upload/edit operation is retried automatically. A remaining failure
retains the draft or published result for inspection; do not blindly rerun
mutations. Published corrections need a new version and qualified candidate.

GitHub's immutable-release attestation is distinct from SLSA build provenance.
No SLSA claim is made. Successful publication is still separate from Obsidian's
full release review, installation and activation. Require that completed full
review before installing or activating. Preserve disagreements between GitHub
verification and Obsidian; never weaken checks to force agreement. Users fetch
approved updates through Community plugins' **Check for updates** and **Update**.

## References

- [Obsidian entry management and previews](https://docs.obsidian.md/community-directory/manage-entry)
- [Obsidian release requirements](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [GitHub release verification](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity)
- [Immutable-setting API and admin-only read permission](https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository)
