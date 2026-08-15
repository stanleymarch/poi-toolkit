import { FacetClaim, MediaAsset, pointInAnyPolygon, SourceRecord } from "@poi-toolkit/core";
import type { AdminHierarchy } from "@poi-toolkit/core";
import { classifyFacets, detectNoise, NoiseDecision } from "@poi-toolkit/taxonomy";
import { extractMediaCandidates, MediaCandidate, resolveCommonsMetadata, toCommonsAsset, toEgrknAsset, toHttpAsset, toMkrfAsset } from "@poi-toolkit/media";

export const SYNTHESIS_RULE_VERSION = "synthesis-v1";

/**
 * Display repairs are deliberately keyed to the complete corroborated group,
 * not to a loose text pattern. They correct known upstream spelling/formatting
 * defects while keeping the source record that supplies the readable title.
 */
const CURATED_NAME_REPAIRS = [
  {
    sourceRecordIds: ["egrkn:431410176090006", "osm:a1285849270", "wikivoyage:Слободской:684961:21"],
    value: "Часовня-ротонда Иоанна Предтечи",
    sourceRecordId: "wikivoyage:Слободской:684961:21",
    reason: "curated Slobodskoy chapel repair: Wikivoyage corrects OSM's «Ионна» spelling and confirms the EGRKN rotunda title at the OSM geometry",
  },
  {
    sourceRecordIds: ["egrkn:431410176090006", "osm:a1285849270"],
    value: "Часовня-ротонда Иоанна Предтечи",
    sourceRecordId: "egrkn:431410176090006",
    reason: "curated Slobodskoy chapel repair: normalize the retained EGRKN title while using the OSM chapel geometry",
  },
] as const;

export type SelectedField<T> = { value: T; sourceRecordId: string; sourceField: string; license: string | null; attribution: string | null; rule: { id: string; version: string }; alternatives: Array<{ sourceRecordId: string; rejectionReason: string }> };

export type GeometryDecision = { geometry: SourceRecord["geometry"]; policy: "osm" | "verified-source" | "manual"; sourceRecordId: string; rule: string; safe: boolean; reason: string };

export type SynthesizedEntity = {
  sourceRecordIds: string[];
  hasOsmAnchor: boolean;
  identity: SelectedField<string>;
  geometry: GeometryDecision;
  name: SelectedField<string> | null;
  facets: FacetClaim[];
  noise: NoiseDecision;
  description: SelectedField<string> | null;
  photo: SelectedField<MediaAsset> | null;
  heritage: { value: boolean; significance: string | null; sourceRecordId: string | null };
  urls: Array<{ url: string; kind: string; sourceRecordId: string }>;
  standaloneEligible: boolean;
  adminHierarchy: AdminHierarchy | null;
};

export type Candidate = { sourceRecordIds: [string, string]; relation: string; decision: string };

export type SynthesisContext = {
  bbox?: [number, number, number, number];
  /** Map of "lon,lat" → count of EGRKN records sharing that centroid. */
  egrknCentroidCounts?: Map<string, number>;
  /** High-confidence geocoded geometry for EGRKN records without native coords.
   * addressCompatible=false means the geocoder dropped/changed house parts (e.g. литера)
   * and must never become a publishable point. */
  geocodedEvidence?: Map<string, { geometry: { type: "Point"; coordinates: [number, number] }; confidence: string; addressCompatible?: boolean; conflictReason?: string | null }>;
  /** Neighbor-region polygons: a point inside any of these is outside the territory (Kirov = bbox − neighbors). */
  exclusionPolygons?: { coordinates: number[][][][] }[];
  commonsResolver?: (fileNames: string[]) => Promise<(import("@poi-toolkit/media").CommonsMetadata | null)[]>;
};

/** Build entity groups from records joined by accepted `same`-relation candidates (union-find). */
export function buildEntityGroups(records: SourceRecord[], candidates: Candidate[]): SourceRecord[][] {
  const parent = new Map(records.map((r) => [r.id, r.id]));
  const find = (id: string): string => { const p = parent.get(id) ?? id; if (p === id) return id; const root = find(p); parent.set(id, root); return root; };
  const unite = (a: string, b: string) => { const x = find(a), y = find(b); if (x !== y) parent.set(y, x); };
  for (const c of candidates) if (c.decision === "accepted" && c.relation === "same" && c.sourceRecordIds.length === 2) unite(c.sourceRecordIds[0], c.sourceRecordIds[1]);
  const groups = new Map<string, SourceRecord[]>();
  for (const r of records) { const key = find(r.id); groups.set(key, [...(groups.get(key) ?? []), r]); }
  return [...groups.values()];
}

