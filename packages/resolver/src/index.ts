import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EntityRelation, SourceRecord, SourceRecordSchema, safeContainedPath } from "@poi-toolkit/core";
import { curatedIdentityCandidates } from "./curated-identities.js";

export const RESOLVER_RULE_VERSION = "evidence-first-v1";
export type Decision = "accepted" | "pending" | "rejected";
export type FeatureVector = {
  geometrySafe: boolean; distanceMeters: number | null; nameSimilarity: number; addressSimilarity: number;
  typeCompatibility: number; adminContext: number; repeatedCentroid: boolean; relativeAddress: boolean;
  compoundAddress: boolean; competingCandidateCount: number; scoreMargin: number | null;
};
export type CandidateDossier = {
  id: string; sourceRecordIds: [string, string]; relation: EntityRelation["relation"]; decision: Decision;
  rule: { id: string; version: string }; featureVector: FeatureVector; score: number | null;
  reasons: string[]; autoLinkClass: "explicit-identifier" | "high-confidence-fuzzy" | "fuzzy-pending" | "unsafe-geometry" | "curated-identity" | "rejected";
};
export type ResolveResult = { candidates: CandidateDossier[]; relations: EntityRelation[]; unresolved: Array<{ sourceRecordId: string; reasons: string[] }>; quality: Record<string, unknown> };

/** Resolves normalized records using deterministic pair ordering; fuzzy evidence is deliberately never auto-accepted. */
export async function resolveRun(runDir: string): Promise<ResolveResult> {
  const child = (...parts: string[]) => safeContainedPath(runDir, ...parts);
  const records = await readRecords(await child("normalized", "source-records.ndjson"));
  const result = resolveRecords(records);
  await writeImmutable(await child("resolution", "candidates.ndjson"), result.candidates);
  await writeImmutable(await child("resolution", "relations.ndjson"), result.relations);
  await writeImmutable(await child("resolution", "unresolved.ndjson"), result.unresolved);
  await writeImmutable(await child("reports", "resolution-quality.json"), result.quality, true);
  return result;
}

