import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectAgents, readBindings, writeBindings, agentForRole, ROLES } from "../src/workflow/agents.js";

/**
 * Agent selection and role assignment.
 *
 * The pipeline has six capability slots. This module decides which installed
 * agent fills each one. The tests pin the two behaviours the panel depends on:
 * probing never claims an agent it did not find, and an unassigned role falls
 * back to Codex so a fresh install needs no configuration.
 */

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agents-"));
}

test("detection reports every known agent, with a reason when unavailable", () => {
  const agents = detectAgents();
  assert.equal(agents.length, 4, "all four agents are listed");
  for (const agent of agents) {
    assert.equal(typeof agent.available, "boolean");
    if (!agent.available) {
      assert.ok(agent.reason.length > 0, `${agent.id} must say why it is unavailable`);
    }
    if (agent.binary) {
      assert.ok(fs.existsSync(agent.binary), `${agent.id} binary path must exist`);
    }
  }
  // Codex is the executor this project was built around; it must be found.
  const codex = agents.find((a) => a.id === "codex");
  assert.ok(codex, "codex is listed");
  assert.equal(codex!.available, true, "codex should be installed on this machine");
});

test("an unassigned role falls back to codex", () => {
  assert.equal(agentForRole({}, "developer"), "codex");
  assert.equal(agentForRole({ developer: "claude" }, "developer"), "claude");
  assert.equal(agentForRole({ developer: "claude" }, "reviewer"), "codex");
});

test("bindings round-trip through the state directory", () => {
  const dir = scratch();
  try {
    const saved = writeBindings(dir, { developer: "codex", reviewer: "claude" });
    assert.deepEqual(saved, { developer: "codex", reviewer: "claude" });
    assert.deepEqual(readBindings(dir), { developer: "codex", reviewer: "claude" });
    // Writing again replaces the file rather than merging stale roles.
    writeBindings(dir, { tester: "codex" });
    assert.deepEqual(readBindings(dir), { tester: "codex" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown agent id is refused instead of stored", () => {
  const dir = scratch();
  try {
    assert.throws(
      () => writeBindings(dir, { developer: "gpt-9000" }),
      /不认识/,
      "a role cannot point at an agent that does not exist",
    );
    assert.deepEqual(readBindings(dir), {}, "nothing was written");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing bindings file reads as empty", () => {
  const dir = scratch();
  try {
    assert.deepEqual(readBindings(dir), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty strings clear a role instead of binding it", () => {
  const dir = scratch();
  try {
    writeBindings(dir, { developer: "" });
    assert.deepEqual(readBindings(dir), {});
    for (const role of ROLES) {
      assert.equal(agentForRole(readBindings(dir), role), "codex");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
