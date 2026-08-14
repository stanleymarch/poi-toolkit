# Architecture — how the toolkit works

File-first POI toolkit: reproducible collection → normalization → resolution → synthesis → product release. No database required; every stage writes immutable, checksummed artifacts. The producer/consumer boundary and v1 handoff are defined in [Nearventure handoff](nearventure-handoff.md); Nearventure's [data-refresh procedure](https://github.com/stanleymarch/nearventure/blob/main/docs/data-refresh.md) is canonical for consumer import.

## Pipeline data flow

```
                 ┌─────────────────────────────────────────────────────────┐
   collect       │  OSM PBF (osmium)  │  EGRKN API  │  MKRF museums API     │
   (raw/)        │  Wikidata SPARQL   │  Wikivoyage MediaWiki revisions    │
                 └────────────┬────────────────────────────────────────────┘
                              ▼
   normalize    source-records.ndjson  ·  geometry-evidence.ndjson  ·  field-claims.ndjson
   (normalized/)   EGRKN address/geometry classification · OSM tags → SourceRecord
                              ▼
   resolve      candidates.ndjson (accepted / pending / rejected)  ·  relations  ·  unresolved
   (resolution/)   exact-ID links · high-confidence fuzzy · OSM self-dedup
                              ▼
   geocode      geometry-evidence.ndjson + geocode-audit.ndjson
   (geocoded/)     Photon by default; selectable Nominatim/Yandex; complete compatibility audit
                              ▼
   release      entities.geojson · entities.parquet (GeoParquet 1.1) · dataset.gpkg
   (release/)      entities.ndjson · excluded.ndjson · manifest.json (SHA-256)
                   reports/release-quality.json
```

Every directory under `workspace/<territory>/<run-id>/` is immutable once written. A run is resumable: `collect` skips sources whose final snapshot already exists.

## How each mechanism works

### 1. Categories (Nearventure projection)

Generic source-neutral **facets** are computed first (`packages/taxonomy`), then the Nearventure profile maps them to one of six product categories (`packages/profiles-nearventure`).

Facets are hierarchical paths, independent of the product:
- `culture.religious.church`, `culture.heritage.building`, `culture.memorial.monument`, `nature.water.spring`, …

**EGRKN name-aware classification:** EGRKN `objectType` «Памятник» is a *legal protection tier*, not a physical type. The taxonomy classifies by **name** first:
- name contains церковь/собор/часовня/мечеть/храм → `religion`
- name starts with Дом/Здание/Школа/Усадьба → `heritage`
- name contains памятник/обелиск/мемориал → `monument`

Then the profile picks one of: `heritage | monument | sights | religion | nature | museum`. A **building-name override** turns «Дом Советов» into `heritage` even if the facet is ambiguous.

Noise is rejected before assignment: hotels, information boards, linear rivers (`waterway=river`), streets, settlements, memorial plaques, numeric/junk names.

### 2. Photos and media (`packages/media`)

The toolkit stores media **URLs and provenance**, not downloaded media files. Media metadata has two distinct trust levels:

| Source | Toolkit treatment | Reuse status |
|---|---|---|
| OSM `image`, `wikimedia_commons`, or `image:wikimedia` that identifies Commons (`upload.wikimedia.org`, `File:`) | Resolves file metadata (author and license) through the Commons API. | Eligible only when the resolved Commons metadata includes a license; attribution is derived from that metadata. |
| Wikidata P18 / Wikivoyage image | Commons file; follows the same Commons metadata-resolution path. | Same verified Commons metadata requirement. |
| MKRF museums | Keeps the publisher-provided `image.url` with configured Ministry open-data terms and attribution. | Source-level open-data metadata, not a consumer-side decision to fetch or redistribute. |
| EGRKN | Keeps the publisher-provided `photo.url` with configured Ministry open-data terms and attribution. | Source-level open-data metadata, not a consumer-side decision to fetch or redistribute. |
| Arbitrary HTTP URL in an OSM image tag | Keeps the URL as an upstream external reference with OSM-reference provenance. | License and reuse rights are **unverified**. It is not verified reusable media and its attribution is not a license grant. |

