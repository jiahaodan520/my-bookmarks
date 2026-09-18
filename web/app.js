const DATA_FILE = "bookmarks.enc.json";
const THEME_KEY = "bookmark-nav-theme";

function dataUrlCandidates() {
  const isLocalWebPreview = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)
    && window.location.pathname.includes("/web/");
  return isLocalWebPreview
    ? [`../data/${DATA_FILE}`, `./data/${DATA_FILE}`]
    : [`./data/${DATA_FILE}`, `../data/${DATA_FILE}`];
}
const FOLDER_ALL = "__all__";

const state = {
  envelope: null,
  snapshot: null,
  folders: [],
  bookmarks: [],
  activeFolder: FOLDER_ALL,
  query: "",
  theme: "light"
};

const $ = (id) => document.getElementById(id);

function bytesToBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64UrlToString(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const bytes = bytesToBase64(padded);
  return new TextDecoder().decode(bytes);
}

async function deriveKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

async function decryptEnvelope(envelope, passphrase) {
  if (!envelope || envelope.v !== 1) throw new Error("远程文件格式不正确");
  const key = await deriveKey(
    passphrase,
    bytesToBase64(envelope.salt),
    envelope.iterations || 600_000
  );
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytesToBase64(envelope.iv) },
      key,
      bytesToBase64(envelope.ct)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("口令错误，或远程书签文件已损坏");
  }
}

async function fetchEnvelope() {
  const candidates = dataUrlCandidates();
  let lastStatus = 404;
  for (const candidate of candidates) {
    const response = await fetch(`${candidate}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) {
      lastStatus = response.status;
      continue;
    }
    return response.json();
  }
  throw new Error(`无法读取书签文件（HTTP ${lastStatus}）`);
}

function setView(viewId) {
  for (const id of ["loadingView", "unlockView", "emptyView", "appView"]) {
    $(id).classList.toggle("hidden", id !== viewId);
  }
}

function readFragmentKey() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const encoded = params.get("k");
  if (!encoded) return "";
  try {
    return base64UrlToString(encoded);
  } catch {
    return "";
  }
}

function encodeFragmentKey(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function getSavedTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  $("themeToggle").textContent = theme === "dark" ? "☼" : "◐";
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function faviconUrl(_url) {
  // Keep the public page zero-request by default: a remote favicon service
  // would reveal every visited domain to a third party. Cards use initials.
  return "";
}

function initials(title, url) {
  const source = (title || extractDomain(url) || "?").trim();
  return source.slice(0, 1).toUpperCase();
}

function flattenSnapshot(snapshot) {
  const bookmarks = [];
  const folders = [];
  const folderSeen = new Set();

  function visit(node, path, rootIndex) {
    if (node.type === "bookmark" && node.url) {
      bookmarks.push({
        ...node,
        path,
        folder: path[path.length - 1] || "未分类",
        rootIndex
      });
      return;
    }
    const folderPath = node.title ? [...path, node.title] : path;
    if (node.title && !folderSeen.has(folderPath.join("/"))) {
      folderSeen.add(folderPath.join("/"));
      folders.push({ title: node.title, path: folderPath, count: 0 });
    }
    for (const child of node.children || []) visit(child, folderPath, rootIndex);
  }

  (snapshot.roots || []).forEach((root, index) => visit(root, [], index));
  for (const bookmark of bookmarks) {
    const folder = folders.find((item) => item.path.join("/") === bookmark.path.join("/"));
    if (folder) folder.count += 1;
  }
  return { bookmarks, folders };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderFolders() {
  const folderNav = $("folderNav");
  const allButton = makeFolderButton({ title: "全部书签", path: [], count: state.bookmarks.length }, FOLDER_ALL);
  folderNav.replaceChildren(allButton);
  for (const folder of state.folders) {
    folderNav.append(makeFolderButton(folder, folder.path.join("/")));
  }
  $("folderCount").textContent = String(state.folders.length);
}

function makeFolderButton(folder, key) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "folder-button";
  button.classList.toggle("active", state.activeFolder === key);
  button.innerHTML = `<span class="folder-icon">${key === FOLDER_ALL ? "✦" : "▰"}</span><span class="folder-name">${escapeHtml(folder.title)}</span><span class="folder-number">${folder.count}</span>`;
  button.addEventListener("click", () => {
    state.activeFolder = key;
    renderFolders();
    renderBookmarks();
  });
  return button;
}

function matchesBookmark(bookmark) {
  if (state.activeFolder !== FOLDER_ALL && bookmark.path.join("/") !== state.activeFolder) return false;
  if (!state.query) return true;
  const haystack = [bookmark.title, bookmark.url, bookmark.folder, bookmark.path.join("/")].join(" ").toLowerCase();
  return haystack.includes(state.query.toLowerCase());
}

function renderBookmarks() {
  const grid = $("bookmarkGrid");
  const visible = state.bookmarks.filter(matchesBookmark);
  grid.replaceChildren();
  $("noResults").classList.toggle("hidden", visible.length > 0);
  for (const bookmark of visible) grid.append(makeBookmarkCard(bookmark));
  const filtered = Boolean(state.query) || state.activeFolder !== FOLDER_ALL;
  $("searchSummary").classList.toggle("hidden", !filtered);
  if (filtered) {
    $("searchSummary").textContent = `显示 ${visible.length} / ${state.bookmarks.length} 个书签`;
  }
  $("breadcrumbs").innerHTML = state.activeFolder === FOLDER_ALL
    ? "<strong>全部书签</strong>"
    : `<span>文件夹</span><span>›</span><strong>${escapeHtml(state.activeFolder)}</strong>`;
}

function isSafeBookmarkUrl(value) {
  try {
    return ["http:", "https:", "ftp:", "mailto:"].includes(new URL(value).protocol.toLowerCase());
  } catch {
    return false;
  }
}

function makeBookmarkCard(bookmark) {
  const link = document.createElement(isSafeBookmarkUrl(bookmark.url) ? "a" : "div");
  link.className = "bookmark-card";
  if (link.tagName === "A") {
    link.href = bookmark.url;
    link.target = "_blank";
    link.rel = "noreferrer";
  }
  const icon = faviconUrl(bookmark.url);
  link.innerHTML = `
    <div class="card-top">
      <span class="favicon">${icon ? `<img src="${escapeHtml(icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : escapeHtml(initials(bookmark.title, bookmark.url))}</span>
      <span class="external-icon">↗</span>
    </div>
    <span class="card-title">${escapeHtml(bookmark.title || extractDomain(bookmark.url))}</span>
    <span class="card-url">${escapeHtml(extractDomain(bookmark.url))}</span>
    <span class="card-folder">${escapeHtml(bookmark.folder)}</span>
  `;
  const image = link.querySelector("img");
  if (image) {
    image.addEventListener("error", () => {
      image.replaceWith(document.createTextNode(initials(bookmark.title, bookmark.url)));
    });
  }
  return link;
}

function setupSearch() {
  const input = $("searchInput");
  input.addEventListener("input", () => {
    state.query = input.value.trim();
    $("clearSearch").classList.toggle("hidden", !state.query);
    renderBookmarks();
  });
  $("clearSearch").addEventListener("click", () => {
    input.value = "";
    state.query = "";
    input.focus();
    $("clearSearch").classList.add("hidden");
    renderBookmarks();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== input) {
      event.preventDefault();
      input.focus();
    }
  });
}

function renderApp(snapshot) {
  state.snapshot = snapshot;
  const flattened = flattenSnapshot(snapshot);
  state.bookmarks = flattened.bookmarks;
  state.folders = flattened.folders;
  $("bookmarkMeta").textContent = `${state.bookmarks.length} 个书签`;
  $("updatedAt").textContent = formatDate(snapshot.generatedAt);
  renderFolders();
  renderBookmarks();
  setView("appView");
  $("lockButton").classList.remove("hidden");
}

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return value;
  }
}

