/* =========================================================
   Drive Gigante — scripts.js (FULL)
   Multi-cuenta Drive + Upload + Log a Sheets + UI fixes
   ========================================================= */

// =====================
// 0) SHEETS LOG (Apps Script Web App)
// =====================
// Pegá acá tu WebApp:
const SHEETS_LOG_ENDPOINT =
  "https://script.google.com/macros/s/AKfycbwmWHPB1JszHHIsh9qM25J1Hv-rBfpeK2iRijZUBv4BzVawDA48JmD82jbLvBq7FDsn5w/exec";

// manda metadata al Apps Script SIN preflight CORS (Content-Type: text/plain)
async function logUploadToSheet(payload) {
  if (!SHEETS_LOG_ENDPOINT) return;
  try {
    const r = await fetch(SHEETS_LOG_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    if (!r.ok) throw new Error(await r.text().catch(() => "Sheets log failed"));
    return await r.json().catch(() => ({}));
  } catch (e) {
    console.warn("logUploadToSheet error:", e);
    showToast("Subido OK, pero no pude registrar en la planilla.");
  }
}

// =====================
// 1) CONFIG (Google Identity Services)
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
// 3) DOM
// =====================
const elAccounts = document.getElementById("accounts");
const elFiles = document.getElementById("files");

const elUploadAccount = document.getElementById("uploadAccount");
const elFolderId = document.getElementById("folderId");
const elFileInput = document.getElementById("fileInput");

// (opcionales si luego los agregás en el HTML)
const elCategory = document.getElementById("categoryInput");
const elSaga = document.getElementById("sagaInput");
const elSeries = document.getElementById("seriesInput");
const elSeason = document.getElementById("seasonInput");
const elEpisode = document.getElementById("episodeInput");
const elTags = document.getElementById("tagsInput");

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

// scrim
const elScrim = document.getElementById("scrim");

// =====================
// 4) HELPERS (storage, ui)
// =====================
function loadAccounts() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { return []; }
}
function saveAccounts() { localStorage.setItem(LS_KEY, JSON.stringify(accounts)); }

function uid() { return Math.random().toString(16).slice(2) + Date.now().toString(16); }
function isExpired(a) { return !a.access_token || Date.now() > (a.expires_at - 30_000); }

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({
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
// 5) OVERLAYS (scrim + lockScroll + close collisions)
// =====================
function setScrim(on) {
  if (!elScrim) return;
  elScrim.style.display = on ? "" : "none";
}

function setNavOpen(on) {
  if (!topNav) return;
  topNav.classList.toggle("open", on);
  syncOverlayState();
}

function isUploadOpen() {
  return !!(panelUpload && panelUpload.style.display !== "none");
}
function isAccountsOpen() {
  return !!(panelAccounts && panelAccounts.classList.contains("open"));
}
function isNavOpen() {
  return !!(topNav && topNav.classList.contains("open"));
}

function anyOverlayOpen() {
  // en mobile, el menú también cuenta como overlay
  return isNavOpen() || isAccountsOpen() || isUploadOpen();
}

function syncOverlayState() {
  const on = anyOverlayOpen();
  document.body.classList.toggle("lockScroll", on);
  setScrim(on);
}

function setAccountsOpen(on) {
  if (!panelAccounts) return;
  if (on) setUploadOpen(false);
  panelAccounts.classList.toggle("open", on);
  if (on) setNavOpen(false);
  syncOverlayState();
}

function setUploadOpen(on) {
  if (!panelUpload) return;
  if (on) setAccountsOpen(false);
  panelUpload.style.display = on ? "" : "none";
  if (on) setNavOpen(false);
  syncOverlayState();
}

// scrim click: cerrar TODO
if (elScrim) {
  elScrim.addEventListener("click", () => {
    setNavOpen(false);
    setAccountsOpen(false);
    setUploadOpen(false);
  });
}

// click fuera: cerrar solo menú
document.addEventListener("click", (e) => {
  if (!isNavOpen()) return;
  const ham = document.getElementById("btnHamburger");
  if (topNav.contains(e.target) || (ham && ham.contains(e.target))) return;
  setNavOpen(false);
});

// =====================
// 6) AUTH (GIS)
// =====================
function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: () => {}
  });
}

/**
 * requestAccessToken con timeout
 * Evita "cargando infinito" si se cierra/cuelga popup.
 */
