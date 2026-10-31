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
