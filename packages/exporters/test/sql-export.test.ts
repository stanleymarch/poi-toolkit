import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ImportManifestSchema, type ImportManifest, type SourceRecord } from "@poi-toolkit/core";
import { writeSqlExport, type ExportEntity } from "../src/index.js";

const point = (x: number, y: number) => ({ type: "Point" as const, coordinates: [x, y] });

const entity = (id: string, category: string, name: string): ExportEntity => ({
  id,
  category,
  name,
  geometry: point(49.2, 55.7),
  geometryPolicy: "osm",
  description: null,
  descriptionLicense: null,
  photo: null,
  heritage: false,
  heritageSignificance: null,
  facets: ["culture.heritage"],
  urls: [],
  sourceRecordIds: [id.replace("entity:", "osm:")],
  categoryRule: "facet.heritage",
  region: null,
  district: null,
  city: null,
});

const ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";

const releaseManifest = (entityCount: number) => ({
  schemaVersion: 2,
  profile: "nearventure-v1",
  policy: "test",
  entityCount,
  excludedCount: 0,
  categoryCounts: { heritage: 1, monument: 0, sights: 0, religion: 0, nature: 0, museum: entityCount - 1 },
  coverage: { withPhoto: 0, withDescription: 0, withBoth: 0 },
  geoParquet: { version: "1.1.0", primaryColumn: "geometry", defaultCrs: "OGC:CRS84" },
  attribution: ATTRIBUTION,
  sourceCounts: { osm: 1, egrkn: 1 },
  artifacts: [],
});

const collectionProvenance = (slug: string) => ({
  schemaVersion: 1,
  territory: { slug },
  sourceManifests: [
    {
      id: "osm",
      version: "test-v1",
      requiredSecrets: [],
      license: { name: "Open Database License 1.0", url: "https://www.openstreetmap.org/copyright", osmCompatible: true },
      attribution: "© OpenStreetMap contributors",
      updateMode: "snapshot",
    },
    {
      id: "egrkn",
      version: "test-v2",
      requiredSecrets: ["MKRF_API_KEY"],
      license: { name: "Ministry of Culture open data terms", url: "https://opendata.mkrf.ru/", osmCompatible: "unknown" },
      attribution: "Единый государственный реестр объектов культурного наследия (Минкультуры России)",
      updateMode: "snapshot",
    },
  ],
  inputPbf: null,
  snapshots: [],
});

async function fixtureRun(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sql-export-"));
  const run = join(root, "pfo-run-1");
  await mkdir(join(run, "release"), { recursive: true });
  await mkdir(join(run, "reports"), { recursive: true });
  await writeFile(join(run, "release", "manifest.json"), JSON.stringify(releaseManifest(2), null, 2) + "\n");
  await writeFile(join(run, "reports", "collection-provenance.json"), JSON.stringify(collectionProvenance("pfo"), null, 2) + "\n");
  return run;
}

const entities = () => [entity("entity:osm1", "heritage", "First"), entity("entity:osm2", "museum", "Second")];
const REVISION = "f27168e6f1a9d61e9a48b0569e51a05ebfa7bd66";

