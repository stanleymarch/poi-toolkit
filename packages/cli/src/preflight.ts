#!/usr/bin/env node
/** Preflight checks — run before pipeline to catch missing deps early. */
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";

const execFileAsync = promisify(execFile);
const root = resolve(process.env.POI_TOOLKIT_ROOT ?? process.cwd());

type Check = { name: string; status: "pass" | "warn" | "fail"; message: string };

async function check(name: string, fn: () => Promise<Check>): Promise<Check> {
  try { return await fn(); }
  catch (error) { return { name, status: "fail", message: error instanceof Error ? error.message : String(error) }; }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function main() {
  const checks: Check[] = [];

  // Node version ≥22
  const nodeVersion = parseInt(process.versions.node.split(".")[0] ?? "0");
  checks.push({ name: "Node.js", status: nodeVersion >= 22 ? "pass" : "fail", message: `v${process.versions.node} ${nodeVersion >= 22 ? "✓" : "✗ requires ≥22"}` });

  // PBF exists (check territory arg)
  const territory = process.argv[2];
  if (territory) {
    const terrPath = join(root, "territories", `${territory}.json`);
    if (await exists(terrPath)) {
      const terr = JSON.parse(await import("node:fs/promises").then(m => m.readFile(terrPath, "utf8")));
      const pbfPath = join(root, terr.osm?.pbf ?? "");
      const pbfExists = await exists(pbfPath);
      checks.push({ name: "PBF file", status: pbfExists ? "pass" : "fail", message: `${terr.osm?.pbf ?? "?"} ${pbfExists ? "✓" : "✗ NOT FOUND at " + pbfPath}` });
    } else {
      checks.push({ name: "Territory config", status: "fail", message: `${territory}.json not found` });
    }
  }

  // osmium-tool (optional if using Docker)
  try {
    await execFileAsync("osmium", ["--version"], { timeout: 5000 });
    checks.push({ name: "osmium-tool", status: "pass", message: "✓ available" });
  } catch {
    checks.push({ name: "osmium-tool", status: "warn", message: "⚠ not found (use Docker if running locally)" });
  }

  // Photon reachable (optional — geocode falls back)
  const photonUrl = process.env.PHOTON_URL ?? "http://localhost:2322";
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    await fetch(`${photonUrl}/api?q=test`, { signal: controller.signal });
    checks.push({ name: "Photon geocoder", status: "pass", message: `✓ ${photonUrl}` });
  } catch {
    checks.push({ name: "Photon geocoder", status: "warn", message: `⚠ ${photonUrl} not reachable (geocode step will fail)` });
  }

  // MKRF_API_KEY
  checks.push({ name: "MKRF_API_KEY", status: process.env.MKRF_API_KEY ? "pass" : "warn", message: process.env.MKRF_API_KEY ? "✓ set" : "⚠ not set (EGRKN/MKRF collection will fail)" });

  // Disk space (check root drive)
  try {
    const { stdout } = await execFileAsync("df", ["-h", root], { timeout: 5000 });
    const lines = stdout.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    const avail = lastLine.split(/\s+/)[3] ?? "?";
    checks.push({ name: "Disk space", status: "pass", message: `${avail} available` });
  } catch {
    checks.push({ name: "Disk space", status: "warn", message: "⚠ could not check" });
  }

  // Print results
  console.log("\n=== POI Toolkit Preflight ===\n");
  let failures = 0, warnings = 0;
  for (const c of checks) {
    const icon = c.status === "pass" ? "✅" : c.status === "warn" ? "⚠️ " : "❌";
    console.log(`  ${icon} ${c.name}: ${c.message}`);
    if (c.status === "fail") failures++;
    if (c.status === "warn") warnings++;
  }
  console.log(`\n${failures} failure(s), ${warnings} warning(s)\n`);
  process.exitCode = failures > 0 ? 1 : 0;
}

main();
