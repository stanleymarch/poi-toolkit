import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { FieldClaim, GeometryEvidence, safeContainedPath, SourceManifestSchema, SourceRecord, SourceRecordSchema } from "@poi-toolkit/core";

export const OSM_MANIFEST = SourceManifestSchema.parse({
  id: "osm",
  version: "pbf-snapshot-v1",
  requiredSecrets: [],
  license: {
    name: "Open Database License 1.0",
    url: "https://www.openstreetmap.org/copyright",
    osmCompatible: true,
  },
  attribution: "© OpenStreetMap contributors",
  updateMode: "snapshot",
});

const execFile = promisify(execFileCallback);
export type CommandRunner = (executable: string, args: string[]) => Promise<unknown>;
export type OsmiumOptions = { pbf: string; output: string; bbox: [number, number, number, number]; executable?: string; run?: CommandRunner };
const defaultRunner: CommandRunner = (executable, args) => execFile(executable, args, { maxBuffer: 1024 * 1024 });

/** Extracts a bounded, tagged OSM subset and exports an immutable GeoJSON sequence. */
export async function extractOsmGeoJsonSeq(options: OsmiumOptions): Promise<{output:string; command:string[]}> {
  const output = await safeContainedPath(dirname(options.output), basename(options.output));
  await stat(options.pbf);
  await mkdir(dirname(output), { recursive: true });
  try { await stat(output); throw new Error(`immutable snapshot already exists: ${output}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const executable = options.executable ?? "osmium";
  const run = options.run ?? defaultRunner;
  const [west, south, east, north] = options.bbox;
  const temp = await mkdtemp(join(dirname(output), ".osm-"));
  const extracted = join(temp, "bounded.osm.pbf");
  const filtered = join(temp, "filtered.osm.pbf");
  // Keep POI-scale features. A generic `nwr/natural` filter pulls forests,
  // coastlines and their referenced nodes into GeoJSON and can inflate a
  // regional snapshot to hundreds of megabytes.
  const filters = [
    "nwr/historic",
    "nwr/tourism",
    "nwr/amenity=museum",
    "nwr/amenity=place_of_worship",
    "nwr/leisure=park",
    "nwr/leisure=nature_reserve",
    "nwr/natural=water",
    "nwr/natural=waterfall",
    "nwr/natural=spring",
    "nwr/natural=beach",
    "nwr/water=lake",
    "nwr/water=pond",
    "nwr/water=reservoir",
    "nwr/geological",
    "n/natural=peak",
    "n/natural=cave_entrance",
    "n/natural=spring",
    "n/natural=cliff",
    "n/natural=rock",
    "n/natural=stone",
    // Named individual trees (natural=tree). Release filters unnamed at
    // publish time — only ~named trees survive to the final output.
    // Unnamed tree bulk (~107K PFO nodes) inflates the pipeline ~50 MB
    // but never reaches the product.
    "n/natural=tree",
  ];
  // Address index: separate extraction for buildings with addr:housenumber.
  // NOT added to main pipeline filters — extracted separately to build a
  // compact index without bloating SourceRecords.
  const addressFilters = ["nwr/addr:housenumber"];
  try {
    await run(executable, ["extract", "-b", `${west},${south},${east},${north}`, options.pbf, "-o", extracted]);
    await run(executable, ["tags-filter", extracted, ...filters, "-o", filtered]);
    const exportArgs = ["export", filtered, "-f", "geojsonseq", "--add-unique-id=type_id", "-o", output];
    await run(executable, exportArgs);
    return { output, command: [executable, ...exportArgs] };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

type GeoJsonFeature = { type: "Feature"; id: string | number; properties: Record<string, unknown> | null; geometry: unknown };

/** Parses RFC 8142 GeoJSON text sequences, including the optional record separator. */
export function parseOsmGeoJsonSeq(snapshot: string, rawPath = "raw/osm.geojsonseq", capturedAt = new Date().toISOString()): SourceRecord[] {
  const records: SourceRecord[] = [];
  for (const [index, chunk] of snapshot.split("\u001e").flatMap((part) => part.split(/\r?\n/)).entries()) {
    const line = chunk.trim();
    if (!line) continue;
    let feature: GeoJsonFeature;
    try { feature = JSON.parse(line) as GeoJsonFeature; } catch { throw new Error(`OSM GeoJSON sequence schema drift at record ${index + 1}: invalid JSON`); }
    if (feature.type !== "Feature" || (typeof feature.id !== "string" && typeof feature.id !== "number") || !String(feature.id).trim()) {
      throw new Error(`OSM GeoJSON sequence schema drift at record ${index + 1}: missing unique id`);
    }
    if (!feature.geometry || typeof feature.geometry !== "object" || !feature.properties || typeof feature.properties !== "object" || Array.isArray(feature.properties)) {
      throw new Error(`OSM GeoJSON sequence schema drift at record ${index + 1}: expected Feature geometry and properties`);
    }
    const sourceId = String(feature.id);
    const tags = feature.properties;
    // P1.2: Skip unnamed natural=tree nodes — they inflate pipeline by 100K+
    // records but never reach the product (release filters unnamed). Only
    // named trees, or trees with denotation/heritage tags pass through.
    if (tags.natural === "tree" && !tags.name && !tags.denotation && !tags.heritage && !tags["ref:knid"] && !tags.wikidata) continue;
    records.push(SourceRecordSchema.parse({
      id: `osm:${sourceId}`, source: "osm", sourceId, capturedAt, rawRef: `${rawPath}#${index + 1}`,
      name: stringOrNull(tags.name), address: stringOrNull(tags["addr:full"] ?? tags["addr:street"]), geometry: feature.geometry,
      fields: { tags }, license: "Open Database License 1.0",
    }));
  }
  return records;
}

