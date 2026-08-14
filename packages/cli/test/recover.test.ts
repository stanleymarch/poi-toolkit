import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ImportManifestSchema, readManifest } from "@poi-toolkit/core";
import type { ExportEntity } from "@poi-toolkit/exporters";
import { reconstructCollectionProvenance, recoverReleaseExport } from "../src/recover.js";

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

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

const TERRITORY = {
  slug: "test",
  name: "Test",
  egrkn: { region: "Test" },
  osm: { pbf: "input/test.pbf", bbox: [1, 2, 3, 4] },
  wikidata: { regions: ["Q1"] },
  wikivoyage: { pages: ["Test"] },
};

const RELEASE_MANIFEST = {
  schemaVersion: 2,
  profile: "nearventure-v1",
  policy: "test",
  entityCount: 2,
  excludedCount: 0,
  categoryCounts: { heritage: 1, monument: 0, sights: 0, religion: 0, nature: 0, museum: 1 },
  coverage: { withPhoto: 0, withDescription: 0, withBoth: 0 },
  geoParquet: { version: "1.1.0", primaryColumn: "geometry", defaultCrs: "OGC:CRS84" },
  attribution: "© OpenStreetMap contributors (ODbL)",
  sourceCounts: { osm: 1, egrkn: 1, wikidata: 0, wikivoyage: 0, mkrf: 0 },
  artifacts: [],
};

const EMPTY_PROVENANCE = JSON.stringify({
  schemaVersion: 1,
  territory: null,
  sourceManifests: [],
  inputPbf: null,
  snapshots: [],
}, null, 2) + "\n";

const REVISION = "f27168e6f1a9d61e9a48b0569e51a05ebfa7bd66";
const RECOVERED_AT = "2026-08-10T00:00:00.000Z";

type Fixture = {
  root: string;
  runDir: string;
};

async function fixtureRun(overrides: { hardeningBlockers?: string[]; storedProvenance?: string } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "recover-"));
  await mkdir(join(root, "territories"), { recursive: true });
  await writeFile(join(root, "territories", "test.json"), JSON.stringify(TERRITORY));
  await mkdir(join(root, "input"), { recursive: true });
  await writeFile(join(root, "input", "test.pbf"), Buffer.from("pbf-bytes"));

  const runDir = join(root, "workspace", "test", "legacy-run");
  await mkdir(join(runDir, "raw"), { recursive: true });
  await mkdir(join(runDir, "release"), { recursive: true });
  await mkdir(join(runDir, "reports"), { recursive: true });
  await writeFile(join(runDir, "raw", "egrkn.ndjson"), JSON.stringify({ a: 1 }) + "\n" + JSON.stringify({ a: 2 }) + "\n");
  await writeFile(join(runDir, "raw", "osm.geojsonseq"), JSON.stringify({ osm: true }) + "\n");
  await writeFile(join(runDir, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    runId: "legacy-run",
    territory: "test",
    status: "completed",
    startedAt: "2026-07-26T19:22:57.927Z",
    finishedAt: "2026-07-27T10:57:17.517Z",
    sources: {
      egrkn: { status: "completed", records: 2, snapshot: "raw/egrkn.ndjson", error: null },
      osm: { status: "completed", records: 0, snapshot: "raw/osm.geojsonseq", error: null },
      wikidata: { status: "completed", records: 0, snapshot: null, error: null },
      wikivoyage: { status: "completed", records: 0, snapshot: null, error: null },
      mkrf: { status: "completed", records: 0, snapshot: null, error: null },
    },
    diagnostics: [],
  }, null, 2) + "\n");
  await writeFile(join(runDir, "release", "manifest.json"), JSON.stringify(RELEASE_MANIFEST, null, 2) + "\n");
  await writeFile(join(runDir, "release", "entities.ndjson"), [entity("entity:osm1", "heritage", "First"), entity("entity:osm2", "museum", "Second")].map((e) => JSON.stringify(e)).join("\n") + "\n");
  await writeFile(join(runDir, "reports", "hardening-report.json"), JSON.stringify({ ruleVersion: "quality-hardening-v2", counts: {}, blockingFailures: overrides.hardeningBlockers ?? [], nearDuplicatePairs: [] }, null, 2) + "\n");
  const provenance = overrides.storedProvenance ?? EMPTY_PROVENANCE;
  await writeFile(join(runDir, "reports", "collection-provenance.json"), provenance);
  return { root, runDir };
}

