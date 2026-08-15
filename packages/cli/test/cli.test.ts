import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRun } from "@poi-toolkit/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../src/index.js";

async function rootWithTerritory() {
  const root = await mkdtemp(join(tmpdir(), "cli-"));
  await mkdir(join(root, "territories"));
  await writeFile(join(root, "territories", "test.json"), JSON.stringify({
    slug: "test",
    name: "Test",
    egrkn: { region: "Test" },
    osm: { pbf: "input/test.pbf", bbox: [1, 2, 3, 4] },
    wikidata: { regions: ["Q1"] },
    wikivoyage: { pages: ["Test"] },
  }));
  return root;
}

const emptyWikidata = async () => ({ raw: [], records: [], pages: 0 });
const emptyWikivoyage = async () => ({ raw: [], records: [], pages: 0 });
const emptyMkrf = async () => ({ records: [], pages: 0 });

describe("collect CLI", () => {
  it.each(["workspace", "territory"] as const)("rejects a dangling %s symlink before collect can create outside the workspace", async (component) => {
    const root = await rootWithTerritory();
    const outside = join(root, "outside");
    const danglingTarget = join(outside, component);
    await mkdir(outside);
    if (component === "territory") await mkdir(join(root, "workspace"));
    try {
      await symlink(danglingTarget, component === "workspace" ? join(root, "workspace") : join(root, "workspace", "test"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    await expect(collect("test", "new-run", { root })).rejects.toThrow(/symbolic link/);
    expect(await readdir(outside)).toEqual([]);
  });

  it.each(["raw", "reports"] as const)("does not write outside the workspace when an existing run %s directory is a symlink", async (component) => {
    const root = await rootWithTerritory();
    const outside = join(root, "outside");
    const run = await createRun(root, "test", `symlink-${component}`);
    await mkdir(outside);
    if (component === "raw") await rm(join(run.dir, "raw"), { recursive: true });
    try {
      await symlink(join(outside, component), join(run.dir, component), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const collectOptions = {
      root,
      apiKey: "test",
      collectEgrkn: emptyWikidata as never,
      collectWikidata: emptyWikidata as never,
      collectWikivoyage: emptyWikivoyage as never,
      collectMkrf: emptyMkrf as never,
      extractOsmGeoJsonSeq: async (options: { output: string }) => { await writeFile(options.output, "feature\n"); return { output: options.output, command: [] }; },
    };
    if (component === "raw") await expect(collect("test", `symlink-${component}`, collectOptions)).rejects.toThrow(/symbolic link/);
    else expect((await collect("test", `symlink-${component}`, collectOptions)).manifest.status).toBe("failed");
    expect(await readdir(outside)).toEqual([]);
  });

  it("retains incrementally written EGRKN data as a partial snapshot after a later page fails", async () => {
    const root = await rootWithTerritory();
    const failingCollector = async (options: { onPage?: (items: unknown[]) => Promise<void> | void }) => {
      await options.onPage?.([{ id: 1 }]);
      throw new Error("page two failed");
    };

    const result = await collect("test", "failed-egrkn", {
      root,
      apiKey: "test",
      collectEgrkn: failingCollector as never,
      collectWikidata: emptyWikidata as never,
      collectWikivoyage: emptyWikivoyage as never,
      collectMkrf: emptyMkrf as never,
    });

    const run = join(root, "workspace", "test", "failed-egrkn");
    const manifest = JSON.parse(await readFile(join(run, "manifest.json"), "utf8"));
    expect(result.manifest.status).toBe("failed");
    expect(manifest.sources.egrkn).toMatchObject({
      status: "failed",
      records: 1,
      snapshot: "raw/egrkn.ndjson.partial",
    });
    expect(await readFile(join(run, "raw", "egrkn.ndjson.partial"), "utf8")).toBe('{"id":1}\n');
  });

  it("records the immutable GeoJSON-sequence OSM snapshot path", async () => {
    const root = await rootWithTerritory();
    await mkdir(join(root, "input"));
    await writeFile(join(root, "input", "test.pbf"), "pbf");

    const result = await collect("test", "osm-path", {
      root,
      extractOsmGeoJsonSeq: async (options) => {
        await writeFile(options.output, "feature\n");
        return { output: options.output, command: [] };
      },
      collectWikidata: emptyWikidata as never,
      collectWikivoyage: emptyWikivoyage as never,
      collectMkrf: emptyMkrf as never,
    });

    expect(result.manifest.sources.osm).toMatchObject({
      status: "completed",
      snapshot: "raw/osm.geojsonseq",
    });
    const provenance = JSON.parse(await readFile(join(root, "workspace", "test", "osm-path", "reports", "collection-provenance.json"), "utf8"));
    expect(provenance.inputPbf).toMatchObject({ path: "input/test.pbf", bytes: 3 });
    expect(provenance.inputPbf.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(provenance.snapshots).toContainEqual(expect.objectContaining({ source: "osm", path: "raw/osm.geojsonseq" }));
  });
});
