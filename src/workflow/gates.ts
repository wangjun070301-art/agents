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
  /**
   * The artifact being delivered: the integrated build hash or the commit
   * that will be shipped. Distinct from `envelope.base_revision`, which is the
   * state before the work started.
   */
  deliveredArtifact?: string;
  /** What the developer reported, when there is one. */
  result?: TaskResult;
  /** The requirement set the project is working against. */
  requirements?: Requirements;
  /** Human-recorded gate passes, used only where a gate is inherently manual. */
  recorded?: Partial<Record<Gate, RecordedAcceptance>>;
  /** Files changed across the tasks that belong to this stage. */
  changedFiles?: string[];
  /** The reviewer's findings, if a review has run. */
  reviewFindings?: Array<{ severity: "Blocker" | "Major" | "Minor" | "Suggestion"; resolved: boolean }>;
  /** Per-AC verification outcome for the integrated build. */
  verifications?: VerificationRow[];
}

/**
 * A human acceptance, bound to what it accepts. `artifact` is the revision or
 * build hash the person actually looked at, and `accepted_ac_ids` is the set
 * they are signing off. Without those the record only proves that somebody
 * typed three strings.
 */
export interface RecordedAcceptance {
  by: string;
  at: string;
  note: string;
  /** The revision or build hash that was actually looked at. Required. */
  artifact: string;
  /** Which acceptance criteria this acceptance covers. */
  accepted_ac_ids: string[];
}

/** One verification result, with the time it was observed. */
export interface VerificationRow {
  ac_id: string;
  outcome: "passed" | "failed" | "unverified";
  evidence: string;
  /** ISO timestamp of when the check ran, if known. */
  at?: string;
}

/**
 * A recorded human acceptance is a claim by a person, not evidence a gate can
 * verify. What a gate can require is that the claim is specific enough to be
 * audited later: a named person, a parseable timestamp, and a note that says
 * what was actually looked at. "x / now / ok" is not that.
 */
function auditHumanAcceptance(
  record: RecordedAcceptance | undefined,
  context: {
    requiredAcs: string[];
    /** The artifact being delivered. */
    deliveredArtifact: string;
    verifications: VerificationRow[];
  },
): string[] {
  const problems: string[] = [];
  if (!record) return ["no recorded human acceptance"];
  const by = record.by.trim();
  const at = record.at.trim();
  const note = record.note.trim();
  if (by.length < 2) problems.push("accepter is not a name");
  if (Number.isNaN(Date.parse(at))) problems.push(`acceptance time is not a parseable date: ${JSON.stringify(at)}`);
  // Long enough to name what was looked at, short enough not to demand prose.
  if (note.length < 8) problems.push("acceptance note is too short to say what was checked");

  // The acceptance must name the artifact it accepts, and that artifact must
  // be the one being delivered. Comparing against base_revision would be
  // wrong: that is the state before the work, not the build the person looked at.
  const named = record.artifact.trim();
  if (!named) {
    problems.push("acceptance does not name the artifact or revision it accepts");
  } else if (named !== context.deliveredArtifact.trim()) {
    problems.push(
      `acceptance names ${named} but the delivered artifact is ${context.deliveredArtifact.trim()}`,
    );
  }

  // ...and the criteria it covers, which must match the requirement set.
  const accepted = record.accepted_ac_ids;
  if (accepted.length === 0) {
    problems.push("acceptance does not say which criteria were accepted");
  } else {
    const unknown = accepted.filter((id) => !context.requiredAcs.includes(id));
    if (unknown.length) problems.push(`acceptance cites criteria nobody defined: ${unknown.join(", ")}`);
    const uncovered = context.requiredAcs.filter((id) => !accepted.includes(id));
    if (uncovered.length) problems.push(`acceptance leaves criteria unsigned: ${uncovered.join(", ")}`);
  }

  // Temporal ordering: an acceptance stamped before the last verification
  // cannot have looked at its result. If a verification has no timestamp the
  // ordering cannot be established, and that is a problem in itself rather
  // than a check that quietly passes.
  const acceptedAt = parseStrictTimestamp(at);
  if (acceptedAt === undefined) {
    problems.push(`acceptance time is not a full ISO timestamp: ${JSON.stringify(at)}`);
  } else {
    const untimed = context.verifications.filter((v) => !v.at);
    if (untimed.length) {
      problems.push(`verification(s) carry no timestamp, so ordering cannot be checked: ${untimed.map((v) => v.ac_id).join(", ")}`);
    }
    const timed = context.verifications
      .map((v) => parseStrictTimestamp(v.at))
      .filter((n): n is number => n !== undefined);
    const lastVerification = timed.length ? Math.max(...timed) : undefined;
    if (lastVerification !== undefined && acceptedAt < lastVerification) {
      problems.push("acceptance is dated before the last verification it claims to cover");
    }
  }
  return problems;
}

