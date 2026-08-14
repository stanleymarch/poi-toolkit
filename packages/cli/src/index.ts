#!/usr/bin/env node
import { Command } from "commander";
import { createReadStream, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createRun, egrknRecord, loadTerritory, readManifest, writeManifest, type RunManifest } from "@poi-toolkit/core";
import { collectEgrkn, EGRKN_MANIFEST } from "@poi-toolkit/source-egrkn";
import { extractOsmGeoJsonSeq, extractOsmAddressGeoJsonSeq, parseOsmGeoJsonSeq, OSM_MANIFEST } from "@poi-toolkit/source-osm";
import { collectWikidata, WIKIDATA_MANIFEST } from "@poi-toolkit/source-wikidata";
import { collectWikivoyage, collectWikivoyageNature, WIKIVOYAGE_MANIFEST } from "@poi-toolkit/source-wikivoyage";
import { collectMkrf, MKRF_MANIFEST } from "@poi-toolkit/source-mkrf";
import { auditReleaseHardening, buildDispositionLedger, profileSource, qualityGate, scoreRelease } from "@poi-toolkit/quality";
import { normalizeRun } from "@poi-toolkit/normalize";
import { resolveRun } from "@poi-toolkit/resolver";
import { releaseRun, writeProductRelease, writeSqlExport } from "@poi-toolkit/exporters";
import { synthesizeEntities, buildEgrknCentroidCounts } from "@poi-toolkit/synthesis";
import { resolveCommonsMetadata } from "@poi-toolkit/media";
import { projectNearventure } from "@poi-toolkit/profiles-nearventure";
import { recoverReleaseExport } from "./recover.js";
import { requireWorkspaceIdentifier, safeWorkspaceChildPath, workspaceRunDirectory } from "./workspace.js";
import { attestLegacyRawRun, replayRawRun } from "./replay.js";
import { geocodeEgrknRecords, parseGeocoderProvider, GeocodeEvidence } from "@poi-toolkit/geocode";
import { assignSubjectBoundary, buildAddressIndex, matchAddress, serialiseAddressIndex, deserialiseAddressIndex, findContainedCandidates, findExactCrossSourceCandidates, resolveAdminHierarchy, type ContainmentCandidate, type SubjectBoundary } from "@poi-toolkit/geography";

const root = resolve(process.env.POI_TOOLKIT_ROOT ?? process.cwd());
type CollectOptions = {
  root?: string; apiKey?: string; collectEgrkn?: typeof collectEgrkn; extractOsmGeoJsonSeq?: typeof extractOsmGeoJsonSeq;
  collectWikidata?: typeof collectWikidata; collectWikivoyage?: typeof collectWikivoyage; collectMkrf?: typeof collectMkrf;
};
const missing = async (file: string) => { try { await stat(file); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; } };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

