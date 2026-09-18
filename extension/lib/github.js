const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";

function authHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "Content-Type": "application/json"
  };
}

async function parseResponse(response) {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { message: text || "GitHub 返回了无效响应" };
  }
  if (!response.ok) {
    const error = new Error(payload?.message || `GitHub 请求失败（${response.status}）`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function request(path, token, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    // Never serve file SHAs from the HTTP cache: a stale SHA makes the next
    // PUT fail with "does not match <sha>" even though nothing else changed.
    cache: "no-store",
    headers: {
      ...authHeaders(token),
      ...(options.headers || {})
    }
  });
  return parseResponse(response);
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function stringToBase64(value) {
  return bytesToBase64(new TextEncoder().encode(value));
}

export function validateConfig(config) {
  const required = ["owner", "repo", "branch", "token", "passphrase"];
  const missing = required.filter((key) => !config?.[key]);
  if (missing.length) {
    throw new Error(`配置不完整：缺少 ${missing.join("、")}`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(config.owner) || !/^[A-Za-z0-9_.-]+$/.test(config.repo)) {
    throw new Error("GitHub owner/repo 格式不正确");
  }
}

export async function getRepository(config) {
  validateConfig(config);
  return request(`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`, config.token);
}

export async function getFile(config, path) {
  validateConfig(config);
  const encodedPath = encodePath(path);
  try {
    const file = await request(
      `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(config.branch)}`,
      config.token
    );
    return { exists: true, sha: file.sha, file };
  } catch (error) {
    if (error.status === 404) {
      return { exists: false, sha: null, file: null };
    }
    throw error;
  }
}

export async function putFile(config, path, content, message) {
  validateConfig(config);
  const current = await getFile(config, path);
  const body = {
    message,
    content: stringToBase64(content),
    branch: config.branch
  };
  if (current.sha) {
    body.sha = current.sha;
  }

  try {
    return await request(
      `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodePath(path)}`,
      config.token,
      {
        method: "PUT",
        body: JSON.stringify(body)
      }
    );
  } catch (error) {
    if (error.status !== 409) {
      throw error;
    }
    // Another client may have committed between GET and PUT. Refresh the SHA once.
    const latest = await getFile(config, path);
    if (!latest.sha) {
      throw error;
    }
    return request(
      `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodePath(path)}`,
      config.token,
      {
        method: "PUT",
        body: JSON.stringify({ ...body, sha: latest.sha })
      }
    );
  }
}

export async function getRateLimit(config) {
  validateConfig(config);
  return request("/rate_limit", config.token);
}
