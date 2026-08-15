# Guide for AI agents

This file is for AI assistants (Copilot, Cursor, Claude Code, pi, etc.) working
with the poi-toolkit repository. A short map and the safe boundaries so you do
not break anything.

> For humans see [CONTRIBUTING.md](CONTRIBUTING.md) and the
> [Russian README](README.md). This file is only about navigation and safe
> boundaries for agents.

## Read first

1. [README.md](README.md) (RU) — pipeline overview, commands, mermaid diagrams.
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how each stage works, schemas,
   media strategy.
3. [docs/nearventure-handoff.md](docs/nearventure-handoff.md) — the producer
   boundary: what the toolkit publishes and what the consumer (Nearventure)
   alone may do with it.
4. [docs/release-reproducibility.md](docs/release-reproducibility.md) — what is
   reproducible, what is not (no SBOM/provenance yet).

## Core principles

- **Producer boundary.** This repository is the canonical **producer** of an
  immutable v1 POI bundle (data-only SQL + import manifest). It never invokes
  consumer tooling, never writes to the Nearventure database, and never runs
  `psql`. Nearventure alone imports the bundle through its manifest-validated
  importer.
- **Every stage writes immutable, checksummed artifacts.** Never mutate a
  completed run; create a new run. `recover-release` and `replay-raw` exist for
  retained-artifact recovery and must not claim a fresh capture.
- **Workspace containment.** All workspace-derived paths (including descendants
  like `run/raw`, `run/reports`) are validated against symlink escapes before
  every read/write/remove. Do not bypass `workspace.ts` helpers with raw `fs`
  calls on user-controlled paths.

## Safe boundaries

- Do not commit secrets. `.env`, tokens, API keys stay ignored.
- Do not run `scripts/atomic-deploy.sh` (legacy, disabled by design — exits 64).
- Do not `export-sql` a run with empty collection provenance; the CLI gate
  rejects it. Legacy `pfo-v0.1` has no provenance — use its recovered
  successor `pfo-v0.1-v1` for handoff-eligible work.
- Do not change media policy claims: the toolkit records asserted/observed
  upstream metadata (URL, source, attribution, license). It does not grant
  download/cache/redistribute rights; consumers enforce their own SSRF and
  reuse policy.
- Do not hardcode consumer-specific URLs (e.g. Nearventure backend) into source
  clients. The canonical outbound User-Agent is the toolkit's own repo, and
  `POI_TOOLKIT_USER_AGENT` overrides it.

## Where things live

```
packages/cli/          CLI commands (collect, normalize, resolve, geocode,
                       synthesize, release, export-sql, recover, replay)
packages/core/         shared types, synthesis claims, provenance helpers
packages/source-*/    source collectors: source-osm, source-egrkn, source-mkrf,
                      source-wikidata, source-wikivoyage
packages/geography/   OSM address index + containment dedup + PFO subject assignment
packages/resolver/    record linking: exact-ID, fuzzy, OSM self-dedup
packages/normalize/   SourceRecords, evidence, field claims
packages/media/        Commons resolution + attribution
packages/synthesis/    deterministic multi-source field selection
packages/profiles-nearventure/  Nearventure 6-category projection
packages/exporters/    atomic export (GeoJSON/Parquet/GPKG/NDJSON + SQL + manifest)
packages/geocode/      Photon default, explicit Nominatim/Yandex fallback
packages/quality/      source profiling + quality score
docker/                Dockerfile, osmium/GDAL image, Photon
territories/           territory JSON definitions
docs/                  architecture (EN/RU), handoff, reproducibility
```

## Common tasks

- **Collect a new territory** — define `territories/<slug>.json`, then run the
  CLI collect pipeline for that territory; every stage writes into its own
  run directory.
- **New source collector** — add a package under `packages/source-*`, keep
  raw snapshots immutable, record source manifests with license/attribution.
- **Change synthesis rules** — edit `packages/synthesis/`; keep
  determinism: same inputs → byte-identical normalized/resolution/release.
- **Fix a CLI safety bug** — use the centralized workspace path validation in
  `packages/cli/src/workspace.ts`; add a symlink-escape regression test.

## Validation

```bash
npm run typecheck   # core build + all packages typecheck
npm test            # full vitest suite
npm run build       # all packages build
```

`npm run build` and `npm test` must stay green before any commit.