async function loadPfoSubjectBoundaries(): Promise<SubjectBoundary[]> {
  const data = JSON.parse(await readFile(join(root, "territories", "pfo-subjects.geojson"), "utf8")) as { features?: Array<{ id?: string; properties?: { region?: string }; geometry?: SubjectBoundary["geometry"] }> };
  const boundaries = (data.features ?? []).flatMap((feature) => feature.id && feature.properties?.region && feature.geometry && (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon")
    ? [{ id: String(feature.id), region: feature.properties.region, geometry: feature.geometry }]
    : []);
  if (boundaries.length !== 14 || new Set(boundaries.map((boundary) => boundary.region)).size !== 14) throw new Error("PFO subject boundary layer must contain exactly 14 canonical regions");
  return boundaries;
}

/** Each source is isolated: a later failure only changes run status, never removes a completed snapshot. */
export async function collect(territorySlug: string, runId?: string, options: CollectOptions = {}) {
  const collectionRoot = options.root ?? root;
  requireWorkspaceIdentifier("territory", territorySlug);
  const runIdValue = runId ?? randomUUID();
  requireWorkspaceIdentifier("run id", runIdValue);
  const territory = await loadTerritory(collectionRoot, territorySlug);
  const runDirPath = await workspaceRunDirectory(collectionRoot, territory.slug, runIdValue);
  let run: { dir: string; manifest: RunManifest };
  if (existsSync(runDirPath)) {
    const manifest = await readManifest(runDirPath);
    manifest.status = "running";
    manifest.finishedAt = null;
    run = { dir: runDirPath, manifest };
  } else {
    run = await createRun(collectionRoot, territory.slug, runIdValue);
  }
  const manifest = run.manifest;
  const childPath = (...parts: string[]) => safeWorkspaceChildPath(run.dir, ...parts);
  const collectJson = async (source: "egrkn" | "wikidata" | "wikivoyage", action: (onPage: (items: unknown[]) => Promise<void>) => Promise<{ records: unknown[] }>) => {
    const partial = await childPath("raw", `${source}.ndjson.partial`);
    const final = await childPath("raw", `${source}.ndjson`);
    if (!await missing(final)) {
      const lines = (await readFile(final, "utf8")).trim().split("\n").filter(Boolean).length;
      manifest.sources[source] = { status: "completed", records: lines, snapshot: `raw/${source}.ndjson`, error: null };
      return;
    }
    let received = 0;
    try {
      await writeFile(partial, "", { flag: "wx" });
      const result = await action(async (items) => { received += items.length; await appendFile(partial, items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : "")); });
      await rename(partial, final);
      manifest.sources[source] = { status: "completed", records: result.records.length, snapshot: `raw/${source}.ndjson`, error: null };
    } catch (error) {
      manifest.sources[source] = { status: "failed", records: received, snapshot: `raw/${source}.ndjson.partial`, error: errorText(error) };
    }
  };

  const apiKey = options.apiKey ?? process.env.MKRF_API_KEY;
  if (apiKey) await collectJson("egrkn", (onPage) => (options.collectEgrkn ?? collectEgrkn)({ apiKey, region: territory.egrkn.region, regions: territory.egrkn.regions, onPage }));
  else manifest.sources.egrkn = { status: "failed", records: 0, snapshot: null, error: "MKRF_API_KEY is not set" };

  const pbf = resolve(collectionRoot, territory.osm.pbf);
  try {
    const osmFile = await childPath("raw", "osm.geojsonseq");
    if (!await missing(osmFile)) { manifest.sources.osm = { status: "completed", records: 0, snapshot: "raw/osm.geojsonseq", error: null }; }
    else {
      if (!existsSync(pbf)) throw new Error(`PBF missing: ${pbf}`);
      await (options.extractOsmGeoJsonSeq ?? extractOsmGeoJsonSeq)({ pbf, output: osmFile, bbox: territory.osm.bbox });
      manifest.sources.osm = { status: "completed", records: 0, snapshot: "raw/osm.geojsonseq", error: null };
    }
  } catch (error) {
    manifest.sources.osm = { status: "failed", records: 0, snapshot: null, error: errorText(error) };
  }

  await collectJson("wikidata", (onPage) => (options.collectWikidata ?? collectWikidata)({ regions: territory.wikidata.regions, onPage }));
  await collectJson("wikivoyage", (onPage) => (options.collectWikivoyage ?? collectWikivoyage)({ pages: territory.wikivoyage.pages, onPage }));

  // Wikivoyage natural monuments (Природные памятники России/<регион>) — ООПТ with registry numbers.
  const naturePages = (territory as { wikivoyageNature?: { pages: string[] } }).wikivoyageNature?.pages ?? [];
  if (naturePages.length) {
    const natureFile = await childPath("raw", "wikivoyage-nature.ndjson");
    if (await missing(natureFile)) {
      try {
        const chunks: string[] = [];
        const result = await collectWikivoyageNature({ pages: naturePages, onPage: (records) => { chunks.push(records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "")); } });
        await writeFile(natureFile, chunks.join(""), { flag: "wx" });
        manifest.sources.wikivoyageNature = { status: "completed", records: result.records.length, snapshot: "raw/wikivoyage-nature.ndjson", error: null };
      } catch (error) { manifest.sources.wikivoyageNature = { status: "failed", records: 0, snapshot: null, error: errorText(error) }; }
    } else {
      const lines = (await readFile(natureFile, "utf8")).trim().split("\n").filter(Boolean).length;
      manifest.sources.wikivoyageNature = { status: "completed", records: lines, snapshot: "raw/wikivoyage-nature.ndjson", error: null };
    }
  }

  // MKRF museums: all-Russia fetch clipped to territory. Records are already-normalized SourceRecords.
  try {
    if (!apiKey) throw new Error("MKRF_API_KEY is not set");
    const mkrfFile = await childPath("raw", "mkrf.ndjson");
    if (!await missing(mkrfFile)) { const lines = (await readFile(mkrfFile, "utf8")).trim().split("\n").filter(Boolean).length; manifest.sources.mkrf = { status: "completed", records: lines, snapshot: "raw/mkrf.ndjson", error: null }; }
    else {
    let received = 0;
    const chunks: string[] = [];
    const result = await (options.collectMkrf ?? collectMkrf)({
      apiKey, clipBbox: territory.mkrf?.clipBbox, regionKeywords: territory.mkrf?.regionKeywords,
      onPage: (records: { length: number }) => { received += records.length; chunks.push((records as unknown[]).map((r: unknown) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "")); },
    });
    await writeFile(mkrfFile, chunks.join(""), { flag: "wx" });
    manifest.sources.mkrf = { status: "completed", records: result.records.length, snapshot: "raw/mkrf.ndjson", error: null };
    }
  } catch (error) {
    manifest.sources.mkrf = { status: "failed", records: 0, snapshot: null, error: errorText(error) };
  }
  try {
    const snapshots = await Promise.all(Object.entries(manifest.sources).filter(([, source]) => source.snapshot).map(async ([source, entry]) => ({
      source,
      path: entry.snapshot!,
      ...await hashFile(await childPath(...entry.snapshot!.split("/"))),
    })));
    const inputPbf = existsSync(pbf) ? { path: territory.osm.pbf, ...await hashFile(pbf) } : null;
    const collectionProvenance = await childPath("reports", "collection-provenance.json");
    await mkdir(await childPath("reports"), { recursive: true });
    await writeFile(collectionProvenance, JSON.stringify({
      schemaVersion: 1,
      territory,
      sourceManifests: [EGRKN_MANIFEST, OSM_MANIFEST, WIKIDATA_MANIFEST, WIKIVOYAGE_MANIFEST, MKRF_MANIFEST],
      inputPbf,
      snapshots,
    }, null, 2) + "\n", { flag: await missing(collectionProvenance) ? "wx" : "w" });
  } catch (error) {
    manifest.diagnostics.push(`collection provenance failed: ${errorText(error)}`);
  }
  manifest.status = Object.values(manifest.sources).every((source) => source.status === "completed") && !manifest.diagnostics.length ? "completed" : "failed";
  manifest.finishedAt = new Date().toISOString();
  await writeManifest(run.dir, manifest);
  return { run, manifest };
}

