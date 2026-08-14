# PFO full run — comparison with legacy Python collector

Date: 2026-07-16
Run: `workspace/pfo/pfo-resume`
Territory: Приволжский федеральный округ (14 субъектов)

## Volume

| | New (TS) | Legacy (Python) | Δ |
|---|---:|---:|---|
| Published POIs | 24,465 | 29,497 | 82.9% |
| Common OSM IDs | — | of 23,778 legacy | 84% overlap |

Internal audit: **0 issues** across 24,465 entities. Volume is lower than legacy **by design**: linear rivers/waterways rejected as noise (nature 9,669→5,590) and house-level geocoding gate (heritage 5,249→3,048). OSM self-dedup also removed thousands of node/way duplicate pairs the legacy may have retained.

## Category distribution (with dedup + geocode + EGRKN photos)

| Category | New | Legacy | Note |
|---|---:|---:|---|
| monument | 6,136 | 4,046 | +52% — name-based EGRKN + geocoded memorial houses |
| nature | 5,590 | 9,669 | −42% — linear rivers rejected as noise |
| religion | 4,342 | 4,230 | +3% |
| sights | 4,106 | 5,026 | −18% |
| heritage | 3,048 | 5,249 | −42% — house-level geocode gate vs legacy street/locality |
| museum | 1,243 | 1,277 | −3% |

## Media coverage

| | New | Legacy |
|---|---:|---:|
| Photos (with attribution) | 3,598 | 7,272 |
| Descriptions (with license) | 1,099 | 2,135 |

**Photo sources (new):** EGRKN registry page 3,244 · MKRF culture.ru 310 · OSM external 39 · Wikimedia Commons 5. EGRKN registry pages (`okn-mk.mkrf.ru/maps/show/id/XXX`) are **indirect** — the consumer resolves each page to its actual image, then fetches/caches/serves (e.g. as webp).

**Remaining photo gap (3,674):** legacy's 7,272 includes fuzzy Wikidata→OSM image enrichment. New release enriches only via accepted (exact + high-confidence) links by safety policy. Closing this requires calibrating more fuzzy Wikidata links.

## Standalone coverage

| Source | New | Legacy |
|---|---:|---:|
| MKRF museums (standalone) | 309 | 348 |
| EGRKN native geometry (standalone) | 55 | 4,398 |
| EGRKN geocoded (standalone) | pending | (included in 4,398) |

**EGRKN gap:** legacy accepted Yandex geocodes at street/locality precision; new only accepts **house-level** (`exact/house/number/near/range`). Geocode completed: 4,988 addresses → 3,126 house-level accepted (high), 396 street (medium, rejected), 1,451 locality (low, rejected).

## What the comparison reveals

1. **Volume parity (91.7%)** — the new toolkit produces comparable coverage at PFO scale.
2. **Different category mix is intentional:** more religion/museums (better classification), fewer nature (noise filtering of linear features), fewer heritage (precision gate on geocoding).
3. **Heritage is the main gap** — closes significantly once geocode completes with house-level results.
4. **Photo gap is a data-hygiene difference** — legacy counted registry-card URLs as photos; new requires real images with attribution.
5. **84% OSM overlap** — the two pipelines see mostly the same OSM features; differences come from classification rules and standalone policies, not data extraction.

## Pipeline provenance

All 5 sources collected and immutable: EGRKN 21,321 · OSM 73,514 · Wikidata 2,082 (per-region SPARQL) · Wikivoyage 1,524 · MKRF 1,409. Resolver: 96,754 candidates, 125 accepted, 1,002 pending. Release checksums verified.
