import type { AdminHierarchy, SourceRecord } from "@poi-toolkit/core";

export * from "./address-index.js";

// ── Public types ──────────────────────────────────────────────────────────

export type ContainmentCandidate = {
  sourceRecordIds: [string, string];
  relation: "same";
  decision: "accepted";
  reason: string;
};

/** Structured building address. House suffixes, corpus, structure and letter
 * are intentionally separate: dropping a letter can move a point to a
 * neighbouring building and create a false duplicate. */
export type BuildingAddress = {
  street: string | null;
  house: string | null;
  corpus: string | null;
  structure: string | null;
  letter: string | null;
};

export type AddressCompatibility = { compatible: boolean; reason: string; expected: BuildingAddress; returned: BuildingAddress };

/** Canonical PFO subject polygon loaded from territories/pfo-subjects.geojson. */
export type SubjectBoundary = {
  id: string;
  region: string;
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] };
};

export type SubjectAssignment = { region: string | null; boundaryId: string | null; point: [number, number] | null };

const EMPTY_ADDRESS: BuildingAddress = { street: null, house: null, corpus: null, structure: null, letter: null };

/** Parse a Russian postal address without collapsing house parts or letters. */
export function parseBuildingAddress(value: string | null | undefined): BuildingAddress {
  if (!value?.trim()) return { ...EMPTY_ADDRESS };
  const text = value.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  const prefixStreet = text.match(/(?:^|[,;\s])(?:улица|ул|проспект|пр-?кт|переулок|пер|площадь|пл|набережная|наб|шоссе)(?![а-яёa-z])\.?\s*([^,;]+)/i)?.[1]?.trim() ?? null;
  const suffixStreet = text.match(/(?:^|[,;]\s*)([^,;]+?)\s+(?:улица|ул|проспект|пр-?кт|переулок|пер|площадь|пл|набережная|наб|шоссе)(?![а-яёa-z])/i)?.[1]?.trim() ?? null;
  const street = prefixStreet ?? suffixStreet;
  const markedHouse = text.match(/(?:^|[,;\s])(?:д(?:ом)?\.?\s*)(\d+)\s*([а-яa-z])?(?=$|[,;\s])/i);
  const fallbackHouse = !markedHouse ? text.match(/(?:^|[,;])\s*(\d+)\s*([а-яa-z])?(?=$|[,;\s])/i) : null;
  const houseMatch = markedHouse ?? fallbackHouse;
  const letter = text.match(/(?:лит(?:ера)?\.?|лит\.)\s*([а-яa-z])/i)?.[1] ?? houseMatch?.[2] ?? null;
  // Treat compact suffixes such as «д. 67 кД» as a corpus discriminator.
  // A returned corpus/letter that was not requested is also a conflict: 67 ≠ 67 кД.
  const corpus = text.match(/(?:^|[,;\s])(?:корп(?:ус)?|к)\.?\s*(\d+[а-яa-z]?|[а-яa-z])(?=$|[,;\s])/i)?.[1] ?? null;
  const structure = text.match(/(?:^|[,;\s])(?:стр(?:оение)?|с)\.?\s*(\d+[а-яa-z]?|[а-яa-z])(?=$|[,;\s])/i)?.[1] ?? null;
  return { street, house: houseMatch?.[1] ?? null, corpus, structure, letter };
}

export function buildingAddressFingerprint(address: BuildingAddress): string {
  return [address.street, address.house, address.corpus, address.structure, address.letter].map((part) => part ?? "").join("|");
}

/** A returned geocoder address is safe only when it preserves every specified
 * building discriminator from the requested address. */
export function validateBuildingAddress(expectedText: string | null | undefined, returnedText: string | null | undefined): AddressCompatibility {
  const expected = parseBuildingAddress(expectedText);
  const returned = parseBuildingAddress(returnedText);
  for (const key of ["house", "corpus", "structure", "letter"] as const) {
    // An added discriminator is no safer than a missing one: 67 and 67 кД
    // are different buildings even when the source address does not spell out
    // a corpus. Require exact agreement for every parsed building part.
    if (expected[key] !== returned[key]) return { compatible: false, reason: `${key} mismatch: expected ${expected[key] ?? "missing"}, got ${returned[key] ?? "missing"}`, expected, returned };
  }
  if (expected.street && returned.street && !returned.street.includes(expected.street) && !expected.street.includes(returned.street)) {
    return { compatible: false, reason: "street mismatch", expected, returned };
  }
  return { compatible: true, reason: "building address compatible", expected, returned };
}

