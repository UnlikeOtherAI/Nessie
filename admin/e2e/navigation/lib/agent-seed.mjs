import { call } from './seed.mjs'

/**
 * Create one ordinary agent through the product route, then cross its
 * Documents doorway once so the case receives the canonical page identities
 * it must find in the Finder. The route is the production provisioning seam:
 * a fixture that wrote the two files itself would only prove the fixture.
 */
export const seedKnowledgeAgent = async (seed) => {
  const suffix = Date.now().toString(36)
  const agent = await call('/api/agents', {
    body: {
      name: `Knowledge files ${suffix}`,
      speakingStyle: 'Concise, curious, and direct.',
      systemPrompt: 'Keep the navigation proof visible and explain decisions clearly.',
    },
    method: 'POST',
    token: seed.token,
  })
  const documents = await call(`/api/agents/${agent.id}/docs`, { token: seed.token })
  if (!documents.space?.canRead || documents.coreDocuments?.length !== 2) {
    throw new Error('the seeded agent did not receive its readable two-file core')
  }
  return { agent, documents }
}
