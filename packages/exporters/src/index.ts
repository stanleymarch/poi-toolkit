import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { SourceRecord, SourceRecordSchema, safeContainedPath } from "@poi-toolkit/core";
import { parquetWriteFile } from "hyparquet-writer";

export type PublishedEntity = { id: string; name: string; geometry: NonNullable<SourceRecord["geometry"]>; geometryPolicy: "osm" | "verified-source"; sourceRecordIds: string[] };
type Candidate = { sourceRecordIds: string[]; relation: "same" | string; decision: "accepted" | string };
export type GdalRunner = (executable: string, args: string[]) => Promise<unknown>;
export type ReleaseOptions = { gdalRunner?: GdalRunner; gdalExecutable?: string };
export type ReleaseResult = { entities: PublishedEntity[]; quality: ReleaseQuality };
export type ReleaseQuality = { published: number; excluded: { standaloneEgrkn: number; standaloneNonOsm: number; unnamedOrUnlocatedOsm: number; fuzzyPending: number; unsafeEgrknGeometry: number }; sourceCounts: Record<string, number>; blockingFailures: string[] };
const runGdal: GdalRunner = async (executable, args) => promisify(execFileCallback)(executable, args, { maxBuffer: 1024 * 1024 });

/** Conservative projection: only named OSM anchors and accepted same-relation groups publish. */
export function projectPublishedEntities(records: SourceRecord[], candidates: Candidate[]): { entities: PublishedEntity[]; quality: ReleaseQuality } {
  const byId = new Map(records.map((record) => [record.id, record]));
  const parent = new Map(records.map((record) => [record.id, record.id]));
  const find = (id: string): string => { const p = parent.get(id) ?? id; if (p === id) return id; const root = find(p); parent.set(id, root); return root; };
  const unite = (a: string, b: string) => { const x = find(a), y = find(b); if (x !== y) parent.set(y, x); };
  for (const candidate of candidates) if (candidate.decision === "accepted" && candidate.relation === "same" && candidate.sourceRecordIds.length > 1) unite(candidate.sourceRecordIds[0], candidate.sourceRecordIds[1]);
  const groups = new Map<string, SourceRecord[]>();
  for (const record of records) { const key = find(record.id); groups.set(key, [...(groups.get(key) ?? []), record]); }
  const sourceCounts = Object.fromEntries([...new Set(records.map((r) => r.source))].sort().map((source) => [source, records.filter((r) => r.source === source).length]));
  const entities: PublishedEntity[] = [];
  let standaloneEgrkn = 0, standaloneNonOsm = 0, unnamedOrUnlocatedOsm = 0;
  for (const members of groups.values()) {
    const osm = members.filter((record) => record.source === "osm" && record.name && record.geometry).sort((a, b) => a.id.localeCompare(b.id));
    if (!osm.length) {
      standaloneEgrkn += members.filter((r) => r.source === "egrkn").length;
      standaloneNonOsm += members.filter((r) => r.source === "wikidata" || r.source === "wikivoyage").length;
      unnamedOrUnlocatedOsm += members.filter((r) => r.source === "osm").length;
      continue;
    }
    // An OSM record is a named anchor; accepted links only extend its provenance.
    const anchor = osm[0];
    const ids = members.map((r) => r.id).sort();
    entities.push({ id: `entity:${anchor.id.slice(4)}`, name: anchor.name!, geometry: anchor.geometry!, geometryPolicy: "osm", sourceRecordIds: ids });
  }
  const fuzzyPending = candidates.filter((c) => c.decision === "pending").length;
  const centroidCounts = new Map<string, number>();
  for (const record of records.filter((r) => r.source === "egrkn" && r.geometry?.type === "Point")) {
    const key = JSON.stringify(record.geometry!.coordinates);
    centroidCounts.set(key, (centroidCounts.get(key) ?? 0) + 1);
  }
  const unsafeEgrknGeometry = records.filter((record) => {
    if (record.source !== "egrkn" || !record.geometry) return record.source === "egrkn";
    const addressClass = String(record.fields.addressClassification ?? "");
    const geometryClass = String(record.fields.nativeGeometryClassification ?? "");
    const repeated = record.geometry.type === "Point" && (centroidCounts.get(JSON.stringify(record.geometry.coordinates)) ?? 0) > 1;
    return repeated || addressClass === "relative" || geometryClass === "complex" || geometryClass === "unknown";
  }).length;
  entities.sort((a, b) => a.id.localeCompare(b.id));
  return { entities, quality: { published: entities.length, excluded: { standaloneEgrkn, standaloneNonOsm, unnamedOrUnlocatedOsm, fuzzyPending, unsafeEgrknGeometry }, sourceCounts, blockingFailures: [] } };
}

