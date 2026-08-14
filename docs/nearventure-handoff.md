# Nearventure v1 bundle handoff

This document defines the **producer-side** boundary for a POI Toolkit release intended for Nearventure. It describes what the toolkit hands off; it is not an importer or deployment runbook.

The canonical consumer procedures and their current operational status live in Nearventure:

- [data refresh and trusted-root import procedure](https://github.com/stanleymarch/nearventure/blob/main/docs/data-refresh.md)
- [release evidence](https://github.com/stanleymarch/nearventure/blob/main/docs/release-evidence/beta-0.1-acceptance.md)

## Boundary

| Party | Owns | Must not do |
|---|---|---|
| POI Toolkit (producer) | Build and verify an immutable v1 bundle; provide its identifiers, hashes, provenance, and release evidence. | Write to the Nearventure database, invoke `psql`, invoke the Nearventure importer, or configure/copy into its trusted root. |
| Nearventure operator and importer (consumer) | Place the received bundle below its trusted root, run the consumer-owned dry-run/import procedure, and retain importer audit/rollback evidence. | Alter a bundle after it is published or accept it without the consumer's validation. |

A producer release ends when the complete v1 bundle is handed to the Nearventure trusted-root process as immutable bytes. The producer does **not** receive database credentials, select the consumer run directory, execute importer commands, or infer that handoff equals successful import. Only Nearventure's audit and release evidence can establish consumer acceptance.

In particular, `reports/poi_product_import.sql` is data, not an instruction for an operator to run. Direct SQL execution, ad-hoc staging swaps, and direct importer invocation from this repository are prohibited. The legacy `scripts/atomic-deploy.sh` is a permanently disabled compatibility stub: it exits nonzero before reading, copying, or deleting artifacts and cannot access a database. **The only allowed database import path is Nearventure's manifest-validated importer handoff.**

## Immutable v1 bundle

A candidate bundle is one run directory, with paths relative to that directory. It contains at least:

- `reports/poi_product_import.manifest.json` — the strict v1 handoff manifest;
- `reports/poi_product_import.sql` — data-only records referenced by the manifest;
- `release/manifest.json` — release identity, counts, and release digest;
- `reports/collection-provenance.json` — retained-source provenance and its digest.

After the manifest is generated, do not regenerate, edit, or partially copy any listed file. Deliver the directory as one immutable unit. The Nearventure trusted-root owner is responsible for its placement and permissions; see the [canonical data-refresh procedure](https://github.com/stanleymarch/nearventure/blob/main/docs/data-refresh.md).

## Required release identifiers and digests

Before handoff, record these values from `reports/poi_product_import.manifest.json` together with the bundle location:

| Required value | Manifest field or source |
|---|---|
| Bundle format and schema | `schemaVersion`, `kind`, `compatibility.recordsFormat` |
| Dataset and run identity | `datasetVersion`, `run.id`, `territory.slug`, `territory.profile` |
| Producer build identity | `toolkit.version`, `toolkit.revision` |
| SQL identity | `records.path`, `records.count`, `records.bytes`, `records.sha256` |
| Release provenance identity | `provenance.releaseManifest.path`, `provenance.releaseManifest.sha256` |
| Collection provenance identity | `provenance.collectionProvenance.path`, `provenance.collectionProvenance.sha256` |
| Source licensing identity | `sourceAttribution.notice` and `sourceAttribution.components` |

A handoff is incomplete if any required field is absent, if a digest does not match the delivered byte stream, or if the dataset/run identifiers do not name the intended release. A source run with missing or empty collection provenance is historical evidence, not a v1 handoff candidate; create a separate valid v1 bundle instead of altering that run.

## Compatibility and release ordering

1. Produce and locally verify a complete v1 bundle before any handoff.
2. Verify that `compatibility.minImporterVersion` through `compatibility.maxImporterVersionExclusive` includes the target Nearventure importer version.
3. Give Nearventure the dataset version, run ID, all three SHA-256 values (SQL, release manifest, collection provenance), and the producer release evidence.
4. Nearventure places the unchanged bundle under its trusted root and performs its consumer-owned dry-run before an import.
5. Nearventure decides acceptance, records its audit result, and manages import ordering, replay, backup, rollback, and promotion.

Do not treat a successful toolkit `release` or `export-sql` command as Nearventure acceptance. Do not replace an accepted bundle in place: a corrected or later dataset requires a new dataset version, run ID, manifest, and digest set.

## Historical evidence versus future acceptance

`pfo-v0.1` is a historical source/release artifact and does not itself meet the v1 provenance requirement. Its recovered successor `pfo-v0.1-v1` and the consumer observations associated with it are historical, date-specific evidence; they do not pre-approve a later bundle. Each future bundle must independently satisfy the current v1 manifest, compatibility, digest, and consumer validation requirements.

For the historical producer record, see [v0.1 release notes](v0.1-release-notes.md). For the consumer-side acceptance record, use Nearventure's [canonical release evidence](https://github.com/stanleymarch/nearventure/blob/main/docs/release-evidence/beta-0.1-acceptance.md).
