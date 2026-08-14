import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RunManifestSchema, SourceManifestSchema, loadTerritory, readManifest, type RunManifest, type SourceManifest, type Territory } from "@poi-toolkit/core";
import { EGRKN_MANIFEST } from "@poi-toolkit/source-egrkn";
import { MKRF_MANIFEST } from "@poi-toolkit/source-mkrf";
import { OSM_MANIFEST } from "@poi-toolkit/source-osm";
import { WIKIDATA_MANIFEST } from "@poi-toolkit/source-wikidata";
import { WIKIVOYAGE_MANIFEST } from "@poi-toolkit/source-wikivoyage";
import { safeWorkspaceChildPath, workspaceRunDirectory } from "./workspace.js";

export type ReplayRawOptions = {
  root: string;
  territorySlug: string;
  sourceRunId: string;
  targetRunId: string;
  reason: string;
  replayedAt?: string;
};

export type AttestLegacyRawOptions = {
  root: string;
  territorySlug: string;
  sourceRunId: string;
  targetRunId: string;
  reason: string;
  attestedAt?: string;
};

type RawArtifact = { path: string; bytes: number; sha256: string };
type SourceArtifact = RawArtifact & { source: string };
type FileIdentity = Pick<Stats, "dev" | "ino" | "mode" | "nlink" | "size" | "mtimeMs" | "ctimeMs">;

type ReplayCollectionProvenance = {
  schemaVersion: 1;
  territory: Territory;
  sourceManifests: SourceManifest[];
  inputPbf: null;
  snapshots: SourceArtifact[];
  replay: { fromRun: string; at: string; reason: string; note: string; rawArtifacts: RawArtifact[] };
};

type AttestedCollectionProvenance = {
  schemaVersion: 1;
  territory: Territory;
  sourceManifests: SourceManifest[];
  inputPbf: null;
  snapshots: SourceArtifact[];
  attestation: { sourceOrigin: "pfo-v0.1"; fromRun: string; at: string; reason: string; legacy: true; reconstructed: true; note: string; rawArtifacts: RawArtifact[] };
};

function canonicalRawPath(path: string): boolean {
  return /^raw\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(path)
    && !path.includes("\\")
    && !path.split("/").includes("..");
}

function rawRelativePath(rawDir: string, file: string): string {
  const path = relative(rawDir, file);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || path.split(sep).includes("..")) throw new Error(`raw artifact escapes source raw directory: ${file}`);
  const rawPath = `raw/${path.split(sep).join("/")}`;
  if (!canonicalRawPath(rawPath)) throw new Error(`raw artifact path is not canonical: ${rawPath}`);
  return rawPath;
}

function fileIdentity(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino, mode: stats.mode, nlink: stats.nlink, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function requireStableRegularFile(path: string, stats: Stats): FileIdentity {
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`raw artifact must be a regular file, not a symlink or special file: ${path}`);
  if (stats.nlink > 1) throw new Error(`raw artifact must not be hardlinked: ${path}`);
  return fileIdentity(stats);
}

