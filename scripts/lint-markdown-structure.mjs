#!/usr/bin/env node

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES = 1000;
const BASELINE_PATH = path.join(process.cwd(), '.markdown-doc-structure-baseline.json');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function getTrackedMarkdownFiles() {
  const output = execSync("git ls-files '*.md'", {
    encoding: 'utf8',
  });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) {
    return [];
  }

  const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

  if (Array.isArray(parsed)) {
    return parsed.filter((value) => typeof value === 'string');
  }

  const legacy = parsed.allowedOversizedMarkdown;
  if (Array.isArray(legacy)) {
    return legacy.filter((value) => typeof value === 'string');
  }

  return [];
}

function markdownLineCount(file) {
  const content = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
  if (content.length === 0) {
    return 0;
  }

  const lineBreaks = content.match(/\r?\n/g)?.length ?? 0;
  return content.endsWith('\n') ? lineBreaks : lineBreaks + 1;
}

function extractOverviewLinkTargets(overviewPath, content) {
  const links = new Set();
  const markdownLinks = [...content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)];

  for (const match of markdownLinks) {
    const raw = match[1]?.trim();
    if (!raw || raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('#')) {
      continue;
    }

    const target = raw.split('#')[0];
    if (!target || !target.toLowerCase().endsWith('.md')) {
      continue;
    }

    const absolute = path.resolve(path.dirname(overviewPath), target);
    const relative = path
      .relative(process.cwd(), absolute)
      .replace(/\\/g, '/');

    if (!relative || relative.startsWith('..')) {
      continue;
    }

    links.add(relative);
  }

  return links;
}

function expectedOverviewPath(file) {
  const directory = path.dirname(file);
  const baseName = path.basename(file, '.md');
  return path.join(directory, baseName, 'overview.md').replace(/\\/g, '/');
}

function main() {
  const markdownFiles = getTrackedMarkdownFiles();
  const markdownSet = new Set(markdownFiles);
  const baseline = new Set(loadBaseline());
  const violations = [];

  for (const file of markdownFiles) {
    const lines = markdownLineCount(file);
    if (lines > MAX_LINES && !baseline.has(file)) {
      const overviewPath = expectedOverviewPath(file);
      violations.push(
        `${file}: ${lines} lines (limit ${MAX_LINES}); split into ${overviewPath} plus chapter files`,
      );
    }
  }

  const overviewFiles = markdownFiles.filter((file) => path.basename(file) === 'overview.md');

  for (const overviewFile of overviewFiles) {
    const overviewPath = path.resolve(process.cwd(), overviewFile);
    const content = fs.readFileSync(overviewPath, 'utf8');
    const directory = path.dirname(overviewFile);
    const siblings = markdownFiles.filter(
      (file) => path.dirname(file) === directory && path.basename(file) !== 'overview.md',
    );

    const overviewLinks = extractOverviewLinkTargets(overviewPath, content);

    if (!/table\s+of\s+contents/i.test(content)) {
      violations.push(`${overviewFile}: missing "Table of Contents" section`);
    }

    if (siblings.length === 0) {
      violations.push(`${overviewFile}: overview collection has no sibling chapter markdown files`);
    }

    for (const sibling of siblings) {
      const normalizedSibling = sibling.replace(/\\/g, '/');
      const sameDirectoryLink = [...overviewLinks].some(
        (link) =>
          link === normalizedSibling &&
          path.dirname(link) === path.dirname(overviewFile).replace(/\\/g, '/'),
      );

      if (!sameDirectoryLink) {
        violations.push(`${overviewFile}: missing chapter link for ${normalizedSibling}`);
      }
    }

    const conflict = `${directory}.md`.replace(/\\/g, '/');
    if (markdownSet.has(conflict)) {
      violations.push(`${overviewFile}: conflict with sibling collection file ${conflict}`);
    }
  }

  if (violations.length > 0) {
    const unique = [...new Set(violations)];
    console.error('Markdown structure lint failed:');
    for (const issue of unique) {
      console.error(` - ${issue}`);
    }
    fail(`\n${unique.length} markdown structure violation(s) detected.`);
  }

  console.log(`Markdown structure lint passed for ${markdownFiles.length} tracked markdown files.`);
}

main();
