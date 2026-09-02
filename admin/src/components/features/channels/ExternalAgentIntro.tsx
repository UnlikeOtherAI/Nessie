import type { ExternalAgentIdentity } from '../../../facades/integrations/hooks'
import { IdentityTile } from '../../primitives/IdentityTile'

// The empty-state for a first-class external-agent DM (DeepSignal, ...): a
// function-first identity (non-human product glyph + name + one-line
// description) and 2–4 clickable conversation starters that send on click.
// Everything is sourced from the product's plugin manifest, so a second
// external agent renders here with no code change.

type ExternalAgentIntroProps = {
  identity: ExternalAgentIdentity
  onSelectStarter: (prompt: string) => void
}

export const ExternalAgentIntro = ({
  identity,
  onSelectStarter,
}: ExternalAgentIntroProps) => (
  <div className="p-5">
    <div className="admin-card flex flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <IdentityTile
          background="var(--accent-soft)"
          color="var(--thinking)"
          fallback={{
            kind: 'glyph',
            glyph: identity.iconGlyph ?? identity.name.slice(0, 1).toUpperCase(),
          }}
          imageUrl={null}
          label={identity.name}
          size={44}
        />
        <div className="min-w-0">
          <div className="text-base font-bold text-[var(--tx)]">{identity.name}</div>
          {identity.description ? (
            <p className="mt-0.5 text-sm leading-6 text-[var(--tx2)]">
              {identity.description}
            </p>
          ) : null}
        </div>
      </div>

      {identity.conversationStarters.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--tx3)]">
            Try asking
          </span>
          <div className="flex flex-wrap gap-2">
            {identity.conversationStarters.map((prompt) => (
              <button
                className={[
                  'rounded-full border border-[var(--sep)] bg-[var(--overlay-weak)]',
                  'px-3 py-1.5 text-left text-sm text-[var(--tx)]',
                  'transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
                ].join(' ')}
                key={prompt}
                onClick={() => onSelectStarter(prompt)}
                type="button"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  </div>
)
