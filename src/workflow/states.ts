import { gateSchema, stageSchema, type Gate, type Stage } from "./contracts.js";

/**
 * Legal forward edges. No stage may be skipped.
 *
 * Which stages may send work back to IMPLEMENT is a policy choice, recorded
 * here and tested. Currently REVIEW and VERIFY may; INTEGRATE may not.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<Stage, readonly Stage[]>> = {
  INTAKE: ["CLARIFY", "BLOCKED"],
  CLARIFY: ["BASELINE", "BLOCKED"],
  BASELINE: ["SPEC", "BLOCKED"],
  SPEC: ["PLAN", "BLOCKED"],
  PLAN: ["DISPATCH", "BLOCKED"],
  DISPATCH: ["IMPLEMENT", "BLOCKED"],
  IMPLEMENT: ["REVIEW", "BLOCKED"],
  REVIEW: ["VERIFY", "IMPLEMENT", "BLOCKED"],
  VERIFY: ["INTEGRATE", "IMPLEMENT", "BLOCKED"],
  INTEGRATE: ["ACCEPT", "VERIFY", "BLOCKED"],
  ACCEPT: ["DELIVER", "BLOCKED"],
  DELIVER: ["ARCHIVE", "BLOCKED"],
  ARCHIVE: [],
  BLOCKED: [],
};

/** The gate that must pass before leaving `from` for `to`, if any. */
export const GATE_ON_EDGE: Readonly<Partial<Record<`${Stage}->${Stage}`, Gate>>> = {
  "SPEC->PLAN": "G0",
  "PLAN->DISPATCH": "G1",
  "IMPLEMENT->REVIEW": "G2",
  "REVIEW->VERIFY": "G3",
  "VERIFY->INTEGRATE": "G4",
  "ACCEPT->DELIVER": "G5",
};

export function gateFor(from: Stage, to: Stage): Gate | undefined {
  return GATE_ON_EDGE[`${from}->${to}`];
}

/**
 * BLOCKED only returns to the stage that blocked, and only if that stage
 * actually has a BLOCKED edge. Every other edge must be listed in
 * LEGAL_TRANSITIONS.
 *
 * Stage skipping is a protocol error here. Gate *evidence* is not checked by
 * this function: gate assignment is data (see GATE_ON_EDGE), and enforcement
 * belongs to the caller that holds the evidence. Use assertGatePassed for that.
 */
export function canTransition(from: Stage, to: Stage, blockedFrom?: Stage): boolean {
  const legal = (stage: Stage): readonly Stage[] | undefined => LEGAL_TRANSITIONS[stage];
  if (from === "BLOCKED") {
    if (blockedFrom === undefined || blockedFrom === "BLOCKED") return false;
    const resumeEdges = legal(blockedFrom);
    if (!resumeEdges) throw new ProtocolError(`Unknown stage: ${blockedFrom}`, { blockedFrom });
    return to === blockedFrom && resumeEdges.includes("BLOCKED");
  }
  if (blockedFrom !== undefined) return false;
  const edges = legal(from);
  if (!edges) throw new ProtocolError(`Unknown stage: ${from}`, { from });
  return edges.includes(to);
}

export function assertTransition(from: Stage, to: Stage, blockedFrom?: Stage): void {
  if (!canTransition(from, to, blockedFrom)) {
    throw new ProtocolError(`Illegal transition ${from} -> ${to}`, { from, to, blockedFrom });
  }
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function isTerminal(stage: Stage): boolean {
  return stage === "ARCHIVE";
}

/** Throw unless the gated edge is being taken with its gate recorded as passed. */
export function assertGatePassed(from: Stage, to: Stage, passed: readonly Gate[]): void {
  const gate = gateFor(from, to);
  if (!gate) return;
  if (!passed.includes(gate)) {
    throw new ProtocolError(`Gate ${gate} has not passed`, { from, to, gate, passed });
  }
}

/**
 * Edges the spec requires to be gated. Listed explicitly so a deleted gate is
 * detected instead of failing open.
 */
export const REQUIRED_GATES: readonly `${Stage}->${Stage}`[] = Object.freeze([
  "SPEC->PLAN",
  "PLAN->DISPATCH",
  "IMPLEMENT->REVIEW",
  "REVIEW->VERIFY",
  "VERIFY->INTEGRATE",
  "ACCEPT->DELIVER",
]);

export function assertGateTableConsistent(): void {
  for (const key of Object.keys(GATE_ON_EDGE) as Array<`${Stage}->${Stage}`>) {
    const [from, to] = key.split("->") as [Stage, Stage];
    if (!LEGAL_TRANSITIONS[from]?.includes(to)) {
      throw new ProtocolError(`Gate declared on an illegal edge: ${key}`, { key });
    }
  }
  for (const key of REQUIRED_GATES) {
    if (!GATE_ON_EDGE[key]) {
      throw new ProtocolError(`Required gate is missing: ${key}`, { key });
    }
  }
}

export const stageList: readonly Stage[] = Object.freeze([...stageSchema.options]);
export const gateList: readonly Gate[] = Object.freeze([...gateSchema.options]);
