import { z } from "zod";

/**
 * Roles are capability slots, not vendors. Any adapter that can fill a slot
 * may be bound to it; the binding is configuration, the slot is protocol.
 */
export const roleSchema = z.enum([
  "analyst",
  "architect",
  "developer",
  "reviewer",
  "tester",
  "integrator",
]);
export type Role = z.infer<typeof roleSchema>;

/** Lifecycle stages. BLOCKED is reachable from every stage and returns to it. */
export const stageSchema = z.enum([
  "INTAKE",
  "CLARIFY",
  "BASELINE",
  "SPEC",
  "PLAN",
  "DISPATCH",
  "IMPLEMENT",
  "REVIEW",
  "VERIFY",
  "INTEGRATE",
  "ACCEPT",
  "DELIVER",
  "ARCHIVE",
  "BLOCKED",
]);
export type Stage = z.infer<typeof stageSchema>;

/** Quality gates. A gate is passed by evidence, never by a claim. */
export const gateSchema = z.enum(["G0", "G1", "G2", "G3", "G4", "G5"]);
export type Gate = z.infer<typeof gateSchema>;

export const reqIdSchema = z.string().regex(/^REQ-[1-9]\d{0,8}$/, "REQ-ID must look like REQ-1");
export const acIdSchema = z.string().regex(/^AC-[1-9]\d{0,8}$/, "AC-ID must look like AC-1");

/**
 * One acceptance criterion. `automated` means a command decides it;
 * `manual` means a named human check decides it. Both must be observable.
 */
