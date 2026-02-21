const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const https = require("https");

const AGENT_PORT = Number(process.env.AGENT_PORT || 5177);
const DEFAULT_PRINTER_URL = process.env.PRINTER_URL || "http://10.10.20.19:8081";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 3000);
const DISCOVERY_PORT = Number(process.env.DISCOVERY_PORT || 8081);
const DISCOVERY_TIMEOUT_MS = Number(process.env.DISCOVERY_TIMEOUT_MS || 350);
const DISCOVERY_CONCURRENCY = Number(process.env.DISCOVERY_CONCURRENCY || 48);

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".kensar-print-agent");
const PUBLIC_DIR = path.join(__dirname, "public");

let agentServer = null;
let agentConfig = null;
let discoveryCache = { updatedAt: null, printers: [] };

function getConfigPath(configDir) {
  return path.join(configDir, "config.json");
}

function ensureConfigDir(configDir) {
  fs.mkdirSync(configDir, { recursive: true });
}

function normalizePrinterUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const value = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `http://${raw}`;
  const parsed = new URL(value);
  return parsed.toString().replace(/\/$/, "");
}

function loadConfig(configDir) {
  ensureConfigDir(configDir);
  const configPath = getConfigPath(configDir);

  try {
    if (!fs.existsSync(configPath)) {
      return {
        selectedPrinterUrl: normalizePrinterUrl(DEFAULT_PRINTER_URL),
        format: "Kensar",
      };
    }

    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return {
      selectedPrinterUrl: normalizePrinterUrl(parsed.selectedPrinterUrl || DEFAULT_PRINTER_URL),
      format: typeof parsed.format === "string" && parsed.format.trim() ? parsed.format.trim() : "Kensar",
    };
  } catch {
    return {
      selectedPrinterUrl: normalizePrinterUrl(DEFAULT_PRINTER_URL),
      format: "Kensar",
    };
  }
}

function saveConfig(configDir, nextConfig) {
  ensureConfigDir(configDir);
  fs.writeFileSync(getConfigPath(configDir), JSON.stringify(nextConfig, null, 2), "utf8");
}

function isPrivateIpv4(ip) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const [a, b] = ip.split(".").map((x) => Number(x));
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function listSubnetPrefixes() {
  const nets = os.networkInterfaces();
  const prefixes = new Set();
  for (const iface of Object.values(nets)) {
    for (const addr of iface || []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (!isPrivateIpv4(addr.address)) continue;
      const octets = addr.address.split(".");
      prefixes.add(`${octets[0]}.${octets[1]}.${octets[2]}`);
    }
  }
  return [...prefixes];
}

function checkTcpOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function runPool(items, worker, concurrency) {
  const results = [];
  let index = 0;

  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  });

  await Promise.all(runners);
  return results;
}

async function discoverPrinters({ timeoutMs = DISCOVERY_TIMEOUT_MS, port = DISCOVERY_PORT } = {}) {
  const prefixes = listSubnetPrefixes();
  if (!prefixes.length) {
    discoveryCache = { updatedAt: new Date().toISOString(), printers: [] };
    return discoveryCache;
  }

  const ips = [];
  for (const prefix of prefixes) {
    for (let i = 1; i <= 254; i += 1) {
      ips.push(`${prefix}.${i}`);
    }
  }

  const checks = await runPool(
    ips,
    async (ip) => {
      const open = await checkTcpOpen(ip, port, timeoutMs);
      if (!open) return null;
      return { ip, port, url: `http://${ip}:${port}` };
    },
    DISCOVERY_CONCURRENCY
  );

  const printers = checks.filter(Boolean);
  discoveryCache = { updatedAt: new Date().toISOString(), printers };
  return discoveryCache;
}

