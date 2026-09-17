import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

/**
 * The executor's local-MCP surface: the reviewed policy naming servers, the
 * availability of each named server with the reason when it is not, and
 * Kelpie's last-observed instance inventory with its pairing state.
 *
 * A pure fixture suite — the real detail panel over a stubbed access view —
 * so it needs the admin and nothing behind it. Every state is its own
 * scenario and its own screenshot, because the states are the feature:
 * "not installed" and "installed but nothing answered" send a person to
 * opposite machines, and a stale inventory rendered as current is the one
 * lie this screen must never tell.
 */

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/executor-local-mcp')

// Each case: the scenario, the texts that must render, and texts that must
// NOT render — the dangerous reading each state has to rule out.
const cases = [
  {
    scenario: 'available',
    must: [
      'Local MCP servers',
      'available',
      'Kelpie 0.1.11 · 145 tools',
      'Ondrej’s MacBook Pro',
      'MacBookPro18,2',
      'Ondrej’s iPhone',
      'paired',
      'pair on the device',
      'Discovered, not drivable — Kelpie refuses automation until a person pairs on the device itself.',
      'ci-runner-2',
      '192.168.1.20:8421',
      '1512×982',
      'last seen',
    ],
    mustNot: ['not installed on this machine'],
  },
  {
    scenario: 'not-installed',
    must: [
      'not installed',
      'Kelpie is not installed on this machine. Install it there and the next heartbeat reports it.',
    ],
    // The pairing affordance by its own words. A bare 'paired' also matches
    // the panel's standing "paired executors run only the reviewed local
    // policy" boundary note, which has nothing to do with a Kelpie device.
    mustNot: ['no browser announced itself', 'pair on the device'],
  },
  {
    scenario: 'launch-failed',
    must: [
      'launch failed',
      'Kelpie is installed, but the daemon could not start it.',
      'The server process exited with status 1 during launch.',
    ],
    mustNot: ['not installed on this machine'],
  },
  {
    scenario: 'handshake-failed',
    must: [
      'handshake failed',
      'Kelpie started, but did not answer the MCP handshake.',
      'The server closed the connection during initialize.',
    ],
    mustNot: ['not installed on this machine', 'could not start it'],
  },
  {
    scenario: 'unsupported-platform',
    must: ['unsupported platform', 'Kelpie cannot run on this machine’s platform.'],
    mustNot: ['not installed on this machine'],
  },
  {
    scenario: 'not-probed',
    must: ['not probed', 'The daemon has not probed Kelpie yet; a later heartbeat should say.'],
    mustNot: ['not installed on this machine'],
  },
  {
    scenario: 'no-browsers',
    must: [
      'available',
      'Kelpie answered, but no browser announced itself on the network.',
    ],
    mustNot: ['not installed on this machine', 'has not probed the network'],
  },
  {
    scenario: 'unprobed-inventory',
    must: ['available', 'The daemon has not probed the network for Kelpie instances.'],
    mustNot: ['no browser announced itself'],
  },
  {
    scenario: 'stale',
    must: ['observed', 'last seen'],
    mustMatch: [/observed \d+ d ago/, /last seen \d+ d ago/],
    mustNot: ['just now'],
  },
  {
    scenario: 'never-heard',
    must: [
      'This daemon has never reported local MCP status',
      'never reported',
      'The active reviewed policy names this server; the daemon has never reported its status.',
    ],
    // The availability pills by their own words. A bare 'available' also
    // matches the executor's scope line ("available only to entitled
    // organization work"), which says nothing about an MCP server.
    mustNot: ['not in the last report', 'Kelpie 0.1.11', 'tools listed'],
  },
  {
    scenario: 'named-unreported',
    must: [
      'not in the last report',
      'The active reviewed policy names this server, but the daemon’s last report does not.',
    ],
    mustNot: ['has never reported local MCP status'],
  },
  {
    scenario: 'policy-named',
    must: ['Revision 3 local policy', 'Local MCP servers (1):', 'kelpie'],
    mustNot: ['none named'],
  },
  {
    scenario: 'policy-none-named',
    must: [
      'Local MCP servers: none named.',
      'This proposal enables mcp.tools and mcp.call but names no server, so the executor proxies none until its local policy names one.',
    ],
    mustNot: ['Local MCP servers (0)'],
  },
]

const admin = await startAdmin()
const browser = await launchBrowser()
try {
  const context = await browser.newContext({ viewport: { height: 1000, width: 900 } })
  const page = await context.newPage()
  await mkdir(screenshots, { recursive: true })
  for (const testCase of cases) {
    await page.goto(`${ADMIN_URL}/e2e/executor-local-mcp/index.html?scenario=${testCase.scenario}`)
    // Readiness is the heading of the section under test, rather than the
    // executor's label: the label renders for every scenario whether or not
    // this panel mounted, so it would go green on a page that failed to
    // render the thing being asserted.
    await page.getByText(
      testCase.scenario.startsWith('policy-') ? 'Review prepared executor change' : 'Local MCP servers',
      { exact: true },
    ).waitFor()
    const text = await page.locator('body').innerText()
    for (const expected of testCase.must) {
      assert.ok(text.includes(expected), `${testCase.scenario}: missing "${expected}"`)
    }
    for (const pattern of testCase.mustMatch ?? []) {
      assert.match(text, pattern, `${testCase.scenario}: missing ${pattern}`)
    }
    for (const forbidden of testCase.mustNot) {
      assert.ok(!text.includes(forbidden), `${testCase.scenario}: should not render "${forbidden}"`)
    }
    const path = resolve(screenshots, `${testCase.scenario}.png`)
    await page.screenshot({ fullPage: true, path })
    console.log(`executor-local-mcp: ${testCase.scenario} -> ${path}`)
  }
  await context.close()
  console.log(`Executor local MCP proofs passed: ${cases.length} scenarios`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