async function stableHashFile(file: string): Promise<RawArtifact> {
  const before = requireStableRegularFile(file, await lstat(file));
  const handle = await open(file, "r");
  try {
    if (!sameFileIdentity(before, requireStableRegularFile(file, await handle.stat()))) throw new Error(`raw artifact changed before it could be read: ${file}`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    if (!sameFileIdentity(before, requireStableRegularFile(file, await handle.stat()))) throw new Error(`raw artifact changed while it was read: ${file}`);
    if (!sameFileIdentity(before, requireStableRegularFile(file, await lstat(file)))) throw new Error(`raw artifact changed while it was read: ${file}`);
    return { path: "", bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function copyVerifiedRegularFile(source: string, target: string, expected: RawArtifact): Promise<void> {
  const before = requireStableRegularFile(source, await lstat(source));
  const handle = await open(source, "r");
  try {
    if (!sameFileIdentity(before, requireStableRegularFile(source, await handle.stat()))) throw new Error(`raw artifact changed before it could be copied: ${source}`);
    await mkdir(resolve(target, ".."), { recursive: true });
    const sourceHash = createHash("sha256");
    const hashingStream = new Transform({ transform(chunk, _encoding, callback) { sourceHash.update(chunk); callback(null, chunk); } });
    await pipeline(handle.createReadStream({ autoClose: false }), hashingStream, createWriteStream(target, { flags: "wx" }));
    if (!sameFileIdentity(before, requireStableRegularFile(source, await handle.stat()))) throw new Error(`raw artifact changed while it was copied: ${source}`);
    if (!sameFileIdentity(before, requireStableRegularFile(source, await lstat(source)))) throw new Error(`raw artifact changed while it was copied: ${source}`);
    const copied = await stableHashFile(target);
    const sourceSha256 = sourceHash.digest("hex");
    if (sourceSha256 !== expected.sha256 || copied.sha256 !== expected.sha256 || copied.bytes !== expected.bytes) {
      throw new Error(`copied raw artifact does not match source provenance: ${source}`);
    }
  } finally {
    await handle.close();
  }
}

async function listRawArtifacts(rawDir: string): Promise<Array<{ source: string; path: string }>> {
  const files: Array<{ source: string; path: string }> = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const source = join(dir, entry.name);
      if (entry.isDirectory()) {
        const directoryStats = await lstat(source);
        if (directoryStats.isSymbolicLink()) throw new Error(`raw artifact directory must not be a symlink: ${source}`);
        await visit(source);
      } else if (entry.isFile()) {
        requireStableRegularFile(source, await lstat(source));
        files.push({ source, path: rawRelativePath(rawDir, source) });
      } else {
        throw new Error(`raw artifact must be a regular file, not a symlink or special file: ${source}`);
      }
    }
  }
  await visit(rawDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function sourceProvenanceFrom(sourceRunDir: string): Promise<{ sourceManifests: SourceManifest[]; snapshots: SourceArtifact[] }> {
  let provenance: unknown;
  try {
    provenance = JSON.parse(await readFile(await safeWorkspaceChildPath(sourceRunDir, "reports", "collection-provenance.json"), "utf8"));
  } catch {
    throw new Error("source run collection provenance is required for replay");
  }
  if (!provenance || typeof provenance !== "object") throw new Error("source run collection provenance is invalid");
  const value = provenance as { sourceManifests?: unknown; snapshots?: unknown };
  if (!Array.isArray(value.snapshots)) throw new Error("source run collection provenance snapshots are required for replay");
  const snapshots = value.snapshots.map((snapshot): SourceArtifact => {
    if (!snapshot || typeof snapshot !== "object") throw new Error("source run collection provenance snapshot is invalid");
    const candidate = snapshot as Partial<SourceArtifact>;
    if (typeof candidate.source !== "string" || !candidate.source || typeof candidate.path !== "string" || !canonicalRawPath(candidate.path)
      || typeof candidate.bytes !== "number" || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0 || typeof candidate.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(candidate.sha256)) {
      throw new Error("source run collection provenance snapshot is invalid");
    }
    return { source: candidate.source!, path: candidate.path!, bytes: candidate.bytes!, sha256: candidate.sha256! };
  });
  if (new Set(snapshots.map((snapshot) => snapshot.path)).size !== snapshots.length) throw new Error("source run collection provenance has duplicate snapshot paths");
  const parsedManifests = SourceManifestSchema.array().safeParse(value.sourceManifests);
  if (!parsedManifests.success || !parsedManifests.data.length) {
    throw new Error("source run collection provenance sourceManifests must be valid and non-empty for replay");
  }
  return { sourceManifests: parsedManifests.data, snapshots };
}

function legacySourceManifests(): SourceManifest[] {
  return [EGRKN_MANIFEST, OSM_MANIFEST, WIKIDATA_MANIFEST, WIKIVOYAGE_MANIFEST, MKRF_MANIFEST];
}

async function requireEmptyLegacyProvenance(sourceRunDir: string): Promise<void> {
  const provenanceFile = await safeWorkspaceChildPath(sourceRunDir, "reports", "collection-provenance.json");
  let text: string;
  try { text = await readFile(provenanceFile, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!text.trim()) return;
  let provenance: unknown;
  try { provenance = JSON.parse(text); } catch { throw new Error("legacy source collection provenance must be empty or absent"); }
  if (!provenance || typeof provenance !== "object" || !Array.isArray((provenance as { sourceManifests?: unknown }).sourceManifests)
    || (provenance as { sourceManifests: unknown[] }).sourceManifests.length !== 0
    || !Array.isArray((provenance as { snapshots?: unknown }).snapshots)
    || (provenance as { snapshots: unknown[] }).snapshots.length !== 0) {
    throw new Error("legacy source collection provenance must be empty or absent");
  }
}

function ensureProvenanceMatchesRawArtifacts(artifacts: Array<{ path: string }>, snapshots: SourceArtifact[]): Map<string, RawArtifact> {
  const expected = new Map(snapshots.map((snapshot) => [snapshot.path, { path: snapshot.path, bytes: snapshot.bytes, sha256: snapshot.sha256 }]));
  if (expected.size !== artifacts.length || artifacts.some((artifact) => !expected.has(artifact.path))) {
    throw new Error("source retained raw artifacts do not exactly match collection provenance snapshots");
  }
  return expected;
}

function ensureDeclaredSnapshotsAreCopied(manifest: RunManifest, copiedPaths: Set<string>): void {
  for (const [source, entry] of Object.entries(manifest.sources)) {
    if (entry.snapshot && (!canonicalRawPath(entry.snapshot) || !copiedPaths.has(entry.snapshot))) throw new Error(`source run snapshot is not a retained raw artifact: ${source}: ${entry.snapshot}`);
  }
}

/**
 * Attests the retained bytes of the one approved provenance-less legacy source.
 * The source is read-only; this never backfills its empty provenance.
 */
export async function attestLegacyRawRun(options: AttestLegacyRawOptions): Promise<{ sourceRunDir: string; targetRunDir: string; provenance: AttestedCollectionProvenance }> {
  if (!options.reason.trim()) throw new Error("--reason must be non-empty");
  if (options.territorySlug !== "pfo" || options.sourceRunId !== "pfo-v0.1") throw new Error("legacy raw attestation is only approved for pfo-v0.1 in territory pfo");
  if (options.sourceRunId === options.targetRunId) throw new Error("source and target run ids must differ");
  const sourceRunDir = await workspaceRunDirectory(options.root, options.territorySlug, options.sourceRunId);
  const targetRunDir = await workspaceRunDirectory(options.root, options.territorySlug, options.targetRunId);
  const territoryDir = dirname(sourceRunDir);
  if (!existsSync(sourceRunDir)) throw new Error(`source run not found: ${sourceRunDir}`);
  if (existsSync(targetRunDir)) throw new Error(`target run already exists: ${targetRunDir}`);
  const sourceRunStats = await lstat(sourceRunDir);
  if (!sourceRunStats.isDirectory() || sourceRunStats.isSymbolicLink()) throw new Error(`source run path must be a directory: ${sourceRunDir}`);

  const [territory, sourceManifest] = await Promise.all([loadTerritory(options.root, options.territorySlug), readManifest(sourceRunDir)]);
  if (territory.slug !== options.territorySlug) throw new Error(`territory definition slug is ${JSON.stringify(territory.slug)}, expected ${JSON.stringify(options.territorySlug)}`);
  if (sourceManifest.status !== "completed") throw new Error(`source run status is ${JSON.stringify(sourceManifest.status)}, must be "completed"`);
  if (sourceManifest.territory !== options.territorySlug) throw new Error(`source run territory is ${JSON.stringify(sourceManifest.territory)}, expected ${JSON.stringify(options.territorySlug)}`);
  if (sourceManifest.runId !== options.sourceRunId) throw new Error(`source manifest run id is ${JSON.stringify(sourceManifest.runId)}, expected ${JSON.stringify(options.sourceRunId)}`);
  await requireEmptyLegacyProvenance(sourceRunDir);
  const sourceRawDir = await safeWorkspaceChildPath(sourceRunDir, "raw");
  let rawStat: Stats;
  try { rawStat = await lstat(sourceRawDir); } catch { throw new Error(`source run raw directory not found: ${sourceRawDir}`); }
  if (!rawStat.isDirectory() || rawStat.isSymbolicLink()) throw new Error(`source run raw path must be a directory: ${sourceRawDir}`);
  const artifacts = await listRawArtifacts(sourceRawDir);
  if (!artifacts.length) throw new Error("source run has no retained raw artifacts");
  const rawArtifacts: RawArtifact[] = [];
  for (const artifact of artifacts) {
    const actual = await stableHashFile(artifact.source);
    rawArtifacts.push({ path: artifact.path, bytes: actual.bytes, sha256: actual.sha256 });
  }
  const expectedArtifacts = new Map(rawArtifacts.map((artifact) => [artifact.path, artifact]));
  ensureDeclaredSnapshotsAreCopied(sourceManifest, new Set(expectedArtifacts.keys()));
  const stageDir = await safeWorkspaceChildPath(territoryDir, `.${basename(targetRunDir)}.attestation-${randomUUID()}`);
  try {
    await mkdir(await safeWorkspaceChildPath(stageDir, "raw"), { recursive: true });
    for (const artifact of artifacts) await copyVerifiedRegularFile(artifact.source, await safeWorkspaceChildPath(stageDir, ...artifact.path.split("/")), expectedArtifacts.get(artifact.path)!);
    const sourceBySnapshot = new Map(Object.entries(sourceManifest.sources).flatMap(([source, entry]) => entry.snapshot ? [[entry.snapshot, source] as const] : []));
    const snapshots = rawArtifacts.map((artifact) => ({ source: sourceBySnapshot.get(artifact.path) ?? `retained:${artifact.path}`, ...artifact }));
    const attestedAt = options.attestedAt ?? new Date().toISOString();
    const provenance: AttestedCollectionProvenance = {
      schemaVersion: 1, territory, sourceManifests: legacySourceManifests(), inputPbf: null, snapshots,
      attestation: {
        sourceOrigin: "pfo-v0.1", fromRun: options.sourceRunId, at: attestedAt, reason: options.reason, legacy: true, reconstructed: true, rawArtifacts,
        note: "legacy provenance reconstructed from retained raw bytes after SHA-256 verification; this is not a fresh collection and does not alter pfo-v0.1",
      },
    };
    await mkdir(await safeWorkspaceChildPath(stageDir, "reports"), { recursive: true });
    await writeFile(await safeWorkspaceChildPath(stageDir, "reports", "collection-provenance.json"), JSON.stringify(provenance, null, 2) + "\n", { flag: "wx" });
    const targetManifest: RunManifest = {
      schemaVersion: 1, runId: options.targetRunId, territory: options.territorySlug, status: "completed", startedAt: attestedAt, finishedAt: attestedAt,
      sources: sourceManifest.sources, diagnostics: ["legacy raw provenance attested from pfo-v0.1; no collection or network access occurred"],
      attestation: { sourceOrigin: "pfo-v0.1", at: attestedAt, reason: options.reason, legacy: true, reconstructed: true },
    };
    RunManifestSchema.parse(targetManifest);
    await writeFile(await safeWorkspaceChildPath(stageDir, "manifest.json"), JSON.stringify(targetManifest, null, 2) + "\n", { flag: "wx" });
    await rename(stageDir, targetRunDir);
    return { sourceRunDir, targetRunDir, provenance };
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true });
    throw error;
  }
}

/** Creates a distinct run from retained, provenance-verified raw bytes only. */
export async function replayRawRun(options: ReplayRawOptions): Promise<{ sourceRunDir: string; targetRunDir: string; provenance: ReplayCollectionProvenance }> {
  if (!options.reason.trim()) throw new Error("--reason must be non-empty");
  if (options.sourceRunId === options.targetRunId) throw new Error("source and target run ids must differ");
  const sourceRunDir = await workspaceRunDirectory(options.root, options.territorySlug, options.sourceRunId);
  const targetRunDir = await workspaceRunDirectory(options.root, options.territorySlug, options.targetRunId);
  const territoryDir = dirname(sourceRunDir);
  if (!existsSync(sourceRunDir)) throw new Error(`source run not found: ${sourceRunDir}`);
  if (existsSync(targetRunDir)) throw new Error(`target run already exists: ${targetRunDir}`);
  const sourceRunStats = await lstat(sourceRunDir);
  if (!sourceRunStats.isDirectory() || sourceRunStats.isSymbolicLink()) throw new Error(`source run path must be a directory: ${sourceRunDir}`);

  const [territory, sourceManifest, sourceProvenance] = await Promise.all([
    loadTerritory(options.root, options.territorySlug),
    readManifest(sourceRunDir),
    sourceProvenanceFrom(sourceRunDir),
  ]);
  if (territory.slug !== options.territorySlug) throw new Error(`territory definition slug is ${JSON.stringify(territory.slug)}, expected ${JSON.stringify(options.territorySlug)}`);
  if (sourceManifest.status !== "completed") throw new Error(`source run status is ${JSON.stringify(sourceManifest.status)}, must be "completed"`);
  if (sourceManifest.territory !== options.territorySlug) throw new Error(`source run territory is ${JSON.stringify(sourceManifest.territory)}, expected ${JSON.stringify(options.territorySlug)}`);
  if (sourceManifest.runId !== options.sourceRunId) throw new Error(`source manifest run id is ${JSON.stringify(sourceManifest.runId)}, expected ${JSON.stringify(options.sourceRunId)}`);

  const sourceRawDir = await safeWorkspaceChildPath(sourceRunDir, "raw");
  let rawStat: Stats;
  try { rawStat = await lstat(sourceRawDir); } catch { throw new Error(`source run raw directory not found: ${sourceRawDir}`); }
  if (!rawStat.isDirectory() || rawStat.isSymbolicLink()) throw new Error(`source run raw path must be a directory: ${sourceRawDir}`);
  const artifacts = await listRawArtifacts(sourceRawDir);
  if (!artifacts.length) throw new Error("source run has no retained raw artifacts");
  const expectedArtifacts = ensureProvenanceMatchesRawArtifacts(artifacts, sourceProvenance.snapshots);
  ensureDeclaredSnapshotsAreCopied(sourceManifest, new Set(artifacts.map((artifact) => artifact.path)));

  // Hash every source file before creating a target. This fails closed if its retained
  // bytes no longer match the source run's collection provenance.
  for (const artifact of artifacts) {
    const expected = expectedArtifacts.get(artifact.path)!;
    const actual = await stableHashFile(artifact.source);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`source raw artifact does not match collection provenance: ${artifact.path}`);
  }

  const stageDir = await safeWorkspaceChildPath(territoryDir, `.${basename(targetRunDir)}.replay-${randomUUID()}`);
  try {
    await mkdir(await safeWorkspaceChildPath(stageDir, "raw"), { recursive: true });
    const rawArtifacts: RawArtifact[] = [];
    for (const artifact of artifacts) {
      const expected = expectedArtifacts.get(artifact.path)!;
      const target = await safeWorkspaceChildPath(stageDir, ...artifact.path.split("/"));
      await copyVerifiedRegularFile(artifact.source, target, expected);
      rawArtifacts.push(expected);
    }
    const snapshots = Object.entries(sourceManifest.sources)
      .filter(([, entry]) => entry.snapshot)
      .map(([source, entry]) => {
        const raw = expectedArtifacts.get(entry.snapshot!);
        if (!raw) throw new Error(`source run snapshot is not a retained raw artifact: ${source}: ${entry.snapshot}`);
        return { source, ...raw };
      })
      .sort((a, b) => a.source.localeCompare(b.source));
    const replayedAt = options.replayedAt ?? new Date().toISOString();
    const provenance: ReplayCollectionProvenance = {
      schemaVersion: 1, territory, sourceManifests: sourceProvenance.sourceManifests, inputPbf: null, snapshots,
      replay: {
        fromRun: options.sourceRunId, at: replayedAt, reason: options.reason,
        note: "raw artifacts copied from a completed source run after source provenance verification; this is a replay, not a fresh collection",
        rawArtifacts,
      },
    };
    await mkdir(await safeWorkspaceChildPath(stageDir, "reports"), { recursive: true });
    await writeFile(await safeWorkspaceChildPath(stageDir, "reports", "collection-provenance.json"), JSON.stringify(provenance, null, 2) + "\n", { flag: "wx" });
    const targetManifest: RunManifest = {
      schemaVersion: 1, runId: options.targetRunId, territory: options.territorySlug, status: "completed", startedAt: replayedAt, finishedAt: replayedAt,
      sources: sourceManifest.sources, diagnostics: [`raw artifacts replayed from run ${options.sourceRunId}; no collection or network access occurred`],
      replay: { fromRun: options.sourceRunId, at: replayedAt, reason: options.reason },
    };
    RunManifestSchema.parse(targetManifest);
    await writeFile(await safeWorkspaceChildPath(stageDir, "manifest.json"), JSON.stringify(targetManifest, null, 2) + "\n", { flag: "wx" });
    await rename(stageDir, targetRunDir);
    return { sourceRunDir, targetRunDir, provenance };
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true });
    throw error;
  }
}