/** Synthesize one entity from a group of accepted records. Deterministic, order-independent. */
export function synthesizeEntity(group: SourceRecord[], context: SynthesisContext = {}): SynthesizedEntity | null {
  const byId = new Map(group.map((r) => [r.id, r]));
  const osm = group.filter((r) => r.source === "osm").sort((a, b) => a.id.localeCompare(b.id));
  const hasOsmAnchor = osm.length > 0;

  // Identity: OSM anchor preferred, else the lowest-id trusted record.
  const anchor = osm[0] ?? [...group].sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!anchor) return null;
  const identity: SelectedField<string> = { value: anchor.id, sourceRecordId: anchor.id, sourceField: "id", license: anchor.license, attribution: null, rule: { id: "identity", version: SYNTHESIS_RULE_VERSION }, alternatives: [] };

  // Geometry gate.
  const geometry = decideGeometry(group, hasOsmAnchor, context);

  // Name: OSM display name, then MKRF, then Wikivoyage, then Wikidata, then EGRKN.
  const name = selectName(group);

  // Facets + noise (aggregated across all records, deterministic).
  const facets = group.flatMap(classifyFacets);
  const noise = group.map(detectNoise).find((n) => n.noise) ?? { noise: false };

  // Description.
  const description = selectDescription(group, facets);

  // Photo: resolved from media candidates (Commons needs async resolver — handled at run level).
  // Here we stash candidates; resolution happens in synthesizeEntities.
  const photo = null; // populated by synthesizeEntities after Commons resolution.

  // Heritage.
  const heritage = selectHeritage(group);

  // URLs.
  const urls = selectUrls(group);

  // Standalone eligibility: non-OSM group may publish only if geometry is safe AND named AND not noise.
  const standaloneEligible = !hasOsmAnchor && geometry.safe && Boolean(name) && !noise.noise && !group.every((r) => r.source === "egrkn" && !geometry.safe);

  return { sourceRecordIds: group.map((r) => r.id).sort(), hasOsmAnchor, identity, geometry, name, facets, noise, description, photo, heritage, urls, standaloneEligible, adminHierarchy: null };
}

function decideGeometry(group: SourceRecord[], hasOsmAnchor: boolean, context: SynthesisContext): GeometryDecision {
  const osm = group.find((r) => r.source === "osm" && validGeometry(r.geometry));
  if (osm?.geometry) return { geometry: osm.geometry, policy: "osm", sourceRecordId: osm.id, rule: "osm-native", safe: true, reason: "OSM native geometry" };

  // Trusted standalone geometry (MKRF / EGRKN object-level / Wikidata object-level).
  for (const r of group.sort((a, b) => sourceTrust(b) - sourceTrust(a))) {
    if (!r.geometry || r.source === "osm") continue;
    const safe = geometrySafe(r, context);
    if (safe.ok) return { geometry: r.geometry, policy: "verified-source", sourceRecordId: r.id, rule: `${r.source}-verified-source`, safe: true, reason: safe.reason };
  }
  // High-confidence (house-level) geocode as a last-resort for EGRKN standalone.
  if (context.geocodedEvidence) {
    for (const r of group.sort((a, b) => sourceTrust(b) - sourceTrust(a))) {
      if (r.source !== "egrkn") continue;
      const geo = context.geocodedEvidence.get(r.id);
      if (geo?.addressCompatible !== true) continue;
      if (geo.confidence === "high") return { geometry: geo.geometry, policy: "verified-source", sourceRecordId: r.id, rule: "egrkn-geocoded-house-level", safe: true, reason: "Yandex house-level geocode" };
    }
  }
  return { geometry: null, policy: "osm", sourceRecordId: group[0]?.id ?? "", rule: "no-safe-geometry", safe: false, reason: "no eligible source-native geometry" };
}

