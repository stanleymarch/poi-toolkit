import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendInOrder, classifyEgrknAddress, normalizeRun } from "../src/index.js";

const egrkn = (id: string, address: string | null, coordinates: number[] | null) => ({ data: { general: { regNumber: id, name: `Объект ${id}`, objectType: { value: "Памятник" }, address: { fullAddress: address, mapPosition: { coordinates } } } } });

describe("normalization", () => {
  it("classifies unsafe Russian addresses", () => {
    expect(classifyEgrknAddress("г. Киров, ул. Ленина, д. 1")).toBe("exact");
    expect(classifyEgrknAddress("в районе 3 км севернее села")).toBe("relative");
    expect(classifyEgrknAddress("территория усадьбы")).toBe("compound");
    expect(classifyEgrknAddress(null)).toBe("missing");
  });
  it("appends large record batches without argument-list expansion and preserves order", () => {
    const records = Array.from({ length: 130_000 }, (_, index) => index);
    const target = [-1];
    appendInOrder(target, records);
    expect(target).toHaveLength(130_001);
    expect(target.slice(0, 3)).toEqual([-1, 0, 1]);
    expect(target.slice(-3)).toEqual([129_997, 129_998, 129_999]);
  });
  it("rejects a symlinked normalized output directory", async () => {
    const run = await mkdtemp(join(tmpdir(), "normalize-"));
    const outside = join(run, "outside");
    await mkdir(outside);
    try {
      await symlink(outside, join(run, "normalized"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(normalizeRun(run)).rejects.toThrow(/symbolic link/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("writes immutable artifacts and downgrades duplicate EGRKN centroids", async () => {
    const run = await mkdtemp(join(tmpdir(), "normalize-"));
    await mkdir(join(run, "raw"));
    await writeFile(join(run, "raw", "egrkn.ndjson"), [
      egrkn("1", "г. Киров, ул. Ленина, д. 1", [49.6, 58.6]),
      egrkn("2", "в районе села", [49.6, 58.6]),
      egrkn("3", null, null),
    ].map(JSON.stringify).join("\n") + "\n");
    await writeFile(join(run, "raw", "osm.geojsonseq"), "\u001e{" + "\"type\":\"Feature\",\"id\":\"n9\",\"properties\":{\"name\":\"OSM\"},\"geometry\":{\"type\":\"Point\",\"coordinates\":[49,58]}}\n");
    const result = await normalizeRun(run, "2026-01-01T00:00:00.000Z");
    expect(result.records).toHaveLength(4);
    expect(result.geometryEvidence.filter((item) => item.sourceRecordId.startsWith("egrkn:")).every((item) => item.precision === "complex")).toBe(true);
    expect(result.unresolvedGeometry.map((item) => item.reason)).toEqual(expect.arrayContaining(["repeated-coordinate-group", "relative-address", "missing-source-native-geometry"]));
    expect(await readFile(join(run, "normalized", "source-records.ndjson"), "utf8")).toContain("nativeGeometryClassification");
    expect(JSON.parse(await readFile(join(run, "reports", "source-quality.json"), "utf8")).unresolvedGeometry).toHaveLength(4);
    await expect(normalizeRun(run)).rejects.toThrow("immutable normalized artifact");
  });
});
