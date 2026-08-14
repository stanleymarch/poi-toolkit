import type { SourceRecord } from "@poi-toolkit/core";

// ── Types ────────────────────────────────────────────────────────────────

/** A single OSM feature with an address, indexed for exact matching. */
export type AddressIndexEntry = {
  lon: number;
  lat: number;
  osmId: string;
  name: string | null;
  isBuilding: boolean;
  corpus: string | null;
  letter: string | null;
};

/**
 * Compact OSM address index. Key format:
 *   `city|normalizedStreet|houseNumber`
 *
 * Multiple features can share a key (building polygon + entrance node +
 * business POI). The matcher prefers building polygons and rejects
 * business-only points (amenity=restaurant, cafe, bar, etc.).
 */
export type OsmAddressIndex = Map<string, AddressIndexEntry[]>;

export type AddressMatchResult = {
  matched: boolean;
  entry: AddressIndexEntry | null;
  ambiguous: boolean;
  reason: string;
};

// ── Business POI tags that must NOT provide geometry for heritage records ──

const BUSINESS_AMENITIES = new Set([
  "restaurant", "cafe", "bar", "fast_food", "pub", "biergarten",
  "food_court", "ice_cream", "juice_bar", "tea",
]);

const BUSINESS_SHOPS = /^(shop|amenity|tourism|hazard)$/;
const BUSINESS_TOURISM = new Set(["hotel", "hostel", "motel", "guest_house", "apartment", "chalet"]);

// ── Address canonicalisation ──────────────────────────────────────────────

/** Canonicalise a street name: lowercase, ё→е, strip prefixes/suffixes. */
export function canonicalStreet(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  return raw.toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'()№.,:;–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(улица|ул|проспект|пр-?кт|переулок|пер|площадь|пл|набережная|наб|шоссе|тупик|проезд|бульвар|аллея)\s+/i, "")
    .replace(/\s+(улица|ул|проспект|пр-?кт|переулок|пер|площадь|пл|набережная|наб|шоссе|тупик|проезд|бульвар|аллея)$/i, "")
    .trim() || null;
}

/** Canonicalise a house number: lowercase, strip spaces around separators. */
export function canonicalHouse(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  return raw.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, "").replace(/^д(?:ом)?\./i, "").trim() || null;
}

