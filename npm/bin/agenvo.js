#!/usr/bin/env node
// Unified entry point for the agenvo CLI.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const PLATFORM_PACKAGE_BY_TARGET = {
  "x86_64-unknown-linux-gnu": "agenvo-linux-x64",
  "aarch64-unknown-linux-gnu": "agenvo-linux-arm64",
  "x86_64-apple-darwin": "agenvo-darwin-x64",
  "aarch64-apple-darwin": "agenvo-darwin-arm64",
  "x86_64-pc-windows-msvc": "agenvo-win32-x64",
  "aarch64-pc-windows-msvc": "agenvo-win32-arm64",
};

function detectTargetTriple(platformName, archName) {
  switch (platformName) {
    case "linux":
      if (archName === "x64") {
        return "x86_64-unknown-linux-gnu";
      }
      if (archName === "arm64") {
        return "aarch64-unknown-linux-gnu";
      }
      break;
    case "darwin":
      if (archName === "x64") {
        return "x86_64-apple-darwin";
      }
      if (archName === "arm64") {
        return "aarch64-apple-darwin";
      }
      break;
    case "win32":
      if (archName === "x64") {
        return "x86_64-pc-windows-msvc";
      }
      if (archName === "arm64") {
        return "aarch64-pc-windows-msvc";
      }
      break;
    default:
      break;
  }
  return null;
}

function detectPackageManager() {
  const userAgent = process.env.npm_config_user_agent || "";
  if (/\bbun\//.test(userAgent)) {
    return "bun";
  }
  return userAgent ? "npm" : null;
}

const targetTriple = detectTargetTriple(process.platform, process.arch);
if (!targetTriple) {
  throw new Error(`Unsupported platform: ${process.platform} (${process.arch})`);
}

const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
if (!platformPackage) {
  throw new Error(`Unsupported target triple: ${targetTriple}`);
}

const binaryName = process.platform === "win32" ? "agenvo.exe" : "agenvo";
const localVendorRoot = path.join(__dirname, "..", "vendor");
const localBinaryPath = path.join(localVendorRoot, targetTriple, "agenvo", binaryName);

let vendorRoot;
try {
  const packageJsonPath = require.resolve(`${platformPackage}/package.json`);
  vendorRoot = path.join(path.dirname(packageJsonPath), "vendor");
} catch {
  if (existsSync(localBinaryPath)) {
    vendorRoot = localVendorRoot;
  } else {
    const manager = detectPackageManager();
    const updateCommand =
      manager === "bun" ? "bun install -g agenvo@latest" : "npm install -g agenvo@latest";
    throw new Error(`Missing optional dependency ${platformPackage}. Reinstall agenvo: ${updateCommand}`);
  }
}

const binaryPath = path.join(vendorRoot, targetTriple, "agenvo", binaryName);
const env = { ...process.env };
env[detectPackageManager() === "bun" ? "AGENVO_MANAGED_BY_BUN" : "AGENVO_MANAGED_BY_NPM"] = "1";

const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
  env,
});

child.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

const forwardSignal = (signal) => {
  if (child.killed) {
    return;
  }
  try {
    child.kill(signal);
  } catch {
    // Ignore errors when the child already exited.
  }
};

["SIGINT", "SIGTERM", "SIGHUP"].forEach((signal) => {
  process.on(signal, () => forwardSignal(signal));
});

const childResult = await new Promise((resolve) => {
  child.on("exit", (code, signal) => {
    if (signal) {
      resolve({ type: "signal", signal });
    } else {
      resolve({ type: "code", exitCode: code ?? 1 });
    }
  });
});

if (childResult.type === "signal") {
  process.kill(process.pid, childResult.signal);
} else {
  process.exit(childResult.exitCode);
}
