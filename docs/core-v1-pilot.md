# Core v1 pilot — Kirov Oblast

Date: 2026-07-14  
Run: `workspace/kirov-oblast/kirov-core-v1-release`  
Result: **releasable**

## Scope

The pilot ran the complete Docker pipeline against real data:

1. EGRKN cursor API (`MKRF_API_KEY` supplied only through the environment)
2. a local 766,440,018-byte PFO OSM PBF, clipped to the territory bbox
3. Wikidata Query Service for `Q5387`
4. configured Russian Wikivoyage pages
5. normalization, evidence/claim generation, deterministic resolution, and release export

No geocoder was needed. Nothing was uploaded to OSM.

## Collection and normalization

| Source | Normalized records | Located | Named |
|---|---:|---:|---:|
| EGRKN | 913 | 223 | 913 |
| OSM | 9,105 | 4,114 | 4,308 |
| Wikidata | 1,401 | 1,398 | 1,401 |
| Wikivoyage | 349 | 348 | 347 |
| **Total** | **11,768** | **11,074 geometry evidence rows** | |

EGRKN address classes were: 397 relative, 412 missing, 53 structured, 47 exact, 3 compound, and 1 unstructured. Native geometry was classified as 204 object, 19 complex, and 690 unknown. The normalizer emitted 859 unresolved-geometry reasons (694 missing native geometry and 165 relative-address records with coordinates).

The release safety calculation classified 856 EGRKN records as geometrically unsafe for standalone publication or automatic fuzzy linking. This deliberately favors precision over coverage.

## Resolver calibration

The first real run exposed two problems that fixtures had not shown:

- a 1.5 km dense-city spatial join produced 24,627 EGRKN↔OSM dossiers;
- a permissive complex rule marked unrelated nearby objects as possible ensemble parts.

Core v1 now retains only the top 15 deterministic dossiers per EGRKN record while preserving the original competing-candidate count. Complex `contains` hypotheses require either a heritage feature within 100 m or stronger type plus name/address evidence.

Final resolver output:

| Decision | Count | Policy |
|---|---:|---|
| accepted | 12 | explicit stable identifiers only |
| pending | 12 | high-signal fuzzy evidence for review |
| rejected | 2,593 | retained as explainable dossiers |

Accepted links comprise 11 OSM `wikidata` tag links and one Wikivoyage `wdid` link. No fuzzy EGRKN link was auto-accepted. Pending examples include exact-name, metre-scale pairs such as “Обелиск борцам за Советскую власть”; they remain review-only because score alone is not an acceptance policy.

## Published release

The conservative projection published **4,303** named OSM-anchored entities. OSM geometry and name always win in an accepted group.

Excluded/review metrics:

- 913 standalone EGRKN records
- 1,744 standalone Wikidata/Wikivoyage records
- 4,797 unnamed or unlocated OSM records
- 12 fuzzy pending dossiers
- 856 EGRKN records with unsafe geometry (overlaps the standalone count)

Release bundle:

- `release/entities.geojson` — 4,303 features
- `release/entities.parquet` — 4,303 rows, GeoParquet 1.1, WKB; geometry types: Point, LineString, MultiPolygon
- `release/dataset.gpkg` — layer `entities`, 4,303 features
- `release/review-candidates.ndjson` — 12 enriched review dossiers
- `release/unresolved.ndjson` — 11,749 unresolved source-record entries
- `release/manifest.json` — policy, counts, byte sizes, SHA-256 checksums

The GeoPackage extent is `(46.018963, 56.306928) – (55.001630, 60.943449)`. GDAL opened it successfully. All four raw snapshot hashes and all five release artifact hashes were independently recomputed and matched their manifests.

## Failures found and fixed during the pilot

1. **EGRKN pagination:** `nextPage` is a complete URL, not a cursor token. Passing it as `cursor` caused HTTP 400 after page one. The adapter now uses only the opaque `cursor`, detects repetition, and has a page-limit completeness guard.
2. **Missing Wikivoyage pages:** configured absent pages were incorrectly treated as schema drift. MediaWiki `missing: true` is now a documented skip; malformed existing revisions still fail.
3. **OSM snapshot explosion:** generic `nwr/natural` pulled large natural polygons and dependencies, producing an 852 MB GeoJSON sequence. The filter now selects POI-scale natural categories explicitly; the real snapshot fell to about 3.6 MB.
4. **Resolver candidate explosion:** candidate retrieval is now bounded and complex-part rules are stricter.
5. **Release atomicity and provenance:** releases are staged as a directory, atomically promoted, checksummed, and accompanied by raw collection provenance. A successful CLI release marks the run `releasable`.

## Known Core v1 limits

- Standalone Wikidata/Wikivoyage publication remains disabled until cross-source deduplication rules are calibrated.
- EGRKN fuzzy candidates are review-only; no learned model or geocoder is used.
- OSM source count in the collection manifest is zero because the raw GeoJSON sequence is not parsed during collection; the normalized source profile is canonical and reports 9,105.
- GeoPackage contains mixed geometry and therefore reports `Unknown (any)` at the layer level.
- Licenses and attributions are recorded in source manifests; redistribution and any future OSM contribution still require a separate compatibility review.
