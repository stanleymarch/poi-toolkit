import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const PositionSchema = z.array(z.number()).min(2);
const LineSchema = z.array(PositionSchema).min(2);
const PolygonSchema = z.array(LineSchema).min(1);
export const GeometrySchema: z.ZodType = z.lazy(() => z.union([
  z.object({ type: z.literal("Point"), coordinates: PositionSchema }),
  z.object({ type: z.literal("LineString"), coordinates: LineSchema }),
  z.object({ type: z.literal("Polygon"), coordinates: PolygonSchema }),
  z.object({ type: z.literal("MultiPoint"), coordinates: z.array(PositionSchema) }),
  z.object({ type: z.literal("MultiLineString"), coordinates: z.array(LineSchema) }),
  z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(PolygonSchema) }),
  z.object({ type: z.literal("GeometryCollection"), geometries: z.array(GeometrySchema) })
]));
export const SourceManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  requiredSecrets: z.array(z.string()),
  license: z.object({
    name: z.string().min(1),
    url: z.string().url(),
    osmCompatible: z.union([z.boolean(), z.literal("unknown")]),
  }),
  attribution: z.string().min(1),
  updateMode: z.enum(["snapshot", "incremental"]),
});
export type SourceManifest = z.infer<typeof SourceManifestSchema>;

export const SourceRecordSchema = z.object({ id: z.string(), source: z.enum(["egrkn", "osm", "wikidata", "wikivoyage", "mkrf"]), sourceId: z.string(), capturedAt: z.string().datetime(), rawRef: z.string(), name: z.string().nullable(), address: z.string().nullable(), geometry: GeometrySchema.nullable(), fields: z.record(z.unknown()), license: z.string().nullable() });
export type SourceRecord = z.infer<typeof SourceRecordSchema>;
export const GeometryEvidenceSchema = z.object({ sourceRecordId: z.string(), geometry: GeometrySchema, method: z.enum(["source-native", "osm-geometry", "derived-centroid", "geocoder", "manual"]), precision: z.enum(["object", "building", "parcel", "complex", "street", "locality", "unknown"]), precisionMeters: z.number().positive().nullable(), capturedAt: z.string().datetime(), derivedFrom: z.array(z.string()).optional() });
export type GeometryEvidence = z.infer<typeof GeometryEvidenceSchema>;
export const FieldClaimSchema = z.object({ sourceRecordId: z.string(), field: z.string(), value: z.unknown(), provenance: z.string(), observedAt: z.string().datetime(), license: z.string().nullable() });
export type FieldClaim = z.infer<typeof FieldClaimSchema>;
export const EntityCandidateSchema = z.object({ id: z.string(), sourceRecordIds: z.array(z.string()).min(1), ruleVersion: z.string(), evidence: z.array(z.string()), decision: z.enum(["pending", "accepted", "rejected"]) });
export type EntityCandidate = z.infer<typeof EntityCandidateSchema>;
export const EntityRelationSchema = z.object({ fromCandidateId: z.string(), toCandidateId: z.string(), relation: z.enum(["same", "part-of", "contains", "related", "different"]), reason: z.string() });
export type EntityRelation = z.infer<typeof EntityRelationSchema>;

export interface SourceAdapter<TRaw = unknown> {
  readonly manifest: SourceManifest;
  fetch(context: { territory: Territory; signal?: AbortSignal }): AsyncIterable<TRaw>;
  normalize(record: TRaw, rawRef: string, capturedAt?: string): SourceRecord;
}
export const PublishedEntitySchema = z.object({ id: z.string(), name: z.string(), geometry: GeometrySchema, geometryPolicy: z.enum(["osm", "verified-source", "manual"]), sourceRecordIds: z.array(z.string()).min(1) });

export const AdminHierarchySchema = z.object({
  region: z.string().nullable(),
  district: z.string().nullable(),
  city: z.string().nullable(),
});
export type AdminHierarchy = z.infer<typeof AdminHierarchySchema>;
/** Source-neutral hierarchical classification, e.g. culture.heritage.building. */
export const FacetClaimSchema = z.object({
  path: z.string().min(1),
  kind: z.string().nullable(),
  traits: z.array(z.string()),
  sourceRecordId: z.string(),
  sourceField: z.string(),
  rule: z.object({ id: z.string(), version: z.string() }),
  confidence: z.number(),
});
export type FacetClaim = z.infer<typeof FacetClaimSchema>;