// ── A. Admin hierarchy resolver ───────────────────────────────────────────

/** Canonical names for PFO subjects — collapses EGRKN/OSM naming variants
 *  ("Башкортостан" / "Республика Башкортостан", "Татарстан" / "Республика
 *  Татарстан (Татарстан)") into one official short form per subject. */
const REGION_CANONICAL: Array<{ match: RegExp; canonical: string }> = [
  { match: /башкортостан/i, canonical: "Республика Башкортостан" },
  { match: /марий\s*эл/i, canonical: "Республика Марий Эл" },
  { match: /мордови/i, canonical: "Республика Мордовия" },
  { match: /татарстан/i, canonical: "Республика Татарстан" },
  { match: /удмурт/i, canonical: "Удмуртская Республика" },
  { match: /чувашск|чуваши/i, canonical: "Чувашская Республика" },
  { match: /кировск/i, canonical: "Кировская область" },
  { match: /нижегородск/i, canonical: "Нижегородская область" },
  { match: /оренбургск/i, canonical: "Оренбургская область" },
  { match: /пензенск/i, canonical: "Пензенская область" },
  { match: /самарск/i, canonical: "Самарская область" },
  { match: /саратовск/i, canonical: "Саратовская область" },
  { match: /ульяновск/i, canonical: "Ульяновская область" },
  { match: /пермск/i, canonical: "Пермский край" },
];

/** Normalise a raw region string to its canonical PFO subject name, or null
 *  if it does not match any known subject. Returning null for unrecognised
 *  values prevents truncated/false regex matches ("одская область",
 *  "Республика Беларусь.") from polluting the region field. */
export function canonicalRegion(raw: string): string | null {
  for (const { match, canonical } of REGION_CANONICAL) {
    if (match.test(raw)) return canonical;
  }
  return null;
}

/** Assign an object to an authoritative PFO subject polygon. Text fields never
 * override this result: a point outside all 14 subjects is deliberately null. */
export function assignSubjectBoundary(
  geometry: NonNullable<SourceRecord["geometry"]>,
  boundaries: SubjectBoundary[],
): SubjectAssignment {
  const point = geometryRepresentativePoint(geometry);
  if (!point) return { region: null, boundaryId: null, point: null };
  for (const boundary of boundaries) {
    const contained = boundary.geometry.type === "Polygon"
      ? pointInPolygon(point, boundary.geometry.coordinates as number[][][])
      : (boundary.geometry.coordinates as number[][][][]).some((polygon) => pointInPolygon(point, polygon));
    if (contained) return { region: boundary.region, boundaryId: boundary.id, point };
  }
  return { region: null, boundaryId: null, point };
}

function pointInPolygon(point: [number, number], rings: number[][][]): boolean {
  if (!rings.length || !pointInRing(point[0], point[1], rings[0] as [number, number][])) return false;
  return !rings.slice(1).some((ring) => pointInRing(point[0], point[1], ring as [number, number][]));
}

/** Representative point policy: native point, line midpoint, polygon point-on-surface. */
function geometryRepresentativePoint(geometry: NonNullable<SourceRecord["geometry"]>): [number, number] | null {
  if (geometry.type === "Point") return [Number(geometry.coordinates[0]), Number(geometry.coordinates[1])];
  if (geometry.type === "LineString") return lineMidpoint(geometry.coordinates as [number, number][]);
  if (geometry.type === "Polygon") return pointOnPolygonSurface(geometry.coordinates as number[][][]);
  const polygons = geometry.coordinates as number[][][][];
  if (!polygons.length) return null;
  return pointOnPolygonSurface([...polygons].sort((a, b) => polygonArea(b[0] as [number, number][]) - polygonArea(a[0] as [number, number][]))[0]);
}

function lineMidpoint(coords: [number, number][]): [number, number] | null {
  if (!coords.length) return null;
  if (coords.length === 1) return coords[0];
  const lengths = coords.slice(1).map((point, index) => haversine(coords[index][0], coords[index][1], point[0], point[1]));
  const half = lengths.reduce((sum, length) => sum + length, 0) / 2;
  let walked = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    if (walked + lengths[index] >= half) {
      const ratio = (half - walked) / lengths[index];
      return [coords[index][0] + (coords[index + 1][0] - coords[index][0]) * ratio, coords[index][1] + (coords[index + 1][1] - coords[index][1]) * ratio];
    }
    walked += lengths[index];
  }
  return coords.at(-1) ?? null;
}