export function resolveRecords(input: SourceRecord[]): ResolveResult {
  const records = [...input].sort((a, b) => a.id.localeCompare(b.id));
  const candidates: CandidateDossier[] = [];
  const seen = new Set<string>();
  const add = (dossier: CandidateDossier) => { if (!seen.has(dossier.id)) { seen.add(dossier.id); candidates.push(dossier); } };
  const bySource = (source: SourceRecord["source"]) => records.filter((record) => record.source === source);
  const osm = bySource("osm"), wikidata = bySource("wikidata"), egrkn = bySource("egrkn"), wikivoyage = bySource("wikivoyage"), mkrf = bySource("mkrf");
  // Curated repairs are narrowly scoped to independently corroborated upstream
  // coordinate errors. They run before heuristic matching and retain their own
  // explicit audit rule instead of weakening any global proximity threshold.
  for (const dossier of curatedIdentityCandidates(records)) add(dossier);
  // Generic labels never establish identity from name and proximity alone.
  const GENERIC_BLOCK = /^(дом|здание|особняк|памятник|музей|церковь|храм|часовня|сквер|парк|пруд|колодец|родник|мост|ворота|ограждение|забор|контора|амбар|сарай|баня|склад)$/i;

  // Identifier policies are independent of fuzzy geometry/name evidence.
  // P0.3: validate even exact-ID links — wrong ref:knid or heritage:ref
  // must not bypass address/type/distance sanity checks.
  // When one record lacks geometry, accept (geometry comes from the other side).
  // Reject only when BOTH have geometry AND distance > 2km.
  for (const item of osm) for (const wd of wikidata) if (wikidataIds(item).has(wd.sourceId)) {
    const d = safeDistance(item, wd);
    if (d === false || d <= 2000) add(exact(item, wd, "osm-wikidata-tag"));
    else add(rejectedExact(item, wd, "osm-wikidata-tag", `distance ${Math.round(d)}m exceeds 2km sanity gate`));
  }
  for (const item of egrkn) for (const osmItem of osm) if (egrknRefs(osmItem).has(item.sourceId)) {
    const d = safeDistance(item, osmItem);
    const conflict = houseNumberConflict(item, osmItem);
    if (conflict) add(rejectedExact(item, osmItem, "egrkn-osm-ref", "house number conflict"));
    else if (d === false || d <= 2000) add(exact(item, osmItem, "egrkn-osm-ref"));
    else add(rejectedExact(item, osmItem, "egrkn-osm-ref", `distance ${Math.round(d)}m exceeds 2km sanity gate`));
  }
  for (const item of wikivoyage) for (const wd of wikidata) if (wikivoyageIds(item).has(wd.sourceId)) {
    const d = safeDistance(item, wd);
    if (d === false || d <= 2000) add(exact(item, wd, "wikivoyage-wikidata-wdid"));
    else add(rejectedExact(item, wd, "wikivoyage-wikidata-wdid", `distance ${Math.round(d)}m exceeds 2km sanity gate`));
  }

  // Osmium represents every closed OSM way twice in GeoJSON: a raw way `w<ID>`
  // and its derived polygon `a<2×ID>`. They are one source object, even for
  // generic labels such as «Церковь» or «Пруд»; link by this stable identity
  // before any name/proximity heuristic.
  // Linked areas are removed from `osm` for downstream rules (Wikivoyage
  // proximity, OSM self-dedup, MKRF proximity) so the synthetic duplicate
  // does not introduce a false ambiguity guard.
  const osmBySourceId = new Map(osm.map((item) => [item.sourceId, item]));
  const linkedAreaIds = new Set<string>();
  for (const area of osm) {
    const areaId = area.sourceId.match(/^a(\d+)$/)?.[1];
    if (!areaId) continue;
    const numeric = Number(areaId);
    const way = Number.isSafeInteger(numeric) && numeric % 2 === 0 ? osmBySourceId.get(`w${numeric / 2}`) : undefined;
    if (way) { add(osmAreaWayLink(area, way)); linkedAreaIds.add(area.id); }
  }
  const effectiveOsm = linkedAreaIds.size ? osm.filter((item) => !linkedAreaIds.has(item.id)) : osm;

  // OSM self-dedup: the same real-world object is often mapped as both a node and a
  // way (or way + relation). Merge same-name, same-type OSM features within 30 m so
  // the release does not publish the same church/museum twice.
  // P0.3: block generic names (Памятник, Дом, Здание) from auto-merging —
  // they need address or building containment, not just name+distance.
  const osmByName = new Map<string, SourceRecord[]>();
  for (const item of effectiveOsm) { const key = normalizeName(item.name); if (key && !GENERIC_BLOCK.test(key)) osmByName.set(key, [...(osmByName.get(key) ?? []), item]); }
  for (const group of osmByName.values()) {
    for (let i = 0; i < group.length; i += 1) for (let j = i + 1; j < group.length; j += 1) {
      const a = group[i], b = group[j];
      const pa = pointOf(a), pb = pointOf(b);
      if (!pa || !pb) continue;
      const d = distance(pa, pb);
      if (d <= 30) add(osmSelfLink(a, b, d));
    }
  }

  // A Wikivoyage listing can describe an OSM venue without a Wikidata ID.
  // Auto-link only a distinctive identity name at ≤30 m with mutual-nearest
  // evidence and a 10 m margin; descriptive prefixes ("арт-пространство")
  // do not create a second product POI.
  // Runs AFTER OSM area↔way identity and OSM self-dedup so closed-way
  // objects (w<ID> + a<2×ID>) are already merged and the proximity loop
  // sees one OSM entry, not two near-identical representations.
  for (const listing of wikivoyage) {
    const listingPoint = pointOf(listing);
    const identity = venueIdentityName(listing.name);
    if (!listingPoint || !identity || GENERIC_BLOCK.test(identity)) continue;
    const nearby = effectiveOsm
      .filter((item) => venueIdentityName(item.name) === identity && pointOf(item))
      .map((item) => ({ item, d: distance(listingPoint, pointOf(item)!) }))
      .filter((candidate) => candidate.d <= 30)
      .sort((a, b) => a.d - b.d || a.item.id.localeCompare(b.item.id));
    const best = nearby[0];
    if (!best || (nearby[1] && nearby[1].d - best.d < 10)) continue;
    const competingListings = wikivoyage
      .filter((item) => item.id !== listing.id && venueIdentityName(item.name) === identity && pointOf(item))
      .map((item) => distance(pointOf(best.item)!, pointOf(item)!))
      .filter((d) => d <= 30)
      .sort((a, b) => a - b);
    if (competingListings.length && competingListings[0] <= best.d + 10) continue;
    add(wikivoyageOsmVenueLink(listing, best.item, best.d));
  }

  // MKRF↔OSM museum proximity: the same museum often has a generic OSM name («Краеведческий
  // музей») and a different official MKRF name («Слободской музейно-выставочный центр»). Link
  // two museum records within 60 m — both must be museums (tag/registry) to avoid matching a
  // museum to a nearby church or shop. Keeps the OSM anchor identity, enriches from MKRF.
  // P0.3: require mutual-nearest — MKRF must be closest OSM museum AND vice versa.
  // Also require margin ≥10m to avoid ambiguous campus matches.
  const mkrfMuseums = mkrf.filter((m) => pointOf(m));
  const osmMuseums = effectiveOsm.filter((o) => pointOf(o) && /музе|museum/.test(`${o.name ?? ""} ${JSON.stringify(o.fields.tags ?? {})}`.toLowerCase()));
  for (const m of mkrfMuseums) {
    const mp = pointOf(m)!;
    const sorted = osmMuseums.map((o) => ({ osm: o, d: distance(mp, pointOf(o)!) })).filter((x) => x.d <= 60).sort((a, b) => a.d - b.d);
    if (!sorted.length) continue;
    const best = sorted[0];
    const margin = sorted.length > 1 ? sorted[1].d - best.d : Infinity;
    if (margin < 10) continue; // ambiguous — two OSM museums at similar distance
    // Mutual nearest: check that this MKRF is also closest to that OSM
    const op = pointOf(best.osm)!;
    const reverseSorted = mkrfMuseums.map((mm) => ({ mkrf: mm, d: distance(op, pointOf(mm)!) })).filter((x) => x.d <= 60).sort((a, b) => a.d - b.d);
    if (reverseSorted[0]?.mkrf.id !== m.id) continue; // not mutual nearest
    add(mkrfOsmMuseumLink(m, best.osm, best.d));
  }

  const centroidCounts = new Map<string, number>();
  for (const item of egrkn) { const point = pointOf(item); if (point) centroidCounts.set(point.join(","), (centroidCounts.get(point.join(",")) ?? 0) + 1); }
  for (const egr of egrkn) {
    const drafts = effectiveOsm.filter((item) => blockPair(egr, item)).map((item) => fuzzyDraft(egr, item, centroidCounts));
    drafts.sort((a, b) => b.score - a.score || a.osm.id.localeCompare(b.osm.id));
    const best = drafts[0]?.score ?? null;
    // Candidate generation is a retrieval stage, not a Cartesian spatial join.
    // Preserve the full competing count but materialize only the strongest
    // dossiers so dense city centres remain reviewable.
    for (const [index, draft] of drafts.slice(0, 15).entries()) {
      const margin = best === null
        ? null
        : index === 0
          ? draft.score - (drafts[1]?.score ?? 0)
          : best - draft.score;
      add(fuzzy(egr, draft.osm, draft, drafts.length, margin));
    }
  }
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  const relations: EntityRelation[] = candidates.map((candidate) => ({
    fromCandidateId: candidate.sourceRecordIds[0], toCandidateId: candidate.sourceRecordIds[1], relation: candidate.relation,
    reason: `${candidate.rule.id}@${candidate.rule.version}: ${candidate.decision}`,
  }));
  const linked = new Map<string, CandidateDossier[]>();
  for (const candidate of candidates) for (const id of candidate.sourceRecordIds) linked.set(id, [...(linked.get(id) ?? []), candidate]);
  const unresolved = records.filter((record) => !(linked.get(record.id) ?? []).some((candidate) => candidate.decision === "accepted"))
    .map((record) => ({ sourceRecordId: record.id, reasons: unresolvedReasons(record, linked.get(record.id) ?? []) }));
  const byDecision = Object.fromEntries((["accepted", "pending", "rejected"] as Decision[]).map((decision) => [decision, candidates.filter((candidate) => candidate.decision === decision).length]));
  return { candidates, relations, unresolved, quality: { ruleVersion: RESOLVER_RULE_VERSION, candidateCount: candidates.length, decisions: byDecision, explicitIdentifierPolicies: ["OSM wikidata tag ↔ Wikidata QID", "OSM ref:knid/heritage:ref ↔ EGRKN registration number", "Wikivoyage wdid ↔ Wikidata QID"], autoAcceptance: "explicit identifiers only; fuzzy candidates await pilot calibration" } };
}

