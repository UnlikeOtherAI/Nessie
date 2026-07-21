import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "packages/billing-statement-protocol");
const manifestPath = join(
  repositoryRoot,
  "packages/billing-statement-protocol.upstream.sha256",
);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (
      entry.isDirectory()
      && [".turbo", "dist", "node_modules"].includes(entry.name)
    ) {
      continue;
    }

    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath)));
    } else if (entry.isFile()) {
      files.push(relative(packageRoot, absolutePath));
    }
  }

  return files.sort();
}

const manifest = (await readFile(manifestPath, "utf8"))
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => {
    const match = /^([a-f0-9]{64})\s{2}(.+)$/.exec(line);
    if (!match) {
      throw new Error(`Invalid billing protocol checksum line: ${line}`);
    }
    return [match[2], match[1]];
  });
const expected = new Map(manifest);
const actualFiles = await listFiles(packageRoot);
const failures = [];

for (const file of actualFiles) {
  if (!expected.has(file)) {
    failures.push(`unexpected file: ${file}`);
    continue;
  }

  const actualHash = createHash("sha256")
    .update(await readFile(join(packageRoot, file)))
    .digest("hex");
  if (actualHash !== expected.get(file)) {
    failures.push(`checksum mismatch: ${file}`);
  }
}

for (const file of expected.keys()) {
  if (!actualFiles.includes(file)) {
    failures.push(`missing file: ${file}`);
  }
}

if (failures.length > 0) {
  throw new Error(
    `Vendored billing protocol differs from UOA's pinned public package:\n${failures.join("\n")}`,
  );
}

console.log(
  "Verified @unlikeotherai/billing-statement-protocol against UOA commit 675ff2349029eeb56deadcac6aaf1fd7ed6f5fbd.",
);
