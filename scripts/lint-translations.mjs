import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LOCALES = ['en-GB', 'en-US', 'cs', 'de', 'fr', 'it', 'es'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

function flatten(value, prefix = '', output = new Map()) {
  if (typeof value === 'string') {
    output.set(prefix, value);
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, output);
    }
  }
  return output;
}

function interpolationTokens(value) {
  return [...value.matchAll(/{{\s*-?\s*([^{}]+?)\s*}}/g)]
    .map((match) => match[1].trim())
    .sort();
}

async function jsonFiles(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function sourceFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function staticTranslationCalls(source) {
  const namespacesByTranslator = new Map();
  const hook = /(?:const|let)\s*\{\s*t(?:\s*:\s*([\w$]+))?\s*\}\s*=\s*useTranslation\(\s*(['"])([^'"]+)\2\s*\)/g;
  for (const match of source.matchAll(hook)) namespacesByTranslator.set(match[1] ?? 't', match[3]);

  const calls = [];
  for (const [translator, namespace] of namespacesByTranslator) {
    const escaped = translator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const call = new RegExp(`\\b${escaped}\\(\\s*(['"])([^'"]+)\\1`, 'g');
    for (const match of source.matchAll(call)) calls.push({ namespace, key: match[2] });
  }
  return calls;
}

/** Validate the locale catalogs and literal keys in UI source. Returns diagnostics. */
export async function checkTranslations(i18nRoot, sourceRoot) {
  const errors = [];
  const registryPath = join(i18nRoot, 'namespaces.ts');
  let registeredNamespaces = [];
  try {
    const registry = await readFile(registryPath, 'utf8');
    const declaration = registry.match(/translationNamespaces\s*=\s*\[([\s\S]*?)\]/);
    if (!declaration) errors.push('namespaces.ts: could not read translationNamespaces array');
    else registeredNamespaces = [...declaration[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
  } catch (error) {
    if (error.code === 'ENOENT') errors.push('namespaces.ts: translation namespace registry is missing');
    else throw error;
  }
  if (new Set(registeredNamespaces).size !== registeredNamespaces.length) {
    errors.push('namespaces.ts: translationNamespaces contains duplicate names');
  }

  const localeFiles = new Map();
  for (const locale of LOCALES) {
    const files = await jsonFiles(join(i18nRoot, 'locales', locale));
    localeFiles.set(locale, files);
    if (!files.length) errors.push(`${locale}: no namespace JSON catalogs found`);
  }

  const referenceFiles = localeFiles.get('en-GB') ?? [];
  const registeredFiles = registeredNamespaces.map((namespace) => `${namespace}.json`).sort();
  for (const file of registeredFiles) {
    if (!referenceFiles.includes(file)) errors.push(`en-GB: registered namespace has no catalog: ${file}`);
  }
  for (const file of referenceFiles) {
    if (!registeredFiles.includes(file)) errors.push(`en-GB: catalog is not registered in namespaces.ts: ${file}`);
  }
  for (const locale of LOCALES.slice(1)) {
    const files = localeFiles.get(locale) ?? [];
    const missing = referenceFiles.filter((file) => !files.includes(file));
    const extra = files.filter((file) => !referenceFiles.includes(file));
    if (missing.length) errors.push(`${locale}: missing namespace file(s): ${missing.join(', ')}`);
    if (extra.length) errors.push(`${locale}: unexpected namespace file(s): ${extra.join(', ')}`);
  }

  const catalogs = new Map();
  for (const locale of LOCALES) {
    const localeCatalogs = new Map();
    for (const file of localeFiles.get(locale) ?? []) {
      const namespace = file.slice(0, -'.json'.length);
      let parsed;
      try {
        parsed = JSON.parse(await readFile(join(i18nRoot, 'locales', locale, file), 'utf8'));
      } catch (error) {
        errors.push(`${locale}/${file}: invalid JSON (${error.message})`);
        continue;
      }
      const leaves = flatten(parsed);
      if (!leaves.size) errors.push(`${locale}/${file}: catalog has no string values`);
      for (const [key, value] of leaves) {
        if (!value.trim()) errors.push(`${locale}/${file}: ${key} has an empty translation`);
      }
      localeCatalogs.set(namespace, leaves);
    }
    catalogs.set(locale, localeCatalogs);
  }

  const sourceCatalogs = catalogs.get('en-GB') ?? new Map();
  for (const [namespace, source] of sourceCatalogs) {
    for (const locale of LOCALES.slice(1)) {
      const target = catalogs.get(locale)?.get(namespace);
      if (!target) continue;
      for (const key of source.keys()) {
        if (!target.has(key)) errors.push(`${locale}/${namespace}.json: missing key ${key}`);
      }
      for (const key of target.keys()) {
        if (!source.has(key)) errors.push(`${locale}/${namespace}.json: unexpected key ${key}`);
      }
      for (const [key, sourceValue] of source) {
        if (!target.has(key)) continue;
        const expected = interpolationTokens(sourceValue);
        const actual = interpolationTokens(target.get(key));
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          errors.push(`${locale}/${namespace}.json: ${key} interpolation tokens differ (expected ${expected.join(', ') || 'none'}; found ${actual.join(', ') || 'none'})`);
        }
      }
    }
  }

  if (sourceRoot) {
    for (const file of await sourceFiles(sourceRoot)) {
      const source = await readFile(file, 'utf8');
      for (const { namespace, key } of staticTranslationCalls(source)) {
        const namespaceCatalog = sourceCatalogs.get(namespace);
        const relativeFile = relative(sourceRoot, file);
        if (!namespaceCatalog) errors.push(`${relativeFile}: useTranslation references unknown namespace ${namespace}`);
        else if (!namespaceCatalog.has(key)) errors.push(`${relativeFile}: missing translation key ${namespace}.${key}`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.cwd();
  const errors = await checkTranslations(join(root, 'admin/src/i18n'), join(root, 'admin/src'));
  if (errors.length) {
    console.error(`Translation lint failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`Translation lint passed for ${LOCALES.join(', ')}.`);
  }
}