function geometrySafe(r: SourceRecord, context: SynthesisContext): { ok: boolean; reason: string } {
  const g = r.geometry;
  if (!g) return { ok: false, reason: "missing geometry" };
  const point = centroidOf(g);
  if (!point) return { ok: false, reason: "no coordinates" };
  const [lon, lat] = point;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { ok: false, reason: "non-finite coordinates" };
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return { ok: false, reason: "coordinate out of range" };
  if (lon === 0 && lat === 0) return { ok: false, reason: "null island" };
  if (context.exclusionPolygons && pointInAnyPolygon(lon, lat, context.exclusionPolygons)) return { ok: false, reason: "inside neighbor region (outside territory)" };
  if (context.bbox) { const [w, s, e, n] = context.bbox; if (lon < w || lon > e || lat < s || lat > n) return { ok: false, reason: "outside territory bbox" }; }
  if (r.source === "egrkn") {
    const counts = context.egrknCentroidCounts;
    if (counts && g.type === "Point") { const c = counts.get(`${point[0]},${point[1]}`) ?? 0; if (c > 1) return { ok: false, reason: "repeated egrkn centroid" }; }
    const addr = String(r.fields.addressClassification ?? "");
    const geomClass = String(r.fields.nativeGeometryClassification ?? "");
    if (addr === "relative") return { ok: false, reason: "relative egrkn address" };
    if (geomClass === "complex" || geomClass === "unknown") return { ok: false, reason: `${geomClass} egrkn geometry class` };
  }
  return { ok: true, reason: `${r.source} object-level native geometry` };
}