export function osmGeometryEvidence(record: SourceRecord): GeometryEvidence | null {
  if (!record.geometry) return null;
  return { sourceRecordId: record.id, geometry: record.geometry, method: "osm-geometry", precision: record.geometry.type === "Point" ? "object" : "complex", precisionMeters: null, capturedAt: record.capturedAt };
}
export function osmFieldClaims(record: SourceRecord): FieldClaim[] {
  const tags = record.fields.tags;
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return [];
  return Object.entries(tags).map(([field, value]) => ({ sourceRecordId: record.id, field: `tag:${field}`, value, provenance: record.rawRef, observedAt: record.capturedAt, license: record.license }));
}
function stringOrNull(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }

/** Extract OSM features with addr:housenumber for address index building.
 *  Separate from the main POI extraction — output is discarded after index build. */
export async function extractOsmAddressGeoJsonSeq(options: OsmiumOptions): Promise<{ output: string; command: string[] }> {
  const output = await safeContainedPath(dirname(options.output), basename(options.output));
  await stat(options.pbf);
  await mkdir(dirname(output), { recursive: true });
  try { await stat(output); throw new Error(`immutable address snapshot already exists: ${output}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const executable = options.executable ?? "osmium";
  const run = options.run ?? defaultRunner;
  const [west, south, east, north] = options.bbox;
  const temp = await mkdtemp(join(dirname(output), ".osm-addr-"));
  const extracted = join(temp, "bounded.osm.pbf");
  const filtered = join(temp, "filtered.osm.pbf");
  try {
    await run(executable, ["extract", "-b", `${west},${south},${east},${north}`, options.pbf, "-o", extracted]);
    await run(executable, ["tags-filter", extracted, "nwr/addr:housenumber", "-o", filtered]);
    const exportArgs = ["export", filtered, "-f", "geojsonseq", "--add-unique-id=type_id", "-o", output];
    await run(executable, exportArgs);
    return { output, command: [executable, ...exportArgs] };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
