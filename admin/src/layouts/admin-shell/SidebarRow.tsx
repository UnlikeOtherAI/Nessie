export const channelHashClassName =
  'sidebar-row-symbol w-[14px] flex-shrink-0 text-center text-base leading-none text-[color:var(--tx3)]';

/**
 * A project is selected outright on its overview route. When a channel inside
 * it is selected, the project remains a deliberately softer contextual cue.
 */
export const projectSelectionClassName = (
  projectId: string,
  currentProjectId?: string,
  currentChannelId?: string,
) => {
  if (projectId !== currentProjectId) {
    return '';
  }
  return currentChannelId ? 'active-parent' : 'active';
};

const unreadCountClassName =
  'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full ' +
  'bg-[color:var(--accent)] text-[10px] font-bold text-[color:var(--on-accent)]';

export const renderUnreadCount = (count: number) =>
  count > 0 ? <span className={unreadCountClassName}>{count}</span> : null;