async function profile(territory: string, runId: string) {
  const dir = await workspaceRunDirectory(root, territory, runId); const manifest = await readManifest(dir);
  const file = await safeWorkspaceChildPath(dir, "raw", "egrkn.ndjson"); if (!existsSync(file)) throw new Error("EGRKN snapshot not found");
  const lines = (await readFile(file, "utf8")).trim().split("\n").filter(Boolean);
  const records = lines.map((line, index) => egrknRecord(JSON.parse(line), `raw/egrkn.ndjson#${index + 1}`));
  const result = profileSource("egrkn", records); const failures = qualityGate(result);
  const report = await safeWorkspaceChildPath(dir, "reports", "source-quality.json");
  await mkdir(await safeWorkspaceChildPath(dir, "reports"), { recursive: true }); await writeFile(report, JSON.stringify({ profiles: [result], failures }, null, 2) + "\n");
  console.log(JSON.stringify({ runId: manifest.runId, ...result, failures })); if (failures.length) process.exitCode = 2;
}
async function hashFile(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return { bytes: (await stat(file)).size, sha256: hash.digest("hex") };
}

const program = new Command().name("poi-toolkit").description("File-first POI collection toolkit");
program.command("collect").requiredOption("--territory <slug>").option("--run-id <id>").action(async ({ territory, runId }) => { const result = await collect(territory, runId); console.log(JSON.stringify({ runId: result.run.manifest.runId, directory: result.run.dir, status: result.manifest.status })); if (result.manifest.status === "failed") process.exitCode = 2; });
program.command("profile").requiredOption("--territory <slug>").requiredOption("--run-id <id>").action(({ territory, runId }) => profile(territory, runId));
program.command("normalize").requiredOption("--territory <slug>").requiredOption("--run-id <id>").action(async ({ territory, runId }) => {
  const runDir = await workspaceRunDirectory(root, territory, runId);
  await Promise.all(["raw", "normalized", "reports"].map((part) => safeWorkspaceChildPath(runDir, part)));
  const result = await normalizeRun(runDir);
  console.log(JSON.stringify({ runId, records: result.records.length, geometryEvidence: result.geometryEvidence.length, unresolvedGeometry: result.unresolvedGeometry.length }));
});
program.command("resolve").requiredOption("--territory <slug>").requiredOption("--run-id <id>").action(async ({ territory, runId }) => {
  const runDir = await workspaceRunDirectory(root, territory, runId);
  await Promise.all(["normalized", "resolution", "reports"].map((part) => safeWorkspaceChildPath(runDir, part)));
  const result = await resolveRun(runDir);
  console.log(JSON.stringify({ runId, candidates: result.candidates.length, decisions: result.quality.decisions }));
});
program.command("build-address-index").requiredOption("--territory <slug>").requiredOption("--run-id <id>").action(async ({ territory, runId }) => {
  const runDir = await workspaceRunDirectory(root, territory, runId);
  const terr = await loadTerritory(root, territory);
  const addrPath = await safeWorkspaceChildPath(runDir, "raw", "osm-addresses.geojsonseq");
  const indexPath = await safeWorkspaceChildPath(runDir, "geocoded", "osm-address-index.json");
  // Extract addressed buildings from PBF (separate from POI extraction)
  if (await missing(addrPath)) {
    await extractOsmAddressGeoJsonSeq({ pbf: join(root, terr.osm.pbf), output: addrPath, bbox: terr.osm.bbox });
  }
  // Parse and build compact index
  const snapshot = await readFile(addrPath, "utf8");
  const osmRecords = parseOsmGeoJsonSeq(snapshot, "raw/osm-addresses.geojsonseq");
  const index = buildAddressIndex(osmRecords);
  await mkdir(await safeWorkspaceChildPath(runDir, "geocoded"), { recursive: true });
  await writeFile(indexPath, serialiseAddressIndex(index));
  const buildingEntries = [...index.values()].flat().filter((e) => e.isBuilding).length;
  console.log(JSON.stringify({ runId, addressRecords: osmRecords.length, indexKeys: index.size, buildingEntries }));
});
program.command("geocode").requiredOption("--territory <slug>").requiredOption("--run-id <id>").option("--provider <provider>", "photon, nominatim or yandex", "photon").option("--fallback <provider>", "none, photon, nominatim or yandex", "none").option("--limit <count>", "maximum requests; defaults to unlimited local Photon/Nominatim or 1000 Yandex").action(async ({ territory, runId, provider: providerValue, fallback: fallbackValue, limit }) => {
  const runDir = await workspaceRunDirectory(root, territory, runId);
  const records = await readNdjsonFile(await safeWorkspaceChildPath(runDir, "normalized", "source-records.ndjson"));
  const provider = parseGeocoderProvider(providerValue);
  const fallback = fallbackValue === "none" ? "none" : parseGeocoderProvider(fallbackValue);
  const maxRequests = limit === undefined ? undefined : Number(limit);
  if (maxRequests !== undefined && (!Number.isInteger(maxRequests) || maxRequests < 1)) throw new Error("--limit must be a positive integer");
  const terr = await loadTerritory(root, territory);
  const bbox = terr.mkrf?.clipBbox ?? terr.osm.bbox;
  // Load OSM address index if available (built by build-address-index command)
  let osmAddressIndex: Map<string, Array<{ lon: number; lat: number; osmId: string; name: string | null; isBuilding: boolean; corpus: string | null; letter: string | null }>> | undefined;
  try {
    const indexPath = await safeWorkspaceChildPath(runDir, "geocoded", "osm-address-index.json");
    const indexJson = await readFile(indexPath, "utf8");
    osmAddressIndex = new Map(Object.entries(JSON.parse(indexJson)));
    console.error(`geocode: loaded OSM address index (${osmAddressIndex.size} keys)`);
  } catch { /* index not built — skip */ }
  const result = await geocodeEgrknRecords(records, {
    provider, fallback, limit: maxRequests, bbox,
    photonUrl: process.env.PHOTON_URL,
    nominatimUrl: process.env.NOMINATIM_URL,
    apiKey: process.env.GEOCODER_API_KEY,
    osmAddressIndex,
  });
  await mkdir(await safeWorkspaceChildPath(runDir, "geocoded"), { recursive: true });
  await writeFile(await safeWorkspaceChildPath(runDir, "geocoded", "geometry-evidence.ndjson"), result.evidence.map((e) => JSON.stringify(e)).join("\n") + (result.evidence.length ? "\n" : ""), { flag: "wx" });
  await writeFile(await safeWorkspaceChildPath(runDir, "geocoded", "geocode-audit.ndjson"), result.audit.map((e) => JSON.stringify(e)).join("\n") + (result.audit.length ? "\n" : ""), { flag: "wx" });
  console.log(JSON.stringify({ runId, provider, fallback, total: result.total, skipped: result.skipped, ineligible: result.ineligible, primaryCalls: result.primaryCalls, fallbackCalls: result.fallbackCalls, yandexBudgetSkipped: result.yandexBudgetSkipped, high: result.high, medium: result.medium, low: result.low, conflicted: result.conflicted, failed: result.failed }));
});
program.command("synthesize").requiredOption("--territory <slug>").requiredOption("--run-id <id>").action(async ({ territory, runId }) => {
  const runDir = await workspaceRunDirectory(root, territory, runId);
  const records = await readNdjsonFile(await safeWorkspaceChildPath(runDir, "normalized", "source-records.ndjson"));
  const candidates = await readNdjsonFile(await safeWorkspaceChildPath(runDir, "resolution", "candidates.ndjson"));
  const terr = await loadTerritory(root, territory);
  const entities = await synthesizeEntities(records, candidates, { bbox: terr.osm.bbox, commonsResolver: (names) => resolveCommonsMetadata(names, {}) });
  await mkdir(await safeWorkspaceChildPath(runDir, "synthesis"), { recursive: true });
  // Stream entities to avoid V8 string-length limit with 100K+ unnamed features
  const synthStream = createWriteStream(await safeWorkspaceChildPath(runDir, "synthesis", "entities.ndjson"), { flags: "wx" });
  for (const e of entities) {
    const line = JSON.stringify({ ...e, photo: e.photo ? { value: e.photo.value.url, license: e.photo.value.license, attribution: e.photo.value.attribution } : null });
    synthStream.write(line + "\n");
  }
  await new Promise<void>((resolve) => synthStream.end(() => resolve()));
  console.log(JSON.stringify({ runId, synthesized: entities.length, withPhoto: entities.filter((e) => e.photo).length, withDescription: entities.filter((e) => e.description).length }));
});
program.command("release").requiredOption("--territory <slug>").requiredOption("--run-id <id>").action(async ({ territory, runId }) => {
  const runDir = await workspaceRunDirectory(root, territory, runId);
  const records = await readNdjsonFile(await safeWorkspaceChildPath(runDir, "normalized", "source-records.ndjson"));
  const candidates = await readNdjsonFile(await safeWorkspaceChildPath(runDir, "resolution", "candidates.ndjson"));
  const terr = await loadTerritory(root, territory);

  // Geometry-aware dedup: contained OSM representations plus exact cross-source
  // identities. Geocoded EGRKN points participate only when address-compatible.
  const containmentCandidates: ContainmentCandidate[] = findContainedCandidates(records);
  const egrknCentroidCounts = buildEgrknCentroidCounts(records);
  const geocodedEvidence = await readNdjsonFile(await safeWorkspaceChildPath(runDir, "geocoded", "geometry-evidence.ndjson")).catch(() => [] as GeocodeEvidence[]);
  const geocodeMap = new Map(geocodedEvidence.map((e) => [e.sourceRecordId, e]));
  const crossSourceCandidates: ContainmentCandidate[] = findExactCrossSourceCandidates(records, geocodeMap);
  const allCandidates = [...candidates, ...containmentCandidates, ...crossSourceCandidates];
  if (containmentCandidates.length || crossSourceCandidates.length) console.error(`geography: ${containmentCandidates.length} containment + ${crossSourceCandidates.length} cross-source candidates added`);
  const subjectBoundaries = territory === "pfo" ? await loadPfoSubjectBoundaries() : [];
  let entities;
  try {
    entities = await synthesizeEntities(records, allCandidates, { bbox: terr.osm.bbox, egrknCentroidCounts, geocodedEvidence: geocodeMap, commonsResolver: chunkedCommons });
  } catch (error) {
    entities = await synthesizeEntities(records, allCandidates, { bbox: terr.osm.bbox, egrknCentroidCounts, geocodedEvidence: geocodeMap, commonsResolver: async () => [] });
  }
  const byRecord = new Map(records.map((r: any) => [r.id, r])) as Map<string, import("@poi-toolkit/core").SourceRecord>;
  const projection = projectNearventure(entities);
  const excluded = [...projection.excluded];
  const subjectCounts = new Map<string, number>();
  const subjectRegionConflicts: Array<{ id: string; sourceRecordIds: string[]; sourceRegion: string; polygonRegion: string; boundaryId: string }> = [];
  let unassignedSubjectRegions = 0;
  // For PFO, polygon containment is authoritative. Source text only fills
  // district/city and cannot publish an object outside the 14 subject union.
  const enriched: Array<import("@poi-toolkit/exporters").ProductFeature> = [];
  for (const p of projection.published as any[]) {
    const assignment = subjectBoundaries.length ? assignSubjectBoundary(p.geometry, subjectBoundaries) : null;
    if (subjectBoundaries.length && !assignment?.region) {
      unassignedSubjectRegions += 1;
      excluded.push({ sourceRecordIds: p.sourceRecordIds, reason: "outside canonical PFO subject polygons" });
      continue;
    }
    const hierarchy = resolveAdminHierarchy(p.sourceRecordIds, byRecord, terr.name);
    const region = assignment?.region ?? hierarchy.region;
    if (assignment?.region && hierarchy.region && hierarchy.region !== assignment.region) {
      subjectRegionConflicts.push({ id: p.id, sourceRecordIds: p.sourceRecordIds, sourceRegion: hierarchy.region, polygonRegion: assignment.region, boundaryId: assignment.boundaryId! });
      excluded.push({ sourceRecordIds: p.sourceRecordIds, reason: `source region ${hierarchy.region} conflicts with polygon ${assignment.region}` });
      continue;
    }
    if (region) subjectCounts.set(region, (subjectCounts.get(region) ?? 0) + 1);
    enriched.push({
      ...p,
      ...hierarchy,
      region,
      urls: p.urls.map((u: { url: string; kind: string }) => ({ url: u.url, kind: u.kind })),
    });
  }
  const sourceCounts = Object.fromEntries([...new Set(records.map((r: { source: string }) => r.source))].sort().map((s: string) => [s, records.filter((r: { source: string }) => r.source === s).length]));
  await Promise.all(["release", "reports"].map((part) => safeWorkspaceChildPath(runDir, part)));
  const result = await writeProductRelease(runDir, enriched, excluded, sourceCounts);
  const geocodeAuditRaw = await readNdjsonFile(await safeWorkspaceChildPath(runDir, "geocoded", "geocode-audit.ndjson")).catch(() => null) as unknown as null;
  const geocodeAudit = geocodeAuditRaw as unknown as Array<{ sourceRecordId: string; address: string; accepted: boolean; attempts: Array<{ provider: string; outcome: string; returnedAddress: string | null; confidence: string | null; reason: string | null }> }> | null;
  // A fallback can safely resolve an initial conflict, but any unresolved
  // address mismatch is a release blocker and remains explainable in audit.
  const legacyAddressBuildingConflicts = geocodedEvidence.filter((entry) => entry.addressCompatible === false).length;
  const addressBuildingConflicts = legacyAddressBuildingConflicts + (geocodeAudit?.filter((entry) => !entry.accepted && entry.attempts.some((attempt) => attempt.outcome === "address-conflict")).length ?? 0);
  // Fresh accepted evidence must always have the matching complete audit. Old
  // pre-hardening evidence has no explicit `addressCompatible` and is ignored.
  const geocodeAuditFailures = geocodeAudit === null && geocodedEvidence.some((entry) => entry.addressCompatible === true) ? 1 : 0;
  // P3: build disposition ledger from audit + evidence + normalized records.
  const reportPath = (file: string) => safeWorkspaceChildPath(runDir, "reports", file);
  const dispositionReport = buildDispositionLedger(geocodeAudit ?? [], geocodedEvidence, records);
  const dispositionFile = await reportPath("disposition-ledger.json");
  await writeFile(dispositionFile, JSON.stringify(dispositionReport, null, 2) + "\n", { flag: await missing(dispositionFile) ? "wx" : "w" });
  const hardening = auditReleaseHardening(enriched, { addressBuildingConflicts, geocodeAuditFailures, unassignedSubjectRegions, subjectRegionConflicts: subjectRegionConflicts.length, disposition: dispositionReport });
  const geographyReport = await reportPath("geography-report.json");
  await writeFile(geographyReport, JSON.stringify({
    ruleVersion: "pfo-subject-containment-v1",
    subjectCount: subjectBoundaries.length,
    assignments: Object.fromEntries([...subjectCounts.entries()].sort(([a], [b]) => a.localeCompare(b, "ru"))),
    unassignedSubjectRegions,
    subjectRegionConflicts: subjectRegionConflicts.length,
  }, null, 2) + "\n", { flag: await missing(geographyReport) ? "wx" : "w" });
  const geographyConflicts = await reportPath("geography-conflicts.ndjson");
  await writeFile(geographyConflicts, subjectRegionConflicts.map((conflict) => JSON.stringify(conflict)).join("\n") + (subjectRegionConflicts.length ? "\n" : ""), { flag: await missing(geographyConflicts) ? "wx" : "w" });
  const qualityScore = scoreRelease(enriched, { nearDuplicates: hardening.counts.specificNearDuplicates, excludedCount: excluded.length });
  const qualityFile = await reportPath("quality-score.json");
  await writeFile(qualityFile, JSON.stringify({ ruleVersion: "quality-score-v1", ...qualityScore }, null, 2) + "\n", { flag: await missing(qualityFile) ? "wx" : "w" });
  const hardeningFile = await reportPath("hardening-report.json");
  await writeFile(hardeningFile, JSON.stringify(hardening, null, 2) + "\n", { flag: await missing(hardeningFile) ? "wx" : "w" });
  const manifest = await readManifest(runDir);
  const blockingFailures = [...result.quality.blockingFailures, ...hardening.blockingFailures];
  if (!blockingFailures.length) {
    manifest.status = "releasable";
  } else {
    // P0.4: remove release/ directory — failed release must not be consumable.
    // Reports are kept in reports/ for diagnostics.
    await rm(await safeWorkspaceChildPath(runDir, "release"), { recursive: true, force: true });
    manifest.status = "failed";
    manifest.finishedAt = new Date().toISOString();
    manifest.diagnostics = [...new Set([...manifest.diagnostics, ...blockingFailures])];
  }
  await writeManifest(runDir, manifest);
  console.log(JSON.stringify({ runId, published: result.published.length, quality: result.quality, hardening, containmentCandidates: containmentCandidates.length, crossSourceCandidates: crossSourceCandidates.length }));
  if (blockingFailures.length) process.exitCode = 2;
});
program.command("attest-legacy-raw")
  .description("attest retained raw artifacts from legacy pfo-v0.1 into a new provenance-marked source run; performs no collection or network access")
  .requiredOption("--territory <slug>")
  .requiredOption("--source-run-id <id>")
  .requiredOption("--target-run-id <id>")
  .requiredOption("--reason <text>")
  .action(async ({ territory, sourceRunId, targetRunId, reason }) => {
    const { sourceRunDir, targetRunDir, provenance } = await attestLegacyRawRun({
      root,
      territorySlug: territory,
      sourceRunId,
      targetRunId,
      reason,
    });
    console.log(JSON.stringify({ sourceRunDir, targetRunDir, sourceRunId, targetRunId, rawArtifacts: provenance.attestation.rawArtifacts.length, attestedAt: provenance.attestation.at }));
  });