function pointOnPolygonSurface(rings: number[][][]): [number, number] | null {
  const outer = rings[0] as [number, number][] | undefined;
  if (!outer?.length) return null;
  const centroid = polygonCentroid(outer);
  if (centroid && pointInPolygon(centroid, rings)) return centroid;
  const xs = outer.map(([x]) => x), ys = outer.map(([, y]) => y);
  const centre: [number, number] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  let best: [number, number] | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  // A deterministic grid finds an interior point for concave or holed polygons.
  for (let yi = 0; yi < 32; yi += 1) for (let xi = 0; xi < 32; xi += 1) {
    const point: [number, number] = [Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * (xi + 0.5) / 32, Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * (yi + 0.5) / 32];
    if (!pointInPolygon(point, rings)) continue;
    const distance = (point[0] - centre[0]) ** 2 + (point[1] - centre[1]) ** 2;
    if (distance < bestDistance) { best = point; bestDistance = distance; }
  }
  return best;
}

function polygonArea(coords: [number, number][]): number {
  let area = 0;
  for (let index = 0, previous = coords.length - 1; index < coords.length; previous = index++) area += coords[previous][0] * coords[index][1] - coords[index][0] * coords[previous][1];
  return Math.abs(area / 2);
}

/**
 * Resolve the administrative hierarchy (region / district / city) from a
 * group of source records.  Priority order:
 *   1. EGRKN  → fields.region  (subject-level, e.g. "Кировская область")
 *   2. OSM    → addr:region / addr:city / addr:district tags
 *   3. MKRF   → fields.address  (free-text; best-effort)
 *   4. Wikidata → not stored per-record; falls through to territoryName
 *
 * When nothing is found the hierarchy is derived from territoryName, or
 * null fields are returned.
 */
export function resolveAdminHierarchy(
  sourceRecordIds: string[],
  byRecord: Map<string, SourceRecord>,
  territoryName?: string,
): AdminHierarchy {
  const region = resolveRegion(sourceRecordIds, byRecord);
  const district = resolveDistrict(sourceRecordIds, byRecord);
  const city = resolveCity(sourceRecordIds, byRecord);
  return { region, district, city };
}

function resolveRegion(
  ids: string[],
  byRecord: Map<string, SourceRecord>,
  fallback?: string,
): string | null {
  // 1. EGRKN
  for (const id of ids) {
    const r = byRecord.get(id);
    if (r?.source !== "egrkn") continue;
    const v = String(r.fields.region ?? "");
    if (v && v !== "null" && v !== "undefined") {
      const canon = canonicalRegion(v);
      if (canon) return canon;
    }
  }
  // 2. OSM addr:region
  for (const id of ids) {
    const r = byRecord.get(id);
    if (r?.source !== "osm") continue;
    const tags = (r.fields as Record<string, unknown>).tags as Record<string, string> | undefined;
    const v = tags?.["addr:region"] ?? tags?.region ?? "";
    if (v) {
      const canon = canonicalRegion(v);
      if (canon) return canon;
    }
  }
  // 3. MKRF – best-effort from address text
  for (const id of ids) {
    const r = byRecord.get(id);
    if (r?.source !== "mkrf") continue;
    const addr = String(r.fields.address ?? r.fields.description ?? "");
    const m = addr.match(/(.?[а-яёА-ЯЁ]ская\s+(область|республика|край|округ)|Республика\s+\S+|Чувашия|Удмуртия|Марий\s+Эл|Башкортостан|Татарстан)/);
    if (m) {
      const canon = canonicalRegion(m[0]);
      if (canon) return canon;
    }
  }
  return fallback ?? null;
}

function resolveDistrict(
  ids: string[],
  byRecord: Map<string, SourceRecord>,
): string | null {
  for (const id of ids) {
    const r = byRecord.get(id);
    if (r?.source !== "osm") continue;
    const tags = (r.fields as Record<string, unknown>).tags as Record<string, string> | undefined;
    const v = tags?.["addr:district"] ?? tags?.["addr:county"] ?? "";
    if (v) return v;
  }
  return null;
}

