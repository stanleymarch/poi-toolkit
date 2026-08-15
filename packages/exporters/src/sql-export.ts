import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  ImportManifestSchema,
  IMPORT_CATEGORY_KEYS,
  IMPORT_SOURCE_KEYS,
  type SourceRecord,
  safeContainedPath,
} from "@poi-toolkit/core";

export type ExportEntity = {
  id: string;
  category: string;
  name: string;
  geometry: NonNullable<SourceRecord["geometry"]>;
  geometryPolicy: string;
  description: string | null;
  descriptionLicense: string | null;
  photo: { url: string; license: string; attribution: string; author: string | null } | null;
  heritage: boolean;
  heritageSignificance: string | null;
  facets: string[];
  urls: Array<{ url: string; kind: string }>;
  sourceRecordIds: string[];
  categoryRule: string;
  region: string | null;
  district: string | null;
  city: string | null;
};

/** Options for a data-only SQL export + strict import manifest (externalization contract v1). */
export type SqlExportOptions = {
  /** Stable SemVer version of the emitting toolkit, e.g. "0.1.0". */
  toolkitVersion: string;
  /** Exactly 40 lowercase hex chars (git commit). "unknown" is invalid and rejects the export. */
  toolkitRevision: string;
  /** Importer-version compatibility window (stable SemVer). Defaults to 1.0.0 .. <2.0.0. */
  minImporterVersion?: string;
  maxImporterVersionExclusive?: string;
  /** Override for datasetVersion; defaults to `<territorySlug>-<runId>`. */
  datasetVersion?: string;
};

export type SqlExportResult = {
  /** Absolute path to reports/poi_product_import.sql (canonical path: reports/poi_product_import.sql). */
  file: string;
  /** Absolute path to reports/poi_product_import.manifest.json. */
  manifestFile: string;
  /** Number of single-row INSERT statements in the SQL artifact (= records.count). */
  count: number;
  /** Byte length of the SQL artifact. */
  bytes: number;
  /** Lowercase 64-hex SHA-256 of the SQL artifact raw bytes. */
  sha256: string;
};

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REVISION = /^[0-9a-f]{40}$/;
const HTTPS_URL = /^https:\/\//;

/** Deterministic 32-char hex UUID (no dashes) from an entity ID — stable across re-imports. */
export function poiUuid(entityId: string): string {
  return createHash("sha256").update("poi-toolkit:" + entityId).digest("hex").slice(0, 32);
}

