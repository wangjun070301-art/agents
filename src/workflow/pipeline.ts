import type { Gate, Requirements, Stage, TaskEnvelope, TaskResult } from "./contracts.js";
import { assertTransition, canTransition, gateFor, isTerminal } from "./states.js";
import { evaluateGate, type GateInput, type GateVerdict } from "./gates.js";

/**
 * One recorded stage change. `gate` is set when the edge was gated, and
 * `verdict` records what the gate said at that moment — so a later reader can
 * see not just that a transition happened, but that it was allowed.
 */
export interface StageRecord {
  from: Stage;
  to: Stage;
  at: string;
  gate?: Gate;
  verdict?: GateVerdict;
  blockedFrom?: Stage;
  note?: string;
}

export interface TransitionRequest {
  to: Stage;
  /** Stage to return to when resuming from BLOCKED. */
  blockedFrom?: Stage;
  note?: string;
  /**
   * Data the gate needs. Required whenever the edge is gated: a gated
   * transition with no input cannot be judged and is refused.
   */
  gateInput?: GateInput;
}

export interface TransitionResult {
  ok: boolean;
  stage: Stage;
  record?: StageRecord;
  /** Populated when `ok` is false. */
  refused?: {
    reason: "illegal-transition" | "gate-failed" | "gate-input-missing" | "terminal";
    detail: string;
    verdict?: GateVerdict;
  };
}

/**
 * The stage machine with gates wired in.
 *
 * Every advance goes through `advance()`. There is no other way to change the
 * stage, so "the gate was skipped" is not a state this object can reach —
 * unlike a bare `assertGatePassed` that a caller has to remember to invoke.
 */
export class Pipeline {
  private current: Stage;
  private blockedFrom: Stage | undefined;
  readonly history: StageRecord[] = [];

  constructor(
    start: Stage = "INTAKE",
    private readonly now: () => Date = () => new Date(),
  ) {
    this.current = start;
  }

  get stage(): Stage {
    return this.current;
  }

  get isBlocked(): boolean {
    return this.current === "BLOCKED";
  }

  /** Every gate this pipeline has passed, in order. */
  get passedGates(): Gate[] {
    return this.history.flatMap((r) => (r.verdict?.passed && r.gate ? [r.gate] : []));
  }

  /**
   * Attempt to move to `to`. Returns a result rather than throwing, so a
   * scheduler can record a refusal instead of unwinding a stack.
   */
  advance(request: TransitionRequest): TransitionResult {
    if (isTerminal(this.current)) {
      return {
        ok: false,
        stage: this.current,
        refused: { reason: "terminal", detail: `${this.current} is terminal` },
      };
    }

    const { to } = request;

    // Leaving BLOCKED requires naming the stage that blocked. Anything else
    // would be a resume into a stage this pipeline never left.
    if (this.current === "BLOCKED" && request.blockedFrom === undefined) {
      request = { ...request, blockedFrom: this.blockedFrom };
    }

    if (!canTransition(this.current, to, request.blockedFrom)) {
      return {
        ok: false,
        stage: this.current,
        refused: {
          reason: "illegal-transition",
          detail: `illegal transition ${this.current} -> ${to}` +
            (request.blockedFrom ? ` (blocked from ${request.blockedFrom})` : ""),
        },
      };
    }

    const gate = gateFor(this.current, to);
    let verdict: GateVerdict | undefined;

    if (gate) {
      if (!request.gateInput) {
        return {
          ok: false,
          stage: this.current,
          refused: {
            reason: "gate-input-missing",
            detail: `${this.current} -> ${to} requires gate ${gate}, but no gate input was supplied`,
          },
        };
      }
      verdict = evaluateGate(gate, request.gateInput);
      if (!verdict.passed) {
        return {
          ok: false,
          stage: this.current,
          refused: {
            reason: "gate-failed",
            detail: `${gate} blocked ${this.current} -> ${to}: ${verdict.blocking.join("; ")}`,
            verdict,
          },
        };
      }
    }

    // assertTransition is the protocol-level guard; canTransition above is the
    // convenience. Calling both means a future change to either is caught.
    assertTransition(this.current, to, request.blockedFrom);

    const record: StageRecord = {
      from: this.current,
      to,
      at: this.now().toISOString(),
      ...(gate ? { gate, verdict } : {}),
      ...(request.blockedFrom ? { blockedFrom: request.blockedFrom } : {}),
      ...(request.note ? { note: request.note } : {}),
    };
    this.history.push(record);

    if (to === "BLOCKED") {
      this.blockedFrom = this.current;
    } else if (this.current === "BLOCKED") {
      this.blockedFrom = undefined;
    }
    this.current = to;

    return { ok: true, stage: to, record };
  }

  /** Convenience: advance through several stages, stopping at the first refusal. */
  advanceAll(requests: TransitionRequest[]): TransitionResult {
    let last: TransitionResult = { ok: true, stage: this.current };
    for (const request of requests) {
      last = this.advance(request);
      if (!last.ok) return last;
    }
    return last;
  }

  /**
   * The gates this pipeline would need to pass to reach `target`, in order.
   * A planner uses this to know what evidence to collect.
   */
  requiredGatesTo(target: Stage): Gate[] {
    const gates: Gate[] = [];
    let stage = this.current;
    // Walk the shortest legal path; the machine is linear apart from BLOCKED
    // and the rework edges, so a forward walk is enough here.
    while (stage !== target) {
      const next = FORWARD_PATH[stage];
      if (!next) break;
      const gate = gateFor(stage, next);
      if (gate) gates.push(gate);
      stage = next;
    }
    return gates;
  }
}

/** The single forward successor of each stage, ignoring rework edges. */
const FORWARD_PATH: Partial<Record<Stage, Stage>> = {
  INTAKE: "CLARIFY",
  CLARIFY: "BASELINE",
  BASELINE: "SPEC",
  SPEC: "PLAN",
  PLAN: "DISPATCH",
  DISPATCH: "IMPLEMENT",
  IMPLEMENT: "REVIEW",
  REVIEW: "VERIFY",
  VERIFY: "INTEGRATE",
  INTEGRATE: "ACCEPT",
  ACCEPT: "DELIVER",
  DELIVER: "ARCHIVE",
};

/** Build the gate input a pipeline stage typically needs, from project state. */
export interface ProjectState {
  requirements?: Requirements;
  tasks?: TaskEnvelope[];
  envelope?: TaskEnvelope;
  result?: TaskResult;
  deliveredArtifact?: string;
  changedFiles?: string[];
  reviewFindings?: GateInput["reviewFindings"];
  verifications?: GateInput["verifications"];
  recorded?: GateInput["recorded"];
  claimDiscrepancies?: GateInput["claimDiscrepancies"];
}

export function gateInputFor(stage: Stage, state: ProjectState): GateInput | undefined {
  const gate = gateFor(stage, FORWARD_PATH[stage] ?? stage);
  if (!gate) return undefined;
  const input: GateInput & { tasks?: TaskEnvelope[] } = {
    requirements: state.requirements,
    tasks: state.tasks,
    envelope: state.envelope,
    result: state.result,
    deliveredArtifact: state.deliveredArtifact,
    changedFiles: state.changedFiles,
    reviewFindings: state.reviewFindings,
    verifications: state.verifications,
    recorded: state.recorded,
    claimDiscrepancies: state.claimDiscrepancies,
  };
  return input;
}