/**
 * Accept only a full ISO timestamp. A bare date parses as midnight, which
 * would compare as "before" every verification on the same day and produce a
 * false failure.
 */
function parseStrictTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) return undefined;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

const verdict = (gate: Gate, checks: GateCheck[]): GateVerdict => {
  // Zero checks is not a pass. A gate that examined nothing has not cleared
  // anything, and every early-return path must add at least one check.
  if (checks.length === 0) {
    return { gate, passed: false, checks: [], blocking: ["no checks were run"] };
  }
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
 * Do two declared paths overlap? A parent directory and a child file do:
 * ["src"] and ["src/parser.ts"] can be written by the same task. Comparison
 * folds case, because Windows treats "Src" and "src" as the same directory.
 */
function pathsOverlap(a: string, b: string): boolean {
  const x = normalizeForCompare(a, true).toLowerCase();
  const y = normalizeForCompare(b, true).toLowerCase();
  if (x === "" || y === "") return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * Reduce a declared path to the form two tasks can be compared in. `..`
 * segments are resolved against the preceding segment, so "src/../src/a.ts"
 * becomes "src/a.ts". A drive-letter prefix is kept so "C:/repo/src" and
 * "src" do not accidentally compare equal; the caller passes relative
 * paths when it can.
 */
function normalizeForCompare(value: string, resolveDotDot = false): string {
  const slashed = value.replace(/\\/g, "/").trim();
  const segments = slashed.split("/").filter((p) => p !== "" && p !== ".");
  if (!resolveDotDot) return segments.join("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/** Every pair of declared paths that overlap, described for the blocker message. */
function pathOverlap(left: string[], right: string[]): string[] {
  const found: string[] = [];
  for (const a of left) {
    for (const b of right) {
      if (pathsOverlap(a, b)) found.push(`${a} ~ ${b}`);
    }
  }
  return found;
}

/**
 * Transitive dependency closure per task, computed with an iterative walk so a
 * dependency cycle cannot recurse forever. Each task's closure is derived
 * once; the total cost is O(V·E) and the walk itself never recurses.
 */
function dependencyClosure(tasks: TaskEnvelope[]): Map<string, Set<string>> {
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const closure = new Map<string, Set<string>>();
  for (const task of tasks) {
    const seen = new Set<string>();
    const queue = [...task.dependencies];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const next = byId.get(id);
      if (next) queue.push(...next.dependencies);
    }
    closure.set(task.task_id, seen);
  }
  return closure;
}

/**
 * A dependency cycle means no member of the cycle can ever start.
 *
 * Iterative depth-first search with an explicit stack: a plan with thousands
 * of chained tasks must not blow the call stack before the gate can report
 * anything.
 */
function findDependencyCycle(tasks: TaskEnvelope[]): string[] | undefined {
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const state = new Map<string, "visiting" | "done">();

  for (const root of tasks) {
    if (state.get(root.task_id)) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: root.task_id, next: 0 }];
    const onPath: string[] = [];

    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const task = byId.get(frame.id);
      const deps = (task?.dependencies ?? []).filter((d) => byId.has(d));

      if (frame.next === 0) {
        state.set(frame.id, "visiting");
        onPath.push(frame.id);
      }

      if (frame.next < deps.length) {
        const dep = deps[frame.next]!;
        frame.next += 1;
        const mark = state.get(dep);
        if (mark === "visiting") {
          const start = onPath.indexOf(dep);
          return [...onPath.slice(start < 0 ? 0 : start), dep];
        }
        if (mark === "done") continue;
        stack.push({ id: dep, next: 0 });
        continue;
      }

      state.set(frame.id, "done");
      onPath.pop();
      stack.pop();
    }
  }
  return undefined;
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
  if (criteria.length === 0) {
    return verdict("G0", [
      ...checks,
      no("criteria-present", "the requirement set defines no acceptance criteria"),
    ]);
  }
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

  // The AC-coverage check needs the requirement set. Without it G1 would be
  // asserting plan completeness against an unknown target, so it blocks.
  if (!input.requirements?.length) {
    return verdict("G1", [...checks, no("requirements-present", "no requirement set supplied")]);
  }

  const ids = new Set(tasks.map((t) => t.task_id));
  const dangling = tasks.flatMap((t) =>
    t.dependencies.filter((d) => !ids.has(d)).map((d) => `${t.task_id}->${d}`),
  );
  checks.push(
    dangling.length === 0
      ? ok("dependencies-resolve", "every dependency names a task in the plan")
      : no("dependencies-resolve", `dangling: ${dangling.join(", ")}`),
  );

  const cycle = findDependencyCycle(tasks);
  checks.push(
    cycle === undefined
      ? ok("no-dependency-cycle", "the plan is acyclic")
      : no("no-dependency-cycle", `cycle: ${cycle.join(" -> ")}`),
  );

  // Two tasks may not claim the same write target unless one transitively
  // depends on the other, because only then are they guaranteed to run in
  // sequence. Paths are compared after normalization and case folding, so
  // "src" overlaps "src/parser.ts", and "./src" equals "src".
  const collisions: string[] = [];
  const reachable = dependencyClosure(tasks);
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      const ordered =
        reachable.get(a.task_id)?.has(b.task_id) === true ||
        reachable.get(b.task_id)?.has(a.task_id) === true;
      if (ordered) continue;
      const overlap = pathOverlap(a.allowed_paths, b.allowed_paths);
      const deliverableClash = pathOverlap(a.deliverables, b.deliverables);
      if (overlap.length) collisions.push(`${a.task_id}/${b.task_id} share ${overlap.join(", ")}`);
      if (deliverableClash.length) {
        collisions.push(`${a.task_id}/${b.task_id} both deliver ${deliverableClash.join(", ")}`);
      }
    }
  }
  checks.push(
    collisions.length === 0
      ? ok("no-write-collisions", "parallel tasks do not share write targets")
      : no("no-write-collisions", collisions.join("; ")),
  );

  const covered = new Set(tasks.flatMap((t) => t.acceptance_ids));
  const missing = allCriteria(input.requirements)
    .map((ac) => ac.ac_id)
    .filter((id) => !covered.has(id));
  checks.push(
    missing.length === 0
      ? ok("acs-covered", "every acceptance criterion is claimed by a task")
      : no("acs-covered", `unclaimed: ${missing.join(", ")}`),
  );

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

  // A blocked result is a valid report. It is not a finished implementation,
  // so G2 records the report as honest and the status as unfinished, rather
  // than lumping both into one failure the reader has to guess about.
  if (input.result.status === "blocked") {
    return verdict("G2", [
      ...checks,
      no("status-succeeded", `status is blocked: ${input.result.unresolved_issues.join("; ") || "no reason given"}`),
    ]);
  }

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

  // claimIsSupported short-circuits to true for any non-succeeded status, so
  // G2 has to require the status itself. A "partial" result is not a finished
  // implementation, however tidy its fields look.
  checks.push(
    input.result.status === "succeeded"
      ? ok("status-succeeded", "the developer reports the task as finished")
      : no("status-succeeded", `status is ${input.result.status}, not succeeded`),
  );

  // An independent file list, when the caller has one, is the only way to
  // catch a change the developer forgot to mention.
  if (input.changedFiles) {
    // Compare after the same normalization the protocol uses, so an adapter
    // that reports absolute paths is not punished for being precise.
    const fold = (value: string) => normalizeForCompare(value, true).toLowerCase();
    const observed = new Set(input.changedFiles.map(fold));
    const reported = new Set(input.result.changed_files.map(fold));
    const undeclared = input.changedFiles.filter((file) => !reported.has(fold(file)));
    const claimed = input.result.changed_files.filter((file) => !observed.has(fold(file)));
    checks.push(
      undeclared.length === 0 && claimed.length === 0
        ? ok("changed-files-honest", "the reported file list matches the observed one")
        : no(
            "changed-files-honest",
            [
              undeclared.length ? `changed but unreported: ${undeclared.join(", ")}` : "",
              claimed.length ? `reported but unchanged: ${claimed.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("; "),
          ),
    );
  }

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
  // An empty array means the reviewer looked and found nothing. That is a real
  // verdict, but it must be distinguishable from "no review ran", so the
  // caller passes an empty array only after actually reviewing. A missing
  // field blocks.
  if (!findings) {
    return verdict("G3", [no("review-ran", "no review findings supplied")]);
  }
  checks.push(ok("review-ran", `${findings.length} finding(s)`));

  const malformed = findings.filter(
    (f) => !["Blocker", "Major", "Minor", "Suggestion"].includes(f.severity),
  );
  checks.push(
    malformed.length === 0
      ? ok("severity-valid", "every finding carries a known severity")
      : no("severity-valid", `${malformed.length} finding(s) with an unknown severity`),
  );

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

  // Duplicate rows are a conflict, not a last-wins update: appending a passing
  // row after a failing one would otherwise flip the verdict.
  const duplicateIds = [...new Set(
    input.verifications
      .map((v) => v.ac_id)
      .filter((id, i, all) => all.indexOf(id) !== i),
  )];
  checks.push(
    duplicateIds.length === 0
      ? ok("no-duplicate-verifications", "one row per criterion")
      : no("no-duplicate-verifications", `duplicated: ${duplicateIds.join(", ")}`),
  );

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

  // Evidence must be more than whitespace and more than a shrug. A single
  // punctuation mark or "n/a" names nothing, so it is not evidence.
  const isEvidence = (text: string) => {
    const trimmed = text.replace(/[\u200b-\u200d\ufeff]/g, "").trim();
    if (trimmed.length < 4) return false;
    if (/^(n\/?a|none|tbd|-+|\.+|\?+)$/i.test(trimmed)) return false;
    return /[A-Za-z0-9]/.test(trimmed);
  };
  const noEvidence = required.filter((id) => {
    const v = byAc.get(id);
    return v ? v.outcome === "passed" && !isEvidence(v.evidence) : false;
  });
  checks.push(
    noEvidence.length === 0
      ? ok("evidence-cited", "every passing result cites evidence")
      : no("evidence-cited", `passed without evidence: ${noEvidence.join(", ")}`),
  );

  // A verification for a criterion nobody defined is a sign the plan and the
  // evidence have drifted apart.
  const spurious = input.verifications.filter((v) => !required.includes(v.ac_id));
  checks.push(
    spurious.length === 0
      ? ok("no-spurious-verifications", "every verification names a defined criterion")
      : no("no-spurious-verifications", `unknown criteria: ${spurious.map((v) => v.ac_id).join(", ")}`),
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

  const requiredAcs = allCriteria(input.requirements).map((ac) => ac.ac_id);
  // Without a delivered artifact there is nothing for the acceptance to be
  // bound to, so the gate cannot audit it.
  if (!input.deliveredArtifact?.trim()) {
    return verdict("G5", [
      ...checks,
      no("delivered-artifact", "no delivered artifact (build hash or commit) supplied"),
    ]);
  }
  const problems = auditHumanAcceptance(input.recorded?.G5, {
    requiredAcs,
    deliveredArtifact: input.deliveredArtifact,
    verifications: input.verifications ?? [],
  });
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
