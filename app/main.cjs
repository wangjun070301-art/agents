const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { resolveStateDir, startPanel } = require("./panel-host.cjs");

/**
 * The desktop shell. It starts the same pipeline panel server that the browser
 * build uses, then opens a native window pointed at it. Closing the window
 * shuts the server down.
 */

/**
 * Where the panel's own files live.
 *
 * In the source tree `main.cjs` sits in `app/`, one level below `dist/`, so
 * the root is its parent. In a packaged build the whole project is copied into
 * `resources/app/`, and `__dirname` is already the root. Probing for the
 * compiled server distinguishes the two without a build-time flag.
 */
const repoRoot = fs.existsSync(path.join(__dirname, "dist", "workflow", "server.js"))
  ? __dirname
  : path.resolve(__dirname, "..");
const stateDir = resolveStateDir(repoRoot);

app.whenReady().then(async () => {
  let panel;
  try {
    const started = await startPanel({ repoRoot, stateDir, port: 0 });
    panel = started.panel;
    console.log(`[app] panel: ${started.url}`);

    const win = new BrowserWindow({
      width: 1500,
      height: 950,
      minWidth: 1024,
      minHeight: 700,
      backgroundColor: "#0e1117",
      title: "流水线控制台",
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    /**
     * A smoke run is the only way to prove the shell works without a human
     * looking at it: load the page, report whether it rendered, and quit. It
     * is opt-in so a normal launch still behaves like an app.
     */
    const smoke = process.env.PANEL_SMOKE === "1";

    win.webContents.on("did-finish-load", async () => {
      console.log("[app] window: loaded");
      if (smoke) {
        // Loading the page is not the same as the panel rendering. Ask the
        // renderer whether its own markup and data arrived, so a blank window
        // cannot pass as a working one.
        //
        // `did-finish-load` fires when the HTML is parsed, which is before the
        // renderer's own `load()` fetch resolves. Poll until the stage map is
        // drawn or the budget runs out, so this is a real check rather than a
        // race that passes on a fast machine and fails on a slow one.
        const readState = () =>
          win.webContents.executeJavaScript(`
            ({
              title: document.title,
              hasStageMap: !!document.getElementById('stageMap'),
              hasNextStages: !!document.getElementById('nextStages'),
              stageRows: document.querySelectorAll('.stage-row').length,
              gates: document.querySelectorAll('.gate').length,
              stageHint: document.getElementById('stageHint').textContent,
            })
          `);
        try {
          let rendered = await readState();
          for (let attempt = 0; attempt < 40 && rendered.stageRows !== 13; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            rendered = await readState();
          }
          const ok =
            rendered.hasStageMap &&
            rendered.hasNextStages &&
            rendered.stageRows === 13 &&
            rendered.gates === 6 &&
            /当前阶段/.test(rendered.stageHint);
          console.log(`[app] render: ${JSON.stringify(rendered)}`);
          console.log(ok ? "[app] smoke: ok" : "[app] smoke: render incomplete");
          panel.stop().catch(() => {});
          app.exit(ok ? 0 : 1);
        } catch (error) {
          console.error(`[app] render: threw ${error instanceof Error ? error.message : String(error)}`);
          panel.stop().catch(() => {});
          app.exit(1);
        }
      }
    });

    win.webContents.on("did-fail-load", (_event, code, description) => {
      console.error(`[app] window: failed to load (${code}) ${description}`);
      if (smoke) {
        panel.stop().catch(() => {});
        app.exit(1);
      }
    });

    win.loadURL(started.url);
    win.on("closed", () => {
      panel.stop().catch(() => {});
      app.quit();
    });
  } catch (error) {
    console.error("panel failed to start:", error);
    app.exit(1);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