export async function releaseRun(runDir: string, options: ReleaseOptions = {}): Promise<ReleaseResult> {
  const child = (...parts: string[]) => safeContainedPath(runDir, ...parts);
  const records = await readNdjson<SourceRecord>(await child("normalized", "source-records.ndjson"), SourceRecordSchema.parse);
  const candidates = await readNdjson<Candidate>(await child("resolution", "candidates.ndjson"), (value) => value as Candidate);
  const result = projectPublishedEntities(records, candidates);
  const unresolved = await readNdjson<unknown>(await child("resolution", "unresolved.ndjson"), (value) => value);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const reviewCandidates = candidates.filter((candidate) => candidate.decision === "pending").map((candidate) => ({
    ...candidate,
    records: candidate.sourceRecordIds.map((id) => {
      const record = recordsById.get(id);
      return record ? { id: record.id, source: record.source, name: record.name, address: record.address, geometry: record.geometry } : { id };
    }),
  }));
  const release = await child("release"), reports = await child("reports");
  const quality = await child("reports", "release-quality.json");
  await assertMissing(release, "immutable release already exists");
  await assertMissing(quality, "immutable release report already exists");
  await mkdir(reports, { recursive: true });

  const staging = await child(`.release-${randomUUID()}.tmp`);
  const geojson = join(staging, "entities.geojson");
  const parquet = join(staging, "entities.parquet");
  const gpkg = join(staging, "dataset.gpkg");
  const review = join(staging, "review-candidates.ndjson");
  const unresolvedOutput = join(staging, "unresolved.ndjson");
  const releaseManifest = join(staging, "manifest.json");
  const collection = { type: "FeatureCollection", features: result.entities.map((entity) => ({ type: "Feature", id: entity.id, properties: { id: entity.id, name: entity.name, geometryPolicy: entity.geometryPolicy, sourceRecordIds: entity.sourceRecordIds }, geometry: entity.geometry })) };

  await mkdir(staging);
  try {
    await writeAtomic(geojson, JSON.stringify(collection, null, 2) + "\n");
    await writeParquetAtomic(parquet, result.entities);
    await writeGpkgAtomic(gpkg, geojson, options);
    await writeAtomic(review, toNdjson(reviewCandidates));
    await writeAtomic(unresolvedOutput, toNdjson(unresolved));
    const artifacts = await Promise.all([geojson, parquet, gpkg, review, unresolvedOutput].map(async (file) => ({
      path: file.slice(staging.length + 1).replaceAll("\\", "/"),
      bytes: (await stat(file)).size,
      sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
    })));
    await writeAtomic(releaseManifest, JSON.stringify({
      schemaVersion: 1,
      policy: "named OSM anchors enriched only by accepted explicit-identifier links",
      entityCount: result.entities.length,
      reviewCandidateCount: reviewCandidates.length,
      unresolvedCount: unresolved.length,
      geoParquet: { version: "1.1.0", primaryColumn: "geometry", defaultCrs: "OGC:CRS84" },
      sourceCounts: result.quality.sourceCounts,
      artifacts,
    }, null, 2) + "\n");
    await rename(staging, release);
    await writeAtomic(quality, JSON.stringify(result.quality, null, 2) + "\n");
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    result.quality.blockingFailures.push(error instanceof Error ? error.message : String(error));
    if (!await exists(quality)) await writeAtomic(quality, JSON.stringify(result.quality, null, 2) + "\n");
    throw error;
  }
  return result;
}

// ── Product release (synthesis + Nearventure projection) ───────────────────────

