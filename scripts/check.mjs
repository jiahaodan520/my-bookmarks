import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = [
  "extension/background.js",
  "extension/options.js",
  "extension/popup.js",
  "extension/lib/bookmarks.js",
  "extension/lib/crypto.js",
  "extension/lib/github.js",
  "web/app.js"
];

let failed = false;
for (const relative of files) {
  const file = join(root, relative);
  if (!existsSync(file)) {
    console.error(`Missing file: ${relative}`);
    failed = true;
    continue;
  }
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`Syntax error: ${relative}`);
    process.stderr.write(result.stderr || result.stdout || "");
    failed = true;
  }
}

const manifest = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"));
const requiredPermissions = ["bookmarks", "storage", "alarms"];
for (const permission of requiredPermissions) {
  if (!manifest.permissions?.includes(permission)) {
    console.error(`Manifest is missing permission: ${permission}`);
    failed = true;
  }
}
if (manifest.manifest_version !== 3 || manifest.background?.service_worker !== "background.js") {
  console.error("Manifest is not configured as an MV3 service-worker extension");
  failed = true;
}

const placeholder = JSON.parse(readFileSync(join(root, "data/bookmarks.enc.json"), "utf8"));
if (placeholder.status !== "not-initialized") {
  console.error("The checked-in data placeholder must remain not-initialized");
  failed = true;
}

if (failed) process.exit(1);
console.log(`Checked ${files.length} JavaScript files, manifest, and data placeholder.`);
