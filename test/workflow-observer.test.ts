import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  changesOutsideAllowed,
  diffSnapshots,
  snapshotWorktree,
} from "../src/workflow/observer.js";

function scratchRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  return dir;
}

test("a snapshot records every tracked file with a content hash", () => {
  const repo = scratchRepo();
  const snap = snapshotWorktree(repo);
  assert.equal(snap.method, "git");
  assert.equal(snap.files.size, 2);
  assert.equal(snap.files.has("a.txt"), true);
  // Two different contents must not collide.
  assert.notEqual(snap.files.get("a.txt"), snap.files.get("b.txt"));
});

test("diffSnapshots reports added, modified and deleted files", () => {
  const repo = scratchRepo();
  const before = snapshotWorktree(repo);

  fs.writeFileSync(path.join(repo, "a.txt"), "one changed\n");
  fs.rmSync(path.join(repo, "b.txt"));
  fs.writeFileSync(path.join(repo, "c.txt"), "three\n");

  const after = snapshotWorktree(repo);
  const changes = diffSnapshots(before, after);
  assert.deepEqual(changes, [
    { path: "a.txt", kind: "modified" },
    { path: "b.txt", kind: "deleted" },
    { path: "c.txt", kind: "added" },
  ]);
});

test("an unchanged worktree produces no changes", () => {
  const repo = scratchRepo();
  assert.deepEqual(diffSnapshots(snapshotWorktree(repo), snapshotWorktree(repo)), []);
});

test("snapshots from different roots are refused rather than compared", () => {
  const a = scratchRepo();
  const b = scratchRepo();
  assert.throws(
    () => diffSnapshots(snapshotWorktree(a), snapshotWorktree(b)),
    /different roots/,
  );
});

test("a non-git directory still snapshots, by walking it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-plain-"));
  fs.writeFileSync(path.join(dir, "x.txt"), "x\n");
  const snap = snapshotWorktree(dir);
  assert.equal(snap.method, "walk");
  assert.equal(snap.files.size, 1);
});

test("ignored directories do not pollute a walked snapshot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-ignore-"));
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "node_modules", "junk.js"), "x\n");
  fs.writeFileSync(path.join(dir, "real.txt"), "real\n");
  const snap = snapshotWorktree(dir);
  assert.equal(snap.files.has("node_modules/junk.js"), false);
  assert.equal(snap.files.has("real.txt"), true);
});

test("changesOutsideAllowed finds a write outside the allowlist", () => {
  const changes = [
    { path: "src/parser.ts", kind: "modified" as const },
    { path: "README.md", kind: "modified" as const },
    { path: "secrets/key.txt", kind: "added" as const },
  ];
  const outside = changesOutsideAllowed(changes, ["src"]);
  assert.deepEqual(outside, [
    { path: "README.md", kind: "modified" },
    { path: "secrets/key.txt", kind: "added" },
  ]);
});

test("a parent allowlist covers its subtree", () => {
  const changes = [{ path: "src/deep/nested/file.ts", kind: "added" as const }];
  assert.deepEqual(changesOutsideAllowed(changes, ["src"]), []);
});

test("an empty allowlist means nothing may be written", () => {
  const changes = [{ path: "src/a.ts", kind: "modified" as const }];
  assert.deepEqual(changesOutsideAllowed(changes, []), changes);
});

test("allowlist matching ignores separators, case and dot segments", () => {
  const changes = [{ path: "Src\\Parser.TS", kind: "modified" as const }];
  assert.deepEqual(changesOutsideAllowed(changes, ["./src"]), []);
});

test("an allowlist entry that is a file, not a directory, does not cover siblings", () => {
  const changes = [{ path: "src/parser.ts", kind: "modified" as const }];
  assert.deepEqual(
    changesOutsideAllowed(changes, ["src/parser.ts"]),
    [],
    "the exact file is covered",
  );
  assert.deepEqual(
    changesOutsideAllowed(changes, ["src/parser.ts.bak"]),
    changes,
    "a different file is not covered",
  );
});

// ---------------------------------------------------------------- 越界形态

test("a deleted file outside the allowlist is still a change", () => {
  const repo = scratchRepo();
  const before = snapshotWorktree(repo);
  fs.rmSync(path.join(repo, "b.txt"));
  const changes = diffSnapshots(before, snapshotWorktree(repo));
  assert.deepEqual(changes, [{ path: "b.txt", kind: "deleted" }]);
  assert.deepEqual(changesOutsideAllowed(changes, ["src"]), changes);
});

test("a deep write outside the allowlist is caught", () => {
  const repo = scratchRepo();
  const before = snapshotWorktree(repo);
  fs.mkdirSync(path.join(repo, "a", "b", "c"), { recursive: true });
  fs.writeFileSync(path.join(repo, "a", "b", "c", "deep.txt"), "x\n");
  const changes = diffSnapshots(before, snapshotWorktree(repo));
  assert.deepEqual(changes, [{ path: "a/b/c/deep.txt", kind: "added" }]);
  assert.deepEqual(changesOutsideAllowed(changes, ["src"]), changes);
});

test("a rename shows up as a delete plus an add", () => {
  const repo = scratchRepo();
  const before = snapshotWorktree(repo);
  fs.renameSync(path.join(repo, "a.txt"), path.join(repo, "renamed.txt"));
  const changes = diffSnapshots(before, snapshotWorktree(repo));
  assert.deepEqual(changes, [
    { path: "a.txt", kind: "deleted" },
    { path: "renamed.txt", kind: "added" },
  ]);
  // Renaming out of an allowlist is still a write outside it.
  assert.equal(changesOutsideAllowed(changes, ["a.txt"]).length, 1);
});

test("a symlink is reported as a symlink, not followed", () => {
  const repo = scratchRepo();
  const before = snapshotWorktree(repo);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "observer-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  try {
    fs.symlinkSync(outside, path.join(repo, "link-to-outside"));
  } catch {
    // Windows may refuse symlinks without developer mode; skip rather than lie.
    return;
  }
  const changes = diffSnapshots(before, snapshotWorktree(repo));
  const link = changes.find((c) => c.path === "link-to-outside");
  assert.ok(link, "the link must appear as a change");
  assert.equal(link?.symlink, true, "the link must be flagged as a symlink");
  // A symlink whose own path is outside the allowlist is outside.
  assert.deepEqual(changesOutsideAllowed(changes, ["src"]), changes);
});

test("a symlink inside an allowlist is flagged so a caller can still reject it", () => {
  const repo = scratchRepo();
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "real.txt"), "real\n");
  const before = snapshotWorktree(repo);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "observer-outside2-"));
  try {
    fs.symlinkSync(outside, path.join(repo, "src", "escape"));
  } catch {
    return;
  }
  const changes = diffSnapshots(before, snapshotWorktree(repo));
  const link = changes.find((c) => c.path === "src/escape");
  assert.ok(link);
  assert.equal(link?.symlink, true);
  // Path-wise it is inside src/, so containment alone would pass it. The
  // symlink flag is what lets a gate refuse it anyway.
  assert.deepEqual(changesOutsideAllowed(changes, ["src"]), []);
});
