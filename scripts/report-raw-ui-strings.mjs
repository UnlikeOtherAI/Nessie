import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const sourceRoot = join(root, 'admin/src');
const reviewedAttributes = new Set(['aria-label', 'title', 'placeholder']);

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (['.tsx', '.jsx'].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

const candidates = [];
for (const file of await sourceFiles(sourceRoot)) {
  const text = await readFile(file, 'utf8');
  const add = (index, kind, rawValue) => {
    const value = rawValue.replace(/\s+/g, ' ').trim();
    if (value) candidates.push({ file, line: text.slice(0, index).split('\n').length, kind, value });
  };
  const attributes = /\b(aria-label|title|placeholder)\s*=\s*(['"])(.*?)\2/gs;
  for (const match of text.matchAll(attributes)) add(match.index, match[1], match[3]);
  // Match only plain text children of a single JSX element. This avoids
  // interpreting most TypeScript angle brackets as markup, but misses
  // multiline children and text nested with another element/expression.
  const jsxText = /<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?>([^<>{}\n]+?)<\/\1\s*>/g;
  for (const match of text.matchAll(jsxText)) add(match.index, 'JSX text candidate', match[2]);
}

candidates.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
console.log(`Raw UI string audit: ${candidates.length} candidate(s) in admin/src.`);
console.log('Review each candidate: this is a heuristic audit, not proof of coverage. It misses multiline text and text nested with JSX elements or expressions.');
for (const candidate of candidates) {
  const value = candidate.value.replaceAll('`', '\\`');
  console.log(`${relative(root, candidate.file)}:${candidate.line} [${candidate.kind}] ${value}`);
}