function exact(a: SourceRecord, b: SourceRecord, ruleId: string): CandidateDossier {
  return { id: pairId(a, b), sourceRecordIds: ordered(a, b), relation: "same", decision: "accepted", rule: { id: ruleId, version: RESOLVER_RULE_VERSION }, score: null,
    featureVector: { geometrySafe: true, distanceMeters: null, nameSimilarity: 0, addressSimilarity: 0, typeCompatibility: 0, adminContext: 0, repeatedCentroid: false, relativeAddress: false, compoundAddress: false, competingCandidateCount: 0, scoreMargin: null },
    reasons: ["explicit stable identifier agreement", "auto-accepted by identifier-only policy"], autoLinkClass: "explicit-identifier" };
}
/** P0.3: rejected exact-ID candidate — when address/distance/type validation fails. */
function rejectedExact(a: SourceRecord, b: SourceRecord, ruleId: string, reason: string): CandidateDossier {
  return { id: pairId(a, b), sourceRecordIds: ordered(a, b), relation: "different", decision: "rejected", rule: { id: ruleId, version: RESOLVER_RULE_VERSION }, score: null,
    featureVector: { geometrySafe: false, distanceMeters: null, nameSimilarity: 0, addressSimilarity: 0, typeCompatibility: 0, adminContext: 0, repeatedCentroid: false, relativeAddress: false, compoundAddress: false, competingCandidateCount: 0, scoreMargin: null },
    reasons: ["explicit identifier agreement but validation failed", reason], autoLinkClass: "rejected" };
}
/** P0.3: safe distance check — returns false if either record lacks geometry. */
function safeDistance(a: SourceRecord, b: SourceRecord): number | false { const pa = pointOf(a), pb = pointOf(b); if (!pa || !pb) return false; return distance(pa, pb); }
/** P0.3: house number conflict check — if both records have addr:housenumber, they must match. */
function houseNumberConflict(egrkn: SourceRecord, osm: SourceRecord): boolean {
  const egrknHouse = egrkn.address?.toLowerCase().match(/(?:^|[,\s])д(?:ом)?\.?\s*(\d+)/i)?.[1];
  const osmTags = osm.fields.tags as Record<string, string> | undefined;
  const osmHouse = osmTags?.["addr:housenumber"]?.toLowerCase();
  if (!egrknHouse || !osmHouse) return false; // can't conflict if either missing
  // Extract base number from OSM (strip corpus/letter suffixes)
  const osmBase = osmHouse.match(/^(\d+)/)?.[1];
  return egrknHouse !== osmBase;
}
function osmAreaWayLink(area: SourceRecord, way: SourceRecord): CandidateDossier {
  return { id: pairId(area, way), sourceRecordIds: ordered(area, way), relation: "same", decision: "accepted", rule: { id: "osm-area-way-identity", version: RESOLVER_RULE_VERSION }, score: null,
    featureVector: { geometrySafe: true, distanceMeters: 0, nameSimilarity: 1, addressSimilarity: 1, typeCompatibility: 1, adminContext: 0, repeatedCentroid: false, relativeAddress: false, compoundAddress: false, competingCandidateCount: 0, scoreMargin: null },
    reasons: ["Osmium area ID is the deterministic 2× representation of this closed OSM way", "auto-accepted"], autoLinkClass: "explicit-identifier" };
}
function osmSelfLink(a: SourceRecord, b: SourceRecord, d: number): CandidateDossier {
  return { id: pairId(a, b), sourceRecordIds: ordered(a, b), relation: "same", decision: "accepted", rule: { id: "osm-self-dedup", version: RESOLVER_RULE_VERSION }, score: null,
    featureVector: { geometrySafe: true, distanceMeters: round(d), nameSimilarity: 1, addressSimilarity: 0, typeCompatibility: 1, adminContext: 0, repeatedCentroid: false, relativeAddress: false, compoundAddress: false, competingCandidateCount: 0, scoreMargin: null },
    reasons: ["OSM self-dedup: same name and type within 30m (node/way/relation of one object; covers area↔way representation)", "auto-accepted"], autoLinkClass: "explicit-identifier" };
}
function wikivoyageOsmVenueLink(wikivoyage: SourceRecord, osm: SourceRecord, d: number): CandidateDossier {
  return { id: pairId(wikivoyage, osm), sourceRecordIds: ordered(wikivoyage, osm), relation: "same", decision: "accepted", rule: { id: "wikivoyage-osm-venue-name-proximity", version: RESOLVER_RULE_VERSION }, score: null,
    featureVector: { geometrySafe: true, distanceMeters: round(d), nameSimilarity: 1, addressSimilarity: 0, typeCompatibility: 1, adminContext: 0, repeatedCentroid: false, relativeAddress: false, compoundAddress: false, competingCandidateCount: 0, scoreMargin: null },
    reasons: ["Wikivoyage↔OSM: distinctive venue identity agrees after a descriptive-prefix normalisation", `mutual-nearest geometry within ${round(d)}m`, "auto-accepted"], autoLinkClass: "high-confidence-fuzzy" };
}
function mkrfOsmMuseumLink(mkrf: SourceRecord, osm: SourceRecord, d: number): CandidateDossier {
  return { id: pairId(mkrf, osm), sourceRecordIds: ordered(mkrf, osm), relation: "same", decision: "accepted", rule: { id: "mkrf-osm-museum-proximity", version: RESOLVER_RULE_VERSION }, score: null,
    featureVector: { geometrySafe: true, distanceMeters: round(d), nameSimilarity: 0, addressSimilarity: 0, typeCompatibility: 1, adminContext: 0, repeatedCentroid: false, relativeAddress: false, compoundAddress: false, competingCandidateCount: 0, scoreMargin: null },
    reasons: [`MKRF↔OSM museum proximity: both museums within ${round(d)}m (different names, same institution)`, "auto-accepted; OSM keeps identity/geometry, MKRF enriches"], autoLinkClass: "explicit-identifier" };
}
function normalizeName(name: string | null): string {
  return (name ?? "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/gi, " ").trim();
}
/** A narrow normalisation for venue labels, never used for generic POIs. */
function venueIdentityName(name: string | null): string {
  return normalizeName(name).replace(/^(?:арт пространство|творческое пространство|культурное пространство)\s+/, "").trim();
}
type Draft = { osm: SourceRecord; score: number; vector: Omit<FeatureVector, "competingCandidateCount" | "scoreMargin">; reasons: string[] };
function fuzzy(egr: SourceRecord, osm: SourceRecord, draft: Draft, competing: number, margin: number | null): CandidateDossier {
  const vector: FeatureVector = { ...draft.vector, competingCandidateCount: competing, scoreMargin: margin };
  const unsafe = !vector.geometrySafe || vector.repeatedCentroid || vector.relativeAddress;
  // Calibrated high-confidence fuzzy tier (pilot-calibrated): same name at the same spot
  // with matching type is accepted automatically. This safely enriches OSM anchors with
  // Wikidata descriptions/photos and EGRKN heritage without the legacy proximity false-match risk.
  const highConfidence = vector.geometrySafe
    && vector.distanceMeters !== null
    && vector.distanceMeters <= 30
    && vector.nameSimilarity >= 0.85
    && vector.typeCompatibility === 1
    && !vector.compoundAddress;
  const nearbyComplexPart = vector.compoundAddress
    && vector.distanceMeters !== null
    && (
      (vector.distanceMeters <= 100 && isHeritageFeature(osm))
      || (vector.distanceMeters <= 500 && vector.typeCompatibility === 1 && (vector.nameSimilarity >= 0.25 || vector.addressSimilarity >= 0.5))
    );
  const decision: Decision = unsafe || vector.typeCompatibility === 0
    ? "rejected"
    : highConfidence
      ? "accepted"
      : nearbyComplexPart
        ? "pending"
        : draft.score < 50
          ? "rejected"
          : "pending";
  const relation: EntityRelation["relation"] = highConfidence ? "same" : decision === "rejected" && vector.typeCompatibility === 0 ? "different" : vector.compoundAddress ? "contains" : "related";
  const autoLinkClass = highConfidence ? "high-confidence-fuzzy" : unsafe ? "unsafe-geometry" : decision === "pending" ? "fuzzy-pending" : "rejected";
  const reasons = [...draft.reasons, `competing candidates: ${competing}`, `score margin: ${margin === null ? "n/a" : margin.toFixed(2)}`];
  if (unsafe) reasons.push("unsafe/repeated/relative EGRKN geometry cannot be auto-accepted");
  else if (highConfidence) reasons.push("high-confidence fuzzy: name≥0.85, ≤30m, type match → auto-accepted");
  else if (decision === "pending") reasons.push("fuzzy evidence remains pending until pilot calibration");
  return { id: pairId(egr, osm), sourceRecordIds: ordered(egr, osm), relation, decision, rule: { id: "egrkn-osm-evidence", version: RESOLVER_RULE_VERSION }, featureVector: vector, score: round(draft.score), reasons, autoLinkClass };
}
function fuzzyDraft(egr: SourceRecord, osm: SourceRecord, counts: Map<string, number>): Draft {
  const ePoint = pointOf(egr), oPoint = pointOf(osm); const distanceMeters = ePoint && oPoint ? distance(ePoint, oPoint) : null;
  const addressClass = String(egr.fields.addressClassification ?? classifyAddress(egr.address));
  const repeatedCentroid = !!ePoint && (counts.get(ePoint.join(",")) ?? 0) > 1;
  const relativeAddress = addressClass === "relative", compoundAddress = addressClass === "compound" || String(egr.fields.nativeGeometryClassification) === "complex";
  const geometrySafe = distanceMeters !== null && !repeatedCentroid && !relativeAddress;
  const nameSimilarity = similarity(egr.name, osm.name), addressSimilarity = similarity(egr.address, osm.address);
  const typeCompatibility = compatible(egr, osm); const adminContext = adminMatch(egr, osm);
  const geoScore = distanceMeters === null ? 0 : Math.max(0, 1 - distanceMeters / 10_000);
  const score = nameSimilarity * 42 + addressSimilarity * 18 + typeCompatibility * 15 + adminContext * 10 + geoScore * 15 - (repeatedCentroid ? 25 : 0) - (relativeAddress ? 30 : 0) - (compoundAddress ? 8 : 0);
  const reasons = [`distance: ${distanceMeters === null ? "unavailable" : `${round(distanceMeters)}m`}`, `Russian name similarity: ${round(nameSimilarity)}`, `structured-address similarity: ${round(addressSimilarity)}`, `type compatibility: ${typeCompatibility}`, `admin context: ${adminContext}`];
  return { osm, score, vector: { geometrySafe, distanceMeters: distanceMeters === null ? null : round(distanceMeters), nameSimilarity: round(nameSimilarity), addressSimilarity: round(addressSimilarity), typeCompatibility, adminContext, repeatedCentroid, relativeAddress, compoundAddress }, reasons };
}
function blockPair(egr: SourceRecord, osm: SourceRecord): boolean {
  const a = pointOf(egr), b = pointOf(osm);
  // A deliberately conservative first-stage radius prevents dense-city candidate
  // explosions. Wider hypotheses belong to a separate geocoding/research stage.
  return Boolean(a && b && distance(a, b) <= 1_500);
}
function pointOf(record: SourceRecord): [number, number] | null { const g = record.geometry; if (!g) return null; if (g.type === "Point") return [Number(g.coordinates[0]), Number(g.coordinates[1])]; const positions = positionsOf(g as { coordinates?: unknown; geometries?: unknown[] }); if (!positions.length) return null; return [positions.reduce((n, p) => n + p[0], 0) / positions.length, positions.reduce((n, p) => n + p[1], 0) / positions.length]; }
function positionsOf(geometry: { coordinates?: unknown; geometries?: unknown[] }): [number, number][] { if (Array.isArray(geometry.coordinates)) { const out: [number, number][] = []; const walk = (v: unknown): void => { if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") out.push([v[0], v[1]]); else if (Array.isArray(v)) v.forEach(walk); }; walk(geometry.coordinates); return out; } return (geometry.geometries ?? []).flatMap((g) => positionsOf(g as { coordinates?: unknown; geometries?: unknown[] })); }
function distance(a: [number, number], b: [number, number]): number { const r = 6_371_000, dLat = radians(b[1] - a[1]), dLon = radians(b[0] - a[0]), x = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2; return 2 * r * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)); }
const radians = (value: number) => value * Math.PI / 180;
function normalize(value: string | null): string[] { return (value ?? "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/gi, " ").trim().split(/\s+/).filter((word) => word.length > 1 && !["улица", "ул", "город", "г", "дом", "д"].includes(word)); }
function similarity(a: string | null, b: string | null): number { const x = new Set(normalize(a)), y = new Set(normalize(b)); if (!x.size || !y.size) return 0; let common = 0; for (const token of x) if (y.has(token)) common += 1; return 2 * common / (x.size + y.size); }
function isHeritageFeature(record: SourceRecord): boolean {
  const tags = record.fields.tags;
  return Boolean(tags && typeof tags === "object" && !Array.isArray(tags) && typeof (tags as Record<string, unknown>).historic === "string");
}
function typeOf(record: SourceRecord): string | null { const value = [record.name, String(record.fields.objectType ?? ""), JSON.stringify(record.fields.tags ?? {})].join(" ").toLowerCase(); for (const [kind, words] of Object.entries({ museum: ["музе", "museum"], library: ["библиотек", "library"], orphanage: ["приют", "детск", "orphanage"], factory: ["завод", "фабрик", "factory"], tree: ["дерев", "tree"], religion: ["церков", "собор", "часовн", "храм", "мечет", "monastery", "монастыр", "church", "chapel", "place_of_worship", "колокольн"], monument: ["памятник", "монумент", "monument", "obelisk", "обелиск", "memorial", "мемориал"] })) if (words.some((word) => value.includes(word))) return kind; return null; }
function compatible(a: SourceRecord, b: SourceRecord): number { const x = typeOf(a), y = typeOf(b); return x && y ? (x === y ? 1 : 0) : 0.5; }
function adminMatch(a: SourceRecord, b: SourceRecord): number { const region = String(a.fields.region ?? ""); const tags = b.fields.tags; const text = tags && typeof tags === "object" ? JSON.stringify(tags) : ""; return region && text.toLowerCase().includes(region.toLowerCase()) ? 1 : 0; }
function classifyAddress(address: string | null): string { const value = (address ?? "").toLowerCase(); return /в районе|\d+\s*(км|километр)|севернее|южнее|западнее|восточнее/.test(value) ? "relative" : /территори|ансамбл|комплекс|усадьб|монастыр|кладбищ/.test(value) ? "compound" : "unknown"; }
function wikidataIds(record: SourceRecord): Set<string> { const tags = record.fields.tags; const value = tags && typeof tags === "object" && !Array.isArray(tags) ? (tags as Record<string, unknown>).wikidata : null; return new Set(typeof value === "string" ? value.match(/Q\d+/g) ?? [] : []); }
function egrknRefs(record: SourceRecord): Set<string> { const tags = record.fields.tags; const values = tags && typeof tags === "object" && !Array.isArray(tags) ? [(tags as Record<string, unknown>)["ref:knid"], (tags as Record<string, unknown>)["heritage:ref"]] : []; return new Set(values.filter((v): v is string => typeof v === "string").flatMap((v) => v.split(/[;,]/).map((x) => x.trim()))); }
function wikivoyageIds(record: SourceRecord): Set<string> { const value = record.fields.wdid; return new Set(typeof value === "string" ? value.match(/Q\d+/g) ?? [] : []); }
function ordered(a: SourceRecord, b: SourceRecord): [string, string] { return a.id < b.id ? [a.id, b.id] : [b.id, a.id]; }
function pairId(a: SourceRecord, b: SourceRecord): string { return ordered(a, b).join("~"); }
function unresolvedReasons(record: SourceRecord, dossiers: CandidateDossier[]): string[] { if (dossiers.some((d) => d.decision === "pending")) return ["fuzzy candidates pending pilot calibration"]; if (dossiers.some((d) => d.autoLinkClass === "unsafe-geometry")) return ["only unsafe/repeated/relative geometry candidates found"]; return ["no explicit identifier link"]; }
async function readRecords(file: string): Promise<SourceRecord[]> { const text = await readFile(file, "utf8"); return text.split(/\r?\n/).filter(Boolean).map((line) => SourceRecordSchema.parse(JSON.parse(line))); }
async function writeImmutable(file: string, value: unknown, pretty = false): Promise<void> { await mkdir(join(file, ".."), { recursive: true }); try { await stat(file); throw new Error(`immutable resolution artifact already exists: ${file}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } const content = Array.isArray(value) && !pretty ? value.map((row) => JSON.stringify(row)).join("\n") + (value.length ? "\n" : "") : JSON.stringify(value, null, 2) + "\n"; await writeFile(file, content, { flag: "wx" }); }
const round = (value: number) => Math.round(value * 1000) / 1000;
