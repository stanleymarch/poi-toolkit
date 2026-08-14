import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("../../../scripts/atomic-deploy.sh", import.meta.url));

describe("legacy atomic deploy compatibility stub", () => {
  it("fails before touching its artifact argument and directs operators to Nearventure", async () => {
    const root = await mkdtemp(join(tmpdir(), "atomic-deploy-"));
    const artifact = join(root, "artifact.sql");
    const contents = "must remain untouched\n";
    try {
      await writeFile(artifact, contents);

      let failure: { code?: number; stderr?: string } | undefined;
      try {
        await execFileAsync("bash", [script, artifact]);
      } catch (error) {
        failure = error as { code?: number; stderr?: string };
      }

      expect(failure?.code).toBe(64);
      expect(failure?.stderr).toContain("permanently disabled");
      expect(failure?.stderr).toContain("Nearventure's manifest-validated importer handoff");
      expect(await readFile(artifact, "utf8")).toBe(contents);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
