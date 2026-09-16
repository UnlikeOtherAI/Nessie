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
  'sidebar-unread-count flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full ' +
  'bg-[color:var(--accent)] text-[10px] font-bold text-[color:var(--on-accent)]';

/**
 * `undefined` is not zero, and both draw nothing. A `ChannelRecord` built for
 * somebody who is not in the room — an organisation admin's management view —
 * omits `unreadCount` entirely, because unread is participation metadata and
 * they have read nothing. Rendering no badge is the honest answer; the count
 * must never be coerced into a displayed `0`.
 */
export const renderUnreadCount = (count: number | undefined) =>
  count !== undefined && count > 0 ? <span className={unreadCountClassName}>{count}</span> : null;
