// =====================
// 1) CONFIG
// =====================
const CLIENT_ID = "685537038231-mfoljus3n4susmv36bvl7mnf2kuslcc1.apps.googleusercontent.com";

// Scope full Drive (restricted) para ver todo y poder subir
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"; 

// (Opcional) scopes OIDC solo para saber email en pantalla (no es Gmail API)
// Si no te importa el email real, podés quitar estos y dejar "Cuenta 1/2/3".
const OIDC_SCOPES = "openid email profile";

const SCOPES = `${DRIVE_SCOPE} ${OIDC_SCOPES}`;

// LocalStorage key
const LS_KEY = "drive_gigante_accounts_v1";

// =====================
// 2) STATE
// =====================
/**
 * account = {
 *   id: string,
 *   label: string,   // email o "Cuenta X"
 *   access_token: string,
 *   expires_at: number,
 *   storage: { limit, usageInDrive, usageInDriveTrash, usage } (strings int64)
 *   filesCache: Array
 * }
 */
let accounts = loadAccounts();

// GIS token client (se crea al cargar)
let tokenClient = null;

// =====================
// 3) HELPERS
// =====================
function loadAccounts() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { return []; }
}

function saveAccounts() {
  localStorage.setItem(LS_KEY, JSON.stringify(accounts));
}

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function isExpired(a) {
  return !a.access_token || Date.now() > (a.expires_at - 30_000); // 30s margen
}

function fmtBytesStrInt64(x) {
  if (!x) return "-";
  const n = Number(x);
  const units = ["B","KB","MB","GB","TB"];
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

async function apiFetch(url, token, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      Authorization: `Bearer ${token}`
    }
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`API error ${r.status}: ${txt}`);
  }
  return r;
}

// =====================
// 4) AUTH (GIS)
// =====================
function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: () => {} // se reemplaza al pedir token
  });
}

function requestTokenInteractive() {
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) reject(resp);
      else resolve(resp);
    };
    // prompt: 'consent' fuerza selector/consent; si querés menos molesto, probá prompt: ''
    tokenClient.requestAccessToken({ prompt: "consent" });
  });
}

async function addAccount() {
  const resp = await requestTokenInteractive();
  const access_token = resp.access_token;
  const expires_at = Date.now() + (resp.expires_in * 1000);

  const a = {
    id: uid(),
    label: `Cuenta ${accounts.length + 1}`,
    access_token,
    expires_at,
    storage: null,
    filesCache: null
  };

  // Intentar obtener email (opcional)
  try {
    const u = await getUserInfo(access_token);
    if (u?.email) a.label = u.email;
  } catch {
    // si falla, queda como "Cuenta X"
  }

  a.storage = await getStorageQuota(access_token);
  accounts.push(a);
  saveAccounts();
  renderAll();
  await refreshFilesForAccount(a.id);
}

async function reconnectAccount(accountId) {
  const a = accounts.find(x => x.id === accountId);
  if (!a) return;

  const resp = await requestTokenInteractive();
  a.access_token = resp.access_token;
  a.expires_at = Date.now() + (resp.expires_in * 1000);

  a.storage = await getStorageQuota(a.access_token);
  saveAccounts();
  renderAll();
  await refreshFilesForAccount(a.id);
}

async function getUserInfo(token) {
  // userinfo OIDC (para email). No es Gmail API.
  const r = await apiFetch("https://openidconnect.googleapis.com/v1/userinfo", token);
  return await r.json();
}

// =====================
// 5) DRIVE API CALLS
// =====================
async function getStorageQuota(token) {
  const url = "https://www.googleapis.com/drive/v3/about?fields=storageQuota";
  const r = await apiFetch(url, token);
  const data = await r.json();
  return data.storageQuota;
}

async function listAllFiles(token) {
  let files = [];
  let pageToken = "";

  do {
    const params = new URLSearchParams({
      q: "trashed=false",
      pageSize: "1000",
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)"
      // No shared drives (omit supportsAllDrives/includeItemsFromAllDrives)
    });
    if (pageToken) params.set("pageToken", pageToken);

    const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
    const r = await apiFetch(url, token);
    const data = await r.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);

  return files;
}

