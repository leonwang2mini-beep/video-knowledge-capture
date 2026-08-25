import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LauncherError,
  assertSupportedNode,
  isAppAlreadyRunning,
  launchDesktopApp,
} from "../src/launcher.mjs";
import { startLocalApp } from "../src/server.mjs";
import { APP_VERSION } from "../src/version.mjs";

const silentLogger = { error() {}, log() {} };

test("launcher enforces Node.js 20 or newer", () => {
  assert.equal(assertSupportedNode("20.0.0"), 20);
  assert.equal(assertSupportedNode("24.16.0"), 24);
  assert.throws(
    () => assertSupportedNode("18.20.0"),
    (error) => error instanceof LauncherError
      && error.code === "NODE_VERSION_UNSUPPORTED",
  );
});

test("launcher recognizes the exact local app health signature", async () => {
  const matchingFetch = async () => ({
    ok: true,
    async json() {
      return {
        app: "video-knowledge-capture",
        version: APP_VERSION,
        status: "ok",
        binding: "127.0.0.1",
      };
    },
  });
  const otherFetch = async () => ({
    ok: true,
    async json() {
      return { app: "other-service", status: "ok", binding: "127.0.0.1" };
    },
  });

  assert.equal(await isAppAlreadyRunning({ fetchImpl: matchingFetch, port: 43127 }), true);
  assert.equal(await isAppAlreadyRunning({ fetchImpl: otherFetch, port: 43127 }), false);
});

test("repeated launch opens the existing app without starting a second server", async () => {
  const opened = [];
  let startCalls = 0;
  const result = await launchDesktopApp({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          app: "video-knowledge-capture",
          version: APP_VERSION,
          status: "ok",
          binding: "127.0.0.1",
        };
      },
    }),
    logger: silentLogger,
    openBrowserImpl(url) {
      opened.push(url);
    },
    port: 43127,
    async startAppImpl() {
      startCalls += 1;
      throw new Error("must not start");
    },
  });

  assert.equal(result.mode, "existing");
  assert.equal(startCalls, 0);
  assert.deepEqual(opened, ["http://127.0.0.1:43127"]);
});

test("launcher rejects an already running older app instead of opening stale code", async () => {
  let startCalls = 0;
  await assert.rejects(
    launchDesktopApp({
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            app: "video-knowledge-capture",
            binding: "127.0.0.1",
            status: "ok",
            version: "0.2.0",
          };
        },
      }),
      logger: silentLogger,
      openBrowser: false,
      async startAppImpl() {
        startCalls += 1;
      },
    }),
    (error) => error instanceof LauncherError
      && error.code === "APP_VERSION_CONFLICT"
      && /关闭原启动窗口/.test(error.message),
  );
  assert.equal(startCalls, 0);
});

test("launcher starts and opens a new app when no matching service exists", async () => {
  const opened = [];
  const fakeServer = { close() {} };
  const result = await launchDesktopApp({
    fetchImpl: async () => {
      throw new Error("offline");
    },
    logger: silentLogger,
    openBrowserImpl(url) {
      opened.push(url);
    },
    port: 43127,
    async startAppImpl(options) {
      assert.equal(options.openBrowser, false);
      assert.equal(options.port, 43127);
      return { server: fakeServer, url: "http://127.0.0.1:43127" };
    },
  });

  assert.equal(result.mode, "started");
  assert.equal(result.server, fakeServer);
  assert.deepEqual(opened, ["http://127.0.0.1:43127"]);
});

test("launcher detects a real running instance through the loopback health endpoint", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "video-capture-launcher-test-"));
  const first = await startLocalApp({
    configDir: path.join(tempRoot, "config"),
    logger: silentLogger,
    port: 0,
  });
  try {
    const port = Number(new URL(first.url).port);
    let startCalls = 0;
    const opened = [];
    const repeated = await launchDesktopApp({
      logger: silentLogger,
      openBrowserImpl(url) {
        opened.push(url);
      },
      port,
      async startAppImpl() {
        startCalls += 1;
        throw new Error("must not start");
      },
    });
    assert.equal(repeated.mode, "existing");
    assert.equal(startCalls, 0);
    assert.deepEqual(opened, [first.url]);
  } finally {
    await new Promise((resolve) => first.server.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});