export const acceptanceCriterionSchema = z
  .object({
    ac_id: acIdSchema,
    requirement_id: reqIdSchema,
    description: z.string().trim().min(1).max(4000),
    kind: z.enum(["automated", "manual"]),
    verification_command: z.string().trim().min(1).max(4000).optional(),
    manual_check: z
      .object({
        owner: z.string().trim().min(1).max(200),
        procedure: z.string().trim().min(1).max(4000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (ac) => ac.kind !== "automated" || ac.verification_command !== undefined,
    "An automated acceptance criterion must name the command that decides it",
  )
  .refine(
    (ac) => ac.kind !== "manual" || ac.manual_check !== undefined,
    "A manual acceptance criterion must name the human check that decides it",
  )
  .refine(
    (ac) => ac.kind !== "manual" || ac.verification_command === undefined,
    "A manual acceptance criterion must not also carry an automated command",
  )
  .refine(
    (ac) => ac.kind !== "automated" || ac.manual_check === undefined,
    "An automated acceptance criterion must not also carry a manual check",
  );
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

export const requirementSchema = z
  .object({
    req_id: reqIdSchema,
    statement: z.string().trim().min(1).max(20_000),
    acceptance: z.array(acceptanceCriterionSchema).min(1),
  })
  .strict()
  .refine(
    (req) => req.acceptance.every((ac) => ac.requirement_id === req.req_id),
    "Every acceptance criterion must point at the requirement that owns it",
  );
export type Requirement = z.infer<typeof requirementSchema>;

/**
 * A requirement set. AC ids are global, not per-requirement, so a result can
 * cite one criterion without knowing which requirement owns it.
 */
export const requirementsSchema = z
  .array(requirementSchema)
  .min(1)
  .superRefine((requirements, ctx) => {
    const seenReq = new Set<string>();
    const seenAc = new Set<string>();
    requirements.forEach((req, reqIndex) => {
      if (seenReq.has(req.req_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [reqIndex, "req_id"],
          message: `Duplicate requirement id ${req.req_id}`,
        });
      }
      seenReq.add(req.req_id);
      req.acceptance.forEach((ac, acIndex) => {
        if (seenAc.has(ac.ac_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [reqIndex, "acceptance", acIndex, "ac_id"],
            message: `Duplicate acceptance id ${ac.ac_id}`,
          });
        }
        seenAc.add(ac.ac_id);
      });
    });
  });
export type Requirements = z.infer<typeof requirementsSchema>;

/** Section 3.2 of the platform prompt. Every dispatch carries all of it. */
export const verificationCommandSchema = z
  .object({
    command: z.string().trim().min(1).max(4000),
    expect_exit: z.number().int().default(0),
  })
  .strict();
export type VerificationCommand = z.infer<typeof verificationCommandSchema>;

export const taskEnvelopeSchema = z
  .object({
    task_id: z.string().trim().min(1).max(120),
    role: roleSchema,
    objective: z.string().trim().min(1).max(20_000),
    background: z.string().trim().max(50_000).default(""),
    repo_path: z.string().min(1),
    base_revision: z.string().trim().min(1),
    /** Empty means: this task may not write anywhere. */
    allowed_paths: z.array(z.string().trim().min(1)).default([]),
    forbidden_actions: z.array(z.string().min(1)).default([]),
    dependencies: z.array(z.string().min(1)).default([]),
    deliverables: z.array(z.string().min(1)).min(1),
    acceptance_ids: z.array(acIdSchema).min(1),
    verification_commands: z.array(verificationCommandSchema).default([]),
    timeout_seconds: z.number().int().min(10).max(86_400).default(1800),
  })
  .strict();
export type TaskEnvelope = z.infer<typeof taskEnvelopeSchema>;

/** Section 3.3. `succeeded` is only legal when every deliverable and AC passed. */
export const taskStatusSchema = z.enum(["succeeded", "failed", "blocked", "partial"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const commandRecordSchema = z
  .object({
    command: z.string().trim().min(1).max(4000),
    exit_code: z.number().int(),
    output_tail: z.string().max(20_000).default(""),
    duration_ms: z.number().int().min(0).optional(),
  })
  .strict();
export type CommandRecord = z.infer<typeof commandRecordSchema>;

export const testResultSchema = z
  .object({
    name: z.string().trim().min(1).max(500),
    outcome: z.enum(["passed", "failed", "skipped", "unverified"]),
    acceptance_ids: z.array(acIdSchema).default([]),
    detail: z.string().max(20_000).default(""),
  })
  .strict();
export type TestResult = z.infer<typeof testResultSchema>;

export const taskResultSchema = z
  .object({
    task_id: z.string().trim().min(1).max(120),
    status: taskStatusSchema,
    summary: z.string().trim().min(1).max(20_000),
    changed_files: z.array(z.string().min(1)).default([]),
    artifacts: z.array(z.string().min(1)).default([]),
    commands: z.array(commandRecordSchema).default([]),
    test_results: z.array(testResultSchema).default([]),
    unresolved_issues: z.array(z.string().min(1)).default([]),
    risks: z.array(z.string().min(1)).default([]),
    suggested_next_step: z.string().max(4000).default(""),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.status === "failed" || result.status === "blocked") {
      if (result.unresolved_issues.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["unresolved_issues"],
          message: `A ${result.status} result must state what is unresolved`,
        });
      }
    }
  });
export type TaskResult = z.infer<typeof taskResultSchema>;

/**
 * `succeeded` is only legal when the result carries real evidence: at least
 * one test actually ran and passed, nothing is skipped or unverified, no
 * unresolved issue remains, and every acceptance criterion has a passing test
 * naming it.
 *
 * Exit codes are judged against the envelope rather than assumed to be 0, so a
 * verification command that legitimately expects a non-zero exit still works.
 * Pass the envelope whenever you have it; without one, exit codes cannot be
 * checked at all and the result is only evidence-shaped.
 */
export function claimIsSupported(result: TaskResult, envelope?: TaskEnvelope): boolean {
  if (result.status !== "succeeded") return true;
  if (result.unresolved_issues.length > 0) return false;
  if (result.test_results.length === 0) return false;
  if (result.test_results.some((t) => t.outcome !== "passed")) return false;
  if (envelope) return validateTaskResult(envelope, result).length === 0;
  if (result.commands.length === 0) return false;
  if (result.commands.some((c) => c.exit_code !== 0)) return false;
  return true;
}

/** Normalize a path for containment checks: forward slashes, no `.`/`..` escapes. */
function normalizePath(value: string): string {
  const slashed = value.replace(/\\/g, "/").trim();
  const parts: string[] = [];
  for (const part of slashed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return "\u0000escape";
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function isWithin(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (c === "\u0000escape") return false;
  if (p === "") return true;
  return c === p || c.startsWith(`${p}/`);
}

/** Express a path relative to the repo root, so relative and absolute reports agree. */
function relTo(child: string, root: string, caseInsensitive: boolean): string {
  const rawChild = normalizePath(child);
  const rawRoot = normalizePath(root);
  const c = caseInsensitive ? rawChild.toLowerCase() : rawChild;
  const r = caseInsensitive ? rawRoot.toLowerCase() : rawRoot;
  if (r === "") return c;
  if (c === r) return "";
  return c.startsWith(`${r}/`) ? c.slice(r.length + 1) : c;
}

function samePath(child: string, parent: string, caseInsensitive: boolean): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (c === "\u0000escape") return false;
  // An allowlist entry that collapses to nothing ("/", ".", "//") is malformed
  // and must not become a blanket grant.
  if (p === "" || p === "\u0000escape") return false;
  const cc = caseInsensitive ? c.toLowerCase() : c;
  const pp = caseInsensitive ? p.toLowerCase() : p;
  return cc === pp || cc.startsWith(`${pp}/`);
}

/**
 * Reconcile a result against the envelope that commissioned it. Returns every
 * violation; an empty array means the result is a valid answer to that task.
 *
 * This is the strict check: evidence preconditions and envelope-specific rules
 * both apply. Paths are compared relative to repo_path, so an adapter may
 * report either relative or absolute paths.
 */
export function validateTaskResult(envelope: TaskEnvelope, result: TaskResult): string[] {
  const problems: string[] = [];
  const caseInsensitive = process.platform === "win32" || /^[A-Za-z]:|^\\\\/.test(envelope.repo_path);

  if (result.task_id !== envelope.task_id) {
    problems.push(`result task_id ${result.task_id} does not match envelope ${envelope.task_id}`);
  }

  for (const file of result.changed_files) {
    const rel = relTo(file, envelope.repo_path, caseInsensitive);
    const allowed = envelope.allowed_paths.some((a) =>
      samePath(rel, relTo(a, envelope.repo_path, caseInsensitive), caseInsensitive),
    );
    if (!allowed) {
      problems.push(`changed file outside allowed_paths: ${file}`);
    }
  }

  for (const deliverable of envelope.deliverables) {
    // A parenthesised entry is a placeholder for a task that produces no file
    // (a review, a probe, a read-only check). It is not a path and must not be
    // required on disk.
    if (/^\(.*\)$/.test(deliverable.trim())) continue;
    const target = relTo(deliverable, envelope.repo_path, caseInsensitive);
    const produced = result.changed_files.some((file) =>
      samePath(relTo(file, envelope.repo_path, caseInsensitive), target, caseInsensitive),
    );
    if (!produced) {
      problems.push(`deliverable not produced: ${deliverable}`);
    }
  }

  // Every recorded run must satisfy the expectation, not just the first one,
  // so a passing run cannot hide a later failing one.
  for (const expected of envelope.verification_commands) {
    const runs = result.commands.filter((c) => c.command.trim() === expected.command.trim());
    if (runs.length === 0) {
      problems.push(`verification command was not run: ${expected.command}`);
      continue;
    }
    for (const run of runs) {
      if (run.exit_code !== expected.expect_exit) {
        problems.push(
          `verification command exited ${run.exit_code}, expected ${expected.expect_exit}: ${expected.command}`,
        );
      }
    }
  }

  if (result.status === "succeeded") {
    if (result.unresolved_issues.length > 0) {
      problems.push("a succeeded result must have no unresolved issues");
    }
    if (result.test_results.length === 0) {
      problems.push("a succeeded result must carry at least one test result");
    }
    for (const t of result.test_results) {
      if (t.outcome !== "passed") problems.push(`test ${t.name} did not pass (${t.outcome})`);
    }
    for (const acId of envelope.acceptance_ids) {
      const covered = result.test_results.some(
        (t) => t.outcome === "passed" && t.acceptance_ids.includes(acId),
      );
      if (!covered) problems.push(`acceptance criterion has no passing test: ${acId}`);
    }
  }

  return problems;
}

/** Envelope validation: every cited AC must exist in the requirement set. */
export function validateEnvelopeAgainstRequirements(
  envelope: TaskEnvelope,
  requirements: Requirements,
): string[] {
  const known = new Set(requirements.flatMap((r) => r.acceptance.map((ac) => ac.ac_id)));
  const problems: string[] = [];
  for (const acId of envelope.acceptance_ids) {
    if (!known.has(acId)) problems.push(`acceptance id not defined by any requirement: ${acId}`);
  }
  return problems;
}
