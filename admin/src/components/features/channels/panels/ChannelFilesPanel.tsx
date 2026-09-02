import type { ChannelRecord } from '../../../../lib/api-client'
import { SectionLabel } from '../../../primitives/SectionLabel'

/**
 * The Files section, shown on every conversation. Attachment upload is the
 * next backend step; until it lands this states that honestly rather than
 * pretending to an empty list.
 */
export const ChannelFilesPanel = ({
  activeChannel,
  isConversationSurface,
  isPersonalAssistantConversation,
}: {
  activeChannel: ChannelRecord | null
  isConversationSurface: boolean
  isPersonalAssistantConversation: boolean
}) => (
  <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
    <section className="admin-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <SectionLabel>Conversation files</SectionLabel>
          <p className="mt-2 text-sm leading-6 text-[color:var(--tx2)]">
            Files shared in this {isConversationSurface ? 'conversation' : 'channel'} will
            live here instead of getting mixed into runs or agent controls.
          </p>
        </div>
        <span className="rounded-full border border-[color:var(--sep)] bg-[var(--scrim-weak)] px-3 py-1 text-xs font-semibold text-[color:var(--tx3)]">
          Upload backend next
        </span>
      </div>

      <div className="mt-5 rounded-xl border border-dashed border-[color:var(--sep)] bg-[var(--scrim-weak)] p-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--overlay-weak)] text-[color:var(--tx2)]">
          <svg
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
          >
            <path
              d="M15.172 7 8.586 13.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656L5.757 10.757a6 6 0 108.486 8.486L20.5 13"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="mt-4 text-sm font-semibold text-[var(--tx)]">No files yet</div>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[color:var(--tx3)]">
          Attachment upload is the next backend step. Once it lands, files attached to
          messages and added directly to this surface will be searchable and manageable
          from this tab.
        </p>
      </div>
    </section>

    <aside className="admin-card p-4">
      <SectionLabel>Scope</SectionLabel>
      <div className="mt-4 grid gap-3 text-sm">
        <div className="rounded-lg border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-3">
          <div className="text-[color:var(--tx3)]">Surface</div>
          <div className="mt-1 font-semibold text-[var(--tx)]">
            {isConversationSurface ? 'Conversation' : 'Channel'}
          </div>
        </div>
        <div className="rounded-lg border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-3">
          <div className="text-[color:var(--tx3)]">Owner</div>
          <div className="mt-1 font-semibold text-[var(--tx)]">
            {isPersonalAssistantConversation
              ? 'Personal Assistant DM'
              : activeChannel?.label ?? 'Current channel'}
          </div>
        </div>
        <div className="rounded-lg border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-3 text-[color:var(--tx2)]">
          This tab is intentionally visible on every channel so file management has one
          predictable home.
        </div>
      </div>
    </aside>
  </div>
)
