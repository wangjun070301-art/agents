import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/**
 * The Windows launchers.
 *
 * `bin/*` are `#!/bin/sh` scripts and Windows cannot run them, so P22 skipped
 * the launcher test there and P22's notes recorded the gap. The `.cmd`
 * counterparts are covered here, and the test is POSIX-skipped rather than
 * Windows-skipped: the thing under test only exists on Windows.
 */

const execute = promisify(execFile);
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const windowsOnly = { skip: process.platform === "win32" ? false : "bin/*.cmd are Windows launchers" };

/**
 * `.cmd` files are not executables: CreateProcess cannot start them, so
 * execFile fails with EINVAL. They must go through the command interpreter.
 *
 * `/s /c ""file" args"` is the documented form: the outer pair of quotes lets
 * cmd strip exactly one layer, so a path with spaces survives. Passing the
 * arguments separately would let execFile re-quote them and the path would be
 * split again.
 */
function runLauncher(filename: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const comspec = process.env.ComSpec ?? "cmd.exe";
  const command = `""${filename}"${args.length ? " " + args.map((a) => `"${a}"`).join(" ") : ""}"`;
  // windowsVerbatimArguments stops Node from escaping the quotes itself, which
  // would turn them into \" and make cmd see a path that does not exist.
  return execute(comspec, ["/d", "/s", "/c", command], {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
}

/** A fixture install: bin/*.cmd, a dist/ with stub entries, and a .env. */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-cmd-"));
  const install = path.join(root, "fresh install with spaces");
  await fs.mkdir(path.join(install, "bin"), { recursive: true });
  await fs.mkdir(path.join(install, "dist", "platform"), { recursive: true });

  for (const name of await fs.readdir(path.join(source, "bin"))) {
    if (name.endsWith(".cmd")) {
      await fs.copyFile(path.join(source, "bin", name), path.join(install, "bin", name));
    }
  }

  const stub = (script: string) =>
    `console.log(JSON.stringify({script:${JSON.stringify(script)},` +
    `backend:process.env.WORKBUDDY_BACKEND,scopes:process.env.WORKBUDDY_OAUTH_SCOPES,` +
    `cwd:process.cwd(),callerCwd:process.env.AGENT_HUB_CALLER_CWD,args:process.argv.slice(2)}));\n`;

  for (const [name, script] of [
    ["server", "server"],
    ["desktop-worker-cli", "desktop-worker-cli"],
    ["doctor", "doctor"],
    ["service-cli", "service-cli"],
    ["deepseek-server", "deepseek-server"],
  ] as const) {
    await fs.writeFile(path.join(install, "dist", `${name}.js`), stub(script));
  }
  for (const name of ["cli", "mcp"]) {
    await fs.writeFile(path.join(install, "dist", "platform", `${name}.js`), stub(`platform/${name}`));
  }

  await fs.writeFile(
    path.join(install, ".env"),
    [
      "WORKBUDDY_BACKEND=desktop-queue",
      "WORKBUDDY_OAUTH_SCOPES=user.localassistant.invokable user.localassistant.readable",
      "# a comment the loader must skip",
      "",
      "  # an indented comment the loader must skip",
      "",
    ].join("\r\n"),
  );

  return { root, install };
}

test("every Windows launcher loads .env, keeps the project root, and forwards args", windowsOnly, async () => {
  const { root, install } = await fixture();
  try {
    const launchers = [
      ["workbuddy-gateway", "server"],
      ["workbuddy-worker", "desktop-worker-cli"],
      ["workbuddy-doctor", "doctor"],
      ["workbuddy-service", "service-cli"],
      ["agent-hub", "platform/cli"],
      ["agent-hub-mcp", "platform/mcp"],
      ["deepseek-gateway", "deepseek-server"],
    ] as const;

    for (const [launcher, script] of launchers) {
      const filename = path.join(install, "bin", `${launcher}.cmd`);
      const args = ["a", "b"];
      const result = await runLauncher(filename, args, { cwd: root });
      const actual = JSON.parse(result.stdout) as {
        script: string;
        backend?: string;
        scopes?: string;
        cwd: string;
        callerCwd?: string;
        args: string[];
      };
      assert.equal(actual.script, script, `${launcher} must run ${script}`);
      assert.equal(actual.cwd, install, `${launcher} must run from the project root`);
      assert.deepEqual(actual.args, args, `${launcher} must forward its arguments`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * The POSIX launchers source `.env` for the WorkBuddy-family launchers only;
 * `deepseek-gateway` deliberately does not. The Windows versions mirror that,
 * and this pins it so a later edit cannot quietly make them diverge.
 */
test("only the WorkBuddy-family launchers read .env", windowsOnly, async () => {
  const { root, install } = await fixture();
  try {
    const read = async (launcher: string) =>
      JSON.parse((await runLauncher(path.join(install, "bin", `${launcher}.cmd`), [], { cwd: root })).stdout) as {
        backend?: string;
        scopes?: string;
      };

    for (const launcher of ["workbuddy-gateway", "workbuddy-worker", "workbuddy-doctor", "workbuddy-service", "agent-hub", "agent-hub-mcp"]) {
      const actual = await read(launcher);
      assert.equal(actual.backend, "desktop-queue", `${launcher} must load WORKBUDDY_BACKEND from .env`);
      assert.equal(
        actual.scopes,
        "user.localassistant.invokable user.localassistant.readable",
        `${launcher} must load WORKBUDDY_OAUTH_SCOPES from .env`,
      );
    }

    const deepseek = await read("deepseek-gateway");
    assert.equal(deepseek.backend, undefined, "deepseek-gateway must not load .env");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("agent-hub records the caller's directory before changing into the root", windowsOnly, async () => {
  const { root, install } = await fixture();
  try {
    const caller = path.join(root, "caller");
    await fs.mkdir(caller, { recursive: true });
    const actual = JSON.parse(
      (await runLauncher(path.join(install, "bin", "agent-hub.cmd"), [], { cwd: caller })).stdout,
    ) as { cwd: string; callerCwd: string };
    assert.equal(actual.callerCwd, caller, "AGENT_HUB_CALLER_CWD must be the directory the user stood in");
    assert.equal(actual.cwd, install, "the launcher itself must run from the project root");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a launcher propagates the child's exit code", windowsOnly, async () => {
  const { root, install } = await fixture();
  try {
    await fs.writeFile(path.join(install, "dist", "server.js"), "process.exit(7);\n");
    const failure = await runLauncher(path.join(install, "bin", "workbuddy-gateway.cmd"), [], { cwd: root }).then(
      () => undefined,
      (error: { code?: number }) => error,
    );
    assert.ok(failure, "a non-zero child must make the launcher fail");
    assert.equal(failure.code, 7, "the child's exit code must survive the launcher");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workbuddy-doctor refuses to run before a build", windowsOnly, async () => {
  const { root, install } = await fixture();
  try {
    await fs.rm(path.join(install, "dist", "doctor.js"));
    const failure = await runLauncher(path.join(install, "bin", "workbuddy-doctor.cmd"), [], { cwd: root }).then(
      () => undefined,
      (error: { code?: number; stderr?: string }) => error,
    );
    assert.ok(failure, "doctor must fail when dist/doctor.js is missing");
    assert.equal(failure.code, 1);
    assert.match(failure.stderr ?? "", /npm run build/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * `workbuddy-cli` has no sensible Windows default: the POSIX version hardcodes
 * /Applications/WorkBuddy.app, and there is no equivalent. It refuses instead
 * of guessing, so a misconfigured install fails loudly.
 */
test("workbuddy-cli refuses without explicit Electron paths", windowsOnly, async () => {
  const { root, install } = await fixture();
  try {
    const failure = await runLauncher(path.join(install, "bin", "workbuddy-cli.cmd"), [], {
      cwd: root,
      env: { ...process.env, WORKBUDDY_CLI_ELECTRON: "", WORKBUDDY_CLI_SCRIPT: "" },
    }).then(
      () => undefined,
      (error: { code?: number; stderr?: string }) => error,
    );
    assert.ok(failure, "workbuddy-cli must fail without explicit paths");
    assert.equal(failure.code, 1);
    assert.match(failure.stderr ?? "", /WORKBUDDY_CLI_ELECTRON/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
