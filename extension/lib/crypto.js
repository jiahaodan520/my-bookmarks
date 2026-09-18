const DEFAULT_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function stringToBase64Url(value) {
  return bytesToBase64Url(encoder.encode(value));
}

export function base64UrlToString(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return decoder.decode(base64ToBytes(padded));
}

async function deriveKey(passphrase, salt, iterations = DEFAULT_ITERATIONS) {
  if (typeof passphrase !== "string" || passphrase.length < 1) {
    throw new Error("加密口令不能为空");
  }

  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256"
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptJson(value, passphrase, options = {}) {
  const iterations = options.iterations || DEFAULT_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

  return {
    v: 1,
    kdf: "PBKDF2-SHA256",
    iterations,
    cipher: "AES-GCM-256",
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ciphertext)),
    updatedAt: new Date().toISOString()
  };
}

export async function decryptJson(envelope, passphrase) {
  if (!envelope || envelope.status === "not-initialized") {
    throw new Error("远程书签还没有完成首次同步");
  }
  if (envelope.v !== 1 || envelope.kdf !== "PBKDF2-SHA256" || envelope.cipher !== "AES-GCM-256") {
    throw new Error("不支持的加密文件格式");
  }

  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ct);
  const key = await deriveKey(passphrase, salt, envelope.iterations || DEFAULT_ITERATIONS);

  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error("口令错误，或远程文件已损坏");
  }
}

export function validatePassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 12) {
    return "建议使用至少 12 个字符的强口令";
  }
  return "";
}