/** A media asset with mandatory reuse attribution to be publishable. */
export const MediaAssetSchema = z.object({
  url: z.string().url(),
  sourcePageUrl: z.string().nullable(),
  sourceRecordId: z.string(),
  author: z.string().nullable(),
  license: z.string(),
  licenseUrl: z.string().nullable(),
  attribution: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  rule: z.object({ id: z.string(), version: z.string() }),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

/** A value chosen from competing claims with full provenance. */
export const SelectedClaimSchema = z.object({
  value: z.unknown(),
  sourceRecordId: z.string(),
  sourceField: z.string(),
  license: z.string().nullable(),
  attribution: z.string().nullable(),
  rule: z.object({ id: z.string(), version: z.string() }),
  alternatives: z.array(z.object({ sourceRecordId: z.string(), sourceField: z.string(), rejectionReason: z.string() })),
});
export type SelectedClaim<T = unknown> = Omit<z.infer<typeof SelectedClaimSchema>, "value"> & { value: T };

/** Geometry classification used by the standalone-geometry gates. */
export type GeometryClass = "object" | "complex" | "unknown";

export type Territory = { slug: string; name: string; egrkn: { region: string; regions?: string[] }; osm: { pbf: string; bbox: [number, number, number, number] }; mkrf?: { clipBbox?: [number, number, number, number]; regionKeywords?: string[] }; wikidata: { regions: string[] }; wikivoyage: { pages: string[] }; wikivoyageNature?: { pages: string[] } };
export const RunManifestSchema = z.object({ schemaVersion: z.literal(1), runId: z.string(), territory: z.string(), status: z.enum(["running", "failed", "completed", "releasable"]), startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(), sources: z.record(z.object({ status: z.enum(["pending", "completed", "failed"]), records: z.number().int().nonnegative(), snapshot: z.string().nullable(), error: z.string().nullable() })), diagnostics: z.array(z.string()), replay: z.object({ fromRun: z.string(), at: z.string().datetime(), reason: z.string().min(1) }).optional(), attestation: z.object({ sourceOrigin: z.string(), at: z.string().datetime(), reason: z.string().min(1), legacy: z.literal(true), reconstructed: z.literal(true) }).optional() });
export type RunManifest = z.infer<typeof RunManifestSchema>;

// ── POI product import manifest (externalization contract v1) ──────────────────
// One strict, versioned manifest at <run-root>/reports/poi_product_import.manifest.json.
// All path fields are slash-separated, relative to <run-root>, and fixed literals.

export const IMPORT_MANIFEST_KIND = "nearventure.poi-product-import" as const;
export const IMPORT_RECORDS_FORMAT = "nearventure-poi-product-sql-v1" as const;
export const IMPORT_RECORDS_PATH = "reports/poi_product_import.sql" as const;
export const IMPORT_RELEASE_MANIFEST_PATH = "release/manifest.json" as const;
export const IMPORT_COLLECTION_PROVENANCE_PATH = "reports/collection-provenance.json" as const;
/** Canonical six-category keys of the nearventure-v1 profile; their sum equals records.count. */
export const IMPORT_CATEGORY_KEYS = ["heritage", "monument", "sights", "religion", "nature", "museum"] as const;
/** Allowed source-record keys; component ids must equal the keys of counts.sourceRecords. */
export const IMPORT_SOURCE_KEYS = ["osm", "egrkn", "wikidata", "wikivoyage", "mkrf"] as const;

export const asciiIdentifier = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const stableSemVer = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const sha256Hex = /^[0-9a-f]{64}$/;
export const gitRevisionHex = /^[0-9a-f]{40}$/;
const httpsUrl = /^https:\/\//;

const safeNonNegativeInt = z.number().int().nonnegative().refine((value) => Number.isSafeInteger(value), { message: "must be a safe integer" });
const safePositiveInt = z.number().int().positive().refine((value) => Number.isSafeInteger(value), { message: "must be a safe integer" });

export const ImportManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal(IMPORT_MANIFEST_KIND),
  datasetVersion: z.string().regex(asciiIdentifier),
  generatedAt: z.string().datetime(),
  territory: z.strictObject({
    slug: z.string().regex(asciiIdentifier),
    profile: z.literal("nearventure-v1"),
  }),
  run: z.strictObject({ id: z.string().regex(asciiIdentifier) }),
  toolkit: z.strictObject({
    version: z.string().regex(stableSemVer),
    revision: z.string().regex(gitRevisionHex),
  }),
  compatibility: z.strictObject({
    recordsFormat: z.literal(IMPORT_RECORDS_FORMAT),
    minImporterVersion: z.string().regex(stableSemVer),
    maxImporterVersionExclusive: z.string().regex(stableSemVer),
  }),
  records: z.strictObject({
    path: z.literal(IMPORT_RECORDS_PATH),
    count: safePositiveInt,
    bytes: safePositiveInt,
    sha256: z.string().regex(sha256Hex),
  }),
  counts: z.strictObject({
    categories: z.strictObject({
      heritage: safeNonNegativeInt,
      monument: safeNonNegativeInt,
      sights: safeNonNegativeInt,
      religion: safeNonNegativeInt,
      nature: safeNonNegativeInt,
      museum: safeNonNegativeInt,
    }),
    sourceRecords: z.record(z.enum(IMPORT_SOURCE_KEYS), safeNonNegativeInt)
      .refine((records) => Object.keys(records).length > 0, { message: "sourceRecords must be non-empty" }),
  }),
  provenance: z.strictObject({
    releaseManifest: z.strictObject({ path: z.literal(IMPORT_RELEASE_MANIFEST_PATH), sha256: z.string().regex(sha256Hex) }),
    collectionProvenance: z.strictObject({ path: z.literal(IMPORT_COLLECTION_PROVENANCE_PATH), sha256: z.string().regex(sha256Hex) }),
  }),
  sourceAttribution: z.strictObject({
    notice: z.string().min(1),
    components: z.array(z.strictObject({
      id: z.enum(IMPORT_SOURCE_KEYS),
      license: z.strictObject({ name: z.string().min(1), url: z.string().regex(httpsUrl) }),
      attribution: z.string().min(1),
    })).min(1),
  }),
}).superRefine((manifest, ctx) => {
  const categorySum = IMPORT_CATEGORY_KEYS.reduce((sum, key) => sum + manifest.counts.categories[key], 0);
  if (categorySum !== manifest.records.count) {
    ctx.addIssue({ code: "custom", path: ["counts", "categories"], message: `category counts sum (${categorySum}) must equal records.count (${manifest.records.count})` });
  }
  const sourceKeys = Object.keys(manifest.counts.sourceRecords).sort();
  const componentIds = manifest.sourceAttribution.components.map((component) => component.id).sort();
  const unique = new Set(componentIds).size === componentIds.length;
  if (!unique || componentIds.length !== sourceKeys.length || componentIds.some((id, index) => id !== sourceKeys[index])) {
    ctx.addIssue({ code: "custom", path: ["sourceAttribution", "components"], message: "component ids must equal the keys of counts.sourceRecords exactly once" });
  }
});
export type ImportManifest = z.infer<typeof ImportManifestSchema>;


