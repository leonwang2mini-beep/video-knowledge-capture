import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWechatFirewallPowerShellArgs,
  resolveWechatFirewallTargets,
} from "../src/wechat-firewall.mjs";

test("WeChat firewall setup targets only managed stable executable paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "p0004-firewall-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "runtime", "wxChannel", "wx_channel.exe");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "fixture");
  await writeFile(path.join(root, "runtime", "runtime-manifest.json"), JSON.stringify({
    components: { wxChannel: { path: sourcePath } },
  }));

  const targets = await resolveWechatFirewallTargets(root, {
    tempRoot: path.join(root, "temp"),
  });
  const args = buildWechatFirewallPowerShellArgs({
    action: "install",
    scriptPath: path.join(root, "wechat-firewall.ps1"),
    targets,
  });

  assert.equal(
    targets.patchedExecutablePath,
    path.join(root, "work", "wx-channel-buffer", "runtime", "wx_channel.exe"),
  );
  assert.equal(targets.sourceExecutablePath, sourcePath);
  assert.equal(args.includes("-Program"), false);
  assert.equal(args[args.indexOf("-Action") + 1], "install");
  assert.equal(
    args[args.indexOf("-PatchedExecutablePath") + 1],
    targets.patchedExecutablePath,
  );
});