async function unlock(passphrase, fromFragment = false) {
  $("unlockError").textContent = "";
  try {
    const snapshot = await decryptEnvelope(state.envelope, passphrase);
    sessionStorage.setItem("bookmark-nav-unlocked", "1");
    renderApp(snapshot);
    if (!fromFragment) {
      // Do not put a typed password into browser history. Fragment links are opt-in only.
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  } catch (error) {
    setView("unlockView");
    $("unlockError").textContent = error.message;
    $("passphrase").focus();
  }
}

function lock() {
  sessionStorage.removeItem("bookmark-nav-unlocked");
  state.snapshot = null;
  state.bookmarks = [];
  state.folders = [];
  state.activeFolder = FOLDER_ALL;
  state.query = "";
  $("passphrase").value = "";
  $("lockButton").classList.add("hidden");
  $("bookmarkMeta").textContent = "等待解锁";
  setView("unlockView");
}

async function boot() {
  applyTheme(getSavedTheme());
  setupSearch();
  $("themeToggle").addEventListener("click", () => applyTheme(state.theme === "dark" ? "light" : "dark"));
  $("lockButton").addEventListener("click", lock);
  $("revealPassphrase").addEventListener("click", () => {
    const input = $("passphrase");
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    $("revealPassphrase").textContent = visible ? "显示" : "隐藏";
  });
  $("unlockForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void unlock($("passphrase").value);
  });

  try {
    state.envelope = await fetchEnvelope();
    if (state.envelope.status === "not-initialized") {
      setView("emptyView");
      $("bookmarkMeta").textContent = "尚未同步";
      return;
    }
    setView("unlockView");
    const fragmentKey = readFragmentKey();
    if (fragmentKey) {
      $("passphrase").value = fragmentKey;
      await unlock(fragmentKey, true);
    }
  } catch (error) {
    setView("unlockView");
    $("unlockError").textContent = error.message;
  }
}

void boot();