function sqlEscape(value: string | null): string {
  if (value === null) return "NULL";
  return "'" + value.replace(/'/g, "''") + "'";
}

function jsonEscape(value: unknown): string {
  return "'" + JSON.stringify(value).replace(/'/g, "''") + "'::jsonb";
}

function centroid(geometry: NonNullable<SourceRecord["geometry"]>): { lat: number; lon: number } {
  if (geometry.type === "Point") return { lon: geometry.coordinates[0], lat: geometry.coordinates[1] };
  const pts: [number, number][] = [];
  const walk = (c: unknown): void => { if (Array.isArray(c) && typeof c[0] === "number") pts.push([c[0], c[1]]); else if (Array.isArray(c)) c.forEach(walk); };
  walk(geometry.coordinates);
  if (!pts.length) return { lon: 0, lat: 0 };
  return { lon: pts.reduce((n, p) => n + p[0], 0) / pts.length, lat: pts.reduce((n, p) => n + p[1], 0) / pts.length };
}

function urlByKind(urls: Array<{ url: string; kind: string }>, kind: string): string | null {
  return urls.find((u) => u.kind === kind)?.url ?? null;
}

function compareHex(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Data-only single-row upserts, one per entity, in stable poi_uuid order.
 *  No BEGIN/COMMIT/ROLLBACK, no DDL/COPY/SET, no psql meta-commands, no comments:
 *  the importer supplies the transaction and retargets poi_product to its staging table. */
function buildSql(entities: ExportEntity[]): string {
  const sorted = [...entities].sort((a, b) => compareHex(poiUuid(a.id), poiUuid(b.id)));
  const blocks: string[] = [];
  for (const e of sorted) {
    const uuid = poiUuid(e.id);
    const { lat, lon } = centroid(e.geometry);
    const source = e.geometryPolicy === "osm" ? "osm" : "egrkn";
    const externalId = e.id.replace(/^entity:/, "");
    const imageUrl = e.photo?.url ?? null;
    const imageSource = e.photo?.url?.includes("all.culture.ru") ? "mkrf" : e.photo?.url?.includes("okn-mk.mkrf.ru") ? "egrkn" : e.photo?.url?.includes("wikimedia") ? "wikimedia_commons" : e.photo ? "external" : null;
    const imageAttribution = e.photo ? { artist: e.photo.author, license: e.photo.license, attribution: e.photo.attribution } : null;
    const egrknUrl = urlByKind(e.urls, "egrkn");
    const wikidataUrl = e.urls.find((u) => u.kind === "wikipedia")?.url ?? null;
    const officialUrl = urlByKind(e.urls, "official");
    const wikivoyageUrl = urlByKind(e.urls, "wikivoyage");

    const cols = "(poi_uuid, source, external_id, category, name, description, image_url, image_attribution, image_source, lat, lon, is_protected, heritage_facet, attribution, provenance, egrkn_url, wikidata_url, official_url, wikivoyage_url, is_active, subcategory, region, district, city)";
    const vals = [
      sqlEscape(uuid), sqlEscape(source), sqlEscape(externalId), sqlEscape(e.category),
      sqlEscape(e.name), sqlEscape(e.description), sqlEscape(imageUrl),
      imageAttribution ? jsonEscape(imageAttribution) : "NULL", sqlEscape(imageSource),
      String(lat), String(lon),
      e.heritage ? "true" : "false", sqlEscape(e.heritageSignificance),
      imageAttribution ? jsonEscape(imageAttribution) : "NULL",
      jsonEscape({ sources: e.sourceRecordIds, categoryRule: e.categoryRule, geometryPolicy: e.geometryPolicy, facets: e.facets }),
      sqlEscape(egrknUrl), sqlEscape(wikidataUrl), sqlEscape(officialUrl), sqlEscape(wikivoyageUrl),
      "true", sqlEscape(e.facets[0] ?? null), sqlEscape(e.region ?? null),
      sqlEscape(e.district ?? null), sqlEscape(e.city ?? null),
    ].join(", ");

    blocks.push([
      `INSERT INTO poi_product ${cols}`,
      `VALUES (${vals})`,
      `ON CONFLICT (poi_uuid) DO UPDATE SET`,
      `  category=EXCLUDED.category, name=EXCLUDED.name, description=EXCLUDED.description,`,
      `  image_url=EXCLUDED.image_url, image_attribution=EXCLUDED.image_attribution, image_source=EXCLUDED.image_source,`,
      `  lat=EXCLUDED.lat, lon=EXCLUDED.lon,`,
      `  is_protected=EXCLUDED.is_protected, heritage_facet=EXCLUDED.heritage_facet,`,
      `  attribution=EXCLUDED.attribution, provenance=EXCLUDED.provenance,`,
      `  egrkn_url=EXCLUDED.egrkn_url, wikidata_url=EXCLUDED.wikidata_url, official_url=EXCLUDED.official_url, wikivoyage_url=EXCLUDED.wikivoyage_url, subcategory=EXCLUDED.subcategory, region=EXCLUDED.region, district=EXCLUDED.district, city=EXCLUDED.city;`,
    ].join("\n"));
  }
  return blocks.join("\n\n") + "\n";
}

type ReleaseManifestData = {
  profile: string;
  entityCount: number;
  categoryCounts: Record<string, number>;
  attribution: string;
  sourceCounts: Record<string, number>;
};

function parseReleaseManifest(raw: Record<string, unknown>, entityCount: number): ReleaseManifestData {
  if (raw.profile !== "nearventure-v1") throw new Error(`release manifest profile must be "nearventure-v1", got ${JSON.stringify(raw.profile)}`);
  if (raw.entityCount !== entityCount) throw new Error(`release manifest entityCount (${JSON.stringify(raw.entityCount)}) does not match the exported entity set (${entityCount})`);
  const categoryCounts = raw.categoryCounts;
  if (typeof categoryCounts !== "object" || categoryCounts === null) throw new Error("release manifest categoryCounts missing");
  const categories = categoryCounts as Record<string, unknown>;
  const categoryKeys = Object.keys(categories);
  const canonical = new Set<string>([...IMPORT_CATEGORY_KEYS]);
  if (categoryKeys.length !== IMPORT_CATEGORY_KEYS.length || categoryKeys.some((key) => !canonical.has(key))) {
    throw new Error(`release manifest categoryCounts must contain exactly the ${IMPORT_CATEGORY_KEYS.join(", ")} keys, got ${categoryKeys.join(", ")}`);
  }
  for (const [key, value] of Object.entries(categories)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`category count "${key}" must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  const typedCategories = categories as Record<string, number>;
  const categorySum = IMPORT_CATEGORY_KEYS.reduce((sum, key) => sum + typedCategories[key], 0);
  if (categorySum !== entityCount) throw new Error(`release manifest category counts sum (${categorySum}) does not equal entity count (${entityCount})`);
  if (typeof raw.attribution !== "string" || !raw.attribution.trim()) throw new Error("release manifest attribution must be a non-empty string");
  const sourceCounts = raw.sourceCounts;
  if (typeof sourceCounts !== "object" || sourceCounts === null) throw new Error("release manifest sourceCounts missing");
  const sources = sourceCounts as Record<string, unknown>;
  const sourceKeys = Object.keys(sources);
  const allowed = new Set<string>([...IMPORT_SOURCE_KEYS]);
  if (!sourceKeys.length || sourceKeys.some((key) => !allowed.has(key))) {
    throw new Error(`release manifest sourceCounts must be a non-empty subset of ${IMPORT_SOURCE_KEYS.join(", ")}, got ${sourceKeys.join(", ")}`);
  }
  for (const [key, value] of Object.entries(sources)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`source count "${key}" must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return { profile: "nearventure-v1", entityCount, categoryCounts: typedCategories, attribution: raw.attribution, sourceCounts: sources as Record<string, number> };
}

type SourceManifestComponent = { id: string; license: { name: string; url: string }; attribution: string };

function parseCollectionProvenance(raw: Record<string, unknown>): { territorySlug: string; sourceManifests: SourceManifestComponent[] } {
  const territory = raw.territory;
  const slug = typeof territory === "object" && territory !== null ? (territory as Record<string, unknown>).slug : undefined;
  if (typeof slug !== "string" || !slug.trim()) throw new Error("collection provenance territory.slug must be a non-empty string");
  const sourceManifests = raw.sourceManifests;
  if (!Array.isArray(sourceManifests) || !sourceManifests.length) throw new Error("collection provenance sourceManifests must be a non-empty array");
  const allowed = new Set<string>([...IMPORT_SOURCE_KEYS]);
  const components = sourceManifests.map((manifest, index) => {
    if (typeof manifest !== "object" || manifest === null) throw new Error(`collection provenance sourceManifests[${index}] must be an object`);
    const entry = manifest as Record<string, unknown>;
    if (typeof entry.id !== "string" || !allowed.has(entry.id)) {
      throw new Error(`collection provenance sourceManifests[${index}].id must be one of ${IMPORT_SOURCE_KEYS.join(", ")}, got ${JSON.stringify(entry.id)}`);
    }
    const license = entry.license;
    if (typeof license !== "object" || license === null) throw new Error(`collection provenance sourceManifests[${index}].license must be an object`);
    const lic = license as Record<string, unknown>;
    if (typeof lic.name !== "string" || !lic.name.trim()) throw new Error(`collection provenance sourceManifests[${index}].license.name must be non-empty`);
    if (typeof lic.url !== "string" || !HTTPS_URL.test(lic.url)) throw new Error(`collection provenance sourceManifests[${index}].license.url must be an absolute https URL`);
    if (typeof entry.attribution !== "string" || !entry.attribution.trim()) throw new Error(`collection provenance sourceManifests[${index}].attribution must be non-empty`);
    return { id: entry.id, license: { name: lic.name, url: lic.url }, attribution: entry.attribution };
  });
  if (new Set(components.map((component) => component.id)).size !== components.length) throw new Error("collection provenance sourceManifests contain duplicate ids");
  return { territorySlug: slug, sourceManifests: components };
}

/** Component ids must equal the keys of counts.sourceRecords; emitted in canonical source order. */
function buildComponents(sourceManifests: SourceManifestComponent[], sourceCounts: Record<string, number>): SourceManifestComponent[] {
  const byId = new Map(sourceManifests.map((manifest) => [manifest.id, manifest]));
  const requested = Object.keys(sourceCounts);
  for (const id of requested) if (!byId.has(id)) throw new Error(`collection provenance has no source manifest for component id "${id}"`);
  const components: SourceManifestComponent[] = [];
  for (const key of IMPORT_SOURCE_KEYS) {
    const manifest = byId.get(key);
    if (manifest) components.push({ id: key, license: { name: manifest.license.name, url: manifest.license.url }, attribution: manifest.attribution });
  }
  if (components.length !== requested.length) {
    throw new Error(`component ids must equal the keys of counts.sourceRecords (${requested.join(", ")}), got ${components.map((component) => component.id).join(", ")}`);
  }
  return components;
}

function hashHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Deterministic, data-only SQL export plus a strict versioned import manifest.
 *
 *  The SQL artifact is a `nearventure-poi-product-sql-v1` fragment: exactly
 *  `entities.length` single-row `INSERT INTO poi_product (...) VALUES (...)
 *  ON CONFLICT (poi_uuid) DO UPDATE ...;` statements and nothing else. The
 *  importer supplies the transaction and retargets the logical `poi_product`
 *  to its private staging table. A manifest is emitted only when the run's
 *  release manifest and collection provenance are consistent with the export
 *  and the toolkit revision is a real 40-hex commit. */
export async function writeSqlExport(runDir: string, entities: ExportEntity[], options: SqlExportOptions): Promise<SqlExportResult> {
  if (!REVISION.test(options.toolkitRevision)) throw new Error(`toolkit revision must be exactly 40 lowercase hex characters, got "${options.toolkitRevision}"`);
  if (!STABLE_SEMVER.test(options.toolkitVersion)) throw new Error(`toolkit version must be a stable SemVer version, got "${options.toolkitVersion}"`);
  const minImporterVersion = options.minImporterVersion ?? "1.0.0";
  const maxImporterVersionExclusive = options.maxImporterVersionExclusive ?? "2.0.0";
  if (!STABLE_SEMVER.test(minImporterVersion)) throw new Error(`minImporterVersion must be a stable SemVer version, got "${minImporterVersion}"`);
  if (!STABLE_SEMVER.test(maxImporterVersionExclusive)) throw new Error(`maxImporterVersionExclusive must be a stable SemVer version, got "${maxImporterVersionExclusive}"`);
  if (entities.length === 0) throw new Error("cannot export an empty entity set: records.count must be >= 1");

  const releaseManifestFile = await safeContainedPath(runDir, "release", "manifest.json");
  const collectionProvenanceFile = await safeContainedPath(runDir, "reports", "collection-provenance.json");
  const releaseManifest = parseReleaseManifest(JSON.parse(await readFile(releaseManifestFile, "utf8")) as Record<string, unknown>, entities.length);
  const provenance = parseCollectionProvenance(JSON.parse(await readFile(collectionProvenanceFile, "utf8")) as Record<string, unknown>);
  const components = buildComponents(provenance.sourceManifests, releaseManifest.sourceCounts);

  const sql = buildSql(entities);
  const sqlFile = await safeContainedPath(runDir, "reports", "poi_product_import.sql");
  await writeFile(sqlFile, sql, { flag: "wx" });

  try {
    const sqlBytes = await readFile(sqlFile);
    const [releaseBytes, provenanceBytes] = await Promise.all([readFile(releaseManifestFile), readFile(collectionProvenanceFile)]);
    const runId = basename(runDir);
    const datasetVersion = options.datasetVersion ?? `${provenance.territorySlug}-${runId}`;
    const categories: Record<string, number> = {};
    for (const key of IMPORT_CATEGORY_KEYS) categories[key] = releaseManifest.categoryCounts[key];
    const sourceRecords: Record<string, number> = {};
    for (const key of IMPORT_SOURCE_KEYS) if (key in releaseManifest.sourceCounts) sourceRecords[key] = releaseManifest.sourceCounts[key];

    const manifest = {
      schemaVersion: 1,
      kind: "nearventure.poi-product-import",
      datasetVersion,
      generatedAt: new Date().toISOString(),
      territory: { slug: provenance.territorySlug, profile: "nearventure-v1" },
      run: { id: runId },
      toolkit: { version: options.toolkitVersion, revision: options.toolkitRevision },
      compatibility: { recordsFormat: "nearventure-poi-product-sql-v1", minImporterVersion, maxImporterVersionExclusive },
      records: { path: "reports/poi_product_import.sql", count: entities.length, bytes: sqlBytes.byteLength, sha256: hashHex(sqlBytes) },
      counts: { categories, sourceRecords },
      provenance: {
        releaseManifest: { path: "release/manifest.json", sha256: hashHex(releaseBytes) },
        collectionProvenance: { path: "reports/collection-provenance.json", sha256: hashHex(provenanceBytes) },
      },
      sourceAttribution: { notice: releaseManifest.attribution, components },
    };
    ImportManifestSchema.parse(manifest);
    const manifestFile = await safeContainedPath(runDir, "reports", "poi_product_import.manifest.json");
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    return { file: sqlFile, manifestFile, count: entities.length, bytes: sqlBytes.byteLength, sha256: hashHex(sqlBytes) };
  } catch (error) {
    await unlink(sqlFile).catch(() => undefined);
    throw error;
  }
}
