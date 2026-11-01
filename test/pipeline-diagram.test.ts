import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEGAL_TRANSITIONS, GATE_ON_EDGE } from "../src/workflow/states.js";

/**
 * The pipeline diagram is documentation, and documentation drifts.
 *
 * These tests read the HTML and compare it against the state machine: every
 * stage must be drawn, every gate must be named with its real edge, and every
 * backward edge must be one the machine actually allows. A diagram that
 * disagrees with the code is worse than no diagram.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(repo, "docs", "workflow-pipeline.html"), "utf8");

test("every stage in the state machine is drawn", () => {
  const drawn = [...html.matchAll(/code:'([A-Z]+)'/g)].map((m) => m[1]);
  const stages = (Object.keys(LEGAL_TRANSITIONS) as string[]).filter((s) => s !== "BLOCKED");
  assert.equal(drawn.length, stages.length, "one card per stage");
  for (const stage of stages) {
    assert.ok(drawn.includes(stage), `${stage} must appear in the diagram`);
  }
});

test("every gate is shown on the edge the machine assigns it to", () => {
  for (const [edge, gate] of Object.entries(GATE_ON_EDGE)) {
    const [from, to] = edge.split("->");
    // The diagram writes the edge as "from → to" with a real arrow character.
    const pattern = new RegExp(`${gate}:\\s*\\{\\s*edge:'${from} → ${to}'`);
    assert.match(html, pattern, `${gate} must be drawn on ${from} -> ${to}`);
  }
});

test("the diagram draws exactly the backward edges the machine allows", () => {
  const drawn = [...html.matchAll(/\{from:'([A-Z]+)', to:'([A-Z]+)'/g)].map((m) => `${m[1]}->${m[2]}`);
  // Backward edges are the non-forward ones in LEGAL_TRANSITIONS.
  const forward: Record<string, string> = {
    INTAKE: "CLARIFY", CLARIFY: "BASELINE", BASELINE: "SPEC", SPEC: "PLAN",
    PLAN: "DISPATCH", DISPATCH: "IMPLEMENT", IMPLEMENT: "REVIEW", REVIEW: "VERIFY",
    VERIFY: "INTEGRATE", INTEGRATE: "ACCEPT", ACCEPT: "DELIVER", DELIVER: "ARCHIVE",
  };
  const allowed = (Object.keys(LEGAL_TRANSITIONS) as Array<keyof typeof LEGAL_TRANSITIONS>)
    .flatMap((from) =>
      LEGAL_TRANSITIONS[from]
        .filter((to) => to !== "BLOCKED" && to !== forward[from])
        .map((to) => `${from}->${to}`),
    );
  assert.deepEqual(drawn.sort(), allowed.sort(), "drawn backward edges must match the machine");
});

test("every gate check named in the diagram exists in gates.ts", () => {
  const gatesSource = fs.readFileSync(path.join(repo, "src", "workflow", "gates.ts"), "utf8");
  const ids = [...html.matchAll(/\[\s*'([a-z0-9:_-]+)'\s*,/g)]
    .map((m) => m[1]!)
    // g4:* is the diagram's shorthand for "all of G4"; it is not an id.
    .filter((id) => !id.startsWith("g4:"));
  assert.ok(ids.length > 10, "the diagram should list the checks");
  for (const id of ids) {
    assert.ok(gatesSource.includes(id), `check id ${id} is not implemented in gates.ts`);
  }
});
