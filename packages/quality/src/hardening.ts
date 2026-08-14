import type { SourceRecord } from "@poi-toolkit/core";
import type { DispositionReport } from "./disposition.js";

export type HardenedEntity = {
  id: string;
  name: string;
  category: string;
  geometry: NonNullable<SourceRecord["geometry"]>;
  photo: unknown | null;
  sourceRecordIds: string[];
};

export type HardeningReport = {
  ruleVersion: "quality-hardening-v2";
  counts: {
    registryMuseumWithoutPhoto: number;
    standaloneWikivoyageNature: number;
    foodServiceListings: number;
    junkNames: number;
    specificNearDuplicates: number;
    addressBuildingConflicts: number;
    geocodeAuditFailures: number;
    unassignedSubjectRegions: number;
    subjectRegionConflicts: number;
    /** EGRKN records that received no disposition entry (missing audit). */
    missingDisposition: number;
    /** Quarantined-conflict records whose geometry leaked into evidence. */
    leakedQuarantineGeometry: number;
    /** P0.4: museum name categorized as non-museum (e.g. «музей» in sights). */
    museumCategoryMismatch: number;
  };
  blockingFailures: string[];
  /** Exact product pairs that triggered the near-duplicate gate. */
  nearDuplicatePairs: Array<[string, string]>;
};

const FOOD_SERVICE = /вкусноблин|смена\s+пицца|трактиръ\s+колесо|шашлыч|пицц|ресторан|кафе|кофейн|пивн|паб|бистро|столов|закусоч|буфет|хинкал|донер|кебаб|бургер/i;
const GENERIC_BUILDING = /^(дом жилой|жилой дом|здание|особняк|флигель|амбар|сарай|баня|склад|магазин|службы?|ограждение|ворота|забор|контора)$/i;

export function auditReleaseHardening(entities: HardenedEntity[], options: { addressBuildingConflicts?: number; geocodeAuditFailures?: number; unassignedSubjectRegions?: number; subjectRegionConflicts?: number; disposition?: DispositionReport } = {}): HardeningReport {
  const registryMuseumWithoutPhoto = entities.filter((e) => e.category === "museum" && !e.photo && e.sourceRecordIds.some((id) => /^(mkrf|egrkn):/.test(id))).length;
  const standaloneWikivoyageNature = entities.filter((e) => e.category === "nature" && e.sourceRecordIds.length === 1 && e.sourceRecordIds[0].startsWith("wikivoyage:")).length;
  const foodServiceListings = entities.filter((e) => e.sourceRecordIds.some((id) => id.startsWith("wikivoyage:")) && FOOD_SERVICE.test(e.name)).length;
  const junkNames = entities.filter((e) => !/[а-яёa-z]/i.test(e.name) || e.name.trim().length < 2).length;
  const nearDuplicatePairs = findSpecificNearDuplicates(entities);
  const specificNearDuplicates = nearDuplicatePairs.length;
  const addressBuildingConflicts = options.addressBuildingConflicts ?? 0;
  const geocodeAuditFailures = options.geocodeAuditFailures ?? 0;
  const unassignedSubjectRegions = options.unassignedSubjectRegions ?? 0;
  const subjectRegionConflicts = options.subjectRegionConflicts ?? 0;

  // Disposition-based checks.
  const disp = options.disposition;
  const egrknInDisposition = new Set(disp?.entries.map((e) => e.sourceRecordId) ?? []);
  // Any EGRKN normalized record that is NOT in the disposition ledger is missing.
  const missingDisposition = entities.filter((e) =>
    e.sourceRecordIds.some((id) => id.startsWith("egrkn:")) &&
    !e.sourceRecordIds.some((id) => egrknInDisposition.has(id))
  ).length;
  const leakedQuarantineGeometry = disp?.blockingCount ?? 0;
  // P0.4: museum name mismatch — «музей» in name but categorized as sights/religion/nature
  const museumCategoryMismatch = entities.filter((e) =>
    /музей/i.test(e.name) && !/heritage|monument/.test(e.category) && e.category !== "museum"
  ).length;

  const counts = { registryMuseumWithoutPhoto, standaloneWikivoyageNature, foodServiceListings, junkNames, specificNearDuplicates, addressBuildingConflicts, geocodeAuditFailures, unassignedSubjectRegions, subjectRegionConflicts, missingDisposition, leakedQuarantineGeometry, museumCategoryMismatch };
  // When disposition exists with zero leaked geometry, address conflicts are
  // properly quarantined and documented — they do not block release.
  const dispositionCoversAll = !!(disp && disp.blockingCount === 0);
  const blockingFailures = Object.entries(counts).filter(([name, count]) => {
    if (count === 0) return false;
    // When every EGRKN record has a proper disposition and no geometry leak,
    // quarantined address conflicts are documented and safe to skip.
    if (name === "addressBuildingConflicts" && dispositionCoversAll) return false;
    // Documented geography exclusions are written to excluded.ndjson and
    // geography-conflicts.ndjson — they are informational, not blockers.
    if (name === "unassignedSubjectRegions" || name === "subjectRegionConflicts") return false;
    return true;
  }).map(([name, count]) => `${name}: ${count}`);
  return { ruleVersion: "quality-hardening-v2", counts, blockingFailures, nearDuplicatePairs };
}

function findSpecificNearDuplicates(entities: HardenedEntity[]): Array<[string, string]> {
  const grid = new Map<string, Array<{ entity: HardenedEntity; point: [number, number]; name: string }>>();
  for (const entity of entities) {
    if (GENERIC_BUILDING.test(normalize(entity.name))) continue;
    const point = centroid(entity.geometry);
    const key = `${Math.round(point[0] * 2_000)}:${Math.round(point[1] * 2_000)}`;
    grid.set(key, [...(grid.get(key) ?? []), { entity, point, name: normalize(entity.name) }]);
  }
  const pairs: Array<[string, string]> = [];
  for (const [key, cell] of grid) {
    const [x, y] = key.split(":").map(Number);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      for (const a of cell) for (const b of grid.get(`${x + dx}:${y + dy}`) ?? []) {
        if (a.entity.id >= b.entity.id || a.entity.category !== b.entity.category || a.name !== b.name || !a.name) continue;
        // Registry-only clusters commonly represent separate components sharing a
        // complex centroid. Only an unresolved OSM representation is a blocking
        // product duplicate; registry-only clusters remain explainable evidence.
        if (!a.entity.sourceRecordIds.some((id) => id.startsWith("osm:")) && !b.entity.sourceRecordIds.some((id) => id.startsWith("osm:"))) continue;
        if (meters(a.point, b.point) <= 30) pairs.push([a.entity.id, b.entity.id]);
      }
    }
  }
  return pairs;
}

function normalize(value: string): string { return value.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/gi, " ").replace(/\s+/g, " ").trim(); }
function centroid(g: SourceRecord["geometry"]): [number, number] {
  if (!g) return [0, 0];
  if (g.type === "Point") return [Number(g.coordinates[0]), Number(g.coordinates[1])];
  let x = 0, y = 0, count = 0;
  const walk = (value: unknown): void => { if (Array.isArray(value) && typeof value[0] === "number") { x += value[0]; y += value[1]; count += 1; } else if (Array.isArray(value)) value.forEach(walk); };
  walk(g.coordinates);
  return count ? [x / count, y / count] : [0, 0];
}
function meters(a: [number, number], b: [number, number]): number {
  const r = 6_371_000, lat1 = a[1] * Math.PI / 180, lat2 = b[1] * Math.PI / 180;
  const dLat = (b[1] - a[1]) * Math.PI / 180, dLon = (b[0] - a[0]) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