function resolveCity(
  ids: string[],
  byRecord: Map<string, SourceRecord>,
): string | null {
  for (const id of ids) {
    const r = byRecord.get(id);
    if (r?.source !== "osm") continue;
    const tags = (r.fields as Record<string, unknown>).tags as Record<string, string> | undefined;
    const v = tags?.["addr:city"] ?? tags?.["addr:town"] ?? tags?.["addr:village"] ?? "";
    if (v) return v;
  }
  for (const id of ids) {
    const r = byRecord.get(id);
    if (r?.source !== "mkrf") continue;
    const addr = String(r.fields.address ?? "");
    const m = addr.match(/(г\.?\s*[А-ЯЁ][а-яё]+|город\s+[А-ЯЁ][а-яё]+|п\.?\s*[А-ЯЁ][а-яё]+|пос[её]лок\s+[А-ЯЁ][а-яё]+)/);
    if (m) return m[0].replace(/^(г\.?\s*|город\s+|п\.?\s*|пос[её]лок\s+)/, "");
  }
  return null;
}

// ── B. Building-contained dedup ───────────────────────────────────────────

const KNOWN_AREA_KEYS = new Set([
  "building", "leisure", "historic", "tourism", "amenity",
  "landuse", "man_made", "natural", "military", "sport",
]);

/**
 * Find OSM records whose geometry is a closed LineString (first == last
 * coordinate).  Treat them as area/building polygons and check whether any
 * OSM Point records with a similar name fall inside.  Returns candidates
 * that the resolver can accept as `same`-entity links.
 */
/** Cross-source identity link: an OSM anchor and a registry/knowledge source
 * with the same non-generic name at the same object-scale location. This is
 * deliberately stricter than fuzzy matching and excludes address conflicts. */
export function findExactCrossSourceCandidates(
  sourceRecords: SourceRecord[],
  geocodedEvidence: Map<string, { geometry: { type: "Point"; coordinates: [number, number] }; confidence: string; addressCompatible?: boolean }> = new Map(),
): ContainmentCandidate[] {
  const cells = new Map<string, Array<{ record: SourceRecord; point: [number, number]; name: string }>>();
  for (const record of sourceRecords) {
    if (!record.name?.trim()) continue;
    const geocoded = geocodedEvidence.get(record.id);
    const point = geocoded && geocoded.confidence === "high" && geocoded.addressCompatible === true
      ? geocoded.geometry.coordinates
      : record.geometry ? geometryCentroid(record.geometry) : null;
    if (!point) continue;
    const name = normalizeContainedName(record.name);
    if (!name || isGenericBuildingName(name)) continue;
    const key = `${Math.round(point[0] * 2_000)}:${Math.round(point[1] * 2_000)}`;
    cells.set(key, [...(cells.get(key) ?? []), { record, point, name }]);
  }
  const output: ContainmentCandidate[] = [], seen = new Set<string>();
  for (const [key, cell] of cells) {
    const [x, y] = key.split(":").map(Number);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      for (const a of cell) for (const b of cells.get(`${x + dx}:${y + dy}`) ?? []) {
        if (a.record.id >= b.record.id || a.name !== b.name || a.record.source === b.record.source) continue;
        if (a.record.source !== "osm" && b.record.source !== "osm") continue;
        const d = haversine(a.point[0], a.point[1], b.point[0], b.point[1]);
        if (d > 30 || buildingAddressesConflict(a.record.address, b.record.address)) continue;
        const sourceRecordIds = [a.record.id, b.record.id].sort() as [string, string];
        const id = sourceRecordIds.join("~");
        if (seen.has(id)) continue;
        seen.add(id);
        output.push({ sourceRecordIds, relation: "same", decision: "accepted", reason: `cross-source exact-name identity: ${a.record.source}↔${b.record.source}, ${Math.round(d)}m` });
      }
    }
  }
  return output;
}

