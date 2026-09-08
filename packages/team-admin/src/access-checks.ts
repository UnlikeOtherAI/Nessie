// Authority is intentionally owned by runtime so Knowledge can reuse it
// without reversing package dependencies. Team administration preserves its
// existing public API as a forwarding boundary.
export {
  getChannelIfMember,
  isAgentAccessibleToActor,
  isAgentVisibleToUser,
  type ChannelAccessRow,
} from '@nessie/runtime'
