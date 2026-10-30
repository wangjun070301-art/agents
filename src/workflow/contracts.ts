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

export const reqIdSchema = z.string().regex(/^REQ-\d+$/, "REQ-ID must look like REQ-1");
export const acIdSchema = z.string().regex(/^AC-\d+$/, "AC-ID must look like AC-1");

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
  })
  .strict()
  .refine(
    (ac) => ac.kind !== "automated" || ac.verification_command !== undefined,
    "An automated acceptance criterion must name the command that decides it",
  );
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

export const requirementSchema = z
  .object({
    req_id: reqIdSchema,
    statement: z.string().trim().min(1).max(20_000),
    acceptance: z.array(acceptanceCriterionSchema).min(1),
  })
  .strict();
export type Requirement = z.infer<typeof requirementSchema>;

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
    allowed_paths: z.array(z.string().min(1)).default([]),
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
  .strict();
export type TaskResult = z.infer<typeof taskResultSchema>;

/**
 * `succeeded` requires at least one recorded command and no failed or
 * unverified test. This is the machine-checkable half of the completeness
 * rule; the human half is the independent review.
 */
export function claimIsSupported(result: TaskResult): boolean {
  if (result.status !== "succeeded") return true;
  if (result.commands.length === 0) return false;
  return !result.test_results.some((t) => t.outcome === "failed" || t.outcome === "unverified");
}
