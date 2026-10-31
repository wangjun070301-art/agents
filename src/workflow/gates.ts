import type {
  AcceptanceCriterion,
  Gate,
  Requirements,
  TaskEnvelope,
  TaskResult,
} from "./contracts.js";
import {
  claimIsSupported,
  validateEnvelopeAgainstRequirements,
  validateTaskResult,
} from "./contracts.js";

/** One thing a gate looked at, and whether it was satisfied. */
export interface GateCheck {
  id: string;
  passed: boolean;
  detail: string;
}

/**
 * A gate verdict. `passed` is true only when every check passed. `blocking`
 * lists the checks that failed, so a caller can report the reason without
 * re-deriving it.
 */
export interface GateVerdict {
  gate: Gate;
  passed: boolean;
  checks: GateCheck[];
  blocking: string[];
}

/**
 * Everything a gate is allowed to look at. Gates never invent evidence: if a
 * field is absent, the corresponding check fails rather than being skipped.
 */
export interface GateInput {
  /** The task being dispatched or reviewed, when there is one. */
  envelope?: TaskEnvelope;
  /** What the developer reported, when there is one. */
  result?: TaskResult;
  /** The requirement set the project is working against. */
  requirements?: Requirements;
  /** Human-recorded gate passes, used only where a gate is inherently manual. */
  recorded?: Partial<Record<Gate, { by: string; at: string; note: string }>>;
  /** Files changed across the tasks that belong to this stage. */
  changedFiles?: string[];
  /** The reviewer's findings, if a review has run. */
  reviewFindings?: Array<{ severity: "Blocker" | "Major" | "Minor" | "Suggestion"; resolved: boolean }>;
  /** Per-AC verification outcome for the integrated build. */
  verifications?: Array<{ ac_id: string; outcome: "passed" | "failed" | "unverified"; evidence: string }>;
}

/**
 * A recorded human acceptance is a claim by a person, not evidence a gate can
 * verify. What a gate can require is that the claim is specific enough to be
 * audited later: a named person, a parseable timestamp, and a note that says
 * what was actually looked at. "x / now / ok" is not that.
 */
function auditHumanAcceptance(record: { by: string; at: string; note: string } | undefined): string[] {
  const problems: string[] = [];
  if (!record) return ["no recorded human acceptance"];
  const by = record.by.trim();
  const at = record.at.trim();
  const note = record.note.trim();
  if (by.length < 2) problems.push("accepter is not a name");
  if (Number.isNaN(Date.parse(at))) problems.push(`acceptance time is not a parseable date: ${JSON.stringify(at)}`);
  // Long enough to name what was looked at, short enough not to demand prose.
  if (note.length < 8) problems.push("acceptance note is too short to say what was checked");
  return problems;
}

