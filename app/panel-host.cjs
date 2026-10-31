const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

/**
 * The parts of the desktop shell that are worth testing.
 *
 * `main.cjs` needs Electron to run at all, so nothing in it can be exercised
 * headlessly. Everything that decides *what* to start lives here instead: how
 * the state directory is chosen, and how the panel is started. Electron's job
 * is reduced to making a window and pointing it at the result.
 */

/**
 * Where the panel keeps its state.
 *
 * `PANEL_STATE` wins when set, so a second instance can run against a
 * different directory. Otherwise the state lives next to the repo, which is
 * what `tools/panel.mjs` and the docs already assume.
 */
function resolveStateDir(repoRoot, env = process.env) {
  const configured = env.PANEL_STATE;
  return configured ? path.resolve(configured) : path.join(repoRoot, "workflow-state");
}

/**
 * Start the panel on an ephemeral port and report the one it actually bound.
 *
 * Port 0 is deliberate: two instances (a browser tab and the desktop shell,
 * or two shells) must not fight over 18493. The caller needs the real port,
 * not the requested one, or the window would load a URL nothing listens on.
 */
async function startPanel({ repoRoot, stateDir, host = "127.0.0.1", port = 0 }) {
  fs.mkdirSync(stateDir, { recursive: true });
  // The server is ESM and Electron's main process is CommonJS, so load it
  // dynamically. Keeping that here means main.cjs has no module-format
  // gymnastics of its own.
  // `import()` needs a URL, not a filesystem path. On Windows an absolute path
  // like C:\... is read as a URL with the scheme "c:", which fails with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME. pathToFileURL is what makes this portable.
  const moduleUrl = pathToFileURL(path.join(repoRoot, "dist", "workflow", "server.js")).href;
  const { createPanel } = await import(moduleUrl);
  const panel = createPanel({ stateDir, port, host });
  const bound = await panel.start();
  return {
    panel,
    port: bound,
    url: `http://${host}:${bound}/`,
  };
}

module.exports = { resolveStateDir, startPanel };
