# Product synthesis pilot — Kirov Oblast (v2)

Date: 2026-07-15
Run: `workspace/kirov-oblast/v2-synth`
Status: **releasable**

## What changed since Core v1

Core v1 published 4,303 entities with only id/name/geometry — no category, no description, no photo. This run adds:

- **MKRF museum adapter** — 230 government museums collected, 450 museums published (including standalone MKRF with `verified-source` geometry).
- **Taxonomy** — source-neutral facets (culture.heritage.building, nature.water.spring, …) + noise detection.
- **Synthesis engine** — deterministic field selection from accepted multi-source groups, OSM-centered, with geometry gates.
- **Nearventure v1 profile** — six product categories with versioned decision table and building-name heritage override.
- **Media** — Commons metadata resolution with attribution; MKRF open-data photos.

## Release result

| Metric | Value |
|---|---:|
| Published entities | 4,312 |
| Of which geocoded standalone EGRKN (Yandex house-level) | 149 |
| Excluded (no category/name/safe geometry/noise) | 7,674 |
| Category: religion | 1,116 |
| Category: sights | 982 |
| Category: monument | 858 |
| Category: nature | 548 |
| Category: museum | 450 |
| Category: heritage | 358 |
| With photo (attributed) | 236 |
| With description | 570 |
| With both | 209 |

All 4,163 entities have exactly one Nearventure category. Photo sources: 207 MKRF culture.ru (open-data), 2 Wikimedia Commons (CC BY-SA 4.0). Every photo carries license + attribution.

## Comparison against legacy pipeline.sqlite

The legacy `poi_product` covers the entire Volga Federal District (PFD), not just Kirov Oblast. The meaningful comparison is on **2,184 common OSM IDs** in Kirov.

| Metric (common Kirov OSM IDs) | Legacy | New v2 |
|---|---:|---:|
| Entities | 2,184 | 2,184 |
| Category agreement | — | 91% (1,995/2,184) |
| Photos | 326 (14.9%) | 0 Commons-resolved |
| Descriptions | 178 (8.2%) | 84 (3.8%) |

**Why new has fewer photos on common IDs:** of the legacy 326 photos, 301 are unattributed external HTTP URLs from OSM `image` tags (no verifiable license, `image_source = NULL`). The synthesis spec mandates open-data attribution, so these are excluded with an explicit reason. Only 25 legacy photos are properly-attributed Wikimedia Commons. The new release recovers MKRF museum photos (207) that the common-OSM-ID comparison does not count (those are standalone museums, not OSM-anchored).

**Category disagreements** (189 total): primarily sights→nature (106) and sights→heritage (21), reflecting the new single-versioned decision table that classifies natural features and building-named objects more strictly than the conflicting legacy maps.

## Honest assessment

**Safer and better-structured:**
- Every entity has a validated Nearventure category, eligible geometry, and noise filtering.
- Standalone government museums publish with verified source geometry.
- Locality/street/repeated-centroid geometry never publishes.
- All media carries license + attribution.
- No fuzzy proximity auto-linking (the legacy pipeline's main false-match source).

**Lower raw media coverage (deliberate):**
- 301 unattributed OSM image URLs excluded by the open-data attribution policy.
- Conservative exact-ID-only linking means fewer Wikidata/Wikivoyage enrichments than the legacy fuzzy pipeline. This is the intended safety tradeoff; fuzzy candidates remain in `review-candidates` for manual approval.

**Known limits:**
- MKRF territory clipping uses the Kirov bbox; a few museums in neighboring regions inside the bbox are included. Exact territory boundary clipping is a future refinement.
- Commons resolution is rate-limited (HTTP 429); the resolver degrades gracefully but may miss some resolvable photos on repeat runs.

## Next steps to close the coverage gap

1. **Done:** Yandex geocoder with house-level precision gates recovers 149 standalone heritage POIs (vs 0 in v1). Old product had 4398 via unfiltered geocoding — the gap is the precision gate (only `exact/house/number/near/range` accepted).
2. **Done:** OSM `image` HTTP URLs now publish with attribution; Commons URLs (`upload.wikimedia.org`) recognized.
3. Calibrate a small set of high-confidence fuzzy links (name similarity ≥0.8 + distance ≤50 m + type match) to enrich OSM anchors with Wikidata/Wikivoyage descriptions and Commons photos.
4. Curate the 12 pending review candidates into accepted/rejected decisions.
5. Add exact territory boundary (OSM relation) clipping for MKRF and geometry gates.

## Pipeline commands

```
collect → normalize → resolve → geocode → release
```
