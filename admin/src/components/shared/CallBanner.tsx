type CallBannerProps = {
  callerName: string
  meetingUri: string
}

export const CallBanner = ({ callerName, meetingUri }: CallBannerProps) => (
  <div className="flex items-center gap-3 border-b border-[color:var(--success-border)] bg-[color:var(--success-soft)] px-4 py-1.5">
    <span className="relative flex h-2.5 w-2.5">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--success)] opacity-75" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[color:var(--success)]" />
    </span>
    <span className="truncate text-sm text-[color:var(--success-text)]">
      {callerName} started a call
    </span>
    <a
      className="ml-auto rounded-full bg-[color:var(--success)] px-3 py-0.5 text-xs font-medium text-[color:var(--on-accent)] hover:bg-[color:var(--success)]"
      href={meetingUri}
      rel="noopener noreferrer"
      target="_blank"
    >
      Join
    </a>
  </div>
)