const verdict = (gate: Gate, checks: GateCheck[]): GateVerdict => {
  const blocking = checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`);
  return { gate, passed: checks.every((c) => c.passed), checks, blocking };
};

const ok = (id: string, detail: string): GateCheck => ({ id, passed: true, detail });
const no = (id: string, detail: string): GateCheck => ({ id, passed: false, detail });

/** Every acceptance criterion a requirement set defines, flattened. */
function allCriteria(requirements: Requirements): AcceptanceCriterion[] {
  return requirements.flatMap((r) => r.acceptance);
}

/**
 * G0: requirements are answerable.
 *
 * A criterion is answerable when it names how it will be decided: an automated
 * one has a command, a manual one has a named owner and procedure. A criterion
 * that is neither cannot be checked later, so it blocks here rather than
 * silently passing through to VERIFY.
 */
export function gateG0(input: GateInput): GateVerdict {
  const checks: GateCheck[] = [];
  if (!input.requirements?.length) {
    return verdict("G0", [no("requirements-present", "no requirement set supplied")]);
  }
  checks.push(ok("requirements-present", `${input.requirements.length} requirement(s)`));

  const criteria = allCriteria(input.requirements);
  checks.push(ok("criteria-present", `${criteria.length} acceptance criterion(s)`));

  const undecidable = criteria.filter((ac) =>
    ac.kind === "automated" ? !ac.verification_command : !ac.manual_check,
  );
  checks.push(
    undecidable.length === 0
      ? ok("criteria-decidable", "every criterion names its decider")
      : no("criteria-decidable", `no decider for: ${undecidable.map((a) => a.ac_id).join(", ")}`),
  );

  if (input.envelope) {
    const problems = validateEnvelopeAgainstRequirements(input.envelope, input.requirements);
    checks.push(
      problems.length === 0
        ? ok("envelope-cites-known-acs", "every cited AC exists")
        : no("envelope-cites-known-acs", problems.join("; ")),
    );
  }

  return verdict("G0", checks);
}

/**
 * G1: the plan covers the work and does not collide.
 *
 * Checks that every AC is claimed by at least one task, that no two tasks
 * write the same file, and that dependencies name tasks that exist. It cannot
 * see the whole DAG (that belongs to the planner), so it only rejects what it
 * can prove wrong from the envelopes it is given.
 */
export function gateG1(input: GateInput & { tasks?: TaskEnvelope[] }): GateVerdict {
  const checks: GateCheck[] = [];
  const tasks = input.tasks ?? (input.envelope ? [input.envelope] : []);
  if (tasks.length === 0) {
    return verdict("G1", [no("tasks-present", "no task envelopes supplied")]);
  }
  checks.push(ok("tasks-present", `${tasks.length} task(s)`));

  const ids = new Set(tasks.map((t) => t.task_id));
  const dangling = tasks.flatMap((t) =>
    t.dependencies.filter((d) => !ids.has(d)).map((d) => `${t.task_id}->${d}`),
  );
  checks.push(
    dangling.length === 0
      ? ok("dependencies-resolve", "every dependency names a task in the plan")
      : no("dependencies-resolve", `dangling: ${dangling.join(", ")}`),
  );

  // Two tasks may not claim the same write target unless one depends on the
  // other, because then they cannot run at the same time.
  const collisions: string[] = [];
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      const ordered = a.dependencies.includes(b.task_id) || b.dependencies.includes(a.task_id);
      if (ordered) continue;
      const shared = a.allowed_paths.filter((p) => b.allowed_paths.includes(p));
      if (shared.length) collisions.push(`${a.task_id}/${b.task_id} share ${shared.join(", ")}`);
    }
  }
  checks.push(
    collisions.length === 0
      ? ok("no-write-collisions", "parallel tasks do not share write targets")
      : no("no-write-collisions", collisions.join("; ")),
  );

  if (input.requirements) {
    const covered = new Set(tasks.flatMap((t) => t.acceptance_ids));
    const missing = allCriteria(input.requirements)
      .map((ac) => ac.ac_id)
      .filter((id) => !covered.has(id));
    checks.push(
      missing.length === 0
        ? ok("acs-covered", "every acceptance criterion is claimed by a task")
        : no("acs-covered", `unclaimed: ${missing.join(", ")}`),
    );
  }

  return verdict("G1", checks);
}

/**
 * G2: the developer's own evidence is complete.
 *
 * Reuses the protocol checks rather than re-implementing them, so a result
 * that would fail claimIsSupported cannot pass here by a different route.
 */
export function gateG2(input: GateInput): GateVerdict {
  const checks: GateCheck[] = [];
  if (!input.envelope || !input.result) {
    return verdict("G2", [no("result-present", "no envelope/result pair supplied")]);
  }
  checks.push(ok("result-present", `task ${input.envelope.task_id}`));

  const problems = validateTaskResult(input.envelope, input.result);
  checks.push(
    problems.length === 0
      ? ok("result-reconciles", "result matches the envelope")
      : no("result-reconciles", problems.join("; ")),
  );

  const supported = claimIsSupported(input.result, input.envelope);
  checks.push(
    supported
      ? ok("claim-supported", "success claim is backed by evidence")
      : no("claim-supported", `status ${input.result.status} is not supported by the returned evidence`),
  );

  const unresolved = input.result.unresolved_issues;
  checks.push(
    unresolved.length === 0
      ? ok("no-unresolved-issues", "none")
      : no("no-unresolved-issues", unresolved.join("; ")),
  );

  return verdict("G2", checks);
}

/**
 * G3: review found nothing blocking.
 *
 * A Blocker or Major that is still unresolved blocks. Minor and Suggestion do
 * not, because the protocol allows them to be carried with a recorded reason.
 */
export function gateG3(input: GateInput): GateVerdict {
  const checks: GateCheck[] = [];
  const findings = input.reviewFindings;
  if (!findings) {
    return verdict("G3", [no("review-ran", "no review findings supplied")]);
  }
  checks.push(ok("review-ran", `${findings.length} finding(s)`));

  const blocking = findings.filter(
    (f) => (f.severity === "Blocker" || f.severity === "Major") && !f.resolved,
  );
  checks.push(
    blocking.length === 0
      ? ok("no-open-blockers", "no unresolved Blocker or Major")
      : no("no-open-blockers", `${blocking.length} unresolved Blocker/Major`),
  );

  return verdict("G3", checks);
}

/**
 * G4: every required AC has passing evidence on the integrated build.
 *
 * The evidence must name the AC. A test that passed without naming a
 * criterion does not cover it, which is the same rule the protocol applies.
 */
export function gateG4(input: GateInput): GateVerdict {
  const checks: GateCheck[] = [];
  if (!input.requirements) {
    return verdict("G4", [no("requirements-present", "no requirement set supplied")]);
  }
  if (!input.verifications?.length) {
    return verdict("G4", [no("verifications-present", "no verification results supplied")]);
  }

  const required = allCriteria(input.requirements).map((ac) => ac.ac_id);
  const byAc = new Map(input.verifications.map((v) => [v.ac_id, v]));

  const missing = required.filter((id) => !byAc.has(id));
  checks.push(
    missing.length === 0
      ? ok("every-ac-verified", `${required.length} criterion(s) have a result`)
      : no("every-ac-verified", `no result for: ${missing.join(", ")}`),
  );

  const failing = required.filter((id) => {
    const v = byAc.get(id);
    return v ? v.outcome !== "passed" : false;
  });
  checks.push(
    failing.length === 0
      ? ok("every-ac-passes", "all verified criteria passed")
      : no("every-ac-passes", `not passing: ${failing.join(", ")}`),
  );

  const noEvidence = required.filter((id) => {
    const v = byAc.get(id);
    return v ? v.outcome === "passed" && !v.evidence.trim() : false;
  });
  checks.push(
    noEvidence.length === 0
      ? ok("evidence-cited", "every passing result cites evidence")
      : no("evidence-cited", `passed without evidence: ${noEvidence.join(", ")}`),
  );

  return verdict("G4", checks);
}

/**
 * G5: the delivery is usable by someone who was not in the room.
 *
 * Requires a recorded human acceptance, because "it works on my machine" is
 * not something a gate can decide from artefacts alone.
 */
export function gateG5(input: GateInput): GateVerdict {
  const checks: GateCheck[] = [];
  if (!input.requirements) {
    return verdict("G5", [no("requirements-present", "no requirement set supplied")]);
  }

  // G5 depends on G4's evidence: a delivery with unverified criteria is not
  // a delivery.
  const g4 = gateG4(input);
  checks.push(...g4.checks.map((c) => ({ ...c, id: `g4:${c.id}` })));

  const problems = auditHumanAcceptance(input.recorded?.G5);
  checks.push(
    problems.length === 0
      ? ok("human-acceptance", `accepted by ${input.recorded!.G5!.by.trim()} at ${input.recorded!.G5!.at.trim()}`)
      : no("human-acceptance", problems.join("; ")),
  );

  return verdict("G5", checks);
}

const EVALUATORS: Record<Gate, (input: GateInput) => GateVerdict> = {
  G0: gateG0,
  G1: (input) => gateG1(input),
  G2: gateG2,
  G3: gateG3,
  G4: gateG4,
  G5: gateG5,
};

/** Evaluate one gate by name. Unknown gates are a programming error. */
export function evaluateGate(gate: Gate, input: GateInput): GateVerdict {
  const evaluate = EVALUATORS[gate];
  if (!evaluate) throw new Error(`No evaluator for gate ${gate}`);
  return evaluate(input);
}

/** Evaluate every gate, for a dashboard or a full pre-delivery check. */
export function evaluateAllGates(input: GateInput): GateVerdict[] {
  return (Object.keys(EVALUATORS) as Gate[]).map((gate) => evaluateGate(gate, input));
}
