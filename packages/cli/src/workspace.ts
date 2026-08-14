import { lstat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { asciiIdentifier } from "@poi-toolkit/core";

/** Validate a CLI-controlled workspace path component before it is used. */
export function requireWorkspaceIdentifier(label: string, value: string): void {
  if (typeof value !== "string" || !asciiIdentifier.test(value)) {
    throw new Error(`${label} must be a canonical identifier`);
  }
}

function containedPath(parent: string, children: string[]): string {
  const path = resolve(parent, ...children);
  const pathRelative = relative(parent, path);
  if (!pathRelative || pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || resolve(parent, pathRelative) !== path) {
    throw new Error(`path escapes workspace containment: ${children.join("/")}`);
  }
  return path;
}

async function rejectSymlinkComponent(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`workspace path component must not be a symbolic link: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/**
 * Resolve a contained child and reject a symbolic link at every existing
 * component, including the parent. Call this immediately before workspace I/O;
 * missing components remain valid for commands that create new artifacts.
 */
export async function safeWorkspaceChildPath(parent: string, ...children: string[]): Promise<string> {
  if (!children.length) throw new Error("workspace child path must not be empty");
  const path = containedPath(parent, children);
  await rejectSymlinkComponent(parent);
  const pathRelative = relative(parent, path);
  let componentPath = parent;
  for (const component of pathRelative.split(sep)) {
    componentPath = join(componentPath, component);
    await rejectSymlinkComponent(componentPath);
  }
  return path;
}

/**
 * Resolve a user-selected run after validating its identifiers and checking
 * every workspace component with lstat. Missing components are valid because
 * collection and recovery create new runs, but even dangling symlinks are
 * rejected before callers can perform filesystem I/O through them.
 */
export async function workspaceRunDirectory(root: string, territory: string, runId: string): Promise<string> {
  requireWorkspaceIdentifier("territory", territory);
  requireWorkspaceIdentifier("run id", runId);

  const workspace = await safeWorkspaceChildPath(root, "workspace");
  const territoryPath = await safeWorkspaceChildPath(workspace, territory);
  return safeWorkspaceChildPath(territoryPath, runId);
}