program.command("replay-raw")
  .description("copy retained raw artifacts from a completed run into a new provenance-marked replay run; performs no collection or network access")
  .requiredOption("--territory <slug>")
  .requiredOption("--source-run-id <id>")
  .requiredOption("--target-run-id <id>")
  .requiredOption("--reason <text>")
  .action(async ({ territory, sourceRunId, targetRunId, reason }) => {
    const { sourceRunDir, targetRunDir, provenance } = await replayRawRun({
      root,
      territorySlug: territory,
      sourceRunId,
      targetRunId,
      reason,
    });
    console.log(JSON.stringify({ sourceRunDir, targetRunDir, sourceRunId, targetRunId, rawArtifacts: provenance.replay.rawArtifacts.length, replayedAt: provenance.replay.at }));
  });
program.command("recover-release")
  .description("recover a v1 import bundle from a legacy run whose collection provenance is empty (source run stays read-only)")
  .requiredOption("--territory <slug>")
  .requiredOption("--run-id <id>")
  .requiredOption("--output-run-id <id>")
  .option("--dataset-version <version>", "override datasetVersion (default: output-run-id)")
  .action(async ({ territory, runId, outputRunId, datasetVersion }) => {
    const { sourceRunDir, outputRunDir, result } = await recoverReleaseExport({
      root,
      territorySlug: territory,
      runId,
      outputRunId,
      datasetVersion,
      toolkitVersion: await resolveToolkitVersion(),
      toolkitRevision: await resolveToolkitRevision(),
    });
    console.log(JSON.stringify({ sourceRunDir, outputRunDir, runId: outputRunId, sqlFile: result.file, manifestFile: result.manifestFile, entities: result.count, bytes: result.bytes, sha256: result.sha256 }));
  });