export async function loadTerritory(root: string, slug: string): Promise<Territory> {
  const raw = JSON.parse(await readFile(join(root, "territories", `${slug}.json`), "utf8"));
  return z.object({
    slug: z.string(), name: z.string(), egrkn: z.object({ region: z.string(), regions: z.array(z.string()).optional() }),
    osm: z.object({ pbf: z.string(), bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]) }),
    mkrf: z.object({ clipBbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(), regionKeywords: z.array(z.string()).optional() }).optional(),
    wikidata: z.object({ regions: z.array(z.string().regex(/^Q\d+$/)).min(1) }),
    wikivoyage: z.object({ pages: z.array(z.string()).min(1) }),
    wikivoyageNature: z.object({ pages: z.array(z.string()) }).optional(),
  }).parse(raw);
}
export function runDirectory(root: string, territory: string, runId: string) { return resolve(root, "workspace", territory, runId); }

/** Resolve a child path and reject symbolic links in every existing component. */
export async function safeContainedPath(parent: string, ...children: string[]): Promise<string> {
  if (!children.length) throw new Error("contained child path must not be empty");
  const path = resolve(parent, ...children);
  const pathRelative = relative(parent, path);
  if (!pathRelative || pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || resolve(parent, pathRelative) !== path) {
    throw new Error(`path escapes containment: ${children.join("/")}`);
  }
  for (const component of [parent, ...pathRelative.split(sep).map((_, index, components) => join(parent, ...components.slice(0, index + 1)))]) {
    try {
      if ((await lstat(component)).isSymbolicLink()) throw new Error(`path component must not be a symbolic link: ${component}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return path;
}

export async function createRun(root: string, territory: string, runId: string = randomUUID()): Promise<{dir:string; manifest:RunManifest}> {
  const dir = await safeContainedPath(root, "workspace", territory, runId);
  await mkdir(dirname(dir), { recursive: true });
  try { await mkdir(await safeContainedPath(root, "workspace", territory, runId)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`run already exists: ${dir}`); throw error; }
  await mkdir(await safeContainedPath(dir, "raw"));
  const manifest:RunManifest={schemaVersion:1,runId,territory,status:"running",startedAt:new Date().toISOString(),finishedAt:null,sources:{},diagnostics:[]};
  await writeManifest(dir,manifest);
  return {dir,manifest};
}
export async function readManifest(dir:string): Promise<RunManifest> { return RunManifestSchema.parse(JSON.parse(await readFile(await safeContainedPath(dir, "manifest.json"),"utf8"))); }
export async function writeManifest(dir:string, manifest:RunManifest): Promise<void> { RunManifestSchema.parse(manifest); const target = await safeContainedPath(dir, "manifest.json"), tmp = await safeContainedPath(dir, "manifest.json.tmp"); await writeFile(tmp,JSON.stringify(manifest,null,2)+"\n"); await rename(tmp,target); }
export async function immutableNdjsonSnapshot(dir:string, source:string, rows:unknown[]): Promise<string> { const file = await safeContainedPath(dir, "raw", `${source}.ndjson`); try { await stat(file); throw new Error(`immutable snapshot already exists: ${file}`); } catch(e) { if ((e as NodeJS.ErrnoException).code!=="ENOENT") throw e; } const payload=rows.map(r=>JSON.stringify(r)).join("\n")+(rows.length?"\n":""); await writeFile(file,payload,{flag:"wx"}); return `raw/${source}.ndjson`; }
export function sha256(value:string):string { return createHash("sha256").update(value).digest("hex"); }
export function egrknRecord(raw:unknown, rawRef:string, capturedAt=new Date().toISOString()):SourceRecord { const r=raw as any, g=r?.data?.general ?? r?.general ?? {}; const c=g?.address?.mapPosition?.coordinates; const lon=Array.isArray(c)?Number(c[0]):NaN, lat=Array.isArray(c)?Number(c[1]):NaN; const geometry=Number.isFinite(lon)&&Number.isFinite(lat)?{type:"Point" as const,coordinates:[lon,lat]}:null; const id=String(g.regNumber ?? ""); if(!id) throw new Error("EGRKN record has no regNumber"); return SourceRecordSchema.parse({id:`egrkn:${id}`,source:"egrkn",sourceId:id,capturedAt,rawRef,name:nullable(g.name),address:nullable(g?.address?.fullAddress),geometry,fields:{objectType:g?.objectType?.value ?? null,region:g?.region?.value ?? null,categoryType:g?.categoryType?.value ?? null,egrknUrl:`https://okn-mk.mkrf.ru/maps/show/id/${id}`,photoUrl:g?.photo?.url ?? null},license:"Russian Ministry of Culture open data"}); }
const nullable=(v:unknown):string|null=>typeof v==="string"&&v.trim()?v.trim():null;

/** Ray-casting point-in-polygon for a single ring (lon,lat). */
function pointInRing(lon:number, lat:number, ring: [number,number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** True if the point is inside any polygon (MultiPolygon FeatureCollection of neighbor/exclusion regions). */
export function pointInAnyPolygon(lon: number, lat: number, polygons: { coordinates: number[][][][] }[]): boolean {
  for (const poly of polygons) for (const ring of poly.coordinates) { if (pointInRing(lon, lat, ring[0] as [number, number][])) return true; }
  return false;
}
