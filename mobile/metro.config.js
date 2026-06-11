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
config.resolver.unstable_enableSymlinks = true
config.resolver.disableHierarchicalLookup = true

module.exports = config
