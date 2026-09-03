import { Prisma } from '@prisma/client'

// W4 graph pinning, shared by the API workflow services and the worker trigger
// paths: a run must never execute the template's CURRENT graph, because a
// template edit would rewrite installed workflows mid-flight. The graph a new
// run executes is the installation's pinned graph (what was installed), with
// the template's current graph as the fallback for pre-pin installations —
// that is the graph their runs were created from.

type WorkflowInstallationGraphSource = {
  findUnique: (args: {
    select: {
      pinnedGraphJson: true
      workflowTemplate: { select: { graphJson: true } }
    }
    where: { id: string }
  }) => Promise<{
    pinnedGraphJson: Prisma.JsonValue | null
    workflowTemplate: { graphJson: Prisma.JsonValue }
  } | null>
}

export const resolveInstallationPinnedGraph = async (
  prisma: { workflowInstallation: WorkflowInstallationGraphSource },
  installationId: string,
): Promise<Prisma.InputJsonValue> => {
  const installation = await prisma.workflowInstallation.findUnique({
    where: { id: installationId },
    select: {
      pinnedGraphJson: true,
      workflowTemplate: { select: { graphJson: true } },
    },
  })
  return (installation?.pinnedGraphJson ??
    installation?.workflowTemplate.graphJson ??
    {}) as Prisma.InputJsonValue
}
