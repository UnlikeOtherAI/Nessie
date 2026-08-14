// Metro configuration for the pnpm monorepo.
//
// pnpm (nodeLinker: hoisted) places the dependency tree at the monorepo root,
// not under mobile/. Metro must therefore watch the root and resolve modules
// from both mobile/node_modules and <root>/node_modules, following the
// symlinks pnpm creates. The mobile app is a standalone WebView shell and does
// not import the @nessie/* workspace packages, so no source aliasing is needed.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const projectRoot = __dirname
const monorepoRoot = path.resolve(projectRoot, '..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [monorepoRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
]
// Expo's URL polyfill requires webidl-conversions v5, which is nested below
// whatwg-url-without-unicode. In the hoisted workspace, Metro otherwise picks
// an unrelated root v8 package that assumes SharedArrayBuffer exists; Hermes
// on iOS does not expose that global and the application crashes at boot.
const expoWebIdlConversions = path.resolve(
  monorepoRoot,
  'node_modules/whatwg-url-without-unicode/node_modules/webidl-conversions/lib/index.js',
)
const defaultResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === 'webidl-conversions' &&
    context.originModulePath.includes(`${path.sep}whatwg-url-without-unicode${path.sep}`)
  ) {
    return { filePath: expoWebIdlConversions, type: 'sourceFile' }
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform)
}
config.resolver.unstable_enableSymlinks = true
config.resolver.disableHierarchicalLookup = true

module.exports = config
