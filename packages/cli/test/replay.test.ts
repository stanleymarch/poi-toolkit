import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readManifest } from "@poi-toolkit/core";
import { attestLegacyRawRun, replayRawRun } from "../src/replay.js";

const AT = "2026-08-12T10:00:00.000Z";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const snapshot = (source: string, path: string, value: string) => ({ source, path, bytes: Buffer.byteLength(value), sha256: sha(value) });
const sourceManifests = [{
  id: "egrkn", version: "v2", requiredSecrets: ["MKRF_API_KEY"],
  license: { name: "Open Data", url: "https://example.test/license", osmCompatible: "unknown" },
  attribution: "Example", updateMode: "snapshot",
}];

async function completedSource(runId = "source"): Promise<{ root: string; sourceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "replay-"));
  await mkdir(join(root, "territories"), { recursive: true });
  await writeFile(join(root, "territories", "pfo.json"), JSON.stringify({
    slug: "pfo", name: "PFO", egrkn: { region: "PFO" }, osm: { pbf: "input/pfo.pbf", bbox: [1, 2, 3, 4] }, wikidata: { regions: ["Q1"] }, wikivoyage: { pages: ["PFO"] },
  }));
  const sourceDir = join(root, "workspace", "pfo", runId);
  const egrkn = '{"id":1}\n';
  const evidence = '{"fixed":true}\n';
  await mkdir(join(sourceDir, "raw", "nested"), { recursive: true });
  await writeFile(join(sourceDir, "raw", "egrkn.ndjson"), egrkn);
  await writeFile(join(sourceDir, "raw", "nested", "evidence.json"), evidence);
  await mkdir(join(sourceDir, "reports"));
  await writeFile(join(sourceDir, "reports", "collection-provenance.json"), JSON.stringify({
    schemaVersion: 1, sourceManifests, snapshots: [snapshot("egrkn", "raw/egrkn.ndjson", egrkn), snapshot("evidence", "raw/nested/evidence.json", evidence)],
  }, null, 2));
  await writeFile(join(sourceDir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, runId, territory: "pfo", status: "completed", startedAt: AT, finishedAt: AT,
    sources: { egrkn: { status: "completed", records: 1, snapshot: "raw/egrkn.ndjson", error: null } }, diagnostics: [],
  }, null, 2));
  return { root, sourceDir };
}

function replay(root: string, overrides: Partial<{ territorySlug: string; sourceRunId: string; targetRunId: string }> = {}) {
  return replayRawRun({ root, territorySlug: "pfo", sourceRunId: "source", targetRunId: "target", reason: "fix", replayedAt: AT, ...overrides });
}

function attest(root: string, overrides: Partial<{ territorySlug: string; sourceRunId: string; targetRunId: string }> = {}) {
  return attestLegacyRawRun({ root, territorySlug: "pfo", sourceRunId: "pfo-v0.1", targetRunId: "pfo-v0.1-attested", reason: "attest retained legacy raw", attestedAt: AT, ...overrides });
}