Ranking is deterministic: verified Commons metadata > EGRKN publisher media > MKRF publisher media > unverified OSM external reference. The final category does not become verified merely because it is selected as a URL reference.

**Consumer responsibility:** A downstream consumer (for example, the Nearventure backend) may choose to fetch a URL, convert it to WebP, cache it, and serve it. That choice is outside this producer boundary. Before fetching, caching, or redistributing any media, the consumer must decide whether the source terms permit it and enforce SSRF controls (including its own URL/host validation and network-access policy). This is especially required for arbitrary external OSM URLs. The bundle's source, license, attribution, and rule fields are provenance inputs for that decision, not an authorization to retrieve or reuse media.

### 3. Descriptions (`packages/synthesis`)

One existing text is selected — no AI rewriting, no sentence splicing. Ranking (deterministic, order-independent):
- Russian text preferred (Latin-only Wikidata templates are penalized)
- MKRF/Wikivoyage authority bonus for their object type
- Type-compatibility guard rejects a description whose object type conflicts (e.g., a museum description on a river)
- Minimum length check

Every selected description carries `descriptionSourceRecordId` + `descriptionLicense`.

### 4. Geometry gates (`packages/synthesis`)

Priority order:
1. reviewed manual geometry
2. **OSM native geometry** (point/line/polygon preserved — never replaced by centroids)
3. trusted source-native object geometry (MKRF, EGRKN object-level)
4. verified building/house-level geocode from the selected provider

Rejected at every rank: locality, street, district, region, admin-centre geocodes; relative/compound/repeated-centroid EGRKN; coordinates outside the territory. Territory containment uses 13 PFO neighbor-region polygons (Kirov = bbox − neighbors) via point-in-polygon exclusion.

### 5. Linking / dedup (`packages/resolver`)

Three tiers, all explainable:

- **Exact identifiers (auto-accept):** OSM `wikidata=Q…` ↔ Wikidata; OSM `ref:knid`/`heritage:ref` ↔ EGRKN; Wikivoyage `wdid` ↔ Wikidata.
- **High-confidence fuzzy (auto-accept):** same name (≥0.85 similarity) + ≤30 m + matching type + safe geometry. Safely enriches OSM anchors without legacy proximity false-match risk.
- **OSM self-dedup (auto-accept):** the same real-world object mapped as both a node and a way (≤10 m, same name) is merged into one entity. This removed **816 duplicate entities** in Kirov (1040→161 near-duplicate pairs).
- **Review-only (pending):** all other fuzzy candidates. Never auto-accepted.

### 6. Geocoding (`packages/geocode`)

**PFO subject containment:** `territories/pfo-subjects.geojson` holds the 14 canonical OSM `admin_level=4` polygons. A PFO product is published only when its representative point falls inside one of them. The release compares that subject with source text, quarantines a mismatch, and writes `reports/geography-report.json` plus `geography-conflicts.ndjson`; unassigned and conflicting regions block promotion.

**Default: Photon** — self-hosted territory data through `PHOTON_URL` (default `http://localhost:2322`), with no toolkit request budget. It is the production strategy for large territories.

**Selectable providers:** `--provider photon|nominatim|yandex`; `--fallback none|photon|nominatim|yandex` selects one explicit secondary provider. Nominatim requires `NOMINATIM_URL`; the CLI never silently uses a public instance. Yandex requires `GEOCODER_API_KEY` and defaults to 1,000 primary requests.

Photon and Nominatim are high-confidence only when their response contains a house number. Yandex retains its `exact / house / number / near / range` high-precision classification; street/locality/admin results are never product points. Every high result is then checked against the source address: house, corpus, structure and letter must agree. A non-accepted primary attempt is retained in evidence; a compatible fallback can be used without hiding that audit trail.

## Release entity schema

