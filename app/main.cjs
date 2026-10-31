const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");

/**
 * The desktop shell. It starts the same pipeline panel server that the browser
 * build uses, then opens a native window pointed at it. Closing the window
 * shuts the server down.
 */

const repoRoot = path.resolve(__dirname, "..");
const stateDir = process.env.PANEL_STATE
  ? path.resolve(process.env.PANEL_STATE)
  : path.join(repoRoot, "workflow-state");

fs.mkdirSync(stateDir, { recursive: true });

function startPanel() {
  return new Promise((resolve, reject) => {
    // Load the compiled server module. It is ESM; Electron's main process is
    // CommonJS by default, so load it dynamically.
    import(path.join(repoRoot, "dist", "workflow", "server.js"))
      .then(({ createPanel }) => {
        const panel = createPanel({ stateDir, port: 0, host: "127.0.0.1" });
        panel
          .start()
          .then((port) => resolve({ port, panel }))
          .catch(reject);
      })
      .catch(reject);
  });
}

app.whenReady().then(async () => {
  let panel;
  try {
    const started = await startPanel();
    panel = started.panel;
    const port = started.port;

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

    win.loadURL(`http://127.0.0.1:${port}/`);
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