/** Canonicalise a city/locality name. */
export function canonicalCity(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  return raw.toLowerCase()
    .replace(/ё/g, "е")
    .replace(/^(г|город|д|деревня|с|село|пгт|поселок|рп|рабочий поселок|снт|станица|ст)\.?\s*/i, "")
    .replace(/[«»"'()№.,:;–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || null;
}

/** Build the lookup key for the index. */
export function addressKey(city: string | null, street: string | null, house: string | null): string | null {
  const c = canonicalCity(city);
  const s = canonicalStreet(street);
  const h = canonicalHouse(house);
  if (!s || !h) return null;
  return [c ?? "_", s, h].join("|");
}

// ── Index builder ─────────────────────────────────────────────────────────

/**
 * Build an address index from OSM SourceRecords.
 *
 * Only features with BOTH `addr:housenumber` AND `addr:street` are included.
 * Business POIs (amenity=restaurant, cafe, bar, etc.) are marked but NOT
 * preferred for geometry — the matcher always prefers building polygons.
 */
export function buildAddressIndex(records: SourceRecord[]): OsmAddressIndex {
  const index: OsmAddressIndex = new Map();

  for (const record of records) {
    if (record.source !== "osm" || !record.geometry) continue;
    const tags = record.fields.tags as Record<string, string> | undefined;
    if (!tags) continue;

    const house = tags["addr:housenumber"];
    const street = tags["addr:street"];
    if (!house?.trim() || !street?.trim()) continue;

    const city = tags["addr:city"] ?? tags["addr:hamlet"] ?? tags["addr:village"] ?? tags["addr:town"] ?? null;
    const key = addressKey(city, street, house);
    if (!key) continue;

    // Representative point from geometry
    const point = representativePoint(record.geometry);
    if (!point) continue;

    const amenity = tags.amenity ?? null;
    const tourism = tags.tourism ?? null;
    const buildingTag = tags.building ?? null;
    const isBusiness =
      (amenity !== null && BUSINESS_AMENITIES.has(amenity)) ||
      (tourism !== null && BUSINESS_TOURISM.has(tourism));

    const entry: AddressIndexEntry = {
      lon: point[0],
      lat: point[1],
      osmId: record.sourceId,
      name: tags.name ?? null,
      isBuilding: buildingTag !== null && !isBusiness,
      corpus: tags["addr:corpuse"] ?? tags["addr:corpus"] ?? null,
      letter: tags["addr:letter"] ?? null,
    };

    const existing = index.get(key);
    if (existing) existing.push(entry);
    else index.set(key, [entry]);
  }

  return index;
}

// ── Matcher ───────────────────────────────────────────────────────────────

/**
 * Match a parsed address against the OSM index.
 *
 * Priority:
 * 1. Building polygon with matching name → high confidence
 * 2. Building polygon without name → medium confidence
 * 3. Non-building entry → rejected (business POI, ambiguous)
 *
 * If multiple buildings match without a name disambiguator → ambiguous.
 */
export function matchAddress(
  index: OsmAddressIndex,
  city: string | null,
  street: string | null,
  house: string | null,
  expectedName: string | null = null,
): AddressMatchResult {
  const key = addressKey(city, street, house);
  if (!key) return { matched: false, entry: null, ambiguous: false, reason: "incomplete address" };

  const entries = index.get(key);
  if (!entries?.length) return { matched: false, entry: null, ambiguous: false, reason: "address not in OSM index" };

  // Prefer building entries
  const buildings = entries.filter((e) => e.isBuilding);
  if (buildings.length === 0) {
    return { matched: false, entry: null, ambiguous: false, reason: "only non-building entries (business/POI)" };
  }

  // If expected name provided, try to find a building with matching name
  if (expectedName) {
    const normalizedName = expectedName.toLowerCase().replace(/ё/g, "е").trim();
    const nameMatch = buildings.find((b) => {
      if (!b.name) return false;
      const bn = b.name.toLowerCase().replace(/ё/g, "е").trim();
      return bn.includes(normalizedName) || normalizedName.includes(bn);
    });
    if (nameMatch) return { matched: true, entry: nameMatch, ambiguous: false, reason: "building name match" };
  }

  // Single building → use it
  if (buildings.length === 1) return { matched: true, entry: buildings[0], ambiguous: false, reason: "single building at address" };

  // Multiple buildings, no name disambiguator → ambiguous
  return { matched: false, entry: null, ambiguous: true, reason: `multiple buildings (${buildings.length}) at address without name disambiguation` };
}

// ── Geometry helpers ──────────────────────────────────────────────────────

function representativePoint(geometry: NonNullable<SourceRecord["geometry"]>): [number, number] | null {
  if (geometry.type === "Point") {
    const [lon, lat] = geometry.coordinates as [number, number];
    return [lon, lat];
  }
  if (geometry.type === "Polygon") return pointOnPolygonSurface(geometry.coordinates as number[][][]);
  if (geometry.type === "MultiPolygon") {
    const polygons = geometry.coordinates as number[][][][];
    if (!polygons.length) return null;
    // Largest polygon
    const sorted = [...polygons].sort((a, b) => polygonArea(b[0] as [number, number][]) - polygonArea(a[0] as [number, number][]));
    return pointOnPolygonSurface(sorted[0]);
  }
  if (geometry.type === "LineString") {
    const coords = geometry.coordinates as number[][];
    if (isClosedRing(coords)) return pointOnPolygonSurface([coords]);
    return null; // Non-closed line — skip
  }
  return null;
}

function isClosedRing(coords: number[][]): boolean {
  return coords.length >= 4 && coords[0][0] === coords.at(-1)![0] && coords[0][1] === coords.at(-1)![1];
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
  for (let yi = 0; yi < 32; yi += 1) for (let xi = 0; xi < 32; xi += 1) {
    const point: [number, number] = [Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * (xi + 0.5) / 32, Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * (yi + 0.5) / 32];
    if (!pointInPolygon(point, rings)) continue;
    const distance = (point[0] - centre[0]) ** 2 + (point[1] - centre[1]) ** 2;
    if (distance < bestDistance) { best = point; bestDistance = distance; }
  }
  return best;
}

function polygonCentroid(coords: [number, number][]): [number, number] | null {
  if (coords.length < 3) return null;
  let area = 0, cx = 0, cy = 0;
  for (let i = 0, prev = coords.length - 1; i < coords.length; prev = i++) {
    const cross = coords[prev][0] * coords[i][1] - coords[i][0] * coords[prev][1];
    area += cross;
    cx += (coords[prev][0] + coords[i][0]) * cross;
    cy += (coords[prev][1] + coords[i][1]) * cross;
  }
  area = area / 2;
  if (Math.abs(area) < 1e-12) return null;
  return [cx / (6 * area), cy / (6 * area)];
}

function polygonArea(coords: [number, number][]): number {
  let area = 0;
  for (let i = 0, prev = coords.length - 1; i < coords.length; prev = i++) area += coords[prev][0] * coords[i][1] - coords[i][0] * coords[prev][1];
  return Math.abs(area / 2);
}

function pointInPolygon(point: [number, number], rings: number[][][]): boolean {
  if (!rings.length || !pointInRing(point[0], point[1], rings[0] as [number, number][])) return false;
  return !rings.slice(1).some((ring) => pointInRing(point[0], point[1], ring as [number, number][]));
}

function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ── Serialisation ─────────────────────────────────────────────────────────

/** Serialise index to compact JSON for disk storage. */
export function serialiseAddressIndex(index: OsmAddressIndex): string {
  const obj: Record<string, AddressIndexEntry[]> = {};
  for (const [key, entries] of index) obj[key] = entries;
  return JSON.stringify(obj);
}

/** Deserialise index from JSON on disk. */
export function deserialiseAddressIndex(json: string): OsmAddressIndex {
  const obj = JSON.parse(json) as Record<string, AddressIndexEntry[]>;
  return new Map(Object.entries(obj));
}
