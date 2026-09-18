function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response || {});
    });
  });
}

function formatTime(value) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
  } catch {
    return value;
  }
}

function stateLabel(status) {
  const labels = {
    success: "已同步",
    syncing: "同步中…",
    pending: "等待同步",
    error: "同步失败",
    "not-configured": "尚未配置"
  };
  return labels[status?.state] || "未同步";
}

async function refresh() {
  const [statusResponse, configResponse] = await Promise.all([
    sendMessage({ type: "GET_STATUS" }),
    sendMessage({ type: "GET_CONFIG_SUMMARY" })
  ]);
  if (!statusResponse.ok) throw new Error(statusResponse.error || "读取状态失败");
  if (!configResponse.ok) throw new Error(configResponse.error || "读取配置失败");

  const status = statusResponse.status;
  $("repo").textContent = configResponse.configured
    ? `${configResponse.owner}/${configResponse.repo} · ${configResponse.file}`
    : "尚未配置 GitHub 仓库";
  $("state").className = `state ${status.state || ""}`;
  $("state").querySelector("span:last-child").textContent = stateLabel(status);
  $("lastSync").textContent = formatTime(status.lastSyncAt);
  $("count").textContent = Number.isFinite(status.bookmarkCount) ? String(status.bookmarkCount) : "—";
  $("error").textContent = status.lastError || "";
}

function $(id) { return document.getElementById(id); }

$("sync").addEventListener("click", async () => {
  $("sync").disabled = true;
  try {
    const result = await sendMessage({ type: "SYNC_NOW" });
    if (!result.ok) $("error").textContent = result.error || "同步失败";
    await refresh();
  } catch (error) {
    $("error").textContent = error.message;
  } finally {
    $("sync").disabled = false;
  }
});

$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

refresh().catch((error) => {
  $("error").textContent = error.message;
});
