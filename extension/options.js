import { bookmarksToHtml, getNormalizedBookmarks } from "./lib/bookmarks.js";
import { getRepository } from "./lib/github.js";
import { validatePassphrase } from "./lib/crypto.js";

const $ = (id) => document.getElementById(id);
const fields = ["owner", "repo", "branch", "token", "passphrase"];

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result || {});
    });
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response || {});
    });
  });
}

function showMessage(text, type = "") {
  const element = $("message");
  element.textContent = text;
  element.className = `message ${type}`.trim();
}

function getFormConfig() {
  return Object.fromEntries(fields.map((field) => [field, $(field).value.trim()]));
}

function validateForm(config, requireToken = true) {
  const required = requireToken ? fields : ["owner", "repo", "branch", "passphrase"];
  const missing = required.filter((key) => !config[key]);
  if (missing.length) {
    throw new Error(`请填写：${missing.join("、")}`);
  }
  if (config.passphrase !== $("passphraseConfirm").value.trim()) {
    throw new Error("两次输入的加密口令不一致");
  }
  const passphraseWarning = validatePassphrase(config.passphrase);
  if (passphraseWarning) {
    throw new Error(passphraseWarning);
  }
}

async function loadConfig() {
  const { config = {} } = await storageGet(["config"]);
  for (const field of fields) {
    if (config[field]) $(field).value = config[field];
  }
  // Keep the confirmation field aligned when reopening settings, while the
  // actual token and passphrase remain masked by the browser password inputs.
  $("passphraseConfirm").value = config.passphrase || "";
  if (!$("branch").value) $("branch").value = "main";
}

async function saveConfig({ silent = false } = {}) {
  const config = getFormConfig();
  validateForm(config, true);
  await storageSet({ config });
  if (!silent) showMessage("配置已保存。现在可以点击“立即全量同步”。", "success");
  return config;
}

async function testConnection() {
  const button = $("test");
  button.disabled = true;
  try {
    const config = getFormConfig();
    validateForm(config, false);
    if (!config.token) throw new Error("测试连接需要填写 GitHub Token");
    const repository = await getRepository(config);
    showMessage(`连接成功：${repository.full_name}（默认分支 ${repository.default_branch || config.branch}）`, "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function syncNow() {
  const button = $("sync");
  button.disabled = true;
  try {
    await saveConfig({ silent: true });
    const result = await sendMessage({ type: "SYNC_NOW" });
    if (!result.ok) throw new Error(result.error || "同步失败");
    showMessage(`同步完成，共处理 ${result.bookmarkCount ?? "—"} 个书签。`, "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function exportBackup() {
  const button = $("export");
  button.disabled = true;
  try {
    const snapshot = await getNormalizedBookmarks();
    const html = bookmarksToHtml(snapshot);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `bookmarks-backup-${new Date().toISOString().slice(0, 10)}.html`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showMessage("明文备份已生成，请将它放在安全位置。", "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

$("save").addEventListener("click", () => {
  saveConfig().catch((error) => showMessage(error.message, "error"));
});
$("test").addEventListener("click", () => void testConnection());
$("sync").addEventListener("click", () => void syncNow());
$("export").addEventListener("click", () => void exportBackup());

loadConfig().catch((error) => showMessage(`读取配置失败：${error.message}`, "error"));
