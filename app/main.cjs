const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { resolveStateDir, startPanel } = require("./panel-host.cjs");

/**
 * The desktop shell. It starts the same pipeline panel server that the browser
 * build uses, then opens a native window pointed at it. Closing the window
 * shuts the server down.
 */

const repoRoot = path.resolve(__dirname, "..");
const stateDir = resolveStateDir(repoRoot);

app.whenReady().then(async () => {
  let panel;
  try {
    const started = await startPanel({ repoRoot, stateDir, port: 0 });
    panel = started.panel;

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
