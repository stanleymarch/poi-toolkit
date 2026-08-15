import { mkdtemp, mkdir, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceRunDirectory } from "../src/workspace.js";

describe("CLI workspace run containment", () => {
  it("rejects invalid territory and run identifiers before resolving a path", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-paths-"));
    for (const [territory, runId] of [["", "run"], ["../outside", "run"], ["test/run", "run"], ["test", "../outside"], ["test", "/tmp/outside"], ["test", "run\\outside"]]) {
      await expect(workspaceRunDirectory(root, territory, runId)).rejects.toThrow(/canonical identifier/);
    }
  });

  it("allows a new run directory to be created when all workspace components are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-paths-"));
    const runDirectory = await workspaceRunDirectory(root, "test", "new-run");
    await mkdir(join(runDirectory, "release"), { recursive: true });
    expect(await readdir(runDirectory)).toEqual(["release"]);
  });

  it("rejects a territory symlink escape without touching its outside target", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-paths-"));
    const workspace = join(root, "workspace");
    const danglingTarget = join(root, "outside", "territory");
    await mkdir(workspace);
    await mkdir(join(root, "outside"));
    try {
      await symlink(danglingTarget, join(workspace, "test"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    await expect(workspaceRunDirectory(root, "test", "release-run")).rejects.toThrow(/symbolic link/);
    expect(await readdir(join(root, "outside"))).toEqual([]);
  });

  it("rejects a dangling run symlink before release/recovery callers can use it", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-paths-"));
    const territory = join(root, "workspace", "test");
    const outside = join(root, "outside-run");
    await mkdir(territory, { recursive: true });
    await mkdir(outside);
    try {
      await symlink(join(outside, "legacy-run"), join(territory, "legacy-run"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    await expect(workspaceRunDirectory(root, "test", "legacy-run")).rejects.toThrow(/symbolic link/);
    expect(await readdir(outside)).toEqual([]);
  });
});
