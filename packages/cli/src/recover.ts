import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  RunManifestSchema,
  loadTerritory,
  readManifest,
  type RunManifest,
  type SourceManifest,
  type Territory,
} from "@poi-toolkit/core";
import { writeSqlExport, type ExportEntity, type SqlExportResult } from "@poi-toolkit/exporters";
import { safeWorkspaceChildPath, workspaceRunDirectory } from "./workspace.js";
import { EGRKN_MANIFEST } from "@poi-toolkit/source-egrkn";
import { MKRF_MANIFEST } from "@poi-toolkit/source-mkrf";
import { OSM_MANIFEST } from "@poi-toolkit/source-osm";
import { WIKIDATA_MANIFEST } from "@poi-toolkit/source-wikidata";
import { WIKIVOYAGE_MANIFEST } from "@poi-toolkit/source-wikivoyage";

/** Canonical source manifests, in the same order the `collect` command records them. */
export const RECOVERED_SOURCE_MANIFESTS: SourceManifest[] = [
  EGRKN_MANIFEST,
  OSM_MANIFEST,
  WIKIDATA_MANIFEST,
  WIKIVOYAGE_MANIFEST,
  MKRF_MANIFEST,
];

export async function hashFile(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return { bytes: (await stat(file)).size, sha256: hash.digest("hex") };
}

/** Deterministic collection-provenance reconstruction from retained run inputs.
 *
 *  Honest by construction: every field is derived from immutable retained
 *  inputs — the territory JSON, the source-manifest constants (unchanged since
 *  before the legacy run was collected), and SHA-256 of the actual raw
 *  snapshot/PBF files. The explicit `recovered` marker makes the
 *  reconstruction visible and cannot be confused with live capture.
 */
export type ReconstructedProvenance = {
  schemaVersion: 1;
  territory: Territory;
  sourceManifests: SourceManifest[];
  inputPbf: { path: string; bytes: number; sha256: string } | null;
  snapshots: Array<{ source: string; path: string; bytes: number; sha256: string }>;
  recovered: { at: string; fromRun: string; note: string };
};

export type ReconstructProvenanceParams = {
  territory: Territory;
  sourceRunDir: string;
  runManifest: RunManifest;
  sourceManifests?: SourceManifest[];
  pbfPath: string | null;
  recoveredAt?: string;
};

export async function reconstructCollectionProvenance(params: ReconstructProvenanceParams): Promise<ReconstructedProvenance> {
  const snapshots: ReconstructedProvenance["snapshots"] = [];
  for (const [source, entry] of Object.entries(params.runManifest.sources)) {
    if (!entry.snapshot) continue;
    const file = await safeWorkspaceChildPath(params.sourceRunDir, ...entry.snapshot.split("/"));
    if (!existsSync(file)) throw new Error(`cannot reconstruct provenance: snapshot missing: ${entry.snapshot}`);
    snapshots.push({ source, path: entry.snapshot, ...(await hashFile(file)) });
  }
  // Deterministic order: collect() iterates manifest.sources insertion order;
  // sorting guarantees byte-identical reconstruction regardless of run-manifest
  // key order.
  snapshots.sort((a, b) => a.source.localeCompare(b.source));
  const inputPbf = params.pbfPath && existsSync(params.pbfPath)
    ? { path: params.territory.osm.pbf, ...(await hashFile(params.pbfPath)) }
    : null;
  return {
    schemaVersion: 1,
    territory: params.territory,
    sourceManifests: params.sourceManifests ?? RECOVERED_SOURCE_MANIFESTS,
    inputPbf,
    snapshots,
    recovered: {
      at: params.recoveredAt ?? new Date().toISOString(),
      fromRun: params.runManifest.runId,
      note: "reconstructed from retained run artifacts (raw snapshots, territory file, source manifests); the legacy run predates collection-provenance capture",
    },
  };
}

export type RecoverReleaseExportOptions = {
  root: string;
  territorySlug: string;
  /** Source legacy run id; its artifacts are only read, never modified. */
  runId: string;
  /** New run-dir id for the v1 bundle (must not already exist). */
  outputRunId: string;
  datasetVersion?: string;
  toolkitVersion: string;
  toolkitRevision: string;
  recoveredAt?: string;
};

export type RecoverReleaseExportResult = {
  sourceRunDir: string;
  outputRunDir: string;
  result: SqlExportResult;
};

/** Recover a v1 import bundle from a legacy run whose collection provenance is empty.
 *
 *  The source run is strictly read-only. A new run dir is created with the
 *  byte-identical release manifest, the (reconstructed or reused) collection
 *  provenance, and a fresh data-only SQL export + strict v1 import manifest.
 */
