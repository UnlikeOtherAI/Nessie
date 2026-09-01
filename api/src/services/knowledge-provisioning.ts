// Provisioning is shared with worker run setup. Keep API callers on this
// import path while @nessie/knowledge remains the single implementation.
export {
  ensureAgentDocsSpace,
  ensureMyDocsSpace,
  ensureProjectDocumentsSpace,
  ensureTaskFolder,
} from '@nessie/knowledge'
export type { EnsureSpaceResult, TaskFolderTask } from '@nessie/knowledge'
