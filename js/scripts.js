/* =========================================================
   Drive Gigante — scripts.js (versión limpia + mejoras)
   - Multi-cuenta (localStorage)
   - Silent reauth + retry 401/403 (sin alerts feos)
   - Toast (usa #toast en tu HTML)
   - Actualizar una / todas
   - List/Grid + filtros + búsqueda
   - Thumbs lazy para imágenes (sin forzar popup)
   ========================================================= */

// =====================
// 1) CONFIG
// =====================
const CLIENT_ID = "685537038231-mfoljus3n4susmv36bvl7mnf2kuslcc1.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const OIDC_SCOPES = "openid email profile";
const SCOPES = `${DRIVE_SCOPE} ${OIDC_SCOPES}`;
const LS_KEY = "drive_gigante_accounts_v1";

// =====================
// 2) STATE
// =====================
let accounts = loadAccounts();
let tokenClient = null;

let uiState = {
  viewMode: "all_grouped", // all_grouped | all_flat | single
  accountPick: "",
  typeFilter: "all",
  layoutMode: "list", // list | grid
  search: ""
};

// =====================
// 3) HELPERS (storage, ui)
// =====================
function loadAccounts() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { return []; }
}
function saveAccounts() { localStorage.setItem(LS_KEY, JSON.stringify(accounts)); }

function uid() { return Math.random().toString(16).slice(2) + Date.now().toString(16); }
function isExpired(a) { return !a.access_token || Date.now() > (a.expires_at - 30_000); }

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function fmtBytesStrInt64(x) {
  if (!x) return "0 B";
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(2)} ${units[u]}`;
}

function sumTotals() {
  let limit = 0, usageInDrive = 0;
  for (const a of accounts) {
    if (a.storage?.limit) limit += Number(a.storage.limit);
    if (a.storage?.usageInDrive) usageInDrive += Number(a.storage.usageInDrive);
  }
  const free = Math.max(0, limit - usageInDrive);
  return { limit, usageInDrive, free };
}

function setLoading(on) {
  const pill = document.getElementById("loadingPill");
  if (!pill) return;
  pill.style.display = on ? "inline-flex" : "none";
}

// Toast (requiere <div id="toast"> en el HTML)
function showToast(msg, ms = 3200) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.classList.remove("show");
    el.style.display = "none";
  }, ms);
}

// =====================
// 4) AUTH (GIS)
// =====================
function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: () => {}
  });
}

function requestAccessToken({ prompt, hint } = {}) {
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => (resp.error ? reject(resp) : resolve(resp));
    const opts = {};
    if (prompt != null) opts.prompt = prompt;
    if (hint && hint.includes("@")) opts.hint = hint;
    tokenClient.requestAccessToken(opts);
  });
}

// Agregar/reconectar: forzar consentimiento
function requestTokenConsent(hintEmail) {
  return requestAccessToken({ prompt: "consent", hint: hintEmail });
}

// Renovar: intento silencioso
function requestTokenSilent(hintEmail) {
  return requestAccessToken({ prompt: "", hint: hintEmail });
}

async function getUserInfo(token) {
  const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  return await r.json();
}

/**
 * ensureToken(a, allowInteractive)
 * - allowInteractive=false: NO abre popup, solo silent (ideal para llamadas automáticas)
 * - allowInteractive=true: si silent falla, permite popup (ideal cuando hay click del usuario)
 */
async function ensureToken(a, allowInteractive = false) {
  if (!isExpired(a)) return;

  // 1) silent
  try {
    const resp = await requestTokenSilent(a.label);
    a.access_token = resp.access_token;
    a.expires_at = Date.now() + (resp.expires_in * 1000);
    a.needsReconnect = false;
    saveAccounts();
    return;
  } catch (e) {
    // no hacemos nada todavía
  }

  // 2) popup solo si fue provocado por el usuario
  if (!allowInteractive) {
    a.needsReconnect = true;
    saveAccounts();
    throw new Error("TOKEN_EXPIRED_NEEDS_INTERACTIVE");
  }

  const resp = await requestTokenConsent(a.label);
  a.access_token = resp.access_token;
  a.expires_at = Date.now() + (resp.expires_in * 1000);
  a.needsReconnect = false;
  saveAccounts();
}

// =====================
// 5) API FETCH con retry
// =====================
function isAuthError(status, bodyText = "") {
  if (status === 401) return true;
  if (status === 403 && (bodyText.includes("insufficient") || bodyText.includes("Invalid Credentials"))) return true;
  return false;
}

async function apiFetchAccount(a, url, opts = {}, { allowInteractive = false, retry = true } = {}) {
  // asegurar token (silent y si allowInteractive=true, permite popup)
  await ensureToken(a, allowInteractive);

  // 1er intento
  let r = await fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      Authorization: `Bearer ${a.access_token}`
    }
  });

  if (r.ok) return r;

  const txt = await r.text().catch(() => "");
  if (!isAuthError(r.status, txt) || !retry) {
    throw new Error(`API error ${r.status}: ${txt}`);
  }

  // si es auth: intentar renovar (silent; popup solo si allowInteractive)
  try {
    await ensureToken(a, allowInteractive);
  } catch {
    a.needsReconnect = true;
    saveAccounts();
    renderAccounts(); // refrescar UI
    showToast(`Sesión vencida en ${a.label}. Tocá “Reconectar”.`);
    throw new Error(`Auth error ${r.status}: ${txt}`);
  }

  // retry una vez
  r = await fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      Authorization: `Bearer ${a.access_token}`
    }
  });

  if (!r.ok) {
    const txt2 = await r.text().catch(() => "");
    a.needsReconnect = true;
    saveAccounts();
    renderAccounts();
    showToast(`No se pudo renovar ${a.label}. Tocá “Reconectar”.`);
    throw new Error(`API error ${r.status}: ${txt2}`);
  }

  a.needsReconnect = false;
  saveAccounts();
  return r;
}

// =====================
// 6) DRIVE API
// =====================
async function getStorageQuota(a, allowInteractive = false) {
  const url = "https://www.googleapis.com/drive/v3/about?fields=storageQuota";
  const r = await apiFetchAccount(a, url, {}, { allowInteractive });
  const data = await r.json();
  return data.storageQuota;
}

async function listAllFiles(a, allowInteractive = false) {
  let files = [];
  let pageToken = "";
  const fields = "nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,iconLink,webViewLink)";

  do {
    const params = new URLSearchParams({
      q: "trashed=false",
      pageSize: "1000",
      fields
    });
    if (pageToken) params.set("pageToken", pageToken);

    const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
    const r = await apiFetchAccount(a, url, {}, { allowInteractive });
    const data = await r.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);

  return files;
}

// download helpers
function isGoogleWorkspaceDoc(mimeType) {
  return (mimeType || "").startsWith("application/vnd.google-apps.");
}

function defaultExportMime(mimeType) {
  switch (mimeType) {
    case "application/vnd.google-apps.document": return { mime: "application/pdf", ext: "pdf" };
    case "application/vnd.google-apps.spreadsheet": return { mime: "application/pdf", ext: "pdf" };
    case "application/vnd.google-apps.presentation": return { mime: "application/pdf", ext: "pdf" };
    default: return { mime: "application/pdf", ext: "pdf" };
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

async function downloadFile(a, file) {
  // descarga suele ser por click -> allowInteractive=true
  if (isGoogleWorkspaceDoc(file.mimeType)) {
    const exp = defaultExportMime(file.mimeType);
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exp.mime)}`;
    const r = await apiFetchAccount(a, url, {}, { allowInteractive: true });
    const blob = await r.blob();
    triggerDownload(blob, `${file.name}.${exp.ext}`);
  } else {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`;
    const r = await apiFetchAccount(a, url, {}, { allowInteractive: true });
    const blob = await r.blob();
    triggerDownload(blob, file.name);
  }
}

// upload
async function uploadFileToAccount(accountId, fileObj, folderId) {
  const a = accounts.find(x => x.id === accountId);
  if (!a) throw new Error("Cuenta no encontrada");

  // upload es por click -> allowInteractive=true
  await ensureToken(a, true);

  const metadata = { name: fileObj.name };
  if (folderId && folderId.trim()) metadata.parents = [folderId.trim()];

  const boundary = "-------drivegigante" + Math.random().toString(16).slice(2);
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelim = `\r\n--${boundary}--`;

  const metaPart =
    delimiter +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata);

  const filePartHeader =
    delimiter +
    `Content-Type: ${fileObj.type || "application/octet-stream"}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${encodeURIComponent(fileObj.name)}"\r\n\r\n`;

  const blob = new Blob([metaPart, filePartHeader, fileObj, closeDelim], {
    type: `multipart/related; boundary=${boundary}`
  });

  const url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
  const r = await apiFetchAccount(a, url, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: blob
  }, { allowInteractive: true });

  return await r.json();
}

