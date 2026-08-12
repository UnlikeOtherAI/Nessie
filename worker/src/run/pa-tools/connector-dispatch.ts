import {
  runConnectorAuthorizeTool,
  runConnectorDiscoverTool,
  runConnectorInstallTool,
  runConnectorLibrarySearchTool,
  runConnectorListTool,
  runConnectorSetSecretTool,
  runConnectorTestTool,
  runConnectorUninstallTool,
} from './connectors.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'

type ConnectorToolThunk = () => Promise<ToolExecutionResult>

/** Keep connector lifecycle argument shaping beside its PA-only operations. */
export const connectorManagementTool = (
  toolName: string,
  args: Record<string, unknown>,
  context: BuiltinToolRuntimeContext,
): ConnectorToolThunk | null => {
  switch (toolName) {
    case 'connector_list':
      return () => runConnectorListTool(context)
    case 'connector_library_search':
      return () => runConnectorLibrarySearchTool(context, { query: String(args.query ?? '') })
    case 'connector_discover':
      return () => runConnectorDiscoverTool(context, { url: String(args.url ?? '') })
    case 'connector_install':
      return () => runConnectorInstallTool(context, {
        catalogEntryId: typeof args.catalogEntryId === 'string' ? args.catalogEntryId : undefined,
        name: typeof args.name === 'string' ? args.name : undefined,
        label: typeof args.label === 'string' ? args.label : undefined,
        description: typeof args.description === 'string' ? args.description : undefined,
        url: typeof args.url === 'string' ? args.url : undefined,
        transport: typeof args.transport === 'string' ? args.transport : undefined,
        authMethod: typeof args.authMethod === 'string' ? args.authMethod : undefined,
        scope: typeof args.scope === 'string' ? args.scope : undefined,
        scopeId: typeof args.scopeId === 'string' ? args.scopeId : undefined,
      })
    case 'connector_authorize':
      return () => runConnectorAuthorizeTool(context, { instanceId: String(args.instanceId ?? '') })
    case 'connector_test':
      return () => runConnectorTestTool(context, { instanceId: String(args.instanceId ?? '') })
    case 'connector_set_secret':
      return () => runConnectorSetSecretTool(context, {
        instanceId: String(args.instanceId ?? ''),
        secret: String(args.secret ?? ''),
        shared: typeof args.shared === 'boolean' ? args.shared : undefined,
      })
    case 'connector_uninstall':
      return () => runConnectorUninstallTool(context, { instanceId: String(args.instanceId ?? '') })
    default:
      return null
  }
}
