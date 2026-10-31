import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

/**
 * An independent record of what a worktree looked like. The point is to
 * observe file changes without asking the agent what it did, because an
 * agent's own report is a claim and claims are what gates exist to check.
 */
export interface WorktreeSnapshot {
  /** Absolute repo root this snapshot belongs to. */
  root: string;
  /** repo-relative path -> content fingerprint. */
  files: Map<string, string>;
  /** How the snapshot was taken, so the caller knows its fidelity. */
  method: "git" | "walk";
  /** Paths that are symlinks, keyed by repo-relative path. */
  symlinks?: Map<string, boolean>;
}

export interface ObservedChange {
  /** repo-relative path */
  path: string;
  kind: "added" | "modified" | "deleted";
  /**
   * Set when the path is a symlink. A symlink is reported separately because
   * writing through one can reach outside the worktree even when its own path
   * sits inside the allowlist.
   */
  symlink?: boolean;
}

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
]);

function hashFile(absolute: string): string {
  const buffer = fs.readFileSync(absolute);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Fingerprint a path. Symlinks are recorded by their target string, not by
 * following it: following would hash the target's content and hide the fact
 * that a link was created.
 */
function fingerprint(absolute: string): { hash: string; symlink: boolean } | undefined {
  try {
    const link = fs.lstatSync(absolute);
    if (link.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      return { hash: `symlink:${target}`, symlink: true };
    }
    if (!link.isFile()) return undefined;
    return { hash: hashFile(absolute), symlink: false };
  } catch {
    return undefined;
  }
}

/** Recursively collect repo-relative paths and their content hashes. */
function walkFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        visit(absolute);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const print = fingerprint(absolute);
      if (!print) continue;
      out.set(path.relative(root, absolute).replace(/\\/g, "/"), print.hash);
    }
  };
  visit(root);
  return out;
}

/** Repo-relative symlink paths, collected separately from file content. */
function walkLinks(root: string): Map<string, boolean> {
  const links = new Map<string, boolean>();
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        links.set(path.relative(root, absolute).replace(/\\/g, "/"), true);
        continue;
      }
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) visit(absolute);
    }
  };
  visit(root);
  return links;
}

/**
 * Snapshot a worktree. Git is used when the directory is a repository because
 * it already knows what is tracked and what is ignored; otherwise every file
 * is hashed.
 */
export function snapshotWorktree(root: string): WorktreeSnapshot {
  const resolved = fs.realpathSync(root);
  const gitDir = path.join(resolved, ".git");

  if (fs.existsSync(gitDir)) {
    try {
      // List every path git knows about, tracked or untracked but not ignored.
      const listed = execFileSync(
        "git",
        ["-C", resolved, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
      );
      const files = new Map<string, string>();
      const links = new Map<string, boolean>();
      for (const relative of listed.split("\u0000")) {
        if (!relative) continue;
        const absolute = path.join(resolved, relative);
        if (!fs.existsSync(absolute)) continue;
        const print = fingerprint(absolute);
        if (!print) continue;
        const key = relative.replace(/\\/g, "/");
        files.set(key, print.hash);
        if (print.symlink) links.set(key, true);
      }
      return { root: resolved, files, method: "git", symlinks: links };
    } catch {
      // Fall through to the walk when git is unavailable or the repo is odd.
    }
  }

  return { root: resolved, files: walkFiles(resolved), method: "walk", symlinks: walkLinks(resolved) };
}

/**
 * Compare two snapshots of the same worktree. Paths are repo-relative in the
 * result, so a caller can compare them against an envelope's allowlist without
 * knowing how the snapshot was taken.
 */
export function diffSnapshots(before: WorktreeSnapshot, after: WorktreeSnapshot): ObservedChange[] {
  if (before.root !== after.root) {
    throw new Error(`snapshots are from different roots: ${before.root} vs ${after.root}`);
  }
  const changes: ObservedChange[] = [];
  const isLink = (file: string): boolean => after.symlinks?.get(file) === true;
  for (const [file, hash] of after.files) {
    const previous = before.files.get(file);
    const link = isLink(file);
    if (previous === undefined) changes.push({ path: file, kind: "added", ...(link ? { symlink: true } : {}) });
    else if (previous !== hash) changes.push({ path: file, kind: "modified", ...(link ? { symlink: true } : {}) });
  }
  for (const file of before.files.keys()) {
    if (!after.files.has(file)) changes.push({ path: file, kind: "deleted" });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

/**
 * Which observed changes fall outside an allowlist. Uses the same containment
 * rule as the protocol: a declared path covers itself and everything under it.
 */
export function changesOutsideAllowed(
  changes: ObservedChange[],
  allowedPaths: string[],
): ObservedChange[] {
  const normalize = (value: string): string =>
    value
      .replace(/\\/g, "/")
      .trim()
      .split("/")
      .filter((p) => p !== "" && p !== ".")
      .join("/")
      .toLowerCase();

  const allowed = allowedPaths.map(normalize).filter(Boolean);
  if (allowed.length === 0) return changes;

  return changes.filter((change) => {
    const file = normalize(change.path);
    return !allowed.some((a) => file === a || file.startsWith(`${a}/`));
  });
}
