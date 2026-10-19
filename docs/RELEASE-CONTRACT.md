# Shared Obsidian release contract

Viewgram is the canonical home of this release bundle. Mica vendors the same
workflow, dependency-free publisher, tests, scanner CSS configuration and this
contract. `.github/release-bundle.json` records their exact hashes; Mica's
`.github/release-source.json` pins the full Viewgram commit containing them.
Run `node scripts/release.mjs parity --upstream` to reject drift. Update and test
Viewgram first, copy the bundle and hash manifest to Mica, then pin the resulting
Viewgram commit. Never follow a mutable upstream branch or regenerate consumer
hashes to hide drift.

## Automatic delivery on push

Pushes to `review` and `main` run validation. Only `main` can publish. The root
manifest owns the version and minimum app version; package/lock/Cargo metadata
and `versions.json` must agree. For a new version, a passing main run builds,
validates, stages, attests and publishes the exact three plugin assets. The
version must be newer than every stable published version. If the version is
already published with identical asset hashes, validation finishes and
publication is skipped. Changed assets under an existing version fail and
require a new version. There are no version-writeback commits, tag triggers or
scheduled jobs, so the release cannot retrigger itself.

`workflow_dispatch` remains an optional recovery/dry-run entry point on current
main. Its default `publish=false` validates, stages and attests a new version
without creating a tag or release. A supplied `source_sha` must equal current
main. Optional preview SHA and HTTPS report URL must be supplied together, and
the preview/source trees must match. Optional external reports are references,
not authenticated machine evidence. No manual portal report is required for
every push and no nonexistent Community submission API is called.

Obsidian automatically checks new GitHub releases periodically. Its completed
full release review remains the authority for directory acceptance. The optional
**Review branch** preview can diagnose source before publication; it cannot
verify future release attachments. Local checks, GitHub workflow success,
publication, full Community acceptance, installation and activation are separate
outcomes. A missing review is pending, never an inferred pass.

## Validation and essential capabilities

Each product owns `release:validate`, the non-interactive checks available on
hosted Linux. Viewgram includes type checks, unit tests, taxonomy, production
build, browser regressions (including real image/source clipboard round trips),
source/CSS lint and release-contract tests. Mica retains its source/build,
Rust/WASM, stress, assets and CLI gates there. Mica's `release:qualify` additionally
covers native profiles; device, Sync and storage-cutover acceptance remain
explicit separate evidence and are not claimed by Linux CI.

The official `obsidianmd/obsidian-workflows` action is pinned to
`8167caed39664214d82c86fdfa32e06d8d55f61d` (v1.2.3), with `mode=pr`,
`scanner-lint=true`, `strict=true`, and no second build. It covers public rules,
not private heuristics or full release verification. Its setup errors can be
reported as inconclusive without failing the action. Therefore direct official
ESLint and direct Stylelint are required product gates too; their installation
or execution failures fail validation. Shipping-source ESLint and scanner CSS
also reject new warnings; documented browser-only adapter advisories remain
visible in a separate development check. `stylelint.obsidian-scanner.json` is the
unchanged `SCANNER_STYLELINT_CONFIG` from that pinned action's `src/lint.ts`, with
exact dev dependencies `stylelint@17.6.0` and
`stylelint-no-unsupported-browser-features@8.1.1` in each product lockfile.

Do not hide warnings or weaken functionality to change a count. Fix actionable
findings and document necessary advisories. Clipboard access is an essential,
user-initiated feature explicitly allowed by the owner, and Obsidian recommends
the browser clipboard APIs. A capability recommendation is not an error and
must not cause clipboard removal. Keep actual findings visible.

## Assets and permissions

`.github/obsidian-release.json` supplies repository identity, asset directory
and whether an optional additional qualification report is mandatory for a
specific product. Toolchain pins come from `packageManager` and
`rust-toolchain.toml`; common action/CLI pins live in the bundle.

The read-only job stages only nonempty regular `main.js`, `manifest.json`, and
`styles.css`. Built manifest bytes must match the root manifest. Its private
workflow receipt binds repository, source/tree/version, workflow run URL,
optional reports, and every asset's SHA-256 and size. Separate jobs download
that same run's artifacts by ID and revalidate the receipt and bytes. Source
must be clean and current main; main is checked again immediately before
publication. An obsolete run stops rather than publishing a superseded source.

Builds have contents-read only. Previously approved repository-scoped
`id-token: write` and `attestations: write` are confined to the separate
attestation job, which installs no product dependencies and executes no product
build. Only publication has contents-write. No PAT, saved credential, new cloud
trust or long-lived signing key is introduced. Do not add stronger permissions
to work around an unavailable setting or report.

Before first publication, verify that GitHub immutable releases are currently
enabled and set `OBSIDIAN_IMMUTABLE_RELEASES_CONFIRMED=true`. This non-secret
variable records an owner-verified setting; it is not a live admin API check.
An old mutable release does not establish the current setting. The ordinary
workflow token cannot read the admin-only setting; do not add an admin PAT.
Publication verifies the actual new result is immutable and stops delivery if
it is not, preserving its assets for diagnosis.

## Cryptographic verification and recovery

The official pinned `actions/attest` action signs exactly the staged three
assets. The original Sigstore bundle and verification report travel in a
separate workflow artifact, never as extra plugin attachments. Before creating
a tag or release, the publisher independently verifies every asset using the
checksum-pinned official GitHub CLI, SLSA provenance-v1 predicate, exact
repository/source/ref, signer workflow/commit, GitHub Actions OIDC issuer and
GitHub-hosted runner policy. It requires the verified subject set to match all
three asset names and hashes. Decoding a bundle is not verification.

The publisher refuses existing releases and ambiguous leftover drafts; it never
overwrites assets, deletes releases or rewrites tags. A new exact unprefixed
`x.y.z` tag points to the qualified commit. A draft receives the three assets,
whose names, sizes and digests are checked before publishing. After publication,
the result must be immutable; all downloaded assets must match the staged bytes;
`gh release verify` and `gh release verify-asset` must pass. Read-only verification
can wait up to three minutes for attestation propagation. Mutations are not
blindly retried. A retained draft or partial failure requires inspection.

Immutable `release/v0.2` attestations and SLSA build provenance are distinct.
Both are verified. Existing immutable releases are never rewritten or claimed
to have new workflow provenance. A prepared workflow does not prove a genuine
attestation exists or that Obsidian accepts it. Preserve conflicting reports,
inspect the latest applicable run, and diagnose failures without weakening
checks. Require completed Community release acceptance before installation or
activation. Users update via Community plugins' **Check for updates**.

## References

- [Obsidian entry management and previews](https://docs.obsidian.md/community-directory/manage-entry)
- [Obsidian release requirements](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)
- [Official scanner action](https://github.com/obsidianmd/obsidian-workflows/tree/8167caed39664214d82c86fdfa32e06d8d55f61d)
- [Plugin requirements, including clipboard APIs](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [Release verification](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity)
- [Build-provenance action](https://github.com/actions/attest)
- [Exact identity/source verification flags](https://cli.github.com/manual/gh_attestation_verify)