export type ProductFeature = {
  id: string;
  category: string;
  categoryLabel: string;
  categoryLabelLong: string;
  name: string;
  geometry: NonNullable<SourceRecord["geometry"]>;
  geometryPolicy: string;
  description: string | null;
  descriptionLicense: string | null;
  photo: { url: string; license: string; attribution: string; author: string | null; licenseUrl: string | null } | null;
  heritage: boolean;
  heritageSignificance: string | null;
  facets: string[];
  urls: Array<{ url: string; kind: string }>;
  sourceRecordIds: string[];
  region: string | null;
  district: string | null;
  city: string | null;
};

export type ProductReleaseQuality = {
  published: number;
  excludedCount: number;
  categoryCounts: Record<string, number>;
  coverage: { withPhoto: number; withDescription: number; withBoth: number };
  sourceCounts: Record<string, number>;
  blockingFailures: string[];
};

export type ProductReleaseResult = { published: ProductFeature[]; excluded: Array<{ sourceRecordIds: string[]; reason: string }>; quality: ProductReleaseQuality };

export async function writeProductRelease(runDir: string, published: ProductFeature[], excluded: Array<{ sourceRecordIds: string[]; reason: string }>, sourceCounts: Record<string, number>, options: ReleaseOptions = {}): Promise<ProductReleaseResult> {
  const child = (...parts: string[]) => safeContainedPath(runDir, ...parts);
  const release = await child("release"), reports = await child("reports");
  const quality = await child("reports", "release-quality.json");
  await assertMissing(release, "immutable release already exists");
  await assertMissing(quality, "immutable release report already exists");
  await mkdir(reports, { recursive: true });

  const categoryCounts: Record<string, number> = {};
  let withPhoto = 0, withDescription = 0, withBoth = 0;
  for (const f of published) {
    categoryCounts[f.category] = (categoryCounts[f.category] ?? 0) + 1;
    if (f.photo) withPhoto += 1;
    if (f.description) withDescription += 1;
    if (f.photo && f.description) withBoth += 1;
  }
  const result: ProductReleaseResult = {
    published,
    excluded,
    quality: { published: published.length, excludedCount: excluded.length, categoryCounts, coverage: { withPhoto, withDescription, withBoth }, sourceCounts, blockingFailures: [] },
  };

  const staging = await child(`.release-${randomUUID()}.tmp`);
  const geojson = join(staging, "entities.geojson");
  const parquet = join(staging, "entities.parquet");
  const gpkg = join(staging, "dataset.gpkg");
  const ndjson = join(staging, "entities.ndjson");
  const excludedOutput = join(staging, "excluded.ndjson");
  const releaseManifest = join(staging, "manifest.json");
  const collection = {
    type: "FeatureCollection",
    features: published.map((f) => ({
      type: "Feature", id: f.id,
      properties: { id: f.id, category: f.category, categoryLabel: f.categoryLabel, categoryLabelLong: f.categoryLabelLong, name: f.name, geometryPolicy: f.geometryPolicy, description: f.description, descriptionLicense: f.descriptionLicense, photo: f.photo, heritage: f.heritage, heritageSignificance: f.heritageSignificance, facets: f.facets, urls: f.urls, sourceRecordIds: f.sourceRecordIds, region: f.region, district: f.district, city: f.city },
      geometry: f.geometry,
    })),
  };

  await mkdir(staging);
  try {
    await writeAtomic(geojson, JSON.stringify(collection, null, 2) + "\n");
    await writeProductParquetAtomic(parquet, published);
    let gpkgSkipped = false;
    try { await writeGpkgAtomic(gpkg, geojson, options); }
    catch { gpkgSkipped = true; }
    await writeAtomic(ndjson, toNdjson(published));
    await writeAtomic(excludedOutput, toNdjson(excluded));
    const artifactFiles = [geojson, parquet, ndjson, excludedOutput];
    if (!gpkgSkipped) artifactFiles.unshift(gpkg);
    const artifacts = await Promise.all(artifactFiles.map(async (file) => ({
      path: file.slice(staging.length + 1).replaceAll("\\", "/"),
      bytes: (await stat(file)).size,
      sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
    })));
    await writeAtomic(releaseManifest, JSON.stringify({
      schemaVersion: 2,
      profile: "nearventure-v1",
      policy: "OSM-centered multi-source synthesis; trusted standalone government museums and heritage; locality/street geometry excluded",
      entityCount: published.length,
      excludedCount: excluded.length,
      categoryCounts,
      coverage: result.quality.coverage,
      geoParquet: { version: "1.1.0", primaryColumn: "geometry", defaultCrs: "OGC:CRS84" },
      attribution: "© OpenStreetMap contributors (ODbL); Минкультуры РФ; Wikidata (CC0); Wikimedia Commons (per-file); Wikivoyage (CC BY-SA 4.0)",
      sourceCounts,
      artifacts,
    }, null, 2) + "\n");
    await rename(staging, release);
    await writeAtomic(quality, JSON.stringify(result.quality, null, 2) + "\n");
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    result.quality.blockingFailures.push(error instanceof Error ? error.message : String(error));
    if (!await exists(quality)) await writeAtomic(quality, JSON.stringify(result.quality, null, 2) + "\n");
    throw error;
  }
  return result;
}