program.command("export-sql").requiredOption("--territory <slug>").requiredOption("--run-id <id>").action(async ({ territory, runId }) => {
  const runDir = await workspaceRunDirectory(root, territory, runId);
  const manifest = await readManifest(runDir);
  if (manifest.status !== "releasable") throw new Error(`release status is "${manifest.status}", must be "releasable" — diagnostics: ${manifest.diagnostics?.join(", ")}`);
  const hardening = JSON.parse(await readFile(await safeWorkspaceChildPath(runDir, "reports", "hardening-report.json"), "utf8"));
  if (hardening.blockingFailures?.length) throw new Error(`hardening has ${hardening.blockingFailures.length} blocking failure(s): ${hardening.blockingFailures.join(", ")}`);
  const entities = await readNdjsonFile(await safeWorkspaceChildPath(runDir, "release", "entities.ndjson"));
  await Promise.all(["release", "reports"].map((part) => safeWorkspaceChildPath(runDir, part)));
  const result = await writeSqlExport(runDir, entities, {
    toolkitVersion: await resolveToolkitVersion(),
    toolkitRevision: await resolveToolkitRevision(),
  });
  console.log(JSON.stringify({ runId, sqlFile: result.file, manifestFile: result.manifestFile, entities: result.count, bytes: result.bytes, sha256: result.sha256 }));
});
program.command("preflight").argument("[territory]", "territory slug to check PBF for").action(async (territory) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const checks: Array<{ name: string; status: string; message: string }> = [];
  // Node version
  const nodeVersion = parseInt(process.versions.node.split(".")[0] ?? "0");
  checks.push({ name: "Node.js", status: nodeVersion >= 22 ? "pass" : "fail", message: `v${process.versions.node}` });
  // Territory + PBF
  if (territory) {
    requireWorkspaceIdentifier("territory", territory);
    const terrPath = join(root, "territories", `${territory}.json`);
    try {
      const terr = JSON.parse(await readFile(terrPath, "utf8"));
      const pbfPath = join(root, terr.osm?.pbf ?? "");
      try { await stat(pbfPath); checks.push({ name: "PBF", status: "pass", message: terr.osm?.pbf }); }
      catch { checks.push({ name: "PBF", status: "fail", message: `NOT FOUND: ${pbfPath}` }); }
    } catch { checks.push({ name: "Territory", status: "fail", message: `${territory}.json not found` }); }
  }
  // osmium
  try { await execFileAsync("osmium", ["--version"], { timeout: 5000 }); checks.push({ name: "osmium-tool", status: "pass", message: "available" }); }
  catch { checks.push({ name: "osmium-tool", status: "warn", message: "not found (use Docker)" }); }
  // Photon
  const photonUrl = process.env.PHOTON_URL ?? "http://localhost:2322";
  try { const c = new AbortController(); setTimeout(() => c.abort(), 3000); await fetch(`${photonUrl}/api?q=test`, { signal: c.signal }); checks.push({ name: "Photon", status: "pass", message: photonUrl }); }
  catch { checks.push({ name: "Photon", status: "warn", message: `${photonUrl} not reachable` }); }
  // MKRF_API_KEY
  checks.push({ name: "MKRF_API_KEY", status: process.env.MKRF_API_KEY ? "pass" : "warn", message: process.env.MKRF_API_KEY ? "set" : "not set" });
  // Print
  console.log("\n=== Preflight ===");
  let fails = 0;
  for (const c of checks) { const icon = c.status === "pass" ? "✅" : c.status === "warn" ? "⚠️ " : "❌"; console.log(`  ${icon} ${c.name}: ${c.message}`); if (c.status === "fail") fails++; }
  if (fails) process.exitCode = 1;
});
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) program.parseAsync().catch((error) => { console.error(errorText(error)); process.exitCode = 1; });

