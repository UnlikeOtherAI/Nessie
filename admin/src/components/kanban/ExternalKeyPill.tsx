import type { MouseEvent } from 'react'
import { PROVIDER_LABEL, type BoardSourceProvider } from '../../facades/board-sources/hooks'
import { Pill } from '../primitives/Pill'

type ExternalKeyPillProps = {
  externalKey: string
  externalUrl: string
  provider: BoardSourceProvider
}

/**
 * A mirrored card's identity upstream. Opens the item where it actually lives —
 * `noopener` because the target is a third-party page, and `stopPropagation`
 * because the card underneath opens the task dialog.
 */
export const ExternalKeyPill = ({
  externalKey,
  externalUrl,
  provider,
}: ExternalKeyPillProps) => (
  <a
    className="justify-self-start"
    href={externalUrl}
    onClick={(event: MouseEvent) => event.stopPropagation()}
    rel="noopener noreferrer"
    target="_blank"
    title={`Open ${externalKey} in ${PROVIDER_LABEL[provider]}`}
  >
    <Pill size="sm" tone="outline" uppercase={false}>
      {PROVIDER_LABEL[provider]} {externalKey}
    </Pill>
  </a>
)
