import { gateSchema, stageSchema, type Gate, type Stage } from "./contracts.js";

/**
 * Legal forward edges. Review and verify may send work back to IMPLEMENT;
 * everything else moves forward or blocks. No stage may be skipped.
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
  INTEGRATE: ["ACCEPT", "IMPLEMENT", "BLOCKED"],
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
 * BLOCKED only returns to the stage that blocked. Every other edge must be
 * listed in LEGAL_TRANSITIONS, so skipping a gate is a protocol error rather
 * than a shortcut.
 */
export function canTransition(from: Stage, to: Stage, blockedFrom?: Stage): boolean {
  if (from === "BLOCKED") return blockedFrom !== undefined && to === blockedFrom;
  return LEGAL_TRANSITIONS[from].includes(to);
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

export const stageList = stageSchema.options;
export const gateList = gateSchema.options;
