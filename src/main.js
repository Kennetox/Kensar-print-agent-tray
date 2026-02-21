const path = require("path");
const { app, Tray, Menu, shell, nativeImage, Notification } = require("electron");
const { startAgent, stopAgent } = require("./service");

const AGENT_UI_URL = "http://127.0.0.1:5177/ui";

let tray = null;
let isQuitting = false;
let agentState = {
  running: false,
  selectedPrinterUrl: "",
  port: 5177,
};

function getIcon() {
  const iconPath = path.join(__dirname, "assets", process.platform === "win32" ? "tray.ico" : "trayTemplate.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    return nativeImage.createEmpty();
  }
  return icon;
}

function updateTrayMenu() {
  if (!tray) return;
  const statusLabel = agentState.running
    ? `Estado: Activo (impresora ${agentState.selectedPrinterUrl || "sin configurar"})`
    : "Estado: Detenido";

  const menu = Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: "separator" },
    {
      label: "Abrir configuracion",
      click: () => shell.openExternal(AGENT_UI_URL),
    },
    {
      label: "Reiniciar agente",
      click: async () => {
        await restartAgent();
      },
    },
    { type: "separator" },
    {
      label: "Salir",
      click: async () => {
        isQuitting = true;
        await stopAgent();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip("Kensar Print Agent");
}

async function startAgentSafe() {
  try {
    const info = await startAgent();
    agentState = {
      running: true,
      selectedPrinterUrl: info.selectedPrinterUrl || "",
      port: info.port || 5177,
    };
    updateTrayMenu();
    return true;
  } catch (error) {
    agentState.running = false;
    updateTrayMenu();
    new Notification({
      title: "Kensar Print Agent",
      body: `No se pudo iniciar el agente: ${error instanceof Error ? error.message : String(error)}`,
    }).show();
    return false;
  }
}

async function restartAgent() {
  await stopAgent();
  await startAgentSafe();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    shell.openExternal(AGENT_UI_URL);
  });

  app.whenReady().then(async () => {
    app.setLoginItemSettings({ openAtLogin: true });

    tray = new Tray(getIcon());
    tray.on("double-click", () => {
      shell.openExternal(AGENT_UI_URL);
    });

    await startAgentSafe();
    updateTrayMenu();
  });
}

app.on("before-quit", async (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  await stopAgent();
  app.quit();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});
