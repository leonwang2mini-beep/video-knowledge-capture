import { copyFile, lstat, mkdir, readFile, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";


function assertInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing destination outside the explicit installation root: ${candidate}`);
  }
}

async function assertNotLink(candidate) {
  try {
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link destination: ${candidate}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function pruneUndeclaredFiles(managedRoot, installationRoot, declaredTargets, pruned) {
  let entries;
  try {
    entries = await readdir(managedRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const candidate = path.join(managedRoot, entry.name);
    assertInside(installationRoot, candidate);
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link destination: ${candidate}`);
    }
    if (metadata.isDirectory()) {
      await pruneUndeclaredFiles(candidate, installationRoot, declaredTargets, pruned);
      const remaining = await readdir(candidate);
      if (remaining.length === 0) {
        await rmdir(candidate);
        pruned.push(candidate);
      }
      continue;
    }
    if (!declaredTargets.has(path.resolve(candidate))) {
      await rm(candidate, { force: true });
      pruned.push(candidate);
    }
  }
}

export async function exactSyncFiles({ installationRoot, managedRoots, files }) {
  const resolvedRoot = path.resolve(installationRoot);
  if (resolvedRoot === path.parse(resolvedRoot).root) {
    throw new Error("Installation root cannot be a filesystem root.");
  }

  const resolvedManagedRoots = managedRoots.map((entry) => path.resolve(entry));
  const declaredTargets = new Set(files.map(({ target }) => path.resolve(target)));
  const copied = [];
  const pruned = [];

  await mkdir(resolvedRoot, { recursive: true });
  await assertNotLink(resolvedRoot);

  for (const managedRoot of resolvedManagedRoots) {
    assertInside(resolvedRoot, managedRoot);
    await assertNotLink(managedRoot);
    await pruneUndeclaredFiles(managedRoot, resolvedRoot, declaredTargets, pruned);
  }

  for (const { source, target } of files) {
    const resolvedTarget = path.resolve(target);
    assertInside(resolvedRoot, resolvedTarget);
    await assertNotLink(resolvedTarget);
    await mkdir(path.dirname(resolvedTarget), { recursive: true });
    await copyFile(source, resolvedTarget);
    const [sourceBytes, targetBytes] = await Promise.all([
      readFile(source),
      readFile(resolvedTarget),
    ]);
    if (!sourceBytes.equals(targetBytes)) {
      throw new Error(`Installed file verification failed: ${resolvedTarget}`);
    }
    copied.push(resolvedTarget);
  }

  return { copied, pruned };
}
