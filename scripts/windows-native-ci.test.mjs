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
  ["Test shared Windows executor runtime", "executor/windows-common/Cargo.toml"],
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

test("the release gives Tauri an argument-safe Artifact Signing command", () => {
  const desktopBuild = stepBlock(releaseWorkflow, "Build the desktop bundles");
  assert.match(desktopBuild, /\$signCommand = @\{/);
  assert.match(desktopBuild, /cmd = 'pwsh\.exe'/);
  assert.match(desktopBuild, /'-File', \$signScript/);
  assert.match(desktopBuild, /'-FilePath', '%1'/);
  assert.doesNotMatch(
    desktopBuild,
    /signCommand = \$env:WINDOWS_SIGN_COMMAND/,
  );
});

// PowerShell's EnhancedKeyUsageList items carry the OID as a string ObjectId
// and have no Value, so both `$_.Value` and `$_.ObjectId.Value` read blanks and
// fail every correctly signed file. The OID collection is the certificate's own
// EKU extension, whose Oid items do have Value.
test("the release reads EKU values from the Oid collection", () => {
  const signatureVerification = stepBlock(releaseWorkflow, "Verify signatures");
  assert.match(signatureVerification, /X509EnhancedKeyUsageExtension/);
  assert.match(
    signatureVerification,
    /ForEach-Object \{ \$_\.EnhancedKeyUsages \} \|\n\s+ForEach-Object \{ \$_\.Value \}/,
  );
  assert.doesNotMatch(signatureVerification, /EnhancedKeyUsageList \|/);
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

// The managed identity trusts exactly two environments, so the expression that
// decides which one a build joins is the whole signing boundary: a release tag
// behind a release owner's approval, main itself without one, nothing else.
test("only a release tag or main itself can reach the signing identity", () => {
  const build = jobBlock(releaseWorkflow, "build");
  const environment = /\n    environment: >-\n((?: {6}.+\n)+)/.exec(`\n${build}`);
  assert.ok(environment, "the build job chooses its environment");
  assert.equal(
    environment[1].replace(/\s+/g, " ").trim(),
    "${{ (startsWith(github.ref, 'refs/tags/v') && inputs.source_ref == github.ref && "
      + "'direct-download-release') || "
      + "(github.ref == 'refs/heads/main' && inputs.source_ref == '' && 'windows-signing') || '' }}",
  );
  assert.match(releaseWorkflow, /\npermissions:\n {2}contents: read\n {2}id-token: write\n/);
  // The source ref reaches PowerShell as data, never spliced into the script.
  const resolveSigning = stepBlock(build, "Resolve signing configuration");
  assert.match(resolveSigning, /NESSIE_SOURCE_REF: \$\{\{ inputs\.source_ref \}\}/);
  assert.doesNotMatch(resolveSigning.split("run: |")[1], /\$\{\{ inputs\./);
  assert.doesNotMatch(releaseWorkflow, /secrets\.(WINDOWS_SIGN|AZURE_)|AZURE_CLIENT_SECRET/);
});

test("main's edge builds and release tags must be signed", () => {
  const edgeBuild = jobBlock(edgeWorkflow, "build");
  assert.match(edgeBuild, /uses: \.\/\.github\/workflows\/desktop-windows\.yml/);
  assert.match(edgeBuild, /require_signed_release: true/);
  assert.match(edgeBuild, /id-token: write/);
  // A cancelling group would restart a forty-minute build on every merge.
  assert.match(edgeWorkflow, /\nconcurrency:\n {2}group: windows-edge\n {2}cancel-in-progress: false\n/);
  assert.match(jobBlock(directDownloadWorkflow, "windows"), /require_signed_release: true/);
});

test("a published Windows build names its commit and versions", () => {
  const build = jobBlock(releaseWorkflow, "build");
  assert.match(stepBlock(build, "Resolve build versions"), /release-components\.mjs version executor/);
  assert.match(stepBlock(build, "Build the desktop bundles"), /version = \$env:NESSIE_DESKTOP_VERSION/);
  assert.match(stepBlock(build, "Collect artifacts"), /artifacts\/build-info\.json/);
  // The checkout is the commit the run was started for, not the branch tip.
  assert.doesNotMatch(releaseWorkflow, /inputs\.source_ref \|\| github\.ref \}\}/);
});

test("shared installer smoke scripts propagate install and uninstall failures", () => {
  for (const smoke of [desktopInstallerSmoke, executorInstallerSmoke]) {
    assert.match(smoke, /\$install\w*\.ExitCode -ne 0/);
    assert.match(smoke, /\$uninstall\w*\.ExitCode -ne 0/);
  }
});
