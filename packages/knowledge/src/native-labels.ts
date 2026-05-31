import { type Prisma } from '@prisma/client'

export const normalizeLabels = (labels: string[] | undefined): Array<{
  name: string
  normalizedName: string
}> => {
  const byNormalized = new Map<string, string>()
  for (const label of labels ?? []) {
    const name = label.trim()
    const normalizedName = name.toLowerCase()
    if (name && !byNormalized.has(normalizedName)) {
      byNormalized.set(normalizedName, name)
    }
  }
  return [...byNormalized.entries()].map(([normalizedName, name]) => ({
    name,
    normalizedName,
  }))
}

export const replaceLabels = async (
  tx: Prisma.TransactionClient,
  input: { labels: string[] | undefined; organizationId: string; pageId: string },
) => {
  if (input.labels === undefined) return
  await tx.pageLabel.deleteMany({ where: { pageId: input.pageId } })
  const labels = normalizeLabels(input.labels)
  if (labels.length === 0) return
  await tx.pageLabel.createMany({
    data: labels.map((label) => ({
      organizationId: input.organizationId,
      pageId: input.pageId,
      ...label,
    })),
  })
}