// =====================
// 7) THUMBNAILS (grid)
// =====================
function isImageMime(m) { return (m || "").startsWith("image/"); }

async function getImageThumbUrl(a, fileId) {
  if (!a.thumbCache) a.thumbCache = {};
  if (a.thumbCache[fileId]) return a.thumbCache[fileId];

  // thumbs NO deberían abrir popup -> allowInteractive=false
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const r = await apiFetchAccount(a, url, {}, { allowInteractive: false, retry: true });
  const blob = await r.blob();

  const objUrl = URL.createObjectURL(blob);
  a.thumbCache[fileId] = objUrl;
  saveAccounts();
  return objUrl;
}

// =====================
// 8) ACCOUNTS OPS
// =====================
async function addAccount() {
  setLoading(true);
  try {
    const resp = await requestTokenConsent(null);
    const access_token = resp.access_token;
    const expires_at = Date.now() + (resp.expires_in * 1000);

    const a = {
      id: uid(),
      label: `Cuenta ${accounts.length + 1}`,
      access_token,
      expires_at,
      storage: null,
      filesCache: null,
      thumbCache: {},
      needsReconnect: false
    };

    try {
      const u = await getUserInfo(access_token);
      if (u?.email) a.label = u.email;
    } catch {}

    // con click -> allowInteractive=true
    a.storage = await getStorageQuota(a, true);

    accounts.push(a);
    saveAccounts();
    renderAll();
    showToast(`Cuenta agregada: ${a.label}`);
  } finally {
    setLoading(false);
  }
}

async function reconnectAccount(accountId) {
  const a = accounts.find(x => x.id === accountId);
  if (!a) return;

  setLoading(true);
  try {
    const resp = await requestTokenConsent(a.label);
    a.access_token = resp.access_token;
    a.expires_at = Date.now() + (resp.expires_in * 1000);
    a.needsReconnect = false;

    a.storage = await getStorageQuota(a, true);
    saveAccounts();
    renderAll();
    showToast(`Reconectado: ${a.label}`);
  } finally {
    setLoading(false);
  }
}

function removeAccount(accountId) {
  const a = accounts.find(x => x.id === accountId);
  if (a?.thumbCache) {
    Object.values(a.thumbCache).forEach(u => { try { URL.revokeObjectURL(u); } catch {} });
  }
  accounts = accounts.filter(x => x.id !== accountId);
  saveAccounts();
  renderAll();
}

// =====================
// 9) UI BINDINGS
// =====================
const elAccounts = document.getElementById("accounts");
const elFiles = document.getElementById("files");
const elUploadAccount = document.getElementById("uploadAccount");
const elFolderId = document.getElementById("folderId");
const elFileInput = document.getElementById("fileInput");

const elStatUsed = document.getElementById("statUsed");
const elStatFree = document.getElementById("statFree");
const elStatTotal = document.getElementById("statTotal");

// filters
const elViewMode = document.getElementById("viewMode");
const elAccountPick = document.getElementById("accountPick");
const elSingleAccountWrap = document.getElementById("singleAccountWrap");
const elTypeFilter = document.getElementById("typeFilter");
const elSearch = document.getElementById("search");
const elLayoutMode = document.getElementById("layoutMode");

// menu / panels
const btnHamburger = document.getElementById("btnHamburger");
const topNav = document.getElementById("topNav");
const panelAccounts = document.getElementById("panelAccounts");
const panelUpload = document.getElementById("panelUpload");

// nav buttons
document.getElementById("btnAdd").onclick = () => addAccount().catch(errUI);
document.getElementById("btnRefreshAll").onclick = () => refreshAll().catch(errUI);
document.getElementById("btnUpload").onclick = () => doUpload().catch(errUI);

// toggles
document.getElementById("btnToggleAccounts").onclick = () => toggleAccounts(true);
document.getElementById("btnCloseAccounts").onclick = () => toggleAccounts(false);
document.getElementById("btnToggleUpload").onclick = () => toggleUpload(true);
document.getElementById("btnCloseUpload").onclick = () => toggleUpload(false);

btnHamburger.onclick = () => topNav.classList.toggle("open");

document.addEventListener("click", (e) => {
  if (!topNav.classList.contains("open")) return;
  const ham = document.getElementById("btnHamburger");
  if (topNav.contains(e.target) || ham.contains(e.target)) return;
  topNav.classList.remove("open");
});

// filter listeners
elViewMode.onchange = () => {
  uiState.viewMode = elViewMode.value;
  elSingleAccountWrap.style.display = (uiState.viewMode === "single") ? "" : "none";
  renderFiles();
};
elAccountPick.onchange = () => { uiState.accountPick = elAccountPick.value; renderFiles(); };
elTypeFilter.onchange = () => { uiState.typeFilter = elTypeFilter.value; renderFiles(); };
elLayoutMode.onchange = () => { uiState.layoutMode = elLayoutMode.value; renderFiles(); };
elSearch.oninput = () => { uiState.search = elSearch.value || ""; renderFiles(); };

