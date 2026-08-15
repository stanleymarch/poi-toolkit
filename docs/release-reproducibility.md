# Release and reproducibility boundary

This document records the minimum evidence for a public source release and a
POI bundle handoff. It does not authorize a consumer import or database change;
the producer/consumer boundary is defined in
[Nearventure handoff](nearventure-handoff.md).

## Reproduce a source revision

Start from a clean checkout of the exact commit to be released. Use Node 22 and
the pnpm version declared by `package.json`, then install only the locked
dependency graph and run the same checks as CI:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
git rev-parse HEAD
git status --porcelain
```

Record the commit ID, `pnpm-lock.yaml` SHA-256, Node version, pnpm version, and
command results with the release. `git status --porcelain` must be empty before
the source revision is identified. A matching build/test result demonstrates
that source and locked dependencies were checked; it does not by itself attest
to a data bundle.

## Immutable POI handoff

A handoff candidate is the complete run directory, not a collection of files to
be recreated by the recipient. Generate and verify the strict import manifest
before handoff, then preserve every listed byte unchanged. At minimum the
candidate contains:

- `reports/poi_product_import.manifest.json`;
- `reports/poi_product_import.sql`;
- `release/manifest.json`; and
- `reports/collection-provenance.json`.

Record the manifest identity fields and SHA-256 values for the SQL, release
manifest, and collection provenance exactly as specified in
[Nearventure handoff](nearventure-handoff.md#required-release-identifiers-and-digests).
Verify each digest against the delivered bytes before transfer. The dataset
version, run ID, territory/profile, toolkit version, and toolkit revision must
identify the same candidate. A changed byte, a partial copy, or a regenerated
manifest creates a new candidate; it must receive a new manifest and digest set
and must not replace an accepted bundle in place.

The producer hands over immutable bytes and release evidence only. Nearventure
owns trusted-root placement, dry-run validation, import, rollback, and consumer
acceptance. Do not run the SQL directly or infer consumer acceptance from a
successful toolkit command.

## SBOM and provenance boundaries

`pnpm-lock.yaml` is the reproducible dependency-resolution input, not an SBOM.
This repository currently does not generate, sign, or publish an SBOM or a
build provenance attestation. CI validates a checked-out revision with the
lockfile, but it does not publish release artifacts or make supply-chain
attestations.

If an SBOM is attached to a future source release, it must identify its
format/generator/version, the exact source commit, and the exact lockfile digest.
Its scope is the toolkit source and resolved software dependencies only. It must
not claim to describe collected POI data, upstream source licenses, consumer
infrastructure, or the contents of a handoff bundle.

Likewise, source/build provenance (commit, tool versions, lockfile digest, and
command results) is distinct from dataset provenance. Dataset provenance is
carried by the immutable handoff manifest, release manifest, and collection
provenance with their recorded digests. Neither form of provenance substitutes
for the other, and neither substitutes for consumer-side import evidence.