```jsonc
{
  "id": "entity:n12345",            // stable, from OSM anchor or trusted standalone
  "category": "religion",           // one of 6 Nearventure categories
  "categoryLabel": "Религия",
  "name": "Церковь Покрова",
  "geometry": { "type": "Point", "coordinates": [49.66, 58.60] },
  "geometryPolicy": "osm",          // osm | verified-source
  "geometryRule": "osm-native",     // egrkn-geocoded-house-level | mkrf-verified-source | ...
  "description": "...",
  "descriptionLicense": "CC BY-SA 4.0",
  "photo": { "url": "...", "license": "CC BY-SA 4.0", "attribution": "..." },
  "heritage": true,
  "heritageSignificance": "federal", // federal | regional | local | null
  "facets": ["culture.religious.church"],
  "urls": [{ "url": "...", "kind": "wikipedia" }],
  "sourceRecordIds": ["osm:n12345", "wikidata:Q123"]
}
```

Every field is a `SelectedClaim`: value + source record + source field + license + selection rule + rejected alternatives. Nothing is «last writer wins».

## Quality guarantees

- Every published entity has exactly one valid category, a name, and eligible in-territory geometry.
- Every selected media claim retains source, license/status, attribution, and rule metadata; only Commons claims have per-file metadata resolved by the toolkit.
- Every description has a source + license.
- No locality/street geometry or noise class; unverified external OSM media remains explicitly marked as an upstream reference rather than verified reusable media.
- Release is atomic (staged → renamed); manifest carries SHA-256 for all artifacts.
- GeoParquet 1.1 (WKB, CRS84); GeoPackage via GDAL (degrades gracefully if absent).

## Reproducibility

A run is fully determined by: the territory JSON, the source snapshots (checksummed in `collection-provenance.json`), and the versioned rules (taxonomy, resolver, profile, synthesis). Re-running the same inputs produces byte-identical normalized/resolution/release artifacts.

## Recovering a v1 import bundle for legacy runs

Runs collected before `collection-provenance.json` capture (e.g. `pfo-v0.1`, status `completed`, empty provenance) cannot pass the `export-sql` gate. If all source artifacts are retained, `recover-release` rebuilds the bundle deterministically **without modifying the source run**:

```bash
pnpm cli recover-release --territory pfo --run-id pfo-v0.1 \
  --output-run-id pfo-v0.1-v1 --dataset-version pfo-v0.1-v1
```

It requires `release/entities.ndjson`, `release/manifest.json`, and empty `hardening-report.json` `blockingFailures`; reconstructs collection provenance from the territory JSON, source-manifest constants, and SHA-256 of the retained raw snapshots/PBF (explicitly marked `recovered`); creates a new run dir with a byte-identical release manifest and a fresh data-only SQL export + strict v1 import manifest. The source run is strictly read-only. The resulting directory is handed off only under the producer boundary in [Nearventure handoff](nearventure-handoff.md), not deployed by this toolkit.

## Attesting legacy retained raw artifacts

`pfo-v0.1` predates collection-provenance capture and therefore is not a valid `replay-raw` source. `attest-legacy-raw` is narrowly restricted to that source and creates a separate target run from copied, SHA-256-verified retained raw files:

```bash
pnpm cli attest-legacy-raw --territory pfo --source-run-id pfo-v0.1 \
  --target-run-id pfo-v0.1-attested --reason "attest retained raw for replay"
```

The command only accepts the source's empty/absent legacy provenance; it refuses a source that already claims captured provenance. The old run, its raw files, and its release are never modified. The target provenance and run manifest explicitly say `legacy: true`, `reconstructed: true`, and `sourceOrigin: "pfo-v0.1"`, retain the operator reason, and state that no fresh collection occurred. The command rejects noncanonical identifiers, path escapes, symlinked directories/files, hardlinked files, special files, mutation during hashing/copy, and mismatched target hashes. Only the attested target—not the old run—can be provided to `replay-raw`.