function toggleAccounts(open) { panelAccounts.classList.toggle("open", open); }
function toggleUpload(open) { panelUpload.style.display = open ? "" : "none"; }

function errUI(e) {
  console.error(e);
  // nada de alerts feos: usamos toast
  const msg = e?.message || String(e);
  if (msg.includes("TOKEN_EXPIRED_NEEDS_INTERACTIVE")) {
    showToast("Sesión vencida. Tocá “Reconectar” en la cuenta.");
    return;
  }
  showToast(msg);
}

// =====================
// 10) RENDER
// =====================
function renderAll() {
  renderStats();
  renderAccounts();
  renderUploadSelects();
  renderFilters();
  renderFiles();
}

function renderStats() {
  const t = sumTotals();
  elStatUsed.textContent = fmtBytesStrInt64(String(t.usageInDrive));
  elStatFree.textContent = fmtBytesStrInt64(String(t.free));
  elStatTotal.textContent = fmtBytesStrInt64(String(t.limit));
}

function renderAccounts() {
  if (!accounts.length) {
    elAccounts.innerHTML = `<div class="hint">No hay cuentas agregadas.</div>`;
    return;
  }

  elAccounts.innerHTML = accounts.map(a => {
    const s = a.storage || {};
    const badge = a.needsReconnect
      ? `<div class="badgeWarn" style="margin-top:6px;">Requiere reconectar</div>`
      : ``;

    return `
      <div class="accCard">
        <div class="accTop">
          <div>
            <div class="accEmail">${escapeHtml(a.label)}</div>
            ${badge}
            <div class="accSmall">
              Drive usado: ${fmtBytesStrInt64(s.usageInDrive)} / ${fmtBytesStrInt64(s.limit)}<br/>
              Papelera: ${fmtBytesStrInt64(s.usageInDriveTrash)}
            </div>
          </div>
          <div class="accActions">
            <button class="btnSmall" onclick="window.reconnect('${a.id}')">Reconectar</button>
            <button class="btnSmall btnDanger" onclick="window.removeAcc('${a.id}')">Quitar</button>
          </div>
        </div>

        <div style="margin-top:10px;">
          <button class="btnSmall" onclick="window.refreshOne('${a.id}')">Actualizar archivos</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderUploadSelects() {
  elUploadAccount.innerHTML = accounts.map(a =>
    `<option value="${a.id}">${escapeHtml(a.label)}</option>`
  ).join("");
}

function renderFilters() {
  elAccountPick.innerHTML = accounts.map(a =>
    `<option value="${a.id}">${escapeHtml(a.label)}</option>`
  ).join("");

  if (!uiState.accountPick && accounts[0]) uiState.accountPick = accounts[0].id;
  elAccountPick.value = uiState.accountPick;

  elViewMode.value = uiState.viewMode;
  elTypeFilter.value = uiState.typeFilter;
  elLayoutMode.value = uiState.layoutMode;
  elSearch.value = uiState.search;

  elSingleAccountWrap.style.display = (uiState.viewMode === "single") ? "" : "none";
}

// =====================
// 11) DATA OPS
// =====================
async function refreshFilesForAccount(accountId) {
  const a = accounts.find(x => x.id === accountId);
  if (!a) return;

  setLoading(true);
  try {
    // click -> allowInteractive=true
    a.storage = await getStorageQuota(a, true);
    a.filesCache = await listAllFiles(a, true);
    a.needsReconnect = false;
    saveAccounts();
    renderAll();
    showToast(`Actualizado: ${a.label}`);
  } finally {
    setLoading(false);
  }
}

async function refreshAll() {
  if (!accounts.length) {
    showToast("No hay cuentas para refrescar.");
    return;
  }

  setLoading(true);
  try {
    for (const a of accounts) {
      // refresco por click -> allowInteractive=true
      a.storage = await getStorageQuota(a, true);
      a.filesCache = await listAllFiles(a, true);
      a.needsReconnect = false;
      saveAccounts();
      renderAll(); // feedback progresivo
    }
    showToast("Listo: refrescado de todas las cuentas.");
  } finally {
    setLoading(false);
  }
}

async function doUpload() {
  const accountId = elUploadAccount.value;
  const f = elFileInput.files?.[0];
  if (!f) throw new Error("Elegí un archivo primero.");

  const folderId = elFolderId.value;

  setLoading(true);
  try {
    await uploadFileToAccount(accountId, f, folderId);
    await refreshFilesForAccount(accountId);
    showToast("Subido OK");
  } finally {
    setLoading(false);
  }
}

// =====================
// 12) FILES MERGE + FILTER
// =====================
function mergedFiles() {
  const out = [];
  for (const a of accounts) {
    const list = a.filesCache || [];
    for (const f of list) out.push({ a, f });
  }
  return out;
}

function matchType(mimeType, typeFilter) {
  const m = mimeType || "";
  const isFolder = (m === "application/vnd.google-apps.folder");
  if (typeFilter === "all") return true;
  if (typeFilter === "folders") return isFolder;
  if (typeFilter === "pdf") return m === "application/pdf";
  if (typeFilter === "images") return m.startsWith("image/");
  if (typeFilter === "gdoc") return m === "application/vnd.google-apps.document";
  if (typeFilter === "gsheet") return m === "application/vnd.google-apps.spreadsheet";
  if (typeFilter === "gslide") return m === "application/vnd.google-apps.presentation";
  if (typeFilter === "other") {
    return !isFolder &&
      m !== "application/pdf" &&
      !m.startsWith("image/") &&
      !m.startsWith("application/vnd.google-apps.");
  }
  return true;
}

function applyFilters(items) {
  const q = (uiState.search || "").toLowerCase().trim();
  const type = uiState.typeFilter;

  let filtered = items;

  if (uiState.viewMode === "single") {
    filtered = filtered.filter(x => x.a.id === uiState.accountPick);
  }

  filtered = filtered.filter(x => matchType(x.f.mimeType, type));

  if (q) filtered = filtered.filter(x => (x.f.name || "").toLowerCase().includes(q));

  return filtered;
}

// =====================
// 13) FILES RENDER
// =====================
function renderFiles() {
  const itemsAll = mergedFiles();
  const items = applyFilters(itemsAll);

  if (!accounts.length) {
    elFiles.innerHTML = `<div class="hint">Agregá al menos una cuenta.</div>`;
    return;
  }

  if (!items.length) {
    elFiles.innerHTML = `<div class="hint">No hay resultados (¿faltó “Actualizar archivos” o filtros muy estrictos?).</div>`;
    return;
  }

  if (uiState.layoutMode === "grid") {
    renderGrid(items);
    return;
  }

  if (uiState.viewMode === "all_grouped") renderListGrouped(items);
  else renderListFlat(items);
}

function fileIconEmoji(mime) {
  if (mime === "application/vnd.google-apps.folder") return "📁";
  if (mime === "application/pdf") return "📄";
  if ((mime || "").startsWith("image/")) return "🖼️";
  if (mime === "application/vnd.google-apps.spreadsheet") return "📊";
  if (mime === "application/vnd.google-apps.presentation") return "📽️";
  if (mime === "application/vnd.google-apps.document") return "📝";
  return "📦";
}

function fileRow(a, f) {
  const isG = isGoogleWorkspaceDoc(f.mimeType);
  const sizeStr = f.size ? fmtBytesStrInt64(f.size) : "";
  return `
    <div class="fileRow">
      <div class="fileLeft">
        <div class="fileIcon">${fileIconEmoji(f.mimeType)}</div>
        <div class="fileMeta">
          <div class="fileName" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
          <div class="fileInfo">
            ${escapeHtml(a.label)} • ${escapeHtml(f.mimeType)}
            ${sizeStr ? "• " + sizeStr : ""}
            ${f.modifiedTime ? "• " + escapeHtml(f.modifiedTime) : ""}
          </div>
        </div>
      </div>

      <div class="fileBtns">
        <button class="btnSmall" onclick="window.dl('${a.id}','${f.id}')">${isG ? "Exportar" : "Descargar"}</button>
        <button class="btnSmall" onclick="window.openDrive('${a.id}','${f.id}')">Abrir</button>
        <button class="btnSmall" onclick="window.copyId('${f.id}')">Copiar ID</button>
      </div>
    </div>
  `;
}

function renderListFlat(items) {
  elFiles.innerHTML = items.map(x => fileRow(x.a, x.f)).join("");
}

function renderListGrouped(items) {
  const byAcc = new Map();
  for (const it of items) {
    if (!byAcc.has(it.a.id)) byAcc.set(it.a.id, []);
    byAcc.get(it.a.id).push(it.f);
  }

  const html = [];
  for (const [accId, files] of byAcc.entries()) {
    const a = accounts.find(x => x.id === accId);
    html.push(`<div class="hint" style="margin:10px 0 8px;"><b>${escapeHtml(a?.label || "Cuenta")}</b> • ${files.length} items</div>`);
    html.push(files.map(f => fileRow(a, f)).join(""));
  }
  elFiles.innerHTML = html.join("");
}

function fileCard(a, f) {
  const isImg = isImageMime(f.mimeType);
  const isFolder = f.mimeType === "application/vnd.google-apps.folder";
  const isG = isGoogleWorkspaceDoc(f.mimeType);

  const thumbAttr = isImg ? `data-thumb="1" data-acc="${a.id}" data-file="${f.id}"` : "";

  return `
    <div class="card">
      <div class="cardThumb">
        ${isImg
          ? `<img alt="${escapeHtml(f.name)}" ${thumbAttr} />`
          : `<div style="font-size:34px;">${fileIconEmoji(f.mimeType)}</div>`
        }
      </div>
      <div class="cardBody">
        <div class="cardName" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="cardInfo">${escapeHtml(a.label)}</div>
        <div class="cardInfo">${escapeHtml(f.mimeType)}</div>
      </div>
      <div class="cardBtns">
        ${isFolder ? `` : `<button class="btnSmall" onclick="window.dl('${a.id}','${f.id}')">${isG ? "Exportar" : "Descargar"}</button>`}
        <button class="btnSmall" onclick="window.openDrive('${a.id}','${f.id}')">Abrir</button>
      </div>
    </div>
  `;
}

function renderGrid(items) {
  if (uiState.viewMode === "all_grouped") {
    const byAcc = new Map();
    for (const it of items) {
      if (!byAcc.has(it.a.id)) byAcc.set(it.a.id, []);
      byAcc.get(it.a.id).push(it.f);
    }

    const chunks = [];
    for (const [accId, files] of byAcc.entries()) {
      const a = accounts.find(x => x.id === accId);
      chunks.push(`<div class="hint" style="margin:10px 0 8px;"><b>${escapeHtml(a?.label || "Cuenta")}</b> • ${files.length} items</div>`);
      chunks.push(`<div class="gridWrap">${files.map(f => fileCard(a, f)).join("")}</div>`);
    }
    elFiles.innerHTML = chunks.join("");
    lazyLoadThumbs();
    return;
  }

  elFiles.innerHTML = `<div class="gridWrap">${items.map(x => fileCard(x.a, x.f)).join("")}</div>`;
  lazyLoadThumbs();
}

async function lazyLoadThumbs() {
  const imgs = Array.from(document.querySelectorAll('img[data-thumb="1"]'));
  for (const img of imgs) {
    if (img.src) continue;
    const accId = img.getAttribute("data-acc");
    const fileId = img.getAttribute("data-file");
    const a = accounts.find(x => x.id === accId);
    if (!a) continue;

    try {
      const url = await getImageThumbUrl(a, fileId);
      img.src = url;
    } catch {
      // si no se pudo (token vencido), dejamos sin thumb
    }
  }
}

// =====================
// 14) GLOBAL HANDLERS
// =====================
window.refreshOne = (id) => refreshFilesForAccount(id).catch(errUI);
window.reconnect = (id) => reconnectAccount(id).catch(errUI);
window.removeAcc = (id) => removeAccount(id);

window.copyId = async (id) => {
  await navigator.clipboard.writeText(id);
  showToast("ID copiado");
};

window.dl = async (accId, fileId) => {
  const a = accounts.find(x => x.id === accId);
  if (!a) return;
  const f = (a.filesCache || []).find(x => x.id === fileId);
  if (!f) return;
  await downloadFile(a, f);
};

window.openDrive = (accId, fileId) => {
  const a = accounts.find(x => x.id === accId);
  if (!a) return;
  const f = (a.filesCache || []).find(x => x.id === fileId);
  if (!f) return;
  if (f.webViewLink) window.open(f.webViewLink, "_blank");
  else showToast("No hay webViewLink disponible.");
};

// =====================
// 15) BOOT
// =====================
function bootWaitGIS() {
  if (!window.google?.accounts?.oauth2) {
    setTimeout(bootWaitGIS, 100);
    return;
  }
  initAuth();

  // ocultar upload al inicio
  if (panelUpload) panelUpload.style.display = "none";

  // estado inicial
  renderAll();
}

bootWaitGIS();

// // =====================
// // 1) CONFIG
// // =====================
// const CLIENT_ID = "685537038231-mfoljus3n4susmv36bvl7mnf2kuslcc1.apps.googleusercontent.com";
// const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
// const OIDC_SCOPES = "openid email profile";
// const SCOPES = `${DRIVE_SCOPE} ${OIDC_SCOPES}`;
// const LS_KEY = "drive_gigante_accounts_v1";

// // =====================
// // 2) STATE
// // =====================
// let accounts = loadAccounts();
// let tokenClient = null;

// // UI state
// let uiState = {
//     viewMode: "all_grouped", // all_grouped | all_flat | single
//     accountPick: "",
//     typeFilter: "all",
//     layoutMode: "list", // list | grid
//     search: ""
// };

// // =====================
// // 3) HELPERS
// // =====================
// function loadAccounts() {
//     try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
//     catch { return []; }
// }
// function saveAccounts() { localStorage.setItem(LS_KEY, JSON.stringify(accounts)); }
// function uid() { return Math.random().toString(16).slice(2) + Date.now().toString(16); }
// function isExpired(a) { return !a.access_token || Date.now() > (a.expires_at - 30_000); }

// function fmtBytesStrInt64(x) {
//     if (!x) return "0 B";
//     const n = Number(x);
//     if (!Number.isFinite(n)) return "—";
//     const units = ["B", "KB", "MB", "GB", "TB"];
//     let v = n, u = 0;
//     while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
//     return `${v.toFixed(2)} ${units[u]}`;
// }
// function sumTotals() {
//     let limit = 0, usageInDrive = 0;
//     for (const a of accounts) {
//         if (a.storage?.limit) limit += Number(a.storage.limit);
//         if (a.storage?.usageInDrive) usageInDrive += Number(a.storage.usageInDrive);
//     }
//     const free = Math.max(0, limit - usageInDrive);
//     return { limit, usageInDrive, free };
// }
// async function apiFetch(url, token, opts = {}) {
//     const r = await fetch(url, {
//         ...opts,
//         headers: {
//             ...(opts.headers || {}),
//             Authorization: `Bearer ${token}`
//         }
//     });
//     if (!r.ok) {
//         const txt = await r.text().catch(() => "");
//         throw new Error(`API error ${r.status}: ${txt}`);
//     }
//     return r;
// }
// function escapeHtml(s) {
//     return (s || "").replace(/[&<>"']/g, c => ({
//         "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
//     }[c]));
// }
// function setLoading(on) {
//     const pill = document.getElementById("loadingPill");
//     pill.style.display = on ? "inline-flex" : "none";
// }

// // =====================
// // 4) AUTH (GIS)
// // =====================
// function initAuth() {
//     tokenClient = google.accounts.oauth2.initTokenClient({
//         client_id: CLIENT_ID,
//         scope: SCOPES,
//         callback: () => { }
//     });
// }
// function requestTokenInteractive() {
//     return new Promise((resolve, reject) => {
//         tokenClient.callback = (resp) => {
//             if (resp.error) reject(resp);
//             else resolve(resp);
//         };
//         tokenClient.requestAccessToken({ prompt: "consent" });
//     });
// }

// function requestTokenConsent() {
//     return new Promise((resolve, reject) => {
//         tokenClient.callback = (resp) => {
//             if (resp.error) reject(resp);
//             else resolve(resp);
//         };
//         tokenClient.requestAccessToken({ prompt: "consent" });
//     });
// }

// function requestTokenSilent(loginHint) {
//     return new Promise((resolve, reject) => {
//         tokenClient.callback = (resp) => {
//             if (resp.error) reject(resp);
//             else resolve(resp);
//         };

//         const opts = { prompt: "" }; // intento silencioso
//         // ayuda MUCHO cuando tenés varias cuentas
//         if (loginHint && loginHint.includes("@")) opts.hint = loginHint;

//         tokenClient.requestAccessToken(opts);
//     });
// }


// async function getUserInfo(token) {
//     const r = await apiFetch("https://openidconnect.googleapis.com/v1/userinfo", token);
//     return await r.json();
// }

// async function addAccount() {
//     const resp = await requestTokenInteractive();
//     const access_token = resp.access_token;
//     const expires_at = Date.now() + (resp.expires_in * 1000);

//     const a = {
//         id: uid(),
//         label: `Cuenta ${accounts.length + 1}`,
//         access_token,
//         expires_at,
//         storage: null,
//         filesCache: null,
//         // cache thumbnails (fileId -> objectURL) para grid
//         thumbCache: {}
//     };

//     try {
//         const u = await getUserInfo(access_token);
//         if (u?.email) a.label = u.email;
//     } catch { }

//     a.storage = await getStorageQuota(access_token);
//     accounts.push(a);
//     saveAccounts();
//     renderAll();
// }

// async function reconnectAccount(accountId) {
//     const a = accounts.find(x => x.id === accountId);
//     if (!a) return;

//     const resp = await requestTokenInteractive();
//     a.access_token = resp.access_token;
//     a.expires_at = Date.now() + (resp.expires_in * 1000);

//     a.storage = await getStorageQuota(a.access_token);
//     saveAccounts();
//     renderAll();
// }

// async function ensureToken(a) {
//     if (!isExpired(a)) return;
//     try {
//         // 1) intento silencioso
//         const resp = await requestTokenSilent(a.label);
//         a.access_token = resp.access_token;
//         a.expires_at = Date.now() + (resp.expires_in * 1000);
//         a.storage = await getStorageQuota(a.access_token);
//         saveAccounts();
//     } catch (e) {
//         // 2) si falla, recién ahí popup
//         const resp = await requestTokenConsent();
//         a.access_token = resp.access_token;
//         a.expires_at = Date.now() + (resp.expires_in * 1000);
//         a.storage = await getStorageQuota(a.access_token);
//         saveAccounts();
//     }
// }

// // =====================
// // 5) DRIVE API CALLS
// // =====================
// async function getStorageQuota(token) {
//     const url = "https://www.googleapis.com/drive/v3/about?fields=storageQuota";
//     const r = await apiFetch(url, token);
//     const data = await r.json();
//     return data.storageQuota;
// }

// async function listAllFiles(token) {
//     let files = [];
//     let pageToken = "";

//     // Nota: pedimos iconLink/webViewLink para UI, y mimeType/size/modifiedTime/parents
//     const fields = "nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,iconLink,webViewLink)";

//     do {
//         const params = new URLSearchParams({
//             q: "trashed=false",
//             pageSize: "1000",
//             fields
//         });
//         if (pageToken) params.set("pageToken", pageToken);

//         const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
//         const r = await apiFetch(url, token);
//         const data = await r.json();
//         files.push(...(data.files || []));
//         pageToken = data.nextPageToken || "";
//     } while (pageToken);

//     return files;
// }

// // Download
// function isGoogleWorkspaceDoc(mimeType) {
//     return mimeType?.startsWith("application/vnd.google-apps.");
// }
// function defaultExportMime(mimeType) {
//     switch (mimeType) {
//         case "application/vnd.google-apps.document": return { mime: "application/pdf", ext: "pdf" };
//         case "application/vnd.google-apps.spreadsheet": return { mime: "application/pdf", ext: "pdf" };
//         case "application/vnd.google-apps.presentation": return { mime: "application/pdf", ext: "pdf" };
//         default: return { mime: "application/pdf", ext: "pdf" };
//     }
// }
// async function downloadFile(a, file) {
//     await ensureToken(a);

//     if (isGoogleWorkspaceDoc(file.mimeType)) {
//         const exp = defaultExportMime(file.mimeType);
//         const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exp.mime)}`;
//         const r = await apiFetch(url, a.access_token);
//         const blob = await r.blob();
//         triggerDownload(blob, `${file.name}.${exp.ext}`);
//     } else {
//         const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`;
//         const r = await apiFetch(url, a.access_token);
//         const blob = await r.blob();
//         triggerDownload(blob, file.name);
//     }
// }
// function triggerDownload(blob, filename) {
//     const url = URL.createObjectURL(blob);
//     const link = document.createElement("a");
//     link.href = url;
//     link.download = filename;
//     document.body.appendChild(link);
//     link.click();
//     link.remove();
//     setTimeout(() => URL.revokeObjectURL(url), 8000);
// }

// // Upload
// async function uploadFileToAccount(accountId, fileObj, folderId) {
//     const a = accounts.find(x => x.id === accountId);
//     if (!a) throw new Error("Cuenta no encontrada");
//     await ensureToken(a);

//     const metadata = { name: fileObj.name };
//     if (folderId && folderId.trim()) metadata.parents = [folderId.trim()];

//     const boundary = "-------drivegigante" + Math.random().toString(16).slice(2);
//     const delimiter = `\r\n--${boundary}\r\n`;
//     const closeDelim = `\r\n--${boundary}--`;

//     const metaPart =
//         delimiter +
//         "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
//         JSON.stringify(metadata);

//     const filePartHeader =
//         delimiter +
//         `Content-Type: ${fileObj.type || "application/octet-stream"}\r\n` +
//         `Content-Disposition: form-data; name="file"; filename="${encodeURIComponent(fileObj.name)}"\r\n\r\n`;

//     const blob = new Blob([metaPart, filePartHeader, fileObj, closeDelim], {
//         type: `multipart/related; boundary=${boundary}`
//     });

//     const url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
//     const r = await apiFetch(url, a.access_token, {
//         method: "POST",
//         headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
//         body: blob
//     });

//     return await r.json();
// }

// // =====================
// // 6) PREVIEW THUMB (IMAGES) FOR GRID
// // =====================
// function isImageMime(m) { return (m || "").startsWith("image/"); }

// // mini thumbnail: para imágenes bajamos el archivo pero SOLO cuando hace falta (grid)
// // Para no re-bajar siempre: cache por fileId con objectURL
// async function getImageThumbUrl(a, fileId) {
//     if (a.thumbCache?.[fileId]) return a.thumbCache[fileId];

//     await ensureToken(a);
//     const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
//     const r = await apiFetch(url, a.access_token);
//     const blob = await r.blob();

//     // si la imagen es enorme, el browser la va a escalar igual
//     const objUrl = URL.createObjectURL(blob);
//     a.thumbCache[fileId] = objUrl;
//     saveAccounts();
//     return objUrl;
// }

// // =====================
// // 7) UI / RENDER
// // =====================
// const elAccounts = document.getElementById("accounts");
// const elFiles = document.getElementById("files");
// const elUploadAccount = document.getElementById("uploadAccount");
// const elFolderId = document.getElementById("folderId");
// const elFileInput = document.getElementById("fileInput");

// const elStatUsed = document.getElementById("statUsed");
// const elStatFree = document.getElementById("statFree");
// const elStatTotal = document.getElementById("statTotal");

// // filters
// const elViewMode = document.getElementById("viewMode");
// const elAccountPick = document.getElementById("accountPick");
// const elSingleAccountWrap = document.getElementById("singleAccountWrap");
// const elTypeFilter = document.getElementById("typeFilter");
// const elSearch = document.getElementById("search");
// const elLayoutMode = document.getElementById("layoutMode");

// // menu / panels
// const btnHamburger = document.getElementById("btnHamburger");
// const topNav = document.getElementById("topNav");
// const panelAccounts = document.getElementById("panelAccounts");
// const panelUpload = document.getElementById("panelUpload");

// document.getElementById("btnAdd").onclick = () => addAccount().catch(alertErr);
// document.getElementById("btnRefreshAll").onclick = () => refreshAll().catch(alertErr);
// document.getElementById("btnUpload").onclick = () => doUpload().catch(alertErr);

// // toggles
// document.getElementById("btnToggleAccounts").onclick = () => toggleAccounts(true);
// document.getElementById("btnCloseAccounts").onclick = () => toggleAccounts(false);
// document.getElementById("btnToggleUpload").onclick = () => toggleUpload(true);
// document.getElementById("btnCloseUpload").onclick = () => toggleUpload(false);

// btnHamburger.onclick = () => {
//     topNav.classList.toggle("open");
// };

// // filter listeners
// elViewMode.onchange = () => {
//     uiState.viewMode = elViewMode.value;
//     elSingleAccountWrap.style.display = (uiState.viewMode === "single") ? "" : "none";
//     renderFiles();
// };
// elAccountPick.onchange = () => { uiState.accountPick = elAccountPick.value; renderFiles(); };
// elTypeFilter.onchange = () => { uiState.typeFilter = elTypeFilter.value; renderFiles(); };
// elLayoutMode.onchange = () => { uiState.layoutMode = elLayoutMode.value; renderFiles(); };
// elSearch.oninput = () => { uiState.search = elSearch.value || ""; renderFiles(); };

// function toggleAccounts(open) {
//     panelAccounts.classList.toggle("open", open);
// }
// function toggleUpload(open) {
//     panelUpload.style.display = open ? "" : "none";
// }

// function alertErr(e) {
//     console.error(e);
//     alert(e?.message || String(e));
// }

// function renderAll() {
//     renderStats();
//     renderAccounts();
//     renderUploadSelects();
//     renderFilters();
//     renderFiles();
// }

// function renderStats() {
//     const t = sumTotals();
//     elStatUsed.textContent = fmtBytesStrInt64(String(t.usageInDrive));
//     elStatFree.textContent = fmtBytesStrInt64(String(t.free));
//     elStatTotal.textContent = fmtBytesStrInt64(String(t.limit));
//     elStatUsed.className = "statvalue used";
//     elStatFree.className = "statvalue free";
//     elStatTotal.className = "statvalue total";
// }

// function renderAccounts() {
//     if (!accounts.length) {
//         elAccounts.innerHTML = `<div class="hint">No hay cuentas agregadas.</div>`;
//         return;
//     }

//     elAccounts.innerHTML = accounts.map(a => {
//         const s = a.storage || {};
//         return `
//       <div class="accCard">
//         <div class="accTop">
//           <div>
//             <div class="accEmail">${escapeHtml(a.label)}</div>
//             <div class="accSmall">
//               Drive usado: ${fmtBytesStrInt64(s.usageInDrive)} / ${fmtBytesStrInt64(s.limit)}<br/>
//               Papelera: ${fmtBytesStrInt64(s.usageInDriveTrash)}
//             </div>
//           </div>
//           <div class="accActions">
//             <button class="btnSmall" onclick="window.reconnect('${a.id}')">Reconectar</button>
//             <button class="btnSmall btnDanger" onclick="window.removeAcc('${a.id}')">Quitar</button>
//           </div>
//         </div>

//         <div style="margin-top:10px;">
//           <button class="btnSmall" onclick="window.refreshOne('${a.id}')">Actualizar archivos</button>
//         </div>
//       </div>
//     `;
//     }).join("");
// }

// function renderUploadSelects() {
//     elUploadAccount.innerHTML = accounts.map(a =>
//         `<option value="${a.id}">${escapeHtml(a.label)}</option>`
//     ).join("");
// }

// function renderFilters() {
//     // accountPick options
//     elAccountPick.innerHTML = accounts.map(a =>
//         `<option value="${a.id}">${escapeHtml(a.label)}</option>`
//     ).join("");

//     if (!uiState.accountPick && accounts[0]) uiState.accountPick = accounts[0].id;
//     elAccountPick.value = uiState.accountPick;

//     elViewMode.value = uiState.viewMode;
//     elTypeFilter.value = uiState.typeFilter;
//     elLayoutMode.value = uiState.layoutMode;
//     elSearch.value = uiState.search;

//     elSingleAccountWrap.style.display = (uiState.viewMode === "single") ? "" : "none";
//     // upload panel hidden by default on desktop if you want:
//     // panelUpload.style.display = "none";
// }

// // data ops
// async function refreshFilesForAccount(accountId) {
//     const a = accounts.find(x => x.id === accountId);
//     if (!a) return;

//     setLoading(true);
//     try {
//         await ensureToken(a);
//         a.storage = await getStorageQuota(a.access_token);
//         a.filesCache = await listAllFiles(a.access_token);
//         saveAccounts();
//         renderAll();
//     } finally {
//         setLoading(false);
//     }
// }

// async function refreshAll() {
//     setLoading(true);
//     try {
//         for (const a of accounts) {
//             await refreshFilesForAccount(a.id);
//         }
//     } finally {
//         setLoading(false);
//     }
// }

// async function doUpload() {
//     const accountId = elUploadAccount.value;
//     const f = elFileInput.files?.[0];
//     if (!f) throw new Error("Elegí un archivo primero.");

//     const folderId = elFolderId.value;
//     setLoading(true);
//     try {
//         await uploadFileToAccount(accountId, f, folderId);
//         await refreshFilesForAccount(accountId);
//         alert("Subido OK");
//     } finally {
//         setLoading(false);
//     }
// }

// // merged data
// function mergedFiles() {
//     const out = [];
//     for (const a of accounts) {
//         const list = a.filesCache || [];
//         for (const f of list) out.push({ a, f });
//     }
//     return out;
// }

// // Filtering
// function matchType(mimeType, typeFilter) {
//     const m = mimeType || "";
//     const isFolder = (m === "application/vnd.google-apps.folder");
//     if (typeFilter === "all") return true;
//     if (typeFilter === "folders") return isFolder;
//     if (typeFilter === "pdf") return m === "application/pdf";
//     if (typeFilter === "images") return m.startsWith("image/");
//     if (typeFilter === "gdoc") return m === "application/vnd.google-apps.document";
//     if (typeFilter === "gsheet") return m === "application/vnd.google-apps.spreadsheet";
//     if (typeFilter === "gslide") return m === "application/vnd.google-apps.presentation";
//     if (typeFilter === "other") {
//         return !isFolder &&
//             m !== "application/pdf" &&
//             !m.startsWith("image/") &&
//             !m.startsWith("application/vnd.google-apps.");
//     }
//     return true;
// }

// function applyFilters(items) {
//     const q = (uiState.search || "").toLowerCase().trim();
//     const type = uiState.typeFilter;

//     let filtered = items;

//     // view mode
//     if (uiState.viewMode === "single") {
//         filtered = filtered.filter(x => x.a.id === uiState.accountPick);
//     }

//     // type
//     filtered = filtered.filter(x => matchType(x.f.mimeType, type));

//     // search
//     if (q) filtered = filtered.filter(x => (x.f.name || "").toLowerCase().includes(q));

//     return filtered;
// }

// function renderFiles() {
//     const itemsAll = mergedFiles();
//     const items = applyFilters(itemsAll);

//     if (!accounts.length) {
//         elFiles.innerHTML = `<div class="hint">Agregá al menos una cuenta.</div>`;
//         return;
//     }
//     if (!items.length) {
//         elFiles.innerHTML = `<div class="hint">No hay resultados (¿faltó “Actualizar archivos” o filtros muy estrictos?).</div>`;
//         return;
//     }

//     if (uiState.layoutMode === "grid") {
//         renderGrid(items);
//         return;
//     }

//     // list
//     if (uiState.viewMode === "all_grouped") {
//         renderListGrouped(items);
//     } else {
//         renderListFlat(items);
//     }
// }

// function fileIconEmoji(mime) {
//     if (mime === "application/vnd.google-apps.folder") return "📁";
//     if (mime === "application/pdf") return "📄";
//     if ((mime || "").startsWith("image/")) return "🖼️";
//     if (mime === "application/vnd.google-apps.spreadsheet") return "📊";
//     if (mime === "application/vnd.google-apps.presentation") return "📽️";
//     if (mime === "application/vnd.google-apps.document") return "📝";
//     return "📦";
// }

// function fileRow(a, f) {
//     const isG = isGoogleWorkspaceDoc(f.mimeType);
//     const sizeStr = f.size ? fmtBytesStrInt64(f.size) : "";
//     return `
//     <div class="fileRow">
//       <div class="fileLeft">
//         <div class="fileIcon">${fileIconEmoji(f.mimeType)}</div>
//         <div class="fileMeta">
//           <div class="fileName" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
//           <div class="fileInfo">
//             ${escapeHtml(a.label)} • ${escapeHtml(f.mimeType)} ${sizeStr ? "• " + sizeStr : ""} ${f.modifiedTime ? "• " + escapeHtml(f.modifiedTime) : ""}
//           </div>
//         </div>
//       </div>

//       <div class="fileBtns">
//         <button class="btnSmall" onclick="window.dl('${a.id}','${f.id}')">${isG ? "Exportar" : "Descargar"}</button>
//         <button class="btnSmall" onclick="window.openDrive('${a.id}','${f.id}')">Abrir</button>
//         <button class="btnSmall" onclick="window.copyId('${f.id}')">Copiar ID</button>
//       </div>
//     </div>
//   `;
// }

// function renderListFlat(items) {
//     elFiles.innerHTML = items.map(x => fileRow(x.a, x.f)).join("");
// }

// function renderListGrouped(items) {
//     // group by account id
//     const byAcc = new Map();
//     for (const it of items) {
//         if (!byAcc.has(it.a.id)) byAcc.set(it.a.id, []);
//         byAcc.get(it.a.id).push(it.f);
//     }

//     const html = [];
//     for (const [accId, files] of byAcc.entries()) {
//         const a = accounts.find(x => x.id === accId);
//         html.push(`<div class="hint" style="margin:10px 0 8px;"><b>${escapeHtml(a?.label || "Cuenta")}</b> • ${files.length} items</div>`);
//         html.push(files.map(f => fileRow(a, f)).join(""));
//     }
//     elFiles.innerHTML = html.join("");
// }

// function renderGrid(items) {
//     // grouped in grid is optional; we follow viewMode:
//     if (uiState.viewMode === "all_grouped") {
//         const byAcc = new Map();
//         for (const it of items) {
//             if (!byAcc.has(it.a.id)) byAcc.set(it.a.id, []);
//             byAcc.get(it.a.id).push(it.f);
//         }

//         const chunks = [];
//         for (const [accId, files] of byAcc.entries()) {
//             const a = accounts.find(x => x.id === accId);
//             chunks.push(`<div class="hint" style="margin:10px 0 8px;"><b>${escapeHtml(a?.label || "Cuenta")}</b> • ${files.length} items</div>`);
//             chunks.push(`<div class="gridWrap">${files.map(f => fileCard(a, f)).join("")}</div>`);
//         }
//         elFiles.innerHTML = chunks.join("");
//         // lazy thumbs
//         lazyLoadThumbs();
//         return;
//     }

//     elFiles.innerHTML = `<div class="gridWrap">${items.map(x => fileCard(x.a, x.f)).join("")}</div>`;
//     lazyLoadThumbs();
// }

// function fileCard(a, f) {
//     const isImg = isImageMime(f.mimeType);
//     const isFolder = f.mimeType === "application/vnd.google-apps.folder";
//     const isG = isGoogleWorkspaceDoc(f.mimeType);

//     // data attrs para lazy thumb
//     const thumbAttr = isImg ? `data-thumb="1" data-acc="${a.id}" data-file="${f.id}"` : "";

//     return `
//     <div class="card">
//       <div class="cardThumb">
//         ${isImg
//             ? `<img alt="${escapeHtml(f.name)}" ${thumbAttr} />`
//             : `<div style="font-size:34px;">${fileIconEmoji(f.mimeType)}</div>`
//         }
//       </div>
//       <div class="cardBody">
//         <div class="cardName" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
//         <div class="cardInfo">${escapeHtml(a.label)}</div>
//         <div class="cardInfo">${escapeHtml(f.mimeType)}</div>
//       </div>
//       <div class="cardBtns">
//         ${isFolder ? `` : `<button class="btnSmall" onclick="window.dl('${a.id}','${f.id}')">${isG ? "Exportar" : "Descargar"}</button>`}
//         <button class="btnSmall" onclick="window.openDrive('${a.id}','${f.id}')">Abrir</button>
//       </div>
//     </div>
//   `;
// }

// async function lazyLoadThumbs() {
//     // busca imgs con data-thumb sin src y carga objectURL
//     const imgs = Array.from(document.querySelectorAll('img[data-thumb="1"]'));
//     for (const img of imgs) {
//         if (img.src) continue;
//         const accId = img.getAttribute("data-acc");
//         const fileId = img.getAttribute("data-file");
//         const a = accounts.find(x => x.id === accId);
//         if (!a) continue;

//         // carga de a una (simple). Si querés, lo hacemos concurrente con límite.
//         try {
//             const url = await getImageThumbUrl(a, fileId);
//             img.src = url;
//         } catch {
//             // si falla, lo dejamos vacío
//         }
//     }
// }

// // handlers expuestos
// window.refreshOne = (id) => refreshFilesForAccount(id).catch(alertErr);
// window.reconnect = (id) => reconnectAccount(id).catch(alertErr);
// window.removeAcc = (id) => {
//     // liberar objectURLs para no “filtrar memoria”
//     const a = accounts.find(x => x.id === id);
//     if (a?.thumbCache) {
//         Object.values(a.thumbCache).forEach(u => { try { URL.revokeObjectURL(u); } catch { } });
//     }
//     accounts = accounts.filter(a => a.id !== id);
//     saveAccounts();
//     renderAll();
// };
// window.copyId = async (id) => {
//     await navigator.clipboard.writeText(id);
//     alert("ID copiado");
// };
// window.dl = async (accId, fileId) => {
//     const a = accounts.find(x => x.id === accId);
//     if (!a) return;
//     const f = (a.filesCache || []).find(x => x.id === fileId);
//     if (!f) return;
//     await downloadFile(a, f);
// };
// window.openDrive = (accId, fileId) => {
//     const a = accounts.find(x => x.id === accId);
//     if (!a) return;
//     const f = (a.filesCache || []).find(x => x.id === fileId);
//     if (!f) return;
//     // webViewLink abre en Drive
//     if (f.webViewLink) window.open(f.webViewLink, "_blank");
//     else alert("No hay webViewLink disponible.");
// };

// // panels
// document.getElementById("btnToggleAccounts").addEventListener("click", () => toggleAccounts(true));
// document.getElementById("btnToggleUpload").addEventListener("click", () => toggleUpload(true));
// document.getElementById("btnCloseAccounts").addEventListener("click", () => toggleAccounts(false));
// document.getElementById("btnCloseUpload").addEventListener("click", () => toggleUpload(false));

// // close menu when click outside (mobile)
// document.addEventListener("click", (e) => {
//     const nav = document.getElementById("topNav");
//     const ham = document.getElementById("btnHamburger");
//     if (!nav.classList.contains("open")) return;
//     if (nav.contains(e.target) || ham.contains(e.target)) return;
//     nav.classList.remove("open");
// });

// // =====================
// // 8) BOOT
// // =====================
// function bootWaitGIS() {
//     if (!window.google?.accounts?.oauth2) {
//         setTimeout(bootWaitGIS, 100);
//         return;
//     }
//     initAuth();

//     // default: ocultar upload panel (se abre desde botón)
//     document.getElementById("panelUpload").style.display = "none";

//     renderAll();
// }
// bootWaitGIS();