export function findContainedCandidates(sourceRecords: SourceRecord[]): ContainmentCandidate[] {
  const osmAreas: Array<{ record: SourceRecord; polygon: number[][][]; name: string }> = [];
  const osmPoints: Array<{ record: SourceRecord; lon: number; lat: number; name: string }> = [];

  for (const r of sourceRecords) {
    if (r.source !== "osm" || !r.geometry || !r.name) continue;
    const name = r.name.trim();
    if (!name) continue;
    const g = r.geometry;

    if (g.type === "LineString") {
      const coords = g.coordinates as number[][];
      if (!isClosedRing(coords)) continue;
      // Only accept if the record has an area-type tag (building, leisure, …)
      const tags = (r.fields as Record<string, unknown>).tags as Record<string, string> | undefined;
      const hasAreaTag = tags && Object.keys(tags).some((k) => KNOWN_AREA_KEYS.has(k));
      if (!hasAreaTag) continue;
      const poly = lineStringToPolygon(coords);
      osmAreas.push({ record: r, polygon: poly.coordinates, name });
    } else if (g.type === "Point") {
      const [lon, lat] = g.coordinates as [number, number];
      osmPoints.push({ record: r, lon, lat, name });
    }
    // MultiPolygon – use the first polygon
    else if (g.type === "MultiPolygon") {
      const tags = (r.fields as Record<string, unknown>).tags as Record<string, string> | undefined;
      const hasAreaTag = tags && Object.keys(tags).some((k) => KNOWN_AREA_KEYS.has(k));
      if (!hasAreaTag) continue;
      for (const polyCoords of (g.coordinates as number[][][][])) {
        osmAreas.push({ record: r, polygon: polyCoords, name });
      }
    }
  }

  const candidates: ContainmentCandidate[] = [];
  for (const area of osmAreas) {
    for (const pt of osmPoints) {
      if (pt.record.id === area.record.id) continue;

      // A building/area context is strong only with an exact, non-generic name.
      // Never bridge nearby or similar names: a museum and a cafe can share one building.
      if (!pointInRing(pt.lon, pt.lat, area.polygon[0] as [number, number][])) continue;
      const cleanA = normalizeContainedName(pt.name);
      const cleanB = normalizeContainedName(area.name);
      if (!cleanA || cleanA !== cleanB || isGenericBuildingName(cleanA)) continue;
      candidates.push({
        sourceRecordIds: [pt.record.id, area.record.id].sort() as [string, string],
        relation: "same",
        decision: "accepted",
        reason: `osm-contained: exact non-generic name inside area "${area.name}"`,
      });
    }
  }

  return candidates;
}

const GENERIC_BUILDING_NAMES = /^(дом жилой|жилой дом|здание|особняк|флигель|амбар|сарай|баня|склад|магазин|службы?|ограждение|ворота|забор|контора)$/i;

function normalizeContainedName(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").replace(/[«»"'()№.,:;–—-]/g, " ").replace(/\s+/g, " ").trim();
}

export function isGenericBuildingName(value: string): boolean {
  return GENERIC_BUILDING_NAMES.test(normalizeContainedName(value));
}

function buildingAddressesConflict(a: string | null, b: string | null): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  const left = parseBuildingAddress(a), right = parseBuildingAddress(b);
  for (const key of ["house", "corpus", "structure", "letter"] as const) if (left[key] && right[key] && left[key] !== right[key]) return true;
  return false;
}

function geometryCentroid(geometry: NonNullable<SourceRecord["geometry"]>): [number, number] | null {
  if (geometry.type === "Point") return [Number(geometry.coordinates[0]), Number(geometry.coordinates[1])];
  let x = 0, y = 0, count = 0;
  const walk = (value: unknown): void => { if (Array.isArray(value) && typeof value[0] === "number") { x += value[0]; y += value[1]; count += 1; } else if (Array.isArray(value)) value.forEach(walk); };
  walk(geometry.coordinates);
  return count ? [x / count, y / count] : null;
}

// ── Geometry helpers ──────────────────────────────────────────────────────

/** True when the ring's first coordinate equals the last (closed contour). */
export function isClosedRing(coords: number[][]): boolean {
  if (coords.length < 4) return false;
  const [first] = coords;
  const last = coords[coords.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

/** Convert a closed LineString coordinate array to a Polygon geometry. */
export function lineStringToPolygon(coords: number[][]): { type: "Polygon"; coordinates: number[][][] } {
  return { type: "Polygon", coordinates: [coords] };
}

/** Ray-casting point-in-ring test (lon/lat). */
export function pointInRing(
  lon: number,
  lat: number,
  ring: [number, number][],
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Token-overlap similarity (Dice coefficient over normalised short tokens). */
export function similarity(a: string, b: string): number {
  const tok = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/ё/g, "е")
        .replace(/[«»"'()№.,:;–—-]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2),
    );
  const A = tok(a);
  const B = tok(b);
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  const denom = A.size + B.size;
  return denom === 0 ? 0 : (2 * common) / denom;
}

/** Simple centroid of a polygon ring (mean of vertices). */
function polygonCentroid(coords: number[][]): [number, number] | null {
  if (!coords.length) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of coords) { sx += x; sy += y; }
  return [sx / coords.length, sy / coords.length];
}

/** Haversine distance in metres between two (lon,lat) points. */
function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6_371_000;
  const r1 = lat1 * Math.PI / 180;
  const r2 = lat2 * Math.PI / 180;
  const dr = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dr / 2) ** 2 + Math.cos(r1) * Math.cos(r2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
