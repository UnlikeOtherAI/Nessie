import type { PresentedAgentCardBlock } from '@nessie/schemas'

import { useAuthedObjectUrlFromPath } from '../../../lib/uploads'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { MessageMarkdown } from './MessageMarkdown'

/**
 * The body of an agent card: one renderer for the whole closed block
 * vocabulary. A ticket, an email overview, an image with a caption and a form
 * are arrangements of these parts, which is what keeps "universal" from
 * meaning "a component per integration".
 */

const CardImage = ({ alt, attachmentId, caption }: {
  alt: string
  attachmentId: string
  caption?: string
}) => {
  const { token } = useAuthSession()
  // Attachment bytes need the session token and a same-origin blob: an
  // `<img src="/api/…">` fails on both counts.
  const objectUrl = useAuthedObjectUrlFromPath(
    `/api/attachments/${attachmentId}/thumbnail`,
    token,
  )
  return (
    <figure className="m-0">
      {objectUrl ? (
        <img
          alt={alt}
          className="max-h-64 w-auto rounded-[var(--radius-md)] border border-[color:var(--line)]"
          src={objectUrl}
        />
      ) : (
        <div
          className={[
            'flex h-24 items-center justify-center rounded-[var(--radius-md)]',
            'border border-[color:var(--line)] bg-[color:var(--panel-soft)]',
            'text-xs text-[color:var(--tx2)]',
          ].join(' ')}
        >
          {alt}
        </div>
      )}
      {caption ? (
        <figcaption className="mt-1 text-xs text-[color:var(--tx2)]">{caption}</figcaption>
      ) : null}
    </figure>
  )
}

export type AgentCardFieldValue = string | number | boolean

/**
 * A settled card is a record of what was decided, not a form nobody can use.
 * Rendering its inputs as empty disabled controls says "nothing was chosen",
 * which is the opposite of what happened, so the answered values are shown
 * as plain label/value rows instead — and a secret as `provided`, never a value.
 */
const settledValueText = (
  block: Extract<PresentedAgentCardBlock, { type: 'input' | 'secret' }>,
  values: Record<string, AgentCardFieldValue>,
  providedSecretKeys: string[],
): string => {
  if (block.type === 'secret') {
    return providedSecretKeys.includes(block.key) ? 'provided' : 'not provided'
  }
  const value = values[block.key]
  if (value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (block.input === 'select') {
    return block.options?.find((option) => option.value === String(value))?.label ?? String(value)
  }
  return String(value)
}

export const AgentCardBlocks = ({
  blocks,
  disabled,
  onValueChange,
  providedSecretKeys,
  secrets,
  settled,
  onSecretChange,
  values,
}: {
  blocks: PresentedAgentCardBlock[]
  disabled: boolean
  onSecretChange: (key: string, value: string) => void
  onValueChange: (key: string, value: AgentCardFieldValue) => void
  /** Keys of secrets that were supplied, for a settled card. */
  providedSecretKeys: string[]
  secrets: Record<string, string>
  /** The card reached a terminal state: show what was answered, not controls. */
  settled: boolean
  values: Record<string, AgentCardFieldValue>
}) => (
  <div className="flex flex-col gap-3">
    {blocks.map((block, index) => {
      if (block.type === 'text') {
        return (
          <div className="text-sm" key={`text-${index}`}>
            {/* Card text is agent-authored prose, not channel chat: it carries
                no @mention entities to resolve, so text nodes pass through
                unchanged. Remote images stay blocked by the default. */}
            <MessageMarkdown renderInlineText={(text) => text}>
              {block.markdown}
            </MessageMarkdown>
          </div>
        )
      }
      if (block.type === 'fields') {
        return (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" key={`fields-${index}`}>
            {block.items.map((item) => (
              <div className="contents" key={item.label}>
                <dt className="text-[color:var(--tx2)]">{item.label}</dt>
                <dd className="m-0 text-[color:var(--tx1)]">{item.value}</dd>
              </div>
            ))}
          </dl>
        )
      }
      if (block.type === 'image') {
        return (
          <CardImage
            alt={block.alt}
            attachmentId={block.attachmentId}
            key={`image-${index}`}
            {...(block.caption === undefined ? {} : { caption: block.caption })}
          />
        )
      }
      if (block.type === 'link') {
        return (
          <a
            className="text-sm text-[color:var(--thinking)] underline"
            href={block.href}
            key={`link-${index}`}
            onClick={(event) => event.stopPropagation()}
            rel="noopener noreferrer"
            target="_blank"
          >
            {block.label}
          </a>
        )
      }
      if (settled && (block.type === 'input' || block.type === 'secret')) {
        return (
          <div className="flex flex-col gap-0.5 text-sm" key={block.key}>
            <span className="text-xs text-[color:var(--tx2)]">{block.label}</span>
            <span className="text-[color:var(--tx1)]">
              {settledValueText(block, values, providedSecretKeys)}
            </span>
          </div>
        )
      }
      if (block.type === 'secret') {
        return (
          <label className="flex flex-col gap-1 text-sm" key={block.key}>
            <span className="text-[color:var(--tx2)]">{block.label}</span>
            <input
              autoComplete="off"
              className="admin-input admin-input-sm"
              disabled={disabled}
              onChange={(event) => onSecretChange(block.key, event.target.value)}
              onClick={(event) => event.stopPropagation()}
              type="password"
              value={secrets[block.key] ?? ''}
            />
            <span className="text-xs text-[color:var(--tx2)]">
              {block.help ?? `Stored securely in ${block.destinationLabel}. Never shown in this chat.`}
            </span>
          </label>
        )
      }

      const value = values[block.key]
      const common = {
        disabled,
        onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
      }
      return (
        <label className="flex flex-col gap-1 text-sm" key={block.key}>
          <span className="text-[color:var(--tx2)]">
            {block.label}
            {block.required ? ' *' : ''}
          </span>
          {block.input === 'textarea' ? (
            <textarea
              {...common}
              className="admin-input admin-input-sm"
              onChange={(event) => onValueChange(block.key, event.target.value)}
              maxLength={block.maxLength ?? 500}
              placeholder={block.placeholder ?? ''}
              rows={3}
              value={String(value ?? '')}
            />
          ) : block.input === 'select' ? (
            <select
              {...common}
              className="admin-input admin-input-sm"
              onChange={(event) => onValueChange(block.key, event.target.value)}
              value={String(value ?? '')}
            >
              <option value="">Choose…</option>
              {(block.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : block.input === 'checkbox' ? (
            <input
              {...common}
              checked={value === true}
              onChange={(event) => onValueChange(block.key, event.target.checked)}
              type="checkbox"
            />
          ) : (
            <input
              {...common}
              className="admin-input admin-input-sm"
              onChange={(event) =>
                onValueChange(
                  block.key,
                  block.input === 'number' ? Number(event.target.value) : event.target.value,
                )
              }
              {...(block.input === 'text' ? { maxLength: block.maxLength ?? 500 } : {})}
              placeholder={block.placeholder ?? ''}
              type={block.input === 'number' ? 'number' : block.input === 'date' ? 'date' : 'text'}
              value={String(value ?? '')}
            />
          )}
        </label>
      )
    })}
  </div>
)