function sendToPrinter(printerUrl, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url = new URL(printerUrl);
    const lib = url.protocol === "https:" ? https : http;

    const req = lib.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode || 0, body: data });
        });
      }
    );

    req.on("error", (err) => reject(err));

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Printer timeout (${REQUEST_TIMEOUT_MS}ms)`));
    });

    req.end(body);
  });
}

function sendUiFile(res, filename, contentType) {
  try {
    const filePath = path.join(PUBLIC_DIR, filename);
    const fileContent = fs.readFileSync(filePath);
    res.setHeader("Content-Type", contentType);
    res.send(fileContent);
  } catch (error) {
    res.status(500).json({
      error: "UI file error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function createApp(configDir) {
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get(["/", "/ui/", "/ui/index.html"], (_req, res) => {
    sendUiFile(res, "index.html", "text/html; charset=utf-8");
  });

  app.get("/ui", (_req, res) => {
    res.redirect(301, "/ui/");
  });

  app.get("/ui/styles.css", (_req, res) => {
    sendUiFile(res, "styles.css", "text/css; charset=utf-8");
  });

  app.get("/ui/app.js", (_req, res) => {
    sendUiFile(res, "app.js", "application/javascript; charset=utf-8");
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      mode: "local-agent-tray",
      selectedPrinterUrl: agentConfig.selectedPrinterUrl,
      configPath: getConfigPath(configDir),
      port: AGENT_PORT,
    });
  });

  app.get("/config", (_req, res) => {
    res.json({ ok: true, config: agentConfig, configPath: getConfigPath(configDir) });
  });

  app.post("/config", (req, res) => {
    try {
      const next = { ...agentConfig, ...(req.body || {}) };
      if (next.selectedPrinterUrl) {
        next.selectedPrinterUrl = normalizePrinterUrl(next.selectedPrinterUrl);
      }
      if (!next.selectedPrinterUrl) {
        return res.status(400).json({ error: "selectedPrinterUrl is required" });
      }
      if (typeof next.format !== "string" || !next.format.trim()) {
        next.format = "Kensar";
      } else {
        next.format = next.format.trim();
      }
      agentConfig = next;
      saveConfig(configDir, agentConfig);
      return res.json({ ok: true, config: agentConfig });
    } catch (error) {
      return res.status(500).json({
        error: "Could not save config",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/printers", (_req, res) => {
    res.json({ ok: true, selectedPrinterUrl: agentConfig.selectedPrinterUrl, discovered: discoveryCache });
  });

  app.get("/printers/discover", async (req, res) => {
    const timeoutMs = Number(req.query.timeoutMs || DISCOVERY_TIMEOUT_MS);
    const port = Number(req.query.port || DISCOVERY_PORT);

    try {
      const result = await discoverPrinters({ timeoutMs, port });
      return res.json({ ok: true, selectedPrinterUrl: agentConfig.selectedPrinterUrl, ...result });
    } catch (error) {
      return res.status(500).json({
        error: "Discovery failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/printers/select", (req, res) => {
    const raw = req.body?.url || req.body?.printerUrl || req.body?.ip;
    if (!raw) {
      return res.status(400).json({ error: "url or ip is required" });
    }

    const nextUrl = normalizePrinterUrl(raw.includes(":") ? raw : `${raw}:${DISCOVERY_PORT}`);
    if (!nextUrl) {
      return res.status(400).json({ error: "Invalid printer url/ip" });
    }

    agentConfig = { ...agentConfig, selectedPrinterUrl: nextUrl };
    saveConfig(configDir, agentConfig);

    return res.json({ ok: true, selectedPrinterUrl: agentConfig.selectedPrinterUrl });
  });

  app.post("/print", async (req, res) => {
    const printerUrl =
      typeof req.query.printerUrl === "string" && req.query.printerUrl.length > 0
        ? normalizePrinterUrl(req.query.printerUrl)
        : agentConfig.selectedPrinterUrl || normalizePrinterUrl(DEFAULT_PRINTER_URL);

    if (!printerUrl) {
      return res.status(400).json({ error: "Missing printerUrl" });
    }

    try {
      const upstream = await sendToPrinter(printerUrl, req.body);
      if (upstream.status >= 200 && upstream.status < 300) {
        return res.json({ ok: true, printerUrl });
      }
      return res.status(502).json({
        error: `Printer error ${upstream.status}`,
        detail: upstream.body,
        printerUrl,
      });
    } catch (error) {
      return res.status(502).json({
        error: "Printer request failed",
        detail: error instanceof Error ? error.message : String(error),
        printerUrl,
      });
    }
  });

  return app;
}

async function startAgent() {
  if (agentServer) {
    return { port: AGENT_PORT, selectedPrinterUrl: agentConfig?.selectedPrinterUrl || "" };
  }

  const configDir = process.env.KENSAR_AGENT_CONFIG_DIR || DEFAULT_CONFIG_DIR;
  agentConfig = loadConfig(configDir);
  const app = createApp(configDir);

  await new Promise((resolve, reject) => {
    const server = app.listen(AGENT_PORT, "127.0.0.1", () => {
      agentServer = server;
      resolve();
    });
    server.on("error", reject);
  });

  return {
    port: AGENT_PORT,
    selectedPrinterUrl: agentConfig.selectedPrinterUrl,
    configPath: getConfigPath(configDir),
  };
}

async function stopAgent() {
  if (!agentServer) return;
  await new Promise((resolve) => {
    agentServer.close(() => resolve());
  });
  agentServer = null;
}

module.exports = {
  startAgent,
  stopAgent,
};
