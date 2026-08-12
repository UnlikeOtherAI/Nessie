type NativeShellInfo = {
  clientId: string
  formFactor: 'ipad' | 'phone'
  platform: string
}

export const createNativePushSurfaceClientId = (): string => {
  const fragment = (): string => Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, '0')
  const random = `${fragment()}${fragment()}${fragment()}${fragment()}`
  return `${random.slice(0, 8)}-${random.slice(8, 12)}-4${random.slice(13, 16)}-8${random.slice(17, 20)}-${random.slice(20, 32)}`
}

export const nativeShellInfoScript = (info: NativeShellInfo): string => `
window.__nessieNativeShell = { platform: ${JSON.stringify(info.platform)}, formFactor: ${
  JSON.stringify(info.formFactor)
} };
window.__nessieNativeAppForeground = true;
window.__nessiePushSurfaceClientId = ${JSON.stringify(info.clientId)};
try { window.dispatchEvent(new Event('nessie:native-shell-info')); } catch (e) {}
true;
`

export const nativeAppForegroundScript = (foreground: boolean): string => `
window.__nessieNativeAppForeground = ${JSON.stringify(foreground)};
try {
  window.dispatchEvent(new CustomEvent('nessie:native-app-foreground', {
    detail: ${JSON.stringify(foreground)},
  }));
} catch (e) {}
`