describe("reconstructCollectionProvenance", () => {
  it("derives territory, five source manifests, snapshot hashes, PBF hash, and a recovered marker from retained inputs", async () => {
    const { root, runDir } = await fixtureRun();
    const manifest = await readManifest(runDir);
    const provenance = await reconstructCollectionProvenance({
      territory: TERRITORY,
      sourceRunDir: runDir,
      runManifest: manifest,
      pbfPath: join(root, "input", "test.pbf"),
      recoveredAt: RECOVERED_AT,
    });

    expect(provenance.schemaVersion).toBe(1);
    expect(provenance.territory.slug).toBe("test");
    expect(provenance.sourceManifests.map((m) => m.id).sort()).toEqual(["egrkn", "mkrf", "osm", "wikidata", "wikivoyage"]);
    for (const m of provenance.sourceManifests) {
      expect(m.license.url).toMatch(/^https:\/\//);
      expect(m.attribution.length).toBeGreaterThan(0);
    }
    expect(provenance.snapshots.map((s) => s.source).sort()).toEqual(["egrkn", "osm"]);
    const egrknHash = sha(await readFile(join(runDir, "raw", "egrkn.ndjson")));
    expect(provenance.snapshots.find((s) => s.source === "egrkn")?.sha256).toBe(egrknHash);
    expect(provenance.inputPbf).toEqual({ path: "input/test.pbf", bytes: 9, sha256: sha("pbf-bytes") });
    expect(provenance.recovered).toMatchObject({ at: RECOVERED_AT, fromRun: "legacy-run" });
  });

  it("reports inputPbf null when the PBF is not retained", async () => {
    const { runDir } = await fixtureRun();
    const manifest = await readManifest(runDir);
    const provenance = await reconstructCollectionProvenance({
      territory: TERRITORY,
      sourceRunDir: runDir,
      runManifest: manifest,
      pbfPath: join("nonexistent", "test.pbf"),
      recoveredAt: RECOVERED_AT,
    });
    expect(provenance.inputPbf).toBeNull();
  });

  it("rejects a run whose declared snapshot file is missing", async () => {
    const { runDir } = await fixtureRun();
    const manifest = await readManifest(runDir);
    manifest.sources.egrkn.snapshot = "raw/gone.ndjson";
    await expect(reconstructCollectionProvenance({
      territory: TERRITORY,
      sourceRunDir: runDir,
      runManifest: manifest,
      pbfPath: null,
      recoveredAt: RECOVERED_AT,
    })).rejects.toThrow(/snapshot missing/);
  });
});

describe("recoverReleaseExport", () => {
  it("rejects an output run traversal before an outside workspace path is touched", async () => {
    const root = await mkdtemp(join(tmpdir(), "recover-path-"));
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "unchanged");
    await expect(recoverReleaseExport({
      root,
      territorySlug: "test",
      runId: "legacy-run",
      outputRunId: "../outside",
      toolkitVersion: "0.1.0",
      toolkitRevision: "a".repeat(40),
    })).rejects.toThrow(/canonical identifier/);
    expect(await readdir(outside)).toEqual(["sentinel"]);
  });

  it.each(["release", "reports"] as const)("rejects a source run with a symlinked %s directory before mutating outside the workspace", async (component) => {
    const { root, runDir } = await fixtureRun();
    const outside = await mkdtemp(join(tmpdir(), "recover-outside-"));
    const sentinel = join(outside, "sentinel");
    await writeFile(sentinel, "unchanged");
    await rm(join(runDir, component), { recursive: true });
    try {
      await symlink(outside, join(runDir, component), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    await expect(recoverReleaseExport({
      root,
      territorySlug: "test",
      runId: "legacy-run",
      outputRunId: "legacy-run-v1",
      toolkitVersion: "0.1.0",
      toolkitRevision: REVISION,
    })).rejects.toThrow(/symbolic link/);

    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
    expect(await readdir(join(root, "workspace", "test"))).toEqual(["legacy-run"]);
  });

  it("produces a v1 import bundle in a new run dir without touching the source run", async () => {
    const { root, runDir } = await fixtureRun();
    const before = await readFile(join(runDir, "release", "manifest.json"));
    const { outputRunDir, result } = await recoverReleaseExport({
      root,
      territorySlug: "test",
      runId: "legacy-run",
      outputRunId: "legacy-run-v1",
      datasetVersion: "legacy-run-v1",
      toolkitVersion: "0.1.0",
      toolkitRevision: REVISION,
      recoveredAt: RECOVERED_AT,
    });

    // Source run untouched.
    expect(await readFile(join(runDir, "release", "manifest.json"))).toEqual(before);
    expect(outputRunDir).toBe(join(root, "workspace", "test", "legacy-run-v1"));

    // Release manifest copied byte-for-byte.
    expect(await readFile(join(outputRunDir, "release", "manifest.json"))).toEqual(before);

    // Reconstructed provenance with recovered marker.
    const provenance = JSON.parse(await readFile(join(outputRunDir, "reports", "collection-provenance.json"), "utf8"));
    expect(provenance.territory.slug).toBe("test");
    expect(provenance.sourceManifests.length).toBe(5);
    expect(provenance.recovered.fromRun).toBe("legacy-run");

    // Output run manifest: releasable + recovery diagnostic.
    const outputManifest = await readManifest(outputRunDir);
    expect(outputManifest.status).toBe("releasable");
    expect(outputManifest.diagnostics.join(" ")).toContain("recovered from run legacy-run");

    // SQL artifact: data-only, exactly records.count single-row upserts.
    const sql = await readFile(result.file, "utf8");
    expect(sql).not.toMatch(/BEGIN|COMMIT|ROLLBACK|COPY|SET |--|\\gexec|\\copy/i);
    expect(sql.match(/INSERT INTO poi_product/g)).toHaveLength(2);
    expect(result.count).toBe(2);

    // Strict import manifest with consistent hashes.
    const manifest = JSON.parse(await readFile(result.manifestFile, "utf8"));
    expect(ImportManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.datasetVersion).toBe("legacy-run-v1");
    expect(manifest.run.id).toBe("legacy-run-v1");
    expect(manifest.records).toMatchObject({ path: "reports/poi_product_import.sql", count: 2, bytes: result.bytes, sha256: result.sha256 });
    expect(manifest.provenance.releaseManifest.sha256).toBe(sha(before));
    expect(manifest.provenance.collectionProvenance.sha256).toBe(sha(await readFile(join(outputRunDir, "reports", "collection-provenance.json"))));
    expect(manifest.toolkit).toEqual({ version: "0.1.0", revision: REVISION });
    const categorySum = Object.values(manifest.counts.categories).reduce((sum: number, value: number) => sum + value, 0);
    expect(categorySum).toBe(manifest.records.count);
  });

  it("reuses a valid live-captured provenance byte-for-byte without a recovered marker", async () => {
    const stored = JSON.stringify({
      schemaVersion: 1,
      territory: { slug: "test" },
      sourceManifests: [
        { id: "osm", license: { name: "ODbL 1.0", url: "https://www.openstreetmap.org/copyright" }, attribution: "© OpenStreetMap contributors" },
        { id: "egrkn", license: { name: "Ministry of Culture", url: "https://opendata.mkrf.ru/" }, attribution: "ЕГРОКН (Минкультуры России)" },
        { id: "wikidata", license: { name: "CC0", url: "https://creativecommons.org/publicdomain/zero/1.0/" }, attribution: "Wikidata" },
        { id: "wikivoyage", license: { name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" }, attribution: "Wikivoyage" },
        { id: "mkrf", license: { name: "Ministry of Culture", url: "https://opendata.mkrf.ru/" }, attribution: "Минкультуры РФ" },
      ],
      inputPbf: null,
      snapshots: [],
    }, null, 2) + "\n";
    const { root, outputRunDir } = await recoverFixture(stored);
    const written = await readFile(join(outputRunDir, "reports", "collection-provenance.json"));
    expect(written.toString()).toBe(stored);
    expect(JSON.parse(written.toString())).not.toHaveProperty("recovered");
  });

  it("rejects a release with hardening blockingFailures", async () => {
    const { root } = await fixtureRun({ hardeningBlockers: ["blocker"] });
    await expect(recoverReleaseExport({
      root,
      territorySlug: "test",
      runId: "legacy-run",
      outputRunId: "legacy-run-v1",
      toolkitVersion: "0.1.0",
      toolkitRevision: REVISION,
    })).rejects.toThrow(/blockingFailures must be empty/);
  });

  it("rejects when the output run dir already exists", async () => {
    const { root } = await fixtureRun();
    await mkdir(join(root, "workspace", "test", "legacy-run-v1"), { recursive: true });
    await expect(recoverReleaseExport({
      root,
      territorySlug: "test",
      runId: "legacy-run",
      outputRunId: "legacy-run-v1",
      toolkitVersion: "0.1.0",
      toolkitRevision: REVISION,
    })).rejects.toThrow(/already exists/);
  });

  it("rejects a source run missing release artifacts", async () => {
    const { root, runDir } = await fixtureRun();
    // Corrupt: replace entities.ndjson with a directory placeholder (missing file semantics).
    const { rm } = await import("node:fs/promises");
    await rm(join(runDir, "release", "entities.ndjson"));
    await expect(recoverReleaseExport({
      root,
      territorySlug: "test",
      runId: "legacy-run",
      outputRunId: "legacy-run-v1",
      toolkitVersion: "0.1.0",
      toolkitRevision: REVISION,
    })).rejects.toThrow(/missing required artifact/);
  });
});

async function recoverFixture(storedProvenance: string): Promise<{ root: string; outputRunDir: string }> {
  const { root } = await fixtureRun({ storedProvenance });
  const { outputRunDir } = await recoverReleaseExport({
    root,
    territorySlug: "test",
    runId: "legacy-run",
    outputRunId: "legacy-run-v1",
    datasetVersion: "legacy-run-v1",
    toolkitVersion: "0.1.0",
    toolkitRevision: REVISION,
    recoveredAt: RECOVERED_AT,
  });
  return { root, outputRunDir };
}
