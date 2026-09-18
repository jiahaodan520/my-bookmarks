function callBookmarks(method, ...args) {
  return new Promise((resolve, reject) => {
    try {
      chrome.bookmarks[method](...args, (result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export async function getBookmarkTree() {
  return callBookmarks("getTree");
}

function normalizeNode(node) {
  const base = {
    title: node.title || "未命名",
    dateAdded: Number.isFinite(node.dateAdded) ? node.dateAdded : undefined
  };

  if (node.url) {
    return {
      type: "bookmark",
      ...base,
      url: node.url
    };
  }

  return {
    type: "folder",
    ...base,
    dateGroupModified: Number.isFinite(node.dateGroupModified) ? node.dateGroupModified : undefined,
    children: (node.children || []).map(normalizeNode)
  };
}

function removeUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(removeUndefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, removeUndefined(item)])
    );
  }
  return value;
}

export function normalizeBookmarkTree(tree) {
  return {
    schema: 1,
    source: "chrome-bookmarks",
    generatedAt: new Date().toISOString(),
    roots: removeUndefined((tree || []).map(normalizeNode))
  };
}

export async function getNormalizedBookmarks() {
  const tree = await getBookmarkTree();
  return normalizeBookmarkTree(tree);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isSafeBookmarkUrl(value) {
  try {
    return ["http:", "https:", "ftp:", "mailto:"].includes(new URL(value).protocol.toLowerCase());
  } catch {
    return false;
  }
}

function renderHtmlNode(node, depth = 0) {
  const indent = "  ".repeat(depth);
  if (node.type === "bookmark") {
    const label = escapeHtml(node.title || node.url);
    if (!isSafeBookmarkUrl(node.url)) {
      return `${indent}<li><span title="浏览器内部或脚本链接，未导出为可点击链接">${label}</span></li>`;
    }
    return `${indent}<li><a href="${escapeHtml(node.url)}">${label}</a></li>`;
  }
  const children = (node.children || []).map((child) => renderHtmlNode(child, depth + 1)).join("\n");
  return `${indent}<li><strong>${escapeHtml(node.title)}</strong>\n${indent}<ul>\n${children}\n${indent}</ul></li>`;
}

export function bookmarksToHtml(snapshot) {
  const body = (snapshot.roots || []).map((root) => renderHtmlNode(root, 2)).join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bookmark Nav 明文备份</title>
</head>
<body>
  <h1>Bookmark Nav 明文备份</h1>
  <p>导出时间：${escapeHtml(snapshot.generatedAt || new Date().toISOString())}</p>
  <ul>
${body}
  </ul>
</body>
</html>
`;
}
