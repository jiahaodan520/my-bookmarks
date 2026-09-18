import { encryptJson } from "./lib/crypto.js";
import { bookmarksToHtml, getNormalizedBookmarks } from "./lib/bookmarks.js";
import { getRateLimit, putFile, validateConfig } from "./lib/github.js";

const BOOKMARK_FILE = "data/bookmarks.enc.json";
const SYNC_ALARM = "bookmark-nav-sync";
const RETRY_DELAY_MINUTES = 1;
const DEBOUNCE_MS = 15_000;

let debounceTimer = null;
let syncInFlight = null;

function storageGet(area, keys) {
  return new Promise((resolve, reject) => {
    area.get(keys, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function storageSet(area, values) {
  return new Promise((resolve, reject) => {
    area.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function storageRemove(area, keys) {
  return new Promise((resolve, reject) => {
    area.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function getPendingArea() {
  return chrome.storage.session || chrome.storage.local;
}

async function getConfig() {
  const { config = null } = await storageGet(chrome.storage.local, ["config"]);
  return config;
}

async function getStatus() {
  const { status = null } = await storageGet(chrome.storage.local, ["status"]);
  return status || {
    state: "not-configured",
    lastSyncAt: null,
    lastError: null,
    lastTrigger: null
  };
}

async function setStatus(patch) {
  const current = await getStatus();
  await storageSet(chrome.storage.local, {
    status: {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    }
  });
}

async function getPending() {
  const values = await storageGet(getPendingArea(), ["pendingSync"]);
  return values.pendingSync || { dirty: false, revision: 0, dirtySince: null, reason: null };
}

async function setPending(pending) {
  await storageSet(getPendingArea(), { pendingSync: pending });
}

async function markDirty(reason) {
  const current = await getPending();
  const pending = {
    dirty: true,
    revision: (current.revision || 0) + 1,
    dirtySince: current.dirtySince || new Date().toISOString(),
    reason: reason || "bookmark-change"
  };
  await setPending(pending);
  await setStatus({ state: "pending", lastError: null, lastTrigger: pending.reason });
  scheduleDebouncedSync();
}

function createAlarm(delayInMinutes) {
  try {
    chrome.alarms.create(SYNC_ALARM, { delayInMinutes });
  } catch {
    // A setTimeout below is still used while the worker remains alive.
  }
}

function scheduleDebouncedSync() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runSync({ force: false, trigger: "debounced-change" });
  }, DEBOUNCE_MS);
  createAlarm(0.5);
}

async function schedulePendingRecovery() {
  const pending = await getPending();
  if (pending.dirty) {
    createAlarm(0.5);
  }
}

async function clearPendingIfUnchanged(startRevision) {
  const latest = await getPending();
  if ((latest.revision || 0) === startRevision) {
    await setPending({ dirty: false, revision: latest.revision || 0, dirtySince: null, reason: null });
    try {
      await chrome.alarms.clear(SYNC_ALARM);
    } catch {
      // Clearing an already-fired alarm is harmless if the API rejects it.
    }
    return true;
  }
  createAlarm(0.5);
  return false;
}

async function runSync({ force = false, trigger = "manual" } = {}) {
  if (syncInFlight) {
    return syncInFlight;
  }

  syncInFlight = (async () => {
    const config = await getConfig();
    if (!config) {
      await setStatus({
        state: "not-configured",
        lastError: "请先在扩展设置中填写 GitHub 仓库和加密口令",
        lastTrigger: trigger
      });
      return { ok: false, reason: "not-configured" };
    }

    let pending = await getPending();
    if (!force && !pending.dirty) {
      return { ok: true, skipped: true };
    }
    if (force && !pending.dirty) {
      pending = {
        dirty: true,
        revision: (pending.revision || 0) + 1,
        dirtySince: new Date().toISOString(),
        reason: trigger
      };
      await setPending(pending);
    }

    const startRevision = pending.revision || 0;
    await setStatus({ state: "syncing", lastError: null, lastTrigger: trigger });

    try {
      validateConfig(config);
      const snapshot = await getNormalizedBookmarks();
      const envelope = await encryptJson(snapshot, config.passphrase);
      const content = `${JSON.stringify(envelope, null, 2)}\n`;
      const result = await putFile(
        config,
        BOOKMARK_FILE,
        content,
        `sync bookmarks: ${new Date().toISOString()}`
      );

      let rateLimit = null;
      try {
        const rate = await getRateLimit(config);
        rateLimit = rate?.resources?.core || rate?.rate || null;
      } catch {
        // Rate limit visibility is best-effort and must not fail a successful sync.
      }

      const cleared = await clearPendingIfUnchanged(startRevision);
      await setStatus({
        state: cleared ? "success" : "pending",
        lastSyncAt: new Date().toISOString(),
        lastError: null,
        lastTrigger: trigger,
        lastCommit: result?.commit?.sha || result?.content?.sha || null,
        bookmarkCount: countBookmarks(snapshot),
        rateLimit
      });
      return { ok: true, cleared, bookmarkCount: countBookmarks(snapshot) };
    } catch (error) {
      const latest = await getPending();
      await setPending({
        dirty: true,
        revision: latest.revision || startRevision || 1,
        dirtySince: latest.dirtySince || new Date().toISOString(),
        reason: latest.reason || trigger
      });
      await setStatus({
        state: "error",
        lastError: error?.message || String(error),
        lastTrigger: trigger
      });
      createAlarm(RETRY_DELAY_MINUTES);
      return { ok: false, error: error?.message || String(error) };
    }
  })().finally(() => {
    syncInFlight = null;
  });

  return syncInFlight;
}

function countBookmarks(snapshot) {
  let count = 0;
  function visit(node) {
    if (node.type === "bookmark") {
      count += 1;
      return;
    }
    (node.children || []).forEach(visit);
  }
  (snapshot.roots || []).forEach(visit);
  return count;
}

function registerBookmarkEvents() {
  const events = [
    [chrome.bookmarks.onCreated, "created"],
    [chrome.bookmarks.onRemoved, "removed"],
    [chrome.bookmarks.onChanged, "changed"],
    [chrome.bookmarks.onMoved, "moved"],
    [chrome.bookmarks.onChildrenReordered, "reordered"],
    [chrome.bookmarks.onImportEnded, "import-ended"]
  ];

  for (const [event, reason] of events) {
    if (event?.addListener) {
      event.addListener(() => {
        void markDirty(reason);
      });
    }
  }
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) {
      void runSync({ force: false, trigger: "alarm" });
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void setStatus({ state: "not-configured", lastError: null, lastTrigger: "installed" });
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    void schedulePendingRecovery();
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_STATUS") {
    getStatus().then((status) => sendResponse({ ok: true, status })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SYNC_NOW") {
    runSync({ force: true, trigger: "manual" })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_CONFIG_SUMMARY") {
    getConfig()
      .then((config) => sendResponse({
        ok: true,
        configured: Boolean(config),
        owner: config?.owner || "",
        repo: config?.repo || "",
        branch: config?.branch || "main",
        file: BOOKMARK_FILE
      }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CLEAR_ERROR") {
    setStatus({ lastError: null }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

registerBookmarkEvents();
void schedulePendingRecovery();