async function writeProductParquetAtomic(output: string, features: ProductFeature[]): Promise<void> {
  const temp = `${output}.tmp`;
  try {
    await parquetWriteFile({ filename: temp, columnData: [
      { name: "id", data: features.map((f) => f.id), type: "STRING" },
      { name: "category", data: features.map((f) => f.category), type: "STRING" },
      { name: "name", data: features.map((f) => f.name), type: "STRING" },
      { name: "geometry", data: features.map((f) => f.geometry), type: "GEOMETRY" },
      { name: "geometryPolicy", data: features.map((f) => f.geometryPolicy), type: "STRING" },
      { name: "description", data: features.map((f) => f.description ?? ""), type: "STRING" },
      { name: "photoUrl", data: features.map((f) => f.photo?.url ?? ""), type: "STRING" },
      { name: "photoLicense", data: features.map((f) => f.photo?.license ?? ""), type: "STRING" },
      { name: "heritage", data: features.map((f) => f.heritage), type: "BOOLEAN" },
      { name: "sourceRecordIds", data: features.map((f) => JSON.stringify(f.sourceRecordIds)), type: "JSON" },
    ], kvMetadata: [{ key: "geo", value: JSON.stringify({ version: "1.1.0", primary_column: "geometry", columns: { geometry: { encoding: "WKB", geometry_types: [...new Set(features.map((f) => f.geometry.type))] } } }) }] });
    await rename(temp, output);
  } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}

async function writeParquetAtomic(output: string, entities: PublishedEntity[]): Promise<void> {
  const temp = `${output}.tmp`;
  try {
    await parquetWriteFile({ filename: temp, columnData: [
      { name: "id", data: entities.map((e) => e.id), type: "STRING" },
      { name: "name", data: entities.map((e) => e.name), type: "STRING" },
      { name: "geometry", data: entities.map((e) => e.geometry), type: "GEOMETRY" },
      { name: "geometryPolicy", data: entities.map((e) => e.geometryPolicy), type: "STRING" },
      { name: "sourceRecordIds", data: entities.map((e) => JSON.stringify(e.sourceRecordIds)), type: "JSON" },
    ], kvMetadata: [{ key: "geo", value: JSON.stringify({ version: "1.1.0", primary_column: "geometry", columns: { geometry: { encoding: "WKB", geometry_types: [...new Set(entities.map((e) => e.geometry.type))] } } }) }] });
    await rename(temp, output);
  } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}
async function writeGpkgAtomic(output: string, inputGeojson: string, options: ReleaseOptions): Promise<void> {
  const temp = `${output}.tmp`;
  try { await (options.gdalRunner ?? runGdal)(options.gdalExecutable ?? "ogr2ogr", ["-f", "GPKG", temp, inputGeojson, "-nln", "entities"]); await rename(temp, output); }
  catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}
async function writeAtomic(output: string, content: string): Promise<void> { const temp = `${output}.tmp`; await writeFile(temp, content, { flag: "wx" }); await rename(temp, output); }
async function assertMissing(file: string, prefix: string): Promise<void> { try { await stat(file); throw new Error(`${prefix}: ${file}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
async function exists(file: string): Promise<boolean> { try { await stat(file); return true; } catch { return false; } }
function toNdjson(rows: unknown[]): string { return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""); }
async function readNdjson<T>(file: string, parse: (value: unknown) => T): Promise<T[]> { const text = await readFile(file, "utf8"); return text.split(/\r?\n/).filter(Boolean).map((line) => parse(JSON.parse(line))); }
export * from "./sql-export.js";