async function readNdjsonFile(file: string): Promise<any[]> { const text = await readFile(file, "utf8"); return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }

/** Real 40-hex toolkit revision: POI_TOOLKIT_REVISION (CI-provided) or git rev-parse HEAD. "unknown" is never accepted. */
async function resolveToolkitRevision(): Promise<string> {
  const provided = process.env.POI_TOOLKIT_REVISION;
  if (provided !== undefined && provided !== "") {
    if (/^[0-9a-f]{40}$/.test(provided)) return provided;
    throw new Error(`POI_TOOLKIT_REVISION must be exactly 40 lowercase hex characters, got "${provided}"`);
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    const revision = stdout.trim();
    if (/^[0-9a-f]{40}$/.test(revision)) return revision;
    throw new Error(`git rev-parse HEAD returned "${revision}", expected 40 lowercase hex characters`);
  } catch (error) {
    throw new Error(`cannot resolve toolkit revision (set POI_TOOLKIT_REVISION or run inside the poi-toolkit git worktree): ${errorText(error)}`);
  }
}

/** Toolkit version from the workspace root package.json, must be a stable SemVer. */
async function resolveToolkitVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version)) return pkg.version;
  throw new Error(`toolkit package.json version must be a stable SemVer, got ${JSON.stringify(pkg.version)}`);
}

const chunkedCommons = async (names: string[]) => { const out: any[] = []; for (let i = 0; i < names.length; i += 20) { out.push(...await resolveCommonsMetadata(names.slice(i, i + 20), { retries: 6 })); await new Promise((r) => setTimeout(r, 1000)); } return out; };
