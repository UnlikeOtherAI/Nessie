#!/usr/bin/env node
/**
 * Playwright screenshot + ImageMagick pixel comparison loop.
 * Usage: node compare.js [channel|dm|files]   (defaults to all)
 */
const { chromium } = require('playwright');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ORIGINALS = {
  channel: path.resolve(__dirname, '../../tmp/Screenshot 2026-04-07 at 21.17.06.png'),
  dm:      path.resolve(__dirname, '../../tmp/Screenshot 2026-04-07 at 21.16.29.png'),
  files:   path.resolve(__dirname, '../../tmp/Screenshot 2026-04-07 at 21.17.29.png'),
};

const PAGES = {
  channel: path.resolve(__dirname, 'channel.html'),
  dm:      path.resolve(__dirname, 'dm.html'),
  files:   path.resolve(__dirname, 'files.html'),
};

// Screenshots are 2x Retina: 2708×1872 → logical 1354×936
// Crop 100px from top of 2x original = 50px in 1x = removes macOS window chrome
// Resulting original height: (1872-100)/2 = 886
const VIEWPORT_W = 1354;
const VIEWPORT_H = 886;
const ORIG_CROP_TOP_2X = 100;

async function screenshotPage(pageName) {
  const htmlPath = PAGES[pageName];
  if (!fs.existsSync(htmlPath)) { console.log(`  SKIP: ${htmlPath} not found`); return null; }

  const browser = await chromium.launch({ headless: true });
  // Use 2x device scale to match original Retina screenshots — both will be downsampled to 1x
  const ctx = await browser.newContext({ viewport: { width: VIEWPORT_W, height: VIEWPORT_H }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`file://${htmlPath}`);
  await page.waitForLoadState('networkidle');

  const outPath2x = path.resolve(__dirname, `../../tmp/tpl-${pageName}-2x.png`);
  const outPath = path.resolve(__dirname, `../../tmp/tpl-${pageName}.png`);
  await page.screenshot({ path: outPath2x, fullPage: false });
  await browser.close();

  // Downsample 2x → 1x to match original screenshot processing
  magick(outPath2x, '-resize', `${VIEWPORT_W}x${VIEWPORT_H}!`, '+repage', outPath);
  return outPath;
}

function magick(...args) {
  const r = spawnSync('magick', args, { encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function getImageDimensions(imgPath) {
  const r = magick('identify', '-format', '%wx%h', imgPath);
  const [w, h] = (r.stdout || r.stderr || '').trim().split('x').map(Number);
  return { w, h };
}

function compare(screenshotPath, originalPath, pageName) {
  const croppedOrigPath = path.resolve(__dirname, `../../tmp/orig-${pageName}-1x.png`);
  const diffPath = path.resolve(__dirname, `../../tmp/diff-${pageName}.png`);

  const { w: origW, h: origH } = getImageDimensions(originalPath);
  const croppedH2x = origH - ORIG_CROP_TOP_2X;
  const logicalW = Math.floor(origW / 2);
  const logicalH = Math.floor(croppedH2x / 2);

  // Crop top chrome, scale to 1x, then crop to exact viewport
  magick(
    originalPath,
    '-crop', `${origW}x${croppedH2x}+0+${ORIG_CROP_TOP_2X}`,
    '+repage',
    '-resize', `${logicalW}x${logicalH}!`,
    '-crop', `${VIEWPORT_W}x${VIEWPORT_H}+0+0`,
    '+repage',
    croppedOrigPath
  );

  // AE = absolute error (different pixel count)
  const cmpResult = spawnSync('magick', [
    'compare', '-metric', 'AE', '-fuzz', '12%',
    croppedOrigPath, screenshotPath, diffPath
  ], { encoding: 'utf8' });

  const raw = (cmpResult.stdout || '') + (cmpResult.stderr || '');
  const diffPixels = parseInt(raw.trim()) || 0;
  const totalPixels = VIEWPORT_W * VIEWPORT_H;
  const similarity = ((1 - diffPixels / totalPixels) * 100).toFixed(2);

  return { similarity: parseFloat(similarity), diffPixels, totalPixels, diffPath, croppedOrigPath };
}

async function run() {
  const targets = process.argv[2]
    ? [process.argv[2]]
    : Object.keys(PAGES).filter(k => fs.existsSync(PAGES[k]));

  let allPassed = true;

  for (const name of targets) {
    console.log(`\n── ${name.toUpperCase()} ──`);
    const ssPath = await screenshotPage(name);
    if (!ssPath) continue;

    const orig = ORIGINALS[name];
    if (!fs.existsSync(orig)) { console.log(`  SKIP: original not found`); continue; }

    const { similarity, diffPixels, totalPixels, diffPath, croppedOrigPath } = compare(ssPath, orig, name);
    const pass = similarity >= 98;

    console.log(`  ${pass ? '✓' : '✗'} Similarity: ${similarity}%  (${diffPixels.toLocaleString()} / ${totalPixels.toLocaleString()} pixels differ)`);
    console.log(`  Template   : ${ssPath}`);
    console.log(`  Original   : ${croppedOrigPath}`);
    console.log(`  Diff image : ${diffPath}`);
    if (!pass) { allPassed = false; console.log(`  Need ${(98 - similarity).toFixed(2)}% more match`); }
  }

  console.log(allPassed ? '\n✓ All pages ≥ 98%' : '\n✗ Below threshold — review diffs and iterate');
  process.exit(allPassed ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
