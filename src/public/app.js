const healthBadge = document.getElementById("healthBadge");
const printerUrlInput = document.getElementById("printerUrlInput");
const formatInput = document.getElementById("formatInput");
const saveConfigBtn = document.getElementById("saveConfigBtn");
const testPrintBtn = document.getElementById("testPrintBtn");
const refreshBtn = document.getElementById("refreshBtn");
const statusMessage = document.getElementById("statusMessage");
const discoverBtn = document.getElementById("discoverBtn");
const discoverMeta = document.getElementById("discoverMeta");
const discoverResults = document.getElementById("discoverResults");
const printersTableBody = document.getElementById("printersTableBody");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildLoadingRingSvg(size = 18) {
  const center = size / 2;
  const maxThickness = Math.max(6, size * 0.18);
  const minThickness = Math.max(1.5, size * 0.025);
  const outerRadius = center - 1;
  const startDeg = -104;
  const endDeg = 200;
  const segments = 70;

  const toXY = (deg, radius) => {
    const rad = (deg * Math.PI) / 180;
    return { x: center + radius * Math.cos(rad), y: center + radius * Math.sin(rad) };
  };

  const outerPoints = [];
  const innerPoints = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const angle = startDeg + (endDeg - startDeg) * t;
    const thickness = minThickness + (maxThickness - minThickness) * t;
    const outer = toXY(angle, outerRadius);
    const inner = toXY(angle, outerRadius - thickness);
    outerPoints.push(`${outer.x.toFixed(3)},${outer.y.toFixed(3)}`);
    innerPoints.push(`${inner.x.toFixed(3)},${inner.y.toFixed(3)}`);
  }

  const pathD = `M ${outerPoints.join(" L ")} L ${innerPoints.reverse().join(" L ")} Z`;
  const startMid = toXY(startDeg, outerRadius - minThickness / 2);
  const endMid = toXY(endDeg, outerRadius - maxThickness / 2);

  return `
    <span class="loading-ring" style="width:${size}px;height:${size}px" aria-hidden="true">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <defs>
          <linearGradient id="metrik-spinner-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#10b981"></stop>
            <stop offset="100%" stop-color="#6ee7b7"></stop>
          </linearGradient>
        </defs>
        <path d="${pathD}" fill="url(#metrik-spinner-gradient)"></path>
        <circle cx="${startMid.x}" cy="${startMid.y}" r="${minThickness / 2}" fill="#5fdab4"></circle>
        <circle cx="${endMid.x}" cy="${endMid.y}" r="${maxThickness / 2}" fill="#1fc68e"></circle>
      </svg>
    </span>
  `;
}

function setStatus(message, type = "neutral", loading = false) {
  const safeMessage = escapeHtml(message || "");
  statusMessage.innerHTML = loading
    ? `${buildLoadingRingSvg(18)}<span>${safeMessage}</span>`
    : safeMessage;
  statusMessage.className = "status";
  if (type === "ok") statusMessage.classList.add("ok");
  if (type === "error") statusMessage.classList.add("error");
  if (loading) statusMessage.classList.add("loading");
}

function setButtonLoading(button, active, loadingText, idleText) {
  if (!button) return;
  if (active) {
    button.disabled = true;
    button.innerHTML = `${buildLoadingRingSvg(16)}<span>${escapeHtml(loadingText)}</span>`;
    return;
  }
  button.disabled = false;
  button.textContent = idleText;
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
  discoverResults.classList.remove("hidden");
  discoverMeta.textContent = "";
  printersTableBody.innerHTML = `<tr><td colspan="4" class="empty loading-inline">${buildLoadingRingSvg(18)}<span>Buscando impresoras...</span></td></tr>`;
  setButtonLoading(discoverBtn, true, "Buscando...", "Buscar impresoras");
  setStatus("Buscando impresoras en la red...", "neutral", true);
  try {
    const response = await httpJson(`/printers/discover?force=true&timeoutMs=700&t=${Date.now()}`);
    renderPrinters(response.printers || []);
    const count = (response.printers || []).length;
    discoverMeta.textContent = `Ultimo escaneo: ${new Date(
      response.updatedAt
    ).toLocaleString()} · Detectadas: ${count}`;

    if (response.throttled) {
      setStatus("Escaneo limitado temporalmente. Mostrando resultado reciente.");
      return;
    }
    if (response.cached) {
      setStatus("Mostrando resultado reciente de autodeteccion.");
      return;
    }
    setStatus(count ? `Se detectaron ${count} impresora(s).` : "Sin impresoras detectadas.");
  } finally {
    setButtonLoading(discoverBtn, false, "Buscando...", "Buscar impresoras");
  }
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
    setButtonLoading(saveConfigBtn, true, "Guardando...", "Guardar configuracion");
    setStatus("Guardando configuracion...", "neutral", true);
    await saveConfig();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setButtonLoading(saveConfigBtn, false, "Guardando...", "Guardar configuracion");
  }
});

testPrintBtn.addEventListener("click", async () => {
  try {
    setButtonLoading(testPrintBtn, true, "Imprimiendo...", "Imprimir prueba");
    setStatus("Enviando prueba...", "neutral", true);
    await testPrint();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setButtonLoading(testPrintBtn, false, "Imprimiendo...", "Imprimir prueba");
  }
});

refreshBtn.addEventListener("click", async () => {
  try {
    setButtonLoading(refreshBtn, true, "Cargando...", "Refrescar estado");
    setStatus("Actualizando estado...", "neutral", true);
    await loadHealth();
    await loadConfig();
    setStatus("Estado actualizado.", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setButtonLoading(refreshBtn, false, "Cargando...", "Refrescar estado");
  }
});

discoverBtn.addEventListener("click", async () => {
  try {
    await discoverPrinters();
  } catch (error) {
    setStatus(error.message, "error");
    setButtonLoading(discoverBtn, false, "Buscando...", "Buscar impresoras");
  }
});

async function init() {
  try {
    setStatus("Cargando configuracion inicial...", "neutral", true);
    await loadHealth();
    await loadConfig();
    setStatus("Estado listo.", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

init();
