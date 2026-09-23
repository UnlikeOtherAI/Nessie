// The Documents home has one Agents doorway, never one row per agent. The
// doorway pushes into a directory, then the selected agent's real knowledge
// home, where both canonical files are ordinary readable file nodes. This is
// the phone flow that originally exposed the inline-agent menu defect.
import { createChecks } from '../lib/expect.mjs'
import { waitForStackSettled } from '../lib/freeze.mjs'
import { clickBackTo, gotoPath, shot } from '../lib/page.mjs'
import { seedKnowledgeAgent } from '../lib/agent-seed.mjs'

const row = (page, id) => page.locator(`[data-finder-row="${id}"]`).first()

export const phoneKnowledgeAgentsDirectory = {
  name: 'phone-knowledge-agents-directory',
  run: async ({ page, seed }) => {
    const caseName = 'phone-knowledge-agents-directory'
    const checks = createChecks(caseName)
    const { agent, documents } = await seedKnowledgeAgent(seed)
    const coreByName = new Map(documents.coreDocuments.map((document) => [
      document.filename,
      document,
    ]))
    const agentsRow = row(page, 'virtual:agents')

    page.setDefaultNavigationTimeout(120_000)
    await gotoPath(page, '/knowledge-base')
    await agentsRow.waitFor({ timeout: 60_000 })
    await waitForStackSettled(page)
    checks.equal(
      `${caseName}: Documents home has one Agents doorway`,
      await page.locator('[data-finder-row="virtual:agents"]').count(),
      1,
    )
    checks.equal(
      `${caseName}: agent is not listed on Documents home`,
      await page.locator(`[data-finder-row="${agent.id}"]`).count(),
      0,
    )
    const frames = [await shot(page, caseName, '00-documents-home')]

    await agentsRow.click()
    await page.waitForURL(/\/knowledge-base\/agents$/u)
    await waitForStackSettled(page)
    const agentRow = row(page, agent.id)
    await agentRow.waitFor({ timeout: 60_000 })
    checks.equal(
      `${caseName}: Agents doorway opens the directory route`,
      new URL(page.url()).pathname,
      '/knowledge-base/agents',
    )
    checks.ok(
      `${caseName}: directory lists the seeded agent`,
      await agentRow.isVisible(),
      agent.name,
    )
    frames.push(await shot(page, caseName, '01-agents-directory'))

    await agentRow.click()
    await page.waitForURL(new RegExp(`/knowledge-base/agents/${agent.id}$`, 'u'))
    await waitForStackSettled(page)
    const agentsDocument = coreByName.get('AGENTS.md')
    const personalityDocument = coreByName.get('personality.md')
    if (!agentsDocument || !personalityDocument) {
      throw new Error('the seeded agent core did not name both canonical files')
    }
    const agentsDocumentRow = row(page, agentsDocument.pageId)
    const personalityDocumentRow = row(page, personalityDocument.pageId)
    await agentsDocumentRow.waitFor({ timeout: 60_000 })
    await personalityDocumentRow.waitFor({ timeout: 60_000 })
    checks.ok(`${caseName}: AGENTS.md is available`, await agentsDocumentRow.isVisible())
    checks.ok(`${caseName}: personality.md is available`, await personalityDocumentRow.isVisible())
    frames.push(await shot(page, caseName, '02-agent-home'))

    await agentsDocumentRow.click()
    await waitForStackSettled(page)
    const preview = page.locator('[data-testid="markdown-file-preview"]')
    await preview.waitFor({ timeout: 60_000 })
    checks.ok(
      `${caseName}: AGENTS.md opens with its instructions`,
      (await preview.textContent())?.includes('navigation proof visible') ?? false,
    )
    frames.push(await shot(page, caseName, '03-agents-markdown'))

    const documentBack = page.locator(
      '[data-phone-navigation-layer="current"] button[aria-label^="Back"]',
    ).first()
    await documentBack.waitFor({ timeout: 30_000 })
    checks.equal(
      `${caseName}: document Back names its destination`,
      await documentBack.getAttribute('aria-label'),
      'Back to space',
    )
    await documentBack.click()
    await waitForStackSettled(page)
    await agentsDocumentRow.waitFor({ timeout: 30_000 })
    await clickBackTo(page, `Back from ${agent.name}`)
    await waitForStackSettled(page)
    await agentRow.waitFor({ timeout: 30_000 })
    checks.equal(
      `${caseName}: agent Back returns to Agents`,
      new URL(page.url()).pathname,
      '/knowledge-base/agents',
    )
    await clickBackTo(page, 'Back to Knowledge')
    await waitForStackSettled(page)
    await agentsRow.waitFor({ timeout: 30_000 })
    checks.equal(
      `${caseName}: Agents Back returns to Documents home`,
      new URL(page.url()).pathname,
      '/knowledge-base',
    )

    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'phone',
}
