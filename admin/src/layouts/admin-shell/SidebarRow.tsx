export const channelHashClassName =
  'w-[14px] flex-shrink-0 text-center text-base leading-none text-[color:var(--tx3)]';

const unreadCountClassName =
  'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full ' +
  'bg-[color:var(--accent)] text-[10px] font-bold text-[color:var(--on-accent)]';

export const renderUnreadCount = (count: number) =>
  count > 0 ? <span className={unreadCountClassName}>{count}</span> : null;
