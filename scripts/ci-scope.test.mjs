import { strict as assert } from 'node:assert';
import test from 'node:test';

import { isWindowsNative } from './ci-scope.mjs';

test('Windows-native scope includes every shipped Windows source tree', () => {
  for (const file of [
    'desktop/src-tauri/src/lib.rs',
    'executor/service-windows/src/main.rs',
    'executor/packaging/windows/nessie-executor.wxs',
    'executor/guest/kernel/PIN',
    'assets/icon-1024.png',
  ]) {
    assert.equal(isWindowsNative(file), true, file);
  }
});

test('Windows-native scope leaves unrelated product code to its own checks', () => {
  for (const file of [
    'admin/src/App.tsx',
    'api/src/routes/projects.ts',
    'packages/runtime/src/index.ts',
    'docs/running-the-apps/windows-desktop.md',
  ]) {
    assert.equal(isWindowsNative(file), false, file);
  }
});
