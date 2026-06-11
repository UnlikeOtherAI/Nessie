// Metro configuration for the pnpm monorepo.
//
// pnpm hoists workspace packages into a symlinked `node_modules` tree, and the
// shared packages (@nessie/client-core, @nessie/schemas) live at the monorepo
// root, not under mobile/. Metro must therefore:
//   1. watch the monorepo root (so it picks up the workspace packages), and
//   2. resolve modules from both mobile/node_modules and <root>/node_modules.
//   3. follow symlinks (pnpm links every dep as a symlink).
//
// Without this, `npx expo export` fails to resolve the @nessie/* imports.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const projectRoot = __dirname
const monorepoRoot = path.resolve(projectRoot, '..')

const config = getDefaultConfig(projectRoot)

// 1. Watch the whole monorepo so changes in packages/* are picked up.
config.watchFolders = [monorepoRoot]

// 2. Resolve from the app first, then the hoisted root store.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
]

// 3. pnpm stores every dependency as a symlink; Metro must traverse them.
config.resolver.unstable_enableSymlinks = true
config.resolver.disableHierarchicalLookup = true

// 4. The workspace packages publish their build output via `exports`
//    (./dist/index.js), which is absent in the dev tree. Rather than require a
//    prebuild, resolve the @nessie/* packages to their TypeScript source so
//    Metro/Babel transpile them inline. Confined to these two source-only
//    workspace packages; everything else uses normal resolution.
const workspaceSourceEntries = {
  '@nessie/client-core': path.resolve(monorepoRoot, 'packages/client-core/src/index.ts'),
  '@nessie/schemas': path.resolve(monorepoRoot, 'packages/schemas/src/index.ts'),
}

// The workspace sources use NodeNext-style relative imports ending in `.js`
// (e.g. `import './api-client.js'`) that actually point at `.ts` files. Metro
// does not rewrite those, so strip a trailing `.js` on relative imports that
// originate from the monorepo's `packages/*/src` trees before resolving.
const packagesSrcRoot = path.resolve(monorepoRoot, 'packages')
const shouldStripJs = (originDir, moduleName) =>
  moduleName.startsWith('.') &&
  moduleName.endsWith('.js') &&
  originDir.startsWith(packagesSrcRoot)

const defaultResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const sourceEntry = workspaceSourceEntries[moduleName]
  if (sourceEntry) {
    return { type: 'sourceFile', filePath: sourceEntry }
  }
  const resolver = defaultResolveRequest ?? context.resolveRequest
  const originDir = context.originModulePath ? path.dirname(context.originModulePath) : ''
  if (shouldStripJs(originDir, moduleName)) {
    // Drop the `.js` so Metro resolves the real `.ts`/`.tsx` source via its
    // normal source-extension lookup.
    return resolver(context, moduleName.replace(/\.js$/, ''), platform)
  }
  return resolver(context, moduleName, platform)
}

module.exports = config
