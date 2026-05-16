/**
 * Domain facade placeholder for HTTP API connectors (Slice D — `packages/
 * connectors`). The connector HTTP surface has not landed on `main` yet
 * (Slice C exposed MCP catalog + tool registry only). When the connector
 * endpoints land — e.g. `/api/connectors`, `/api/connectors/{id}/install` —
 * the hooks below are the only place the UI needs to be wired.
 *
 * Keeping the file present (per plan §3 ownership table) means downstream
 * pages can `import { useConnectors }` today without a follow-up rename;
 * `useConnectors()` returns an empty list until the backend route exists.
 */

import { useQuery } from '@tanstack/react-query'

export type ConnectorDescriptorRecord = {
  id: string
  name: string
  label: string
  description: string
}

const CONNECTORS_QUERY_KEY = ['connectors'] as const

/**
 * Placeholder query that resolves to an empty array. It deliberately does NOT
 * hit a backend endpoint so the rest of the UI can compose against it before
 * the connector route ships, without polluting the network tab with 404s.
 *
 * The signature matches the future hook so swapping in the real `apiClient`
 * call is a 2-line change.
 */
export const useConnectors = () =>
  useQuery<ConnectorDescriptorRecord[]>({
    queryKey: CONNECTORS_QUERY_KEY,
    queryFn: () => Promise.resolve<ConnectorDescriptorRecord[]>([]),
  })
