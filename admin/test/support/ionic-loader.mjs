// Ionic publishes ESM .js without a package type. tsx interprets those files
// as CommonJS, losing named exports. Node tests use Ionic's own CJS build;
// Vite continues to tree-shake the public ESM entry in the product.
export const resolve = (specifier, context, nextResolve) => nextResolve(
  specifier === '@ionic/core' ? '@ionic/core/dist/index.cjs.js' : specifier,
  context,
)
