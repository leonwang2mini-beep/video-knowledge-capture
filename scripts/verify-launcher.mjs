import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APP_VERSION } from "../src/version.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcherPath = path.join(projectRoot, "src", "launcher.mjs");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "video-capture-launcher-"));
const configDir = path.join(tempRoot, "config");

async function reserveAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  assert.ok(port);
  return port;
}

function collectProcess(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}

async function verifyBatchWrapper() {
  if (process.platform !== "win32") {
    return "skipped-non-windows";
  }
  const probe = spawn(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/c", "start-video-capture.cmd", "--port", "invalid"],
    {
      cwd: projectRoot,
      env: { ...process.env, VKC_NO_PAUSE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const result = await collectProcess(probe);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Starting local capture desk/);
  assert.doesNotMatch(result.stderr, /is not recognized/i);
  return "passed";
}

async function waitForHealth(url) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) {
        const payload = await response.json();
        if (payload.app === "video-knowledge-capture" && payload.status === "ok") {
          return payload;
        }
      }
    } catch {
      // The child process may still be binding the loopback port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("launcher health check timed out");
}

const port = await reserveAvailablePort();
const batchWrapper = await verifyBatchWrapper();
const url = `http://127.0.0.1:${port}`;
const commonArgs = [
  launcherPath,
  "--no-open",
  "--port",
  String(port),
  "--config-dir",
  configDir,
];
const first = spawn(process.execPath, commonArgs, {
  cwd: projectRoot,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const firstResult = collectProcess(first);

let report;
try {
  const health = await waitForHealth(url);
  assert.equal(health.binding, "127.0.0.1");
  assert.equal(health.version, APP_VERSION);

  const second = spawn(process.execPath, commonArgs, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const repeated = await collectProcess(second);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.match(repeated.stdout, /已经在运行/);

  report = {
    status: "passed",
    checks: {
      first_process_started: true,
      app_version: health.version,
      health_signature_matched: true,
      loopback_binding: health.binding,
      repeated_launch_exit_code: repeated.code,
      repeated_launch_detected_existing_app: true,
      windows_batch_wrapper: batchWrapper,
      browser_opened_during_test: false,
    },
  };
} finally {
  if (first.exitCode === null) {
    first.kill();
  }
  await firstResult;
  const resolvedTemp = path.resolve(tempRoot);
  const resolvedTempBase = path.resolve(os.tmpdir());
  assert.ok(resolvedTemp.startsWith(`${resolvedTempBase}${path.sep}`));
  await rm(resolvedTemp, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
