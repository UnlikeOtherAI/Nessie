import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
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
      entry.isDirectory() &&
      [".turbo", "dist", "node_modules"].includes(entry.name)
    ) {
      continue;
    }

    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath)));
    } else if (entry.isFile()) {
      files.push(relative(packageRoot, absolutePath).replaceAll(sep, "/"));
    }
  }

  return files.sort();
}

async function upstreamFileDigest(file) {
  const contents = await readFile(join(packageRoot, file));
  // The upstream manifest is recorded from Git's LF checkout. Text files in a
  // Windows checkout can be CRLF through core.autocrlf without being modified.
  const canonicalContents = isUtf8(contents)
    ? Buffer.from(contents.toString("utf8").replaceAll("\r\n", "\n"), "utf8")
    : contents;

  return createHash("sha256").update(canonicalContents).digest("hex");
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

  const actualHash = await upstreamFileDigest(file);
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
  "Verified @unlikeotherai/billing-statement-protocol against UOA commit 698765f.",
);