function requestAccessToken({ prompt, hint } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("popup_timeout_or_closed"));
    }, 45_000);

    tokenClient.callback = (resp) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (resp?.error) reject(new Error(resp.error));
      else resolve(resp);
    };

    const opts = {};
    if (prompt != null) opts.prompt = prompt;
    if (hint && hint.includes("@")) opts.hint = hint;
    tokenClient.requestAccessToken(opts);
  });
}

function requestTokenConsent(hintEmail) {
  return requestAccessToken({ prompt: "consent", hint: hintEmail });
}

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
 */
async function ensureToken(a, allowInteractive = false) {
  if (!isExpired(a)) return;

  // silent
  try {
    const resp = await requestTokenSilent(a.label);
    a.access_token = resp.access_token;
    a.expires_at = Date.now() + (resp.expires_in * 1000);
    a.needsReconnect = false;
    saveAccounts();
    return;
  } catch {}

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
// 7) API FETCH con retry
// =====================
function isAuthError(status, bodyText = "") {
  if (status === 401) return true;
  if (status === 403 && (bodyText.includes("insufficient") || bodyText.includes("Invalid Credentials"))) return true;
  return false;
}

async function apiFetchAccount(a, url, opts = {}, { allowInteractive = false, retry = true } = {}) {
  await ensureToken(a, allowInteractive);

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

  try {
    await ensureToken(a, allowInteractive);
  } catch {
    a.needsReconnect = true;
    saveAccounts();
    renderAccounts();
    showToast(`Sesión vencida en ${a.label}. Tocá “Reconectar”.`);
    throw new Error(`Auth error ${r.status}: ${txt}`);
  }

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
// 8) DRIVE API
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

// hacer PUBLICO (anyoneWithLink reader)
async function makePublic(a, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`;
  const body = JSON.stringify({
    role: "reader",
    type: "anyone",
    allowFileDiscovery: false
  });

  await apiFetchAccount(a, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  }, { allowInteractive: true });
}

// upload
async function uploadFileToAccount(accountId, fileObj, folderId) {
  const a = accounts.find(x => x.id === accountId);
  if (!a) throw new Error("Cuenta no encontrada");

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

  const fields = encodeURIComponent("id,name,mimeType,size,modifiedTime,webViewLink,parents");
  const url = `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${fields}`;

  const r = await apiFetchAccount(a, url, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: blob
  }, { allowInteractive: true });

  const created = await r.json();

  // hacerlo público
  try { await makePublic(a, created.id); } catch {}

  function buildPublicLink(file) {
    const id = file.id;
    const m = file.mimeType || "";
    if (m === "application/vnd.google-apps.document") return `https://docs.google.com/document/d/${id}/edit?usp=sharing`;
    if (m === "application/vnd.google-apps.spreadsheet") return `https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`;
    if (m === "application/vnd.google-apps.presentation") return `https://docs.google.com/presentation/d/${id}/edit?usp=sharing`;
    return `https://drive.google.com/file/d/${id}/view?usp=sharing`;
  }

  const publicLink = created.webViewLink || buildPublicLink(created);

  // metadata opcional (si no existen inputs, manda "")
  const category = (elCategory?.value || "").trim();
  const saga = (elSaga?.value || "").trim();
  const series = (elSeries?.value || "").trim();
  const season = (elSeason?.value || "").trim();
  const episode = (elEpisode?.value || "").trim();
  const tags = (elTags?.value || "").trim();

  // groupKey simple (podés cambiarlo después)
  const groupKey = [category || "", (series || saga) || "", season ? `T${season}` : ""]
    .filter(Boolean).join(" / ");

  await logUploadToSheet({
    source: "driveXL",
    uploadedAt: new Date().toISOString(),
    accountId: a.id,
    accountLabel: a.label,
    folderId: (folderId || "").trim(),
    fileId: created.id,
    name: created.name,
    mimeType: created.mimeType,
    size: created.size || "",
    modifiedTime: created.modifiedTime || "",
    webViewLink: created.webViewLink || "",
    publicLink,

    // === metadata nueva (IMPORTANTE: usa "category") ===
    category,
    saga,
    series,
    season,
    episode,
    tags,
    groupKey
  });

  return created;
}

// =====================
// 9) THUMBNAILS (grid)
// =====================
function isImageMime(m) { return (m || "").startsWith("image/"); }

async function getImageThumbUrl(a, fileId) {
  if (!a.thumbCache) a.thumbCache = {};
  if (a.thumbCache[fileId]) return a.thumbCache[fileId];

  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const r = await apiFetchAccount(a, url, {}, { allowInteractive: false, retry: true });
  const blob = await r.blob();

  const objUrl = URL.createObjectURL(blob);
  a.thumbCache[fileId] = objUrl;
  saveAccounts();
  return objUrl;
}

// =====================
// 10) ACCOUNTS OPS
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
// 11) UI BINDINGS (botones)
// =====================
function bindUI() {
  // nav buttons
  document.getElementById("btnAdd").onclick = () => addAccount().catch(errUI);
  document.getElementById("btnRefreshAll").onclick = () => refreshAll().catch(errUI);
  document.getElementById("btnUpload").onclick = () => doUpload().catch(errUI);

  // toggles
  document.getElementById("btnToggleAccounts").onclick = () => setAccountsOpen(true);
  document.getElementById("btnCloseAccounts").onclick = () => setAccountsOpen(false);
  document.getElementById("btnToggleUpload").onclick = () => setUploadOpen(true);
  document.getElementById("btnCloseUpload").onclick = () => setUploadOpen(false);

  // hamburger
  if (btnHamburger) {
    btnHamburger.onclick = () => setNavOpen(!isNavOpen());
  }

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
}

function errUI(e) {
  console.error(e);
  const msg = e?.message || String(e);

  if (msg.includes("popup_closed_by_user") || msg.includes("popup_timeout_or_closed")) {
    showToast("Acción cancelada.");
    setLoading(false);
    return;
  }

  if (msg.includes("TOKEN_EXPIRED_NEEDS_INTERACTIVE")) {
    showToast("Sesión vencida. Tocá “Reconectar” en la cuenta.");
    setLoading(false);
    return;
  }

  showToast(msg);
  setLoading(false);
}

// =====================
// 12) RENDER
// =====================
function renderAll() {
  renderStats();
  renderAccounts();
  renderUploadSelects();
  renderFilters();
  renderFiles();
  syncOverlayState();
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
      ? `<div style="margin-top:6px; padding:6px 10px; border-radius:999px; display:inline-block; border:1px solid rgba(251,191,36,.35); background: rgba(251,191,36,.12); color:#fbbf24; font-size:.85rem;">Requiere reconectar</div>`
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
// 13) DATA OPS
// =====================
async function refreshFilesForAccount(accountId) {
  const a = accounts.find(x => x.id === accountId);
  if (!a) return;

  setLoading(true);
  try {
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
      a.storage = await getStorageQuota(a, true);
      a.filesCache = await listAllFiles(a, true);
      a.needsReconnect = false;
      saveAccounts();
      renderAll();
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
    await uploadFileToAccount(accountId, f, folderId); // público + log a Sheet
    await refreshFilesForAccount(accountId);
    showToast("Subido OK (público + guardado en planilla).");
  } finally {
    setLoading(false);
  }
}

// =====================
// 14) FILES MERGE + FILTER
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
// 15) FILES RENDER
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
  const isFolder = f.mimeType === "application/vnd.google-apps.folder";
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
        ${isFolder ? "" : `<button class="btnSmall" onclick="window.dl('${a.id}','${f.id}')">${isG ? "Exportar" : "Descargar"}</button>`}
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
    } catch {}
  }
}

// =====================
// 16) GLOBAL HANDLERS
// =====================
window.refreshOne = (id) => refreshFilesForAccount(id).catch(errUI);
window.reconnect = (id) => reconnectAccount(id).catch(errUI);
window.removeAcc = (id) => removeAccount(id);

window.copyId = async (id) => {
  try {
    await navigator.clipboard.writeText(id);
    showToast("ID copiado");
  } catch {
    showToast("No se pudo copiar");
  }
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
// 17) BOOT
// =====================
function bootWaitGIS() {
  if (!window.google?.accounts?.oauth2) {
    setTimeout(bootWaitGIS, 100);
    return;
  }
  initAuth();
  bindUI();

  if (panelUpload) panelUpload.style.display = "none";

  renderAll();
}
bootWaitGIS();
