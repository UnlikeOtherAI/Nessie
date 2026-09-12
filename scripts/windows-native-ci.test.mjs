import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryDirectory = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const ciWorkflow = await readFile(
  resolve(repositoryDirectory, ".github/workflows/ci.yml"),
  "utf8",
);
const releaseWorkflow = await readFile(
  resolve(repositoryDirectory, ".github/workflows/desktop-windows.yml"),
  "utf8",
);
const desktopInstallerSmoke = await readFile(
  resolve(repositoryDirectory, "desktop/scripts/windows-installer-smoke.ps1"),
  "utf8",
);
const executorInstallerSmoke = await readFile(
  resolve(
    repositoryDirectory,
    "executor/packaging/windows/installer-smoke.ps1",
  ),
  "utf8",
);

const nativeCargoTests = [
  ["Test desktop Rust crate", "desktop/src-tauri/Cargo.toml"],
  ["Test executor native helper crate", "executor/native/Cargo.toml"],
  ["Test Windows provenance crate", "executor/windows-provenance/Cargo.toml"],
  ["Test executor service crate", "executor/service-windows/Cargo.toml"],
  ["Test Hyper-V bridge crate", "executor/hyperv-bridge/Cargo.toml"],
  ["Test executor tray crate", "executor/tray-windows/src-tauri/Cargo.toml"],
];
const nativeExitCheck = "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }";

function jobBlock(workflow, jobName) {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing ${jobName} job`);
  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/\n  [a-z][a-z0-9-]*:\n/);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

function stepBlock(job, stepName) {
  const marker = `      - name: ${stepName}\n`;
  const start = job.indexOf(marker);
  assert.notEqual(start, -1, `missing ${stepName} step`);
  const remainder = job.slice(start + marker.length);
  const nextStep = remainder.search(/\n      - name: |\n  [a-z][a-z0-9-]*:\n/);
  return nextStep === -1 ? remainder : remainder.slice(0, nextStep);
}

test("each Windows-native Cargo test has its own explicit exit-enforcing step", () => {
  const windowsNative = jobBlock(ciWorkflow, "windows-native");
  const cargoCommands =
    windowsNative.match(/^          cargo test --manifest-path .+$/gm) ?? [];
  assert.equal(cargoCommands.length, nativeCargoTests.length);

  for (const [stepName, manifestPath] of nativeCargoTests) {
    const step = stepBlock(windowsNative, stepName);
    assert.match(step, /shell: pwsh/);
    assert.match(
      step,
      new RegExp(
        `cargo test --manifest-path ${manifestPath.replaceAll("/", "\\/")}`,
      ),
    );
    assert.ok(
      step.includes(nativeExitCheck),
      `${stepName} must propagate cargo's exit code`,
    );
    assert.equal((step.match(/cargo test --manifest-path/g) ?? []).length, 1);
  }
});

test(
  "the native exit check stops after an earlier failing command",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `& $env:ComSpec '/d' '/c' 'exit 73'; ${nativeExitCheck}; & $env:ComSpec '/d' '/c' 'exit 0'`,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 73, result.stderr);
  },
);

test("Windows Native builds and smoke-tests unsigned installers without signing", () => {
  const windowsNative = jobBlock(ciWorkflow, "windows-native");
  for (const stepName of [
    "Build unsigned Windows desktop installers",
    "Validate unsigned Windows desktop MSI",
    "Smoke-test unsigned Windows desktop installer",
  ]) {
    assert.notEqual(
      windowsNative.indexOf(`      - name: ${stepName}\n`),
      -1,
      stepName,
    );
  }
  assert.match(windowsNative, /wix msi validate/);
  assert.match(windowsNative, /desktop\/scripts\/windows-installer-smoke\.ps1/);
  assert.doesNotMatch(windowsNative, /WINDOWS_SIGN_|TAURI_SIGNING_/);
  assert.match(
    releaseWorkflow,
    /desktop\/scripts\/windows-installer-smoke\.ps1/,
  );
  assert.match(
    releaseWorkflow,
    /executor\/packaging\/windows\/installer-smoke\.ps1/,
  );
});

test("shared installer smoke scripts propagate install and uninstall failures", () => {
  for (const smoke of [desktopInstallerSmoke, executorInstallerSmoke]) {
    assert.match(smoke, /\$install\w*\.ExitCode -ne 0/);
    assert.match(smoke, /\$uninstall\w*\.ExitCode -ne 0/);
  }
});
