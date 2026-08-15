import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parquetMetadata } from "hyparquet";
import { SourceRecord } from "@poi-toolkit/core";
import { projectPublishedEntities, releaseRun } from "../src/index.js";

const record = (id: string, source: SourceRecord["source"], name: string | null, geometry: SourceRecord["geometry"]): SourceRecord => ({ id, source, sourceId: id.split(":")[1], capturedAt: "2025-01-01T00:00:00.000Z", rawRef: "raw/test", name, address: null, geometry, fields: {}, license: null });
const point = (x: number, y: number) => ({ type: "Point" as const, coordinates: [x, y] });

describe("release projection", () => {
  it("unions only accepted same relations, prefers OSM, and excludes standalone EGRKN", () => {
    const osm = record("osm:n1", "osm", "OSM name", point(1, 2));
    const egrkn = record("egrkn:1", "egrkn", "Registry name", point(3, 4));
    const fuzzy = record("egrkn:2", "egrkn", "Pending", point(5, 6));
    const result = projectPublishedEntities([egrkn, osm, fuzzy], [
      { sourceRecordIds: ["egrkn:1", "osm:n1"], relation: "same", decision: "accepted" },
      { sourceRecordIds: ["egrkn:2", "osm:n1"], relation: "related", decision: "pending" },
    ]);
    expect(result.entities).toEqual([expect.objectContaining({ name: "OSM name", geometry: point(1, 2), sourceRecordIds: ["egrkn:1", "osm:n1"] })]);
    expect(result.quality.excluded.standaloneEgrkn).toBe(1);
    expect(result.quality.excluded.fuzzyPending).toBe(1);
  });

  it("writes immutable GeoParquet metadata and uses an atomic GDAL command", async () => {
    const run = await mkdtemp(join(tmpdir(), "release-"));
    await mkdir(join(run, "normalized")); await mkdir(join(run, "resolution"));
    await writeFile(join(run, "normalized", "source-records.ndjson"), JSON.stringify(record("osm:n1", "osm", "Anchor", point(1, 2))) + "\n");
    await writeFile(join(run, "resolution", "candidates.ndjson"), "");
    await writeFile(join(run, "resolution", "unresolved.ndjson"), "");
    const calls: string[][] = [];
    await releaseRun(run, { gdalRunner: async (_exe, args) => { calls.push(args); await writeFile(args[2], "gpkg"); } });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("-f");
    expect(calls[0][1]).toBe("GPKG");
    expect(calls[0][2]).toMatch(/\.release-.+\.tmp[\\/]dataset\.gpkg\.tmp$/);
    expect(calls[0][3]).toMatch(/\.release-.+\.tmp[\\/]entities\.geojson$/);
    expect(calls[0].slice(4)).toEqual(["-nln", "entities"]);
    const bytes = await readFile(join(run, "release", "entities.parquet"));
    const metadata = parquetMetadata(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const geo = JSON.parse(metadata.key_value_metadata?.find((item) => item.key === "geo")?.value ?? "{}");
    expect(geo).toMatchObject({ version: "1.1.0", primary_column: "geometry", columns: { geometry: { encoding: "WKB" } } });
    expect(geo.columns.geometry).not.toHaveProperty("crs"); // omitted means CRS84 in GeoParquet 1.1
    const manifest = JSON.parse(await readFile(join(run, "release", "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ schemaVersion: 1, entityCount: 1, reviewCandidateCount: 0, unresolvedCount: 0 });
    expect(manifest.artifacts).toHaveLength(5);
    expect(manifest.artifacts.every((artifact: { sha256: string }) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true);
    await expect(releaseRun(run, { gdalRunner: async () => undefined })).rejects.toThrow("immutable release");
  });

  it("removes the staged release if GDAL fails", async () => {
    const run = await mkdtemp(join(tmpdir(), "release-failure-"));
    await mkdir(join(run, "normalized"));
    await mkdir(join(run, "resolution"));
    await writeFile(join(run, "normalized", "source-records.ndjson"), JSON.stringify(record("osm:n1", "osm", "Anchor", point(1, 2))) + "\n");
    await writeFile(join(run, "resolution", "candidates.ndjson"), "");
    await writeFile(join(run, "resolution", "unresolved.ndjson"), "");

    await expect(releaseRun(run, { gdalRunner: async () => { throw new Error("GDAL failed"); } }))
      .rejects.toThrow("GDAL failed");
    await expect(readFile(join(run, "release", "entities.geojson"))).rejects.toThrow();
    const quality = JSON.parse(await readFile(join(run, "reports", "release-quality.json"), "utf8"));
    expect(quality.blockingFailures).toContain("GDAL failed");
  });
});