function centroidOf(g: NonNullable<SourceRecord["geometry"]>): [number, number] | null {
  if (g.type === "Point") return [Number(g.coordinates[0]), Number(g.coordinates[1])];
  const positions = positionsOf(g);
  if (!positions.length) return null;
  return [positions.reduce((n, p) => n + p[0], 0) / positions.length, positions.reduce((n, p) => n + p[1], 0) / positions.length];
}
function positionsOf(geometry: { coordinates?: unknown; geometries?: unknown[] }): [number, number][] {
  if (Array.isArray(geometry.coordinates)) { const out: [number, number][] = []; const walk = (v: unknown): void => { if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") out.push([v[0], v[1]]); else if (Array.isArray(v)) v.forEach(walk); }; walk(geometry.coordinates); return out; }
  return (geometry.geometries ?? []).flatMap((g) => positionsOf(g as { coordinates?: unknown; geometries?: unknown[] }));
}

function validGeometry(g: SourceRecord["geometry"]): boolean { return Boolean(g && centroidOf(g)); }

function sourceTrust(r: SourceRecord): number { return { mkrf: 5, wikivoyage: 4, wikidata: 3, egrkn: 2, osm: 1 }[r.source] ?? 0; }

function selectName(group: SourceRecord[]): SelectedField<string> | null {
  const ids = new Set(group.map((record) => record.id));
  const repair = CURATED_NAME_REPAIRS.find((entry) => entry.sourceRecordIds.every((id) => ids.has(id)));
  if (repair) {
    const source = group.find((record) => record.id === repair.sourceRecordId)!;
    return {
      value: repair.value,
      sourceRecordId: source.id,
      sourceField: "curated-canonical-name",
      license: source.license,
      attribution: null,
      rule: { id: "name-curated-source-repair", version: SYNTHESIS_RULE_VERSION },
      alternatives: group.filter((record) => record.id !== source.id && record.name?.trim()).map((record) => ({ sourceRecordId: record.id, rejectionReason: repair.reason })),
    };
  }
  const ranked = group.filter((r) => r.name?.trim()).sort((a, b) => sourceTrust(b) - sourceTrust(a) || a.id.localeCompare(b.id));
  // OSM name is preferred over higher "trust" sources because it is the display identity.
  const osm = ranked.find((r) => r.source === "osm") ?? ranked[0];
  if (!osm?.name) return null;
  return { value: osm.name, sourceRecordId: osm.id, sourceField: "name", license: osm.license, attribution: null, rule: { id: "name-osm-preferred", version: SYNTHESIS_RULE_VERSION }, alternatives: [] };
}

type DescCandidate = { sourceRecordId: string; text: string; source: string; license: string | null; score: number };

function selectDescription(group: SourceRecord[], facets: FacetClaim[]): SelectedField<string> | null {
  const primaryPath = facets.sort((a, b) => b.confidence - a.confidence)[0]?.path ?? "";
  const candidates: DescCandidate[] = [];
  for (const r of group) {
    const text = descriptionText(r);
    if (!text) continue;
    const isRussian = /[а-яё]/i.test(text);
    const isAscii = !isRussian && /^[\x00-\x7F\s.,;:()-]+$/.test(text);
    let score = 0;
    if (r.source === "mkrf") score += 50;
    if (r.source === "wikivoyage") score += 45;
    if (r.source === "osm") score += 30;
    if (r.source === "egrkn") score += 35;
    if (r.source === "wikidata") score += 20;
    if (isRussian) score += 30;
    if (isAscii) score -= 40; // generic English Wikidata templates
    if (text.length > 60) score += 10;
    if (text.length > 200) score += 5;
    // Type-incompatibility guard: description mentions a different object type.
    if (typeMismatch(primaryPath, text)) score -= 60;
    candidates.push({ sourceRecordId: r.id, text, source: r.source, license: r.license, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 0) return null;
  return { value: best.text, sourceRecordId: best.sourceRecordId, sourceField: "description", license: best.license, attribution: null, rule: { id: "description-ranking", version: SYNTHESIS_RULE_VERSION }, alternatives: candidates.slice(1).map((c) => ({ sourceRecordId: c.sourceRecordId, rejectionReason: `lower score ${c.score}` })) };
}

function descriptionText(r: SourceRecord): string | null {
  if (r.source === "osm") { const tags = (r.fields.tags ?? {}) as Record<string, string>; return String(tags.description ?? tags["description:ru"] ?? "").trim() || null; }
  if (r.source === "wikidata") return String(r.fields.itemDescription ?? "").trim() || null;
  if (r.source === "wikivoyage") return String(r.fields.description ?? "").trim() || null;
  if (r.source === "mkrf") return String(r.fields.description ?? "").trim() || null;
  if (r.source === "egrkn") return null; // EGRKN has no structured description field
  return null;
}

function typeMismatch(primaryPath: string, text: string): boolean {
  const t = text.toLowerCase();
  if (primaryPath.startsWith("culture.museum") && /\b(river|озеро|впадает|приток)\b/i.test(t)) return true;
  if (primaryPath.startsWith("nature.water.river") && /\b(музей|museum|церковь)\b/i.test(t)) return true;
  return false;
}

function selectHeritage(group: SourceRecord[]): SynthesizedEntity["heritage"] {
  const egrkn = group.find((r) => r.source === "egrkn");
  if (egrkn) return { value: true, significance: significanceOf(egrkn), sourceRecordId: egrkn.id };
  const wd = group.find((r) => r.source === "wikidata" && r.fields.heritage);
  if (wd) return { value: true, significance: null, sourceRecordId: wd.id };
  return { value: false, significance: null, sourceRecordId: null };
}

function significanceOf(record: SourceRecord): string | null {
  const type = String(record.fields.categoryType ?? "").toLowerCase();
  if (type.includes("федераль")) return "federal";
  if (type.includes("региональ")) return "regional";
  if (type.includes("местн") || type.includes("выявлен")) return "local";
  return null;
}

function selectUrls(group: SourceRecord[]): SynthesizedEntity["urls"] {
  const urls: SynthesizedEntity["urls"] = [];
  for (const r of group) {
    if (r.source === "egrkn" && r.fields.egrknUrl) urls.push({ url: String(r.fields.egrknUrl), kind: "egrkn", sourceRecordId: r.id });
    if (r.source === "wikidata" && r.fields.article) urls.push({ url: String(r.fields.article), kind: "wikipedia", sourceRecordId: r.id });
    if (r.source === "wikidata" && r.fields.officialWebsite) urls.push({ url: String(r.fields.officialWebsite), kind: "official", sourceRecordId: r.id });
    if (r.source === "wikivoyage" && r.fields.pageUrl) urls.push({ url: String(r.fields.pageUrl), kind: "wikivoyage", sourceRecordId: r.id });
    if (r.source === "mkrf" && r.fields.website) urls.push({ url: String(r.fields.website), kind: "official", sourceRecordId: r.id });
  }
  return urls;
}

/** Resolve Commons media for a synthesized entity and attach the best publishable photo. */
export async function attachPhoto(entity: SynthesizedEntity, byId: Map<string, SourceRecord>, context: SynthesisContext): Promise<SynthesizedEntity> {
  const candidates = entity.sourceRecordIds.map((id) => byId.get(id)).filter((r): r is SourceRecord => Boolean(r)).flatMap(extractMediaCandidates);
  const commons = candidates.filter((c) => c.kind === "commons");
  const mkrf = candidates.filter((c) => c.kind === "mkrf");
  const egrkn = candidates.filter((c) => c.kind === "egrkn");
  const http = candidates.filter((c) => c.kind === "http");
  const resolvedAssets: Array<{ asset: import("@poi-toolkit/core").MediaAsset; candidate: MediaCandidate; rank: number }> = [];

  if (commons.length && context.commonsResolver) {
    const unique = [...new Set(commons.map((c) => c.value))];
    const metas = await context.commonsResolver(unique);
    const byFile = new Map(unique.map((name, i) => [name, metas[i]]));
    for (const c of commons) { const meta = byFile.get(c.value); if (meta) { const asset = toCommonsAsset(c, meta); if (asset) resolvedAssets.push({ asset, candidate: c, rank: 0 }); } }
  }
  for (const c of egrkn) resolvedAssets.push({ asset: toEgrknAsset(c), candidate: c, rank: 1 });
  for (const c of mkrf) resolvedAssets.push({ asset: toMkrfAsset(c), candidate: c, rank: 2 });
  for (const c of http) resolvedAssets.push({ asset: toHttpAsset(c), candidate: c, rank: 3 });

  // Rank: Commons (attributed) > EGRKN/MKRF (open-data images) > OSM external reference.
  resolvedAssets.sort((a, b) => a.rank - b.rank);
  const best = resolvedAssets[0]?.asset ?? null;
  entity.photo = best ? { value: best, sourceRecordId: best.sourceRecordId, sourceField: "image", license: best.license, attribution: best.attribution, rule: { id: "photo-ranking", version: SYNTHESIS_RULE_VERSION }, alternatives: [] } : null;
  return entity;
}

/** High-level: synthesize all entities, resolving Commons media in one batched call. */
export async function synthesizeEntities(records: SourceRecord[], candidates: Candidate[], context: SynthesisContext = {}): Promise<SynthesizedEntity[]> {
  const groups = buildEntityGroups(records, candidates);
  const byId = new Map(records.map((r) => [r.id, r]));
  const egrknCentroidCounts = context.egrknCentroidCounts ?? buildEgrknCentroidCounts(records);
  const ctx: SynthesisContext = { ...context, egrknCentroidCounts };

  // Pre-resolve all Commons file names in chunked batches (Commons API limits ~50 titles per request).
  const allCommons = [...new Set(groups.flatMap((group) => group.flatMap((r) => extractMediaCandidates(r).filter((c) => c.kind === "commons").map((c) => c.value))))];
  let commonsResolver = context.commonsResolver;
  if (commonsResolver === undefined && allCommons.length) {
    commonsResolver = async (names) => { const out: (import("@poi-toolkit/media").CommonsMetadata | null)[] = []; for (let i = 0; i < names.length; i += 50) { out.push(...await resolveCommonsMetadata(names.slice(i, i + 50), {})); } return out; };
  }
  const fullCtx: SynthesisContext = { ...ctx, commonsResolver };

  const entities: SynthesizedEntity[] = [];
  for (const group of groups) {
    const entity = synthesizeEntity(group, fullCtx);
    if (entity) { await attachPhoto(entity, byId, fullCtx); entities.push(entity); }
  }
  return entities;
}

export function buildEgrknCentroidCounts(records: SourceRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of records) { if (r.source !== "egrkn" || r.geometry?.type !== "Point") continue; const key = `${r.geometry.coordinates[0]},${r.geometry.coordinates[1]}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
  return counts;
}
