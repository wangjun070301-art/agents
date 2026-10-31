/**
 * Turn a command's real output into test results.
 *
 * An agent's `test_results` field is a claim. This module reads what the
 * command actually printed, so a gate can compare the claim against the
 * transcript instead of taking it at face value.
 *
 * Recognised formats:
 * - `node --test` TAP-ish summary lines (`ok 1 - name`, `not ok 2 - name`)
 * - TAP anywhere (`ok N - ...` / `not ok N - ...`)
 * - jest / vitest `Tests: X passed, Y failed`
 * - pytest `X passed, Y failed in Zs`
 * - a bare `ok` / `PASS` with no counts is NOT treated as a test result
 */
export interface ParsedTestResult {
  name: string;
  outcome: "passed" | "failed" | "skipped";
  /** Which parser produced this line, so a caller knows its confidence. */
  source: "node-test" | "tap" | "jest" | "pytest" | "counts";
}

export interface ParsedOutput {
  results: ParsedTestResult[];
  /** Totals the parser could infer, when the format reports them. */
  totals?: { passed: number; failed: number; skipped: number };
  /** True when the output contained no recognisable test result at all. */
  empty: boolean;
}

const TAP_LINE = /^(not ok|ok)\s+(\d+)\s*(?:-\s*)?(.*)$/;
const SKIP_HINT = /#\s*skip|#\s*SKIP|#\s*TODO/i;

/**
 * Parse one command's output. Deliberately conservative: a line that merely
 * contains "ok" is not a test result, because most programs print that.
 */
export function parseTestOutput(output: string): ParsedOutput {
  const results: ParsedTestResult[] = [];
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    const tap = TAP_LINE.exec(trimmed);
    if (tap) {
      const [, marker, index, name] = tap;
      const testName = (name ?? "").trim() || `test ${index}`;
      if (SKIP_HINT.test(testName)) {
        results.push({ name: testName, outcome: "skipped", source: "tap" });
      } else {
        results.push({
          name: testName,
          outcome: marker === "ok" ? "passed" : "failed",
          source: "tap",
        });
      }
    }
  }

  // Jest / Vitest summary line.
  const jest = /Tests:\s*(?:(\d+)\s*failed,\s*)?(?:(\d+)\s*skipped,\s*)?(?:(\d+)\s*passed,\s*)?(?:(\d+)\s*total)/i.exec(
    output,
  );
  if (jest) {
    const failed = Number(jest[1] ?? 0);
    const skipped = Number(jest[2] ?? 0);
    const passed = Number(jest[3] ?? 0);
    const total = Number(jest[4] ?? 0);
    results.push({
      name: "jest summary",
      outcome: failed > 0 ? "failed" : "passed",
      source: "counts",
    });
    return {
      results,
      totals: { passed, failed, skipped: skipped + Math.max(0, total - passed - failed - skipped) },
      empty: results.length === 0,
    };
  }

  // pytest summary line.
  const pytest = /(\d+)\s*passed(?:,\s*(\d+)\s*failed)?(?:,\s*(\d+)\s*skipped)?/i.exec(output);
  if (pytest && /pytest|in\s+\d+\.\d+s/i.test(output)) {
    const passed = Number(pytest[1] ?? 0);
    const failed = Number(pytest[2] ?? 0);
    const skipped = Number(pytest[3] ?? 0);
    results.push({
      name: "pytest summary",
      outcome: failed > 0 ? "failed" : "passed",
      source: "counts",
    });
    return { results, totals: { passed, failed, skipped }, empty: false };
  }

  // node --test's own summary block.
  const nodePassed = /ℹ\s*pass\s+(\d+)/.exec(output);
  const nodeFailed = /ℹ\s*fail\s+(\d+)/.exec(output);
  if (nodePassed || nodeFailed) {
    const passed = Number(nodePassed?.[1] ?? 0);
    const failed = Number(nodeFailed?.[1] ?? 0);
    results.push({
      name: "node --test summary",
      outcome: failed > 0 ? "failed" : "passed",
      source: "node-test",
    });
    return { results, totals: { passed, failed, skipped: 0 }, empty: false };
  }

  return { results, empty: results.length === 0 };
}

/**
 * Compare a claimed test result against what the transcript shows.
 *
 * Returns the disagreements, not a boolean: a caller needs to report which
 * claim was unsupported, not merely that something was.
 */
export function reconcileClaimedWithParsed(
  claimed: Array<{ name: string; outcome: string }>,
  parsed: ParsedOutput,
): string[] {
  const problems: string[] = [];
  if (parsed.empty) {
    if (claimed.length > 0) {
      problems.push(`the command output contains no test result, but ${claimed.length} were claimed`);
    }
    return problems;
  }

  const parsedPassed = parsed.results.filter((r) => r.outcome === "passed").length;
  const parsedFailed = parsed.results.filter((r) => r.outcome === "failed").length;
  const claimedPassed = claimed.filter((c) => c.outcome === "passed").length;
  const claimedFailed = claimed.filter((c) => c.outcome === "failed").length;

  if (claimedFailed > 0 && parsedFailed === 0 && parsedPassed > 0) {
    problems.push(`the output shows ${parsedPassed} passing and 0 failing, but ${claimedFailed} failures were claimed`);
  }
  if (claimedPassed > 0 && parsedFailed > 0) {
    problems.push(`the output shows ${parsedFailed} failing, but the claim reports ${claimedPassed} passing and no failure`);
  }
  if (parsed.totals) {
    if (claimedPassed > 0 && parsed.totals.passed === 0) {
      problems.push("the output totals show no passing test, but a pass was claimed");
    }
  }
  return problems;
}
