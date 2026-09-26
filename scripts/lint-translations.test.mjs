import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkTranslations, LOCALES } from './lint-translations.mjs';

async function fixture(t, { catalogs = {}, source = "const { t } = useTranslation('accountMenu'); t('greeting', { name });" } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nessie-i18n-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const i18n = join(root, 'admin/src/i18n');
  const sourceRoot = join(root, 'admin/src');
  await mkdir(i18n, { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(i18n, 'namespaces.ts'), "export const translationNamespaces = ['accountMenu'] as const\n");
  await writeFile(join(sourceRoot, 'page.tsx'), source);
  for (const locale of LOCALES) {
    await mkdir(join(i18n, 'locales', locale), { recursive: true });
    const values = catalogs[locale] ?? catalogs.default ?? { greeting: 'Hello {{name}}' };
    await writeFile(join(i18n, 'locales', locale, 'accountMenu.json'), JSON.stringify(values));
  }
  return { i18n, sourceRoot };
}

test('accepts complete catalogs with matching interpolations and source keys', async (t) => {
  const paths = await fixture(t);
  assert.deepEqual(await checkTranslations(paths.i18n, paths.sourceRoot), []);
});

test('reports missing locale keys, empty values, and interpolation mismatch', async (t) => {
  const catalogs = { default: { greeting: 'Hello {{name}}', other: 'Other' }, fr: { greeting: 'Bonjour {{person}}', other: '   ' }, it: { greeting: 'Ciao {{name}}' } };
  const paths = await fixture(t, { catalogs });
  const errors = await checkTranslations(paths.i18n, paths.sourceRoot);
  assert.ok(errors.some((error) => error.includes('fr/accountMenu.json: greeting interpolation tokens differ')));
  assert.ok(errors.some((error) => error.includes('fr/accountMenu.json: other has an empty translation')));
  assert.ok(errors.some((error) => error.includes('it/accountMenu.json: missing key other')));
});

test('reports incomplete catalogs, namespace registration drift, and missing source keys', async (t) => {
  const paths = await fixture(t, { catalogs: { default: { greeting: 'Hello' }, de: {} }, source: "const { t } = useTranslation('accountMenu'); t('missing');" });
  const namespaceFile = join(paths.i18n, 'namespaces.ts');
  await writeFile(namespaceFile, "export const translationNamespaces = ['accountMenu', 'profile'] as const\n");
  const errors = await checkTranslations(paths.i18n, paths.sourceRoot);
  assert.ok(errors.some((error) => error.includes('missing key greeting')));
  assert.ok(errors.some((error) => error.includes('has no string values')));
  assert.ok(errors.some((error) => error.includes('registered namespace has no catalog: profile.json')));
  assert.ok(errors.some((error) => error.includes('missing translation key accountMenu.missing')));
});

test('rejects malformed JSON and mismatched namespace files', async (t) => {
  const paths = await fixture(t);
  const esFile = join(paths.i18n, 'locales/es/accountMenu.json');
  await writeFile(esFile, '{broken');
  const enPath = join(paths.i18n, 'locales/en-GB/accountMenu.json');
  const en = JSON.parse(await readFile(enPath, 'utf8'));
  delete en.greeting;
  await writeFile(enPath, JSON.stringify(en));
  await writeFile(join(paths.i18n, 'locales/en-GB/extra.json'), '{}');
  await writeFile(join(paths.i18n, 'locales/fr/extra.json'), '{}');
  const errors = await checkTranslations(paths.i18n, paths.sourceRoot);
  assert.ok(errors.some((error) => error.includes('invalid JSON')));
  assert.ok(errors.some((error) => error.includes('catalog is not registered')));
  assert.ok(errors.some((error) => error.includes('missing namespace file')));
});