describe("attestLegacyRawRun", () => {
  it("copies and hashes pfo-v0.1 raw bytes into a separately marked source run that replay-raw accepts", async () => {
    const { root, sourceDir } = await completedSource("pfo-v0.1");
    const sourceManifest = await readFile(join(sourceDir, "manifest.json"));
    const sourceProvenance = await readFile(join(sourceDir, "reports", "collection-provenance.json"));
    await writeFile(join(sourceDir, "reports", "collection-provenance.json"), JSON.stringify({ schemaVersion: 1, sourceManifests: [], snapshots: [] }) + "\n");
    const { targetRunDir, provenance } = await attest(root);
    expect(provenance.attestation).toMatchObject({ sourceOrigin: "pfo-v0.1", fromRun: "pfo-v0.1", at: AT, legacy: true, reconstructed: true });
    expect(provenance.attestation.rawArtifacts).toContainEqual({ path: "raw/egrkn.ndjson", bytes: 9, sha256: sha('{"id":1}\n') });
    expect(provenance.snapshots).toHaveLength(2);
    expect((await readManifest(targetRunDir)).attestation).toMatchObject({ sourceOrigin: "pfo-v0.1", legacy: true, reconstructed: true });
    await expect(replayRawRun({ root, territorySlug: "pfo", sourceRunId: "pfo-v0.1-attested", targetRunId: "pfo-v0.1-replay", reason: "apply current rules", replayedAt: AT })).resolves.toMatchObject({ targetRunDir: join(root, "workspace", "pfo", "pfo-v0.1-replay") });
    expect(await readFile(join(sourceDir, "manifest.json"))).toEqual(sourceManifest);
    expect(await readFile(join(sourceDir, "reports", "collection-provenance.json"), "utf8")).toContain('"sourceManifests":[]');
    expect(sourceProvenance.toString("utf8")).toContain('"sourceManifests"');
  });

  it("rejects any legacy source other than pfo-v0.1 or a source that already claims provenance", async () => {
    const { root, sourceDir } = await completedSource("pfo-v0.1");
    await expect(attest(root, { sourceRunId: "source" })).rejects.toThrow(/only approved for pfo-v0.1/);
    await expect(attest(root, { territorySlug: "test" })).rejects.toThrow(/only approved for pfo-v0.1/);
    await expect(attest(root)).rejects.toThrow(/provenance must be empty or absent/);
    await writeFile(join(sourceDir, "reports", "collection-provenance.json"), "\n");
    await expect(attest(root, { targetRunId: "pfo-v0.1-attested-empty" })).resolves.toBeDefined();
  });

  it("applies replay's symlink and hardlink protections while attesting", async () => {
    const { root, sourceDir } = await completedSource("pfo-v0.1");
    await writeFile(join(sourceDir, "reports", "collection-provenance.json"), "\n");
    const linked = join(sourceDir, "raw", "nested", "evidence.json");
    await rm(linked);
    try {
      await symlink(join(sourceDir, "raw", "egrkn.ndjson"), linked);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(attest(root)).rejects.toThrow(/symlink/);
  });
});

describe("replayRawRun", () => {
  it("copies only provenance-verified retained bytes and writes their hashes", async () => {
    const { root, sourceDir } = await completedSource();
    const { targetRunDir, provenance } = await replay(root, { targetRunId: "slobodskoy-corrected" });
    const copied = await readFile(join(targetRunDir, "raw", "egrkn.ndjson"));
    expect(copied.toString()).toBe('{"id":1}\n');
    expect(provenance.replay).toMatchObject({ fromRun: "source", at: AT, reason: "fix" });
    expect(provenance).toMatchObject({ schemaVersion: 1, inputPbf: null });
    expect(provenance.sourceManifests.length).toBeGreaterThan(0);
    expect(provenance.snapshots).toContainEqual({ source: "egrkn", path: "raw/egrkn.ndjson", bytes: copied.length, sha256: sha(copied) });
    expect(provenance.replay.rawArtifacts).toContainEqual({ path: "raw/nested/evidence.json", bytes: 15, sha256: sha('{"fixed":true}\n') });
    expect(JSON.parse(await readFile(join(targetRunDir, "reports", "collection-provenance.json"), "utf8")).replay.note).toMatch(/provenance verification/);
    expect((await readManifest(targetRunDir)).replay).toMatchObject({ fromRun: "source", reason: "fix" });
    await writeFile(join(sourceDir, "raw", "egrkn.ndjson"), '{"id":2}\n');
    expect(await readFile(join(targetRunDir, "raw", "egrkn.ndjson"), "utf8")).toBe('{"id":1}\n');
    expect((await stat(join(sourceDir, "raw", "egrkn.ndjson"))).size).toBe(copied.length);
  });

  it("rejects traversal and noncanonical territory/source/target identifiers", async () => {
    const { root } = await completedSource();
    for (const override of [
      { territorySlug: "../pfo" }, { territorySlug: "pfo/.." }, { sourceRunId: "../source" }, { sourceRunId: "source/child" }, { targetRunId: "../target" }, { targetRunId: "target/child" },
    ]) await expect(replay(root, override)).rejects.toThrow(/canonical identifier/);
  });

  it("rejects retained bytes that differ from source collection provenance before copying", async () => {
    const { root, sourceDir } = await completedSource();
    await writeFile(join(sourceDir, "raw", "egrkn.ndjson"), '{"id":2}\n');
    await expect(replay(root)).rejects.toThrow(/does not match collection provenance/);
    await expect(lstat(join(root, "workspace", "pfo", "target"))).rejects.toThrow();
  });

  it("rejects symlinked raw artifacts", async () => {
    const { root, sourceDir } = await completedSource();
    await rm(join(sourceDir, "raw", "nested", "evidence.json"));
    try {
      await symlink(join(sourceDir, "raw", "egrkn.ndjson"), join(sourceDir, "raw", "nested", "evidence.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return; // Windows without symlink privilege.
      throw error;
    }
    await expect(replay(root)).rejects.toThrow(/symlink/);
  });

  it("rejects hardlinked raw artifacts where supported", async () => {
    const { root, sourceDir } = await completedSource();
    const original = join(sourceDir, "raw", "egrkn.ndjson");
    const linked = join(sourceDir, "raw", "nested", "evidence.json");
    await rm(linked);
    try {
      await link(original, linked);
    } catch (error) {
      if (["EPERM", "EOPNOTSUPP", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    expect((await lstat(original)).nlink).toBeGreaterThan(1);
    await expect(replay(root)).rejects.toThrow(/hardlinked/);
  });

  it("rejects a non-completed source, absent provenance, and existing target", async () => {
    const { root, sourceDir } = await completedSource();
    const sourceManifest = JSON.parse(await readFile(join(sourceDir, "manifest.json"), "utf8"));
    sourceManifest.status = "failed";
    await writeFile(join(sourceDir, "manifest.json"), JSON.stringify(sourceManifest));
    await expect(replay(root)).rejects.toThrow(/must be "completed"/);
    sourceManifest.status = "completed";
    await writeFile(join(sourceDir, "manifest.json"), JSON.stringify(sourceManifest));
    await rm(join(sourceDir, "reports", "collection-provenance.json"));
    await expect(replay(root)).rejects.toThrow(/provenance is required/);
    await mkdir(join(root, "workspace", "pfo", "target"), { recursive: true });
    await expect(replay(root)).rejects.toThrow(/target run already exists/);
  });

  it("fails closed when source provenance sourceManifests are missing, empty, or invalid", async () => {
    const cases: Array<{ sourceManifests?: unknown }> = [{}, { sourceManifests: [] }, { sourceManifests: [{ id: "egrkn" }] }];
    for (const provenance of cases) {
      const { root, sourceDir } = await completedSource();
      await writeFile(join(sourceDir, "reports", "collection-provenance.json"), JSON.stringify({
        schemaVersion: 1, ...provenance,
        snapshots: [snapshot("egrkn", "raw/egrkn.ndjson", '{"id":1}\n'), snapshot("evidence", "raw/nested/evidence.json", '{"fixed":true}\n')],
      }));
      await expect(replay(root)).rejects.toThrow(/sourceManifests must be valid and non-empty/);
    }
  });

  it("rejects a territory workspace symlink that escapes the real workspace root", async () => {
    const { root } = await completedSource();
    const territoryDir = join(root, "workspace", "pfo");
    const outside = join(root, "outside-pfo");
    await rename(territoryDir, outside);
    try {
      await symlink(outside, territoryDir, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return; // Windows without symlink privilege.
      throw error;
    }
    await expect(replay(root)).rejects.toThrow(/symbolic link/);
  });
});
