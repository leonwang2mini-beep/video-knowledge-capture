import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readProjectFile(relativePath) {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}

test("offline UI keeps one primary link intake and moves setup into a collapsed panel", async () => {
  const html = await readProjectFile("web/index.html");

  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<form class="intake-form" id="intake-form"/);
  assert.match(html, /<label class="visually-hidden" for="intake-url">/);
  assert.match(html, /id="intake-submit" type="submit"/);
  assert.equal((html.match(/class="primary-action"/g) || []).length, 1);
  assert.match(html, /<details class="settings-panel" id="settings-panel">/);
  assert.match(html, /<label for="inbox-path">/);
  assert.match(html, /<label for="retained-media-path">/);
  assert.match(html, /id="retained-media-open" type="button">打开视频目录/);
  assert.match(html, /<label for="local-media-file">/);
  assert.match(html, /for="keep-media-default"/);
  assert.match(html, /id="yuanbao-login"/);
  assert.match(html, /id="intake-result" role="status" aria-live="polite"/);
  assert.match(html, /id="failure-list" aria-live="polite"/);
  assert.match(html, /id="media-job-list" aria-live="polite"/);
  assert.match(html, /class="skip-link"/);

  const resourceUrls = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(resourceUrls, ["/styles.css", "/app.js"]);
});

test("UI styles include keyboard focus, reduced motion and narrow-screen layouts", async () => {
  const css = await readProjectFile("web/styles.css");

  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(max-width: 860px\)/);
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /grid-template-columns: 1fr;/);
});

test("frontend avoids HTML injection and Windows launcher opens only the loopback app", async () => {
  const [client, launcherScript, launcher, server] = await Promise.all([
    readProjectFile("web/app.js"),
    readProjectFile("start-video-capture.cmd"),
    readProjectFile("src/launcher.mjs"),
    readProjectFile("src/server.mjs"),
  ]);

  assert.doesNotMatch(client, /\.innerHTML\s*=/);
  assert.match(client, /textContent/);
  assert.match(client, /apiRequest\("\/api\/intakes"/);
  assert.match(client, /keepMedia: elements\.keepMediaDefault\.checked/);
  assert.match(client, /body: \{ inboxDir, retainedMediaDir \}/);
  assert.match(client, /apiRequest\("\/api\/retained-media\/open", \{ method: "POST" \}\)/);
  assert.match(client, /addEventListener\("paste"/);
  assert.match(client, /job\.result\?\.retainedMediaPath/);
  assert.match(launcherScript, /node src\\launcher\.mjs/);
  assert.match(launcherScript, /%\*/);
  assert.doesNotMatch(launcherScript, /[^\x00-\x7F]/);
  assert.match(launcher, /assertSupportedNode/);
  assert.match(launcher, /isAppAlreadyRunning/);
  assert.match(server, /server\.listen\(port, "127\.0\.0\.1"/);
  assert.doesNotMatch(server, /0\.0\.0\.0/);
});

test("package, server and visible build share the same release version", async () => {
  const [packageText, versionModule, html] = await Promise.all([
    readProjectFile("package.json"),
    readProjectFile("src/version.mjs"),
    readProjectFile("web/index.html"),
  ]);
  const packageData = JSON.parse(packageText);

  assert.equal(packageData.version, "1.4.0-beta.1");
  assert.match(versionModule, /APP_VERSION = "1\.4\.0-beta\.1"/);
  assert.match(html, /BUILD 1\.4\.0-beta\.1/);
});