export async function recoverReleaseExport(options: RecoverReleaseExportOptions): Promise<RecoverReleaseExportResult> {
  const { root, territorySlug, runId, outputRunId } = options;
  const sourceRunDir = await workspaceRunDirectory(root, territorySlug, runId);
  const outputRunDir = await workspaceRunDirectory(root, territorySlug, outputRunId);
  if (!existsSync(sourceRunDir)) throw new Error(`source run not found: ${sourceRunDir}`);
  if (existsSync(outputRunDir)) throw new Error(`output run already exists: ${outputRunDir}`);

  const runManifest = await readManifest(sourceRunDir);
  const hardeningFile = await safeWorkspaceChildPath(sourceRunDir, "reports", "hardening-report.json");
  const releaseManifestFile = await safeWorkspaceChildPath(sourceRunDir, "release", "manifest.json");
  const entitiesFile = await safeWorkspaceChildPath(sourceRunDir, "release", "entities.ndjson");
  for (const file of [hardeningFile, releaseManifestFile, entitiesFile]) {
    if (!existsSync(file)) throw new Error(`source run missing required artifact: ${file}`);
  }
  const hardening = JSON.parse(await readFile(hardeningFile, "utf8")) as { blockingFailures?: unknown };
  if (!Array.isArray(hardening.blockingFailures) || hardening.blockingFailures.length > 0) {
    throw new Error("cannot recover release: hardening-report.json blockingFailures must be empty");
  }

  const territory = await loadTerritory(root, territorySlug);
  const storedProvenanceFile = await safeWorkspaceChildPath(sourceRunDir, "reports", "collection-provenance.json");
  let provenanceBytes: Buffer;
  if (existsSync(storedProvenanceFile)) {
    const stored = JSON.parse(await readFile(storedProvenanceFile, "utf8")) as { sourceManifests?: unknown };
    if (Array.isArray(stored.sourceManifests) && stored.sourceManifests.length > 0) {
      // A valid live-captured provenance wins: reuse it byte-for-byte.
      provenanceBytes = await readFile(storedProvenanceFile);
    } else {
      provenanceBytes = Buffer.from(JSON.stringify(await reconstructCollectionProvenance({
        territory,
        sourceRunDir,
        runManifest,
        pbfPath: resolve(root, territory.osm.pbf),
        recoveredAt: options.recoveredAt,
      }), null, 2) + "\n");
    }
  } else {
    provenanceBytes = Buffer.from(JSON.stringify(await reconstructCollectionProvenance({
      territory,
      sourceRunDir,
      runManifest,
      pbfPath: resolve(root, territory.osm.pbf),
      recoveredAt: options.recoveredAt,
    }), null, 2) + "\n");
  }

  const outputReleaseManifest = await safeWorkspaceChildPath(outputRunDir, "release", "manifest.json");
  const outputProvenance = await safeWorkspaceChildPath(outputRunDir, "reports", "collection-provenance.json");
  await mkdir(await safeWorkspaceChildPath(outputRunDir, "release"), { recursive: true });
  await mkdir(await safeWorkspaceChildPath(outputRunDir, "reports"), { recursive: true });
  await writeFile(outputReleaseManifest, await readFile(releaseManifestFile), { flag: "wx" });
  await writeFile(outputProvenance, provenanceBytes, { flag: "wx" });
  const outputManifest: RunManifest = {
    schemaVersion: 1,
    runId: outputRunId,
    territory: territorySlug,
    status: "releasable",
    startedAt: runManifest.startedAt,
    finishedAt: new Date().toISOString(),
    sources: runManifest.sources,
    diagnostics: [`release artifacts recovered from run ${runId} (legacy run status "${runManifest.status}") via recover-release`],
  };
  RunManifestSchema.parse(outputManifest);
  await writeFile(await safeWorkspaceChildPath(outputRunDir, "manifest.json"), JSON.stringify(outputManifest, null, 2) + "\n", { flag: "wx" });

  const entities = await readNdjsonFile(entitiesFile);
  const result = await writeSqlExport(outputRunDir, entities as ExportEntity[], {
    toolkitVersion: options.toolkitVersion,
    toolkitRevision: options.toolkitRevision,
    datasetVersion: options.datasetVersion ?? outputRunId,
  });
  return { sourceRunDir, outputRunDir, result };
}

async function readNdjsonFile(file: string): Promise<unknown[]> {
  const text = await readFile(file, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
