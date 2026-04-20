type CallBannerProps = {
  onJoin: () => void
  participants: Array<{ displayName: string; userId: string }>
}

export const CallBanner = ({ participants, onJoin }: CallBannerProps) => (
  <div className="flex items-center gap-3 border-b border-emerald-700/40 bg-emerald-900/60 px-4 py-1.5">
    <span className="relative flex h-2.5 w-2.5">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
    </span>
    <span className="text-sm text-emerald-200">Call in progress</span>
    <span className="truncate text-sm text-emerald-300/70">
      {participants.map((p) => p.displayName).join(', ')}
    </span>
    <button
      className="ml-auto rounded-full bg-emerald-600 px-3 py-0.5 text-xs font-medium text-white hover:bg-emerald-500"
      onClick={onJoin}
      type="button"
    >
      Join
    </button>
  </div>
)
