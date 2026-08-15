# POI quality hardening

The toolkit prevents the defects found in the Kirov, Slobodskoy and PFO audits before a release becomes `releasable`.

## Permanent rules

| Defect | Code-level guard |
|---|---|
| Restaurant or hotel published as a sight | Wikivoyage service-name taxonomy filter, including pizza, tavern, shashlik and pancake patterns |
| Missing lakes/rocks/springs | OSM tags filter keeps explicit water, lake, pond, reservoir, geology and nature-reserve features; taxonomy decides publication later |
| OSM area/way/node duplicates | exact-name OSM self-link <=30m, plus exact same-name containment candidates |
| Registry/OSM duplicate | exact non-generic name, <=30m, at least one OSM anchor and no address conflict |
| Two different houses merged | structured address retains house suffix, corpus, structure and letter; conflicts prohibit a merge |
| Geocoder drops `литера` and moves a POI | returned Photon, Nominatim or Yandex address is compared to requested address; incompatible high-precision results are retained in the attempt audit but never publish or dedup |
| `Дом жилой`/`Флигель` collapse | generic building names never auto-merge from name and proximity |
| Malformed product name | Nearventure profile excludes single-character and names without a letter |

Legacy geocode evidence without explicit `addressCompatible: true` is ignored. It cannot bypass the new check; a fresh provider-routed `geocode` run adds only validated points.

## Release hardening report

`poi-toolkit geocode` writes accepted `geocoded/geometry-evidence.ndjson` plus a complete `geocoded/geocode-audit.ndjson`. `poi-toolkit release` writes `reports/hardening-report.json` and exits with status 2 instead of marking a run releasable when one of these counts is non-zero:

- registry-backed museum without a photo;
- standalone `wikivoyage` nature POI;
- Wikivoyage food/service listing;
- malformed published name;
- unresolved specific same-name OSM duplicate within 30m;
- address-building conflict from geocoding;
- accepted provider evidence without its complete geocode audit;
- PFO candidate outside the 14 canonical subject polygons;
- conflict between source-region evidence and its containing subject polygon.

Registry-only clusters are not auto-merged or treated as blocking duplicates: several independently registered parts of a complex may intentionally share an EGRKN centroid.

## Required commands

```bash
# From poi-toolkit
corepack pnpm install
corepack pnpm -r build

# Targeted regression suites
corepack pnpm --filter @poi-toolkit/source-osm test
corepack pnpm --filter @poi-toolkit/geography test
corepack pnpm --filter @poi-toolkit/geocode test
corepack pnpm --filter @poi-toolkit/quality test

# A full run. Large/complex OSM geometries need a larger Node stack.
node --stack-size=65536 packages/cli/dist/index.js normalize --territory pfo --run-id <run>
node --stack-size=65536 packages/cli/dist/index.js resolve --territory pfo --run-id <run>
# Local Photon is default and unbounded. Select Nominatim/Yandex explicitly;
# Yandex is capped at 1,000 calls whether primary or fallback; --fallback is opt-in.
node --stack-size=65536 packages/cli/dist/index.js geocode --territory pfo --run-id <run>
node --stack-size=65536 packages/cli/dist/index.js geocode --territory pfo --run-id <run> --provider photon --fallback yandex
node --stack-size=65536 packages/cli/dist/index.js release --territory pfo --run-id <run>
```

Do not use `export-sql --replace` as a general update mechanism until the new release has been compared with the active catalogue by coverage and feature family. The production patch record is in the Nearventure repository history.
