import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repositoryDirectory = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const normalizeLineEndings = (text) => text.replace(/\r\n?/g, "\n");
const readWorkflow = async (path) =>
  normalizeLineEndings(await readFile(path, "utf8"));

// The Windows Native check runs in Desktop CI, beside the Linux desktop bundle,
// so a desktop build never holds a server deploy.
const ciWorkflow = await readWorkflow(
  resolve(repositoryDirectory, ".github/workflows/desktop-ci.yml"),
);
const releaseWorkflow = await readWorkflow(
  resolve(repositoryDirectory, ".github/workflows/desktop-windows.yml"),
);
const edgeWorkflow = await readWorkflow(
  resolve(repositoryDirectory, ".github/workflows/windows-edge.yml"),
);
const directDownloadWorkflow = await readWorkflow(
  resolve(repositoryDirectory, ".github/workflows/release.yml"),
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
const executorCiKernelFixture = await readFile(
  resolve(
    repositoryDirectory,
    "executor/packaging/windows/create-ci-guest-kernel.ps1",
  ),
  "utf8",
);
const executorMsiBuild = await readFile(
  resolve(repositoryDirectory, "executor/packaging/windows/build-msi.mjs"),
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

test("workflow parsing accepts Windows CRLF checkouts", () => {
  const windowsCheckout = ciWorkflow.replaceAll("\n", "\r\n");
  assert.match(
    jobBlock(normalizeLineEndings(windowsCheckout), "windows-native"),
    /name: Windows Native/,
  );
});

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
    "Create verified executor MSI CI kernel fixture",
    "Build unsigned Windows desktop installers",
    "Validate unsigned Windows desktop MSI",
    "Build unsigned Windows executor MSI",
    "Smoke-test unsigned Windows desktop installer",
    "Smoke-test unsigned Windows executor MSI",
  ]) {
    assert.notEqual(
      windowsNative.indexOf(`      - name: ${stepName}\n`),
      -1,
      stepName,
    );
  }
  assert.match(windowsNative, /wix msi validate/);
  assert.match(windowsNative, /desktop\/scripts\/windows-installer-smoke\.ps1/);
  assert.match(
    windowsNative,
    /executor\/packaging\/windows\/installer-smoke\.ps1/,
  );
  assert.match(
    windowsNative,
    /create-ci-guest-kernel\.ps1 -OutputPath \$fixturePath/,
  );
  assert.match(windowsNative, /node executor\/packaging\/windows\/build-msi\.mjs/);
  assert.match(executorMsiBuild, /'msi', 'validate'/);
  assert.match(
    executorCiKernelFixture,
    /intentionally not a bootable kernel/,
  );
  assert.match(
    executorCiKernelFixture,
    /\$expectedSha256 = '[0-9a-f]{64}'/,
  );
  assert.match(
    executorCiKernelFixture,
    /Get-FileHash -LiteralPath \$absoluteOutputPath -Algorithm SHA256/,
  );
  assert.match(executorCiKernelFixture, /nessie\\\.args=initrd/);
  assert.doesNotMatch(windowsNative, /\n    needs:/);
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

test(
  "the executor MSI fixture is deterministic and carries the required marker",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "nessie-windows-native-"));
    const outputPath = join(directory, "bzImage");
    try {
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          resolve(
            repositoryDirectory,
            "executor/packaging/windows/create-ci-guest-kernel.ps1",
          ),
          "-OutputPath",
          outputPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const fixture = await readFile(outputPath, "ascii");
      assert.match(fixture, /nessie\.args=initrd/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);

// The signing identity trusts the windows-signing environment alone, so the
// expression that decides who joins it is the whole signing boundary.
test("only a build of main itself or its exact release tag can reach the signing identity", () => {
  const build = jobBlock(releaseWorkflow, "build");
  const environment = /\n    environment: >-\n((?: {6}.+\n)+)/.exec(`\n${build}`);
  assert.ok(environment, "the build job joins an environment");
  const expression = environment[1].replace(/\s+/g, " ").trim();
  assert.equal(
    expression,
    "${{ ((github.ref == 'refs/heads/main' && inputs.source_ref == '') || "
      + "(startsWith(github.ref, 'refs/tags/v') && inputs.source_ref == github.ref)) && "
      + "'windows-signing' || '' }}",
  );
  assert.match(build, /\n {6}id-token: write\n/);
  // A branch cannot supply a source to sign: the ref reaches PowerShell as
  // data, never spliced into the script.
  const resolveSigning = stepBlock(build, "Resolve signing");
  assert.match(resolveSigning, /NESSIE_SOURCE_REF: \$\{\{ inputs\.source_ref \}\}/);
  assert.doesNotMatch(resolveSigning.split("run: |")[1], /\$\{\{ inputs\./);
});

test("Windows signing stores no credential and goes through the committed signer", () => {
  assert.doesNotMatch(releaseWorkflow, /secrets\.(WINDOWS_SIGN|AZURE_)/);
  assert.doesNotMatch(releaseWorkflow, /AZURE_CLIENT_SECRET|THUMBPRINT/);
  const build = jobBlock(releaseWorkflow, "build");
  assert.match(
    stepBlock(build, "Prepare Artifact Signing"),
    /& executor\/packaging\/windows\/signing\/sign\.ps1 -Prepare/,
  );
  assert.match(
    stepBlock(build, "Sign the executor package"),
    /& executor\/packaging\/windows\/signing\/sign\.ps1 \$_\.FullName/,
  );
  assert.match(stepBlock(build, "Verify signatures"), /\$publisher\.profileEku/);
});

test("main's edge builds and release tags must be signed", () => {
  const edgeBuild = jobBlock(edgeWorkflow, "build");
  assert.match(edgeBuild, /require_signed_release: true/);
  assert.match(edgeBuild, /id-token: write/);
  // A cancelling group would restart a forty-minute build on every merge.
  assert.match(edgeWorkflow, /\nconcurrency:\n {2}group: windows-edge\n {2}cancel-in-progress: false\n/);
  const releaseWindows = jobBlock(directDownloadWorkflow, "windows");
  assert.match(releaseWindows, /require_signed_release: true/);
  assert.match(releaseWindows, /id-token: write/);
});

test("shared installer smoke scripts propagate install and uninstall failures", () => {
  for (const smoke of [desktopInstallerSmoke, executorInstallerSmoke]) {
    assert.match(smoke, /\$install\w*\.ExitCode -ne 0/);
    assert.match(smoke, /\$uninstall\w*\.ExitCode -ne 0/);
  }
});
