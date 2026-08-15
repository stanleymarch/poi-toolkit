# v2-final verification report (revised after sample audit)

Date: 2026-07-15
Run: `workspace/kirov-oblast/v2-final`
Pipeline: `collect → normalize → resolve → geocode → release`

## Sample audit findings and fixes

A stratified sample check (geocoded EGRKN, MKRF, OSM-with-photo, OSM-with-desc) found three real quality bugs that aggregate comparison missed:

1. **EGRKN category misclassification (systematic):** EGRKN `objectType` = «Памятник» is a *legal protection tier*, not a physical type. Churches, mosques, houses were all classified `monument`. **Fixed:** name-based classification in taxonomy. Result: +79 heritage, +32 religion, −110 monument.

2. **Regex bug «церкв» ≠ substring of «церковь»** (the «о» between к and в). Found because Никольская церковь stayed `monument`. **Fixed:** regex stem corrected to «церков».

3. **MKRF territorial bleed (127/207 = 61% of museums outside Kirov Oblast):** bbox clipping included Udmurtia, Perm, Nizhny Novgorod museums. **Fixed:** exact territory containment via 13 neighbor-region exclusion polygons (Kirov = bbox − neighbors). Result: museum 450 → 330 (dropped 120 phantom museums). The previous "236 photos" was inflated — 120 of those were from out-of-territory museums.

These fixes lowered raw counts but raised data correctness. **Sample checks found what aggregate metrics could not.**

## Final release (post-fix)

| Metric | Value |
|---|---:|
| Published entities | 4,186 |
| Internal audit issues | **0** |
| Category: religion | 1,143 |
| Category: sights | 981 |
| Category: monument | 748 |
| Category: nature | 547 |
| Category: museum | 330 (87 MKRF standalone + 243 OSM) |
| Category: heritage | 437 |
| With photo (attributed) | 116 |
| With description (licensed) | 450 |

Every entity: valid category ∈ 6, name, eligible geometry, in-territory. Every photo: license + attribution. Every description: license.

## Pipeline integrity — PASS

All 5 stages exit 0. All 5 release artifacts: byte-size + SHA-256 match manifest. GeoJSON 4186 features = NDJSON 4186 = GPKG 4186 features (ogrinfo exit 0).

## Geometry policy

OSM-native 3,448 · verified-source 738 (MKRF + EGRKN native + EGRKN geocoded house-level). Territory containment rejects points inside 13 neighbor regions.

## Honest comparison with legacy

Legacy `poi_product` is PFO-wide; this release is Kirov Oblast with exact boundary containment. On 2,184 common OSM IDs: 91.3% category agreement. The new release is safer (no locality geometry, mandatory attribution, exact territory) at the cost of lower raw media volume (sparse OSM cross-tagging in Kirov + conservative linking).