describe("writeSqlExport data-only SQL + strict import manifest", () => {
  it("emits a strict-schema-valid manifest with verifiable hashes, counts, and canonical paths", async () => {
    const run = await fixtureRun();
    const result = await writeSqlExport(run, entities(), { toolkitVersion: "0.1.0", toolkitRevision: REVISION });

    const sql = await readFile(result.file, "utf8");
    expect(sql).not.toMatch(/BEGIN|COMMIT|ROLLBACK|COPY|SET |--|\\gexec|\\copy/i);
    expect(sql.match(/INSERT INTO poi_product/g)).toHaveLength(2);
    expect(result.count).toBe(2);
    const sqlBytes = await readFile(result.file);
    expect(result.bytes).toBe(sqlBytes.byteLength);
    expect(result.sha256).toBe(createHash("sha256").update(sqlBytes).digest("hex"));
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);

    const manifest = JSON.parse(await readFile(result.manifestFile, "utf8")) as ImportManifest;
    expect(ImportManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.records).toMatchObject({ path: "reports/poi_product_import.sql", count: 2, bytes: result.bytes, sha256: result.sha256 });
    expect(manifest.provenance.releaseManifest.path).toBe("release/manifest.json");
    expect(manifest.provenance.collectionProvenance.path).toBe("reports/collection-provenance.json");
    expect(manifest.provenance.releaseManifest.sha256).toBe(createHash("sha256").update(await readFile(join(run, "release", "manifest.json"))).digest("hex"));
    expect(manifest.provenance.collectionProvenance.sha256).toBe(createHash("sha256").update(await readFile(join(run, "reports", "collection-provenance.json"))).digest("hex"));
    expect(manifest.sourceAttribution.notice).toBe(ATTRIBUTION);
    expect(manifest.territory).toEqual({ slug: "pfo", profile: "nearventure-v1" });
    expect(manifest.run.id).toBe("pfo-run-1");
    expect(manifest.datasetVersion).toBe("pfo-pfo-run-1");
    const categorySum = Object.values(manifest.counts.categories).reduce((sum, value) => sum + value, 0);
    expect(categorySum).toBe(manifest.records.count);
    expect(Object.keys(manifest.counts.sourceRecords).sort()).toEqual(["egrkn", "osm"]);
    expect(manifest.sourceAttribution.components.map((component) => component.id).sort()).toEqual(["egrkn", "osm"]);
    expect(manifest.toolkit).toEqual({ version: "0.1.0", revision: REVISION });
    expect(manifest.compatibility.recordsFormat).toBe("nearventure-poi-product-sql-v1");
    expect(manifest.compatibility.minImporterVersion).toBe("1.0.0");
    expect(manifest.compatibility.maxImporterVersionExclusive).toBe("2.0.0");
    // SQL is deterministic data-only: every statement is a single-row upsert targeting only poi_product.
    expect(sql).toContain("ON CONFLICT (poi_uuid) DO UPDATE");
    expect(sql).not.toContain("poi_product_staging");
  });

  it("is deterministic: two exports of identical ordered records have identical SQL bytes/hash", async () => {
    const runA = await fixtureRun();
    const runB = await fixtureRun();
    const options = { toolkitVersion: "0.1.0", toolkitRevision: REVISION };
    const [a, b] = await Promise.all([writeSqlExport(runA, entities(), options), writeSqlExport(runB, entities(), options)]);
    expect(await readFile(a.file)).toEqual(await readFile(b.file));
    expect(a.sha256).toBe(b.sha256);
    expect(a.bytes).toBe(b.bytes);
    const manifestA = JSON.parse(await readFile(a.manifestFile, "utf8")) as ImportManifest;
    const manifestB = JSON.parse(await readFile(b.manifestFile, "utf8")) as ImportManifest;
    // The manifest may differ only in generatedAt.
    const { generatedAt: _a, ...restA } = manifestA;
    const { generatedAt: _b, ...restB } = manifestB;
    expect(restA).toEqual(restB);
    expect(manifestA.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it("rejects a missing or non-40-hex toolkit revision and emits no manifest or SQL", async () => {
    const run = await fixtureRun();
    await expect(writeSqlExport(run, entities(), { toolkitVersion: "0.1.0", toolkitRevision: "unknown" })).rejects.toThrow(/40 lowercase hex/);
    await expect(writeSqlExport(run, entities(), { toolkitVersion: "0.1.0", toolkitRevision: "abc123" })).rejects.toThrow(/40 lowercase hex/);
    await expect(writeSqlExport(run, entities(), { toolkitVersion: "0.1.0", toolkitRevision: "F27168E6F1A9D61E9A48B0569E51A05EBFA7BD66" })).rejects.toThrow(/40 lowercase hex/);
    await expect(readFile(join(run, "reports", "poi_product_import.sql"))).rejects.toThrow();
    await expect(readFile(join(run, "reports", "poi_product_import.manifest.json"))).rejects.toThrow();
  });

  it("rejects an export whose release manifest and collection provenance are inconsistent", async () => {
    const run = await fixtureRun();
    // toolkit.version must be stable SemVer
    await expect(writeSqlExport(run, entities(), { toolkitVersion: "^0.1.0", toolkitRevision: REVISION })).rejects.toThrow(/stable SemVer/);
    // minImporterVersion must be stable SemVer
    await expect(writeSqlExport(run, entities(), { toolkitVersion: "0.1.0", toolkitRevision: REVISION, minImporterVersion: "1.0" })).rejects.toThrow(/stable SemVer/);
    // empty entity set is rejected
    await expect(writeSqlExport(run, [], { toolkitVersion: "0.1.0", toolkitRevision: REVISION })).rejects.toThrow(/empty entity set/);
    // missing release manifest
    const bare = await mkdtemp(join(tmpdir(), "sql-export-bare-"));
    await mkdir(join(bare, "release"));
    await mkdir(join(bare, "reports"));
    await expect(writeSqlExport(bare, entities(), { toolkitVersion: "0.1.0", toolkitRevision: REVISION })).rejects.toThrow();
    // source manifest id missing for a sourceCounts key
    const missing = await fixtureRun();
    await writeFile(join(missing, "reports", "collection-provenance.json"), JSON.stringify({ ...collectionProvenance("pfo"), sourceManifests: [collectionProvenance("pfo").sourceManifests[0]] }, null, 2) + "\n");
    await expect(writeSqlExport(missing, entities(), { toolkitVersion: "0.1.0", toolkitRevision: REVISION })).rejects.toThrow(/no source manifest for component id "egrkn"/);
    await expect(readFile(join(missing, "reports", "poi_product_import.sql"))).rejects.toThrow();
  });
});
