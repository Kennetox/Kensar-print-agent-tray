const healthBadge = document.getElementById("healthBadge");
const printerUrlInput = document.getElementById("printerUrlInput");
const formatInput = document.getElementById("formatInput");
const saveConfigBtn = document.getElementById("saveConfigBtn");
const testPrintBtn = document.getElementById("testPrintBtn");
const refreshBtn = document.getElementById("refreshBtn");
const statusMessage = document.getElementById("statusMessage");
const discoverBtn = document.getElementById("discoverBtn");
const discoverMeta = document.getElementById("discoverMeta");
const printersTableBody = document.getElementById("printersTableBody");

function setStatus(message, type = "neutral") {
  statusMessage.textContent = message || "";
  statusMessage.className = "status";
  if (type === "ok") statusMessage.classList.add("ok");
  if (type === "error") statusMessage.classList.add("error");
}

async function httpJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.detail || data?.error || `Error ${res.status}`);
  }
  return data;
}

function renderPrinters(printers) {
  if (!printers.length) {
    printersTableBody.innerHTML =
      '<tr><td colspan="4" class="empty">No se detectaron impresoras.</td></tr>';
    return;
  }
  printersTableBody.innerHTML = printers
    .map(
      (printer) => `
        <tr>
          <td>${printer.ip}</td>
          <td>${printer.port}</td>
          <td><code>${printer.url}</code></td>
          <td><button data-url="${printer.url}" class="use-printer-btn">Usar</button></td>
        </tr>
      `
    )
    .join("");

  document.querySelectorAll(".use-printer-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const url = button.getAttribute("data-url");
      if (!url) return;
      try {
        await httpJson("/printers/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        printerUrlInput.value = url;
        setStatus(`Impresora seleccionada: ${url}`, "ok");
      } catch (error) {
        setStatus(error.message, "error");
      }
    });
  });
}

async function loadHealth() {
  try {
    const health = await httpJson("/health");
    healthBadge.textContent = "Agente online";
    healthBadge.className = "badge ok";
    discoverMeta.textContent = `Config: ${health.configPath}`;
  } catch {
    healthBadge.textContent = "Agente offline";
    healthBadge.className = "badge error";
  }
}

async function loadConfig() {
  const response = await httpJson("/config");
  printerUrlInput.value = response.config.selectedPrinterUrl || "";
  formatInput.value = response.config.format || "Kensar";
}

async function discoverPrinters() {
  setStatus("Buscando impresoras en la red...");
  const response = await httpJson("/printers/discover");
  renderPrinters(response.printers || []);
  const count = (response.printers || []).length;
  discoverMeta.textContent = `Ultimo escaneo: ${new Date(
    response.updatedAt
  ).toLocaleString()} · Detectadas: ${count}`;
  setStatus(count ? `Se detectaron ${count} impresora(s).` : "Sin impresoras detectadas.");
}

async function saveConfig() {
  const selectedPrinterUrl = printerUrlInput.value.trim();
  const format = formatInput.value.trim() || "Kensar";
  if (!selectedPrinterUrl) {
    setStatus("Debes ingresar la URL de la impresora.", "error");
    return;
  }
  await httpJson("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selectedPrinterUrl, format }),
  });
  setStatus("Configuracion guardada.", "ok");
}

async function testPrint() {
  const format = (formatInput.value || "Kensar").trim();
  const payload = [
    {
      CODIGO: "3519",
      BARRAS: "3519",
      NOMBRE: "Test Agent",
      PRECIO: "$22.000",
      format,
      copies: 1,
    },
  ];

  await httpJson("/print", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  setStatus("Impresion de prueba enviada.", "ok");
}

saveConfigBtn.addEventListener("click", async () => {
  try {
    await saveConfig();
  } catch (error) {
    setStatus(error.message, "error");
  }
});

testPrintBtn.addEventListener("click", async () => {
  try {
    setStatus("Enviando prueba...");
    await testPrint();
  } catch (error) {
    setStatus(error.message, "error");
  }
});

refreshBtn.addEventListener("click", async () => {
  try {
    await loadHealth();
    await loadConfig();
    setStatus("Estado actualizado.", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

discoverBtn.addEventListener("click", async () => {
  try {
    await discoverPrinters();
  } catch (error) {
    setStatus(error.message, "error");
  }
});

async function init() {
  try {
    await loadHealth();
    await loadConfig();
    const data = await httpJson("/printers");
    renderPrinters((data.discovered && data.discovered.printers) || []);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

init();