// 5.3 Download:
function isGoogleWorkspaceDoc(mimeType) {
  return mimeType?.startsWith("application/vnd.google-apps.");
}

function defaultExportMime(mimeType) {
  // podés ajustar a gusto
  switch (mimeType) {
    case "application/vnd.google-apps.document": return { mime: "application/pdf", ext: "pdf" };
    case "application/vnd.google-apps.spreadsheet": return { mime: "application/pdf", ext: "pdf" };
    case "application/vnd.google-apps.presentation": return { mime: "application/pdf", ext: "pdf" };
    default: return { mime: "application/pdf", ext: "pdf" };
  }
}

async function downloadFile(a, file) {
  await ensureToken(a);

  if (isGoogleWorkspaceDoc(file.mimeType)) {
    const exp = defaultExportMime(file.mimeType);
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exp.mime)}`;
    const r = await apiFetch(url, a.access_token);
    const blob = await r.blob();
    triggerDownload(blob, `${file.name}.${exp.ext}`);
  } else {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`;
    const r = await apiFetch(url, a.access_token);
    const blob = await r.blob();
    triggerDownload(blob, file.name);
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function uploadFileToAccount(accountId, fileObj, folderId) {
  const a = accounts.find(x => x.id === accountId);
  if (!a) throw new Error("Cuenta no encontrada");
  await ensureToken(a);

  const metadata = {
    name: fileObj.name
  };
  if (folderId && folderId.trim()) {
    metadata.parents = [folderId.trim()];
  }

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
  const r = await apiFetch(url, a.access_token, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/related; boundary=${boundary}`
    },
    body: blob
  });

  const created = await r.json();
  return created;
}

async function ensureToken(a) {
  if (!isExpired(a)) return;

  // Sin backend no hay refresh token: re-autorizás con popup
  // (como es para vos, es aceptable)
  await reconnectAccount(a.id);
}

// =====================
// 6) UI / RENDER
// =====================
const elAccounts = document.getElementById("accounts");
const elTotals = document.getElementById("totals");
const elFiles = document.getElementById("files");
const elUploadAccount = document.getElementById("uploadAccount");
const elFolderId = document.getElementById("folderId");
const elFileInput = document.getElementById("fileInput");
const elSearch = document.getElementById("search");
const elGroupBy = document.getElementById("groupByAccount");

document.getElementById("btnAdd").onclick = () => addAccount().catch(alertErr);
document.getElementById("btnRefreshAll").onclick = () => refreshAll().catch(alertErr);
document.getElementById("btnUpload").onclick = () => doUpload().catch(alertErr);

elSearch.oninput = () => renderFiles();
elGroupBy.onchange = () => renderFiles();

function alertErr(e) {
  console.error(e);
  alert(e?.message || String(e));
}

function renderAll() {
  renderAccounts();
  renderTotals();
  renderUploadSelect();
  renderFiles();
}

function renderAccounts() {
  if (!accounts.length) {
    elAccounts.innerHTML = `<p class="small">No hay cuentas agregadas.</p>`;
    return;
  }

  elAccounts.innerHTML = accounts.map(a => {
    const s = a.storage || {};
    return `
      <div class="card">
        <div class="row">
          <b>${escapeHtml(a.label)}</b>
          <div>
            <button onclick="window.reconnect('${a.id}')">Reconectar</button>
            <button onclick="window.removeAcc('${a.id}')">Quitar</button>
          </div>
        </div>
        <div class="small">
          Drive usado: ${fmtBytesStrInt64(s.usageInDrive)} / ${fmtBytesStrInt64(s.limit)}
          <br/>Papelera: ${fmtBytesStrInt64(s.usageInDriveTrash)}
        </div>
        <div class="row" style="margin-top:8px;">
          <button onclick="window.refreshOne('${a.id}')">Actualizar archivos</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderTotals() {
  const t = sumTotals();
  elTotals.textContent =
    `TOTAL (solo Drive): Usado ${fmtBytesStrInt64(String(t.usageInDrive))} / ${fmtBytesStrInt64(String(t.limit))} — Libre ${fmtBytesStrInt64(String(t.free))}`;
}

function renderUploadSelect() {
  elUploadAccount.innerHTML = accounts.map(a =>
    `<option value="${a.id}">${escapeHtml(a.label)}</option>`
  ).join("");
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

async function refreshFilesForAccount(accountId) {
  const a = accounts.find(x => x.id === accountId);
  if (!a) return;
  await ensureToken(a);

  a.storage = await getStorageQuota(a.access_token);
  a.filesCache = await listAllFiles(a.access_token);
  saveAccounts();
  renderAll();
}

async function refreshAll() {
  for (const a of accounts) {
    await refreshFilesForAccount(a.id);
  }
}

async function doUpload() {
  const accountId = elUploadAccount.value;
  const f = elFileInput.files?.[0];
  if (!f) throw new Error("Elegí un archivo primero.");

  const folderId = elFolderId.value;
  await uploadFileToAccount(accountId, f, folderId);

  // refrescar esa cuenta
  await refreshFilesForAccount(accountId);
  alert("Subido OK");
}

function mergedFiles() {
  // Devuelve [{file, account}]
  const out = [];
  for (const a of accounts) {
    const list = a.filesCache || [];
    for (const f of list) out.push({ a, f });
  }
  return out;
}

function renderFiles() {
  const q = (elSearch.value || "").toLowerCase().trim();
  const group = elGroupBy.checked;

  const items = mergedFiles().filter(x =>
    !q || (x.f.name || "").toLowerCase().includes(q)
  );

  if (!items.length) {
    elFiles.innerHTML = `<p class="small">No hay archivos para mostrar (¿faltó “Actualizar archivos”?)</p>`;
    return;
  }

  if (!group) {
    elFiles.innerHTML = items.map(x => fileRow(x.a, x.f)).join("");
    return;
  }

  // agrupar por cuenta
  const byAcc = new Map();
  for (const it of items) {
    if (!byAcc.has(it.a.id)) byAcc.set(it.a.id, []);
    byAcc.get(it.a.id).push(it.f);
  }

  elFiles.innerHTML = [...byAcc.entries()].map(([accId, files]) => {
    const a = accounts.find(x => x.id === accId);
    return `
      <div class="card">
        <b>${escapeHtml(a?.label || "Cuenta")}</b>
        <div class="small">${files.length} items</div>
        <div>
          ${files.map(f => fileRow(a, f)).join("")}
        </div>
      </div>
    `;
  }).join("");
}

function fileRow(a, f) {
  const isG = isGoogleWorkspaceDoc(f.mimeType);
  return `
    <div class="file">
      <div>
        <b>${escapeHtml(f.name)}</b>
        <div class="small">
          ${escapeHtml(f.mimeType)} ${f.size ? "· " + fmtBytesStrInt64(f.size) : ""} · ${escapeHtml(f.modifiedTime || "")}
        </div>
      </div>
      <div class="btns">
        <button onclick="window.dl('${a.id}','${f.id}')">
          ${isG ? "Exportar/Descargar" : "Descargar"}
        </button>
        <button onclick="window.copyId('${f.id}')">Copiar ID</button>
      </div>
    </div>
  `;
}

// Exponer handlers
window.refreshOne = (id) => refreshFilesForAccount(id).catch(alertErr);
window.reconnect = (id) => reconnectAccount(id).catch(alertErr);
window.removeAcc = (id) => {
  accounts = accounts.filter(a => a.id !== id);
  saveAccounts();
  renderAll();
};
window.copyId = async (id) => {
  await navigator.clipboard.writeText(id);
  alert("ID copiado");
};
window.dl = async (accId, fileId) => {
  const a = accounts.find(x => x.id === accId);
  if (!a) return;
  const f = (a.filesCache || []).find(x => x.id === fileId);
  if (!f) return;
  await downloadFile(a, f);
};

// =====================
// 7) BOOT
// =====================
function bootWaitGIS() {
  if (!window.google?.accounts?.oauth2) {
    setTimeout(bootWaitGIS, 100);
    return;
  }
  initAuth();
  renderAll();
}
bootWaitGIS();
