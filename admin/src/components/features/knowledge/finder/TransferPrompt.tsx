import type { ReactNode, RefObject } from 'react'
import { faCircleInfo, faCopy, faRightLeft } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { ContextMenu, type ContextMenuItem } from '../../../overlays/ContextMenu'
import type { ContextMenuAnchor } from '../../../overlays/useContextMenu'
import {
  transferAudienceLine,
  transferPromptHeading,
  transferRefusalSentence,
  transferSharingLine,
  type TransferDestination,
} from './transfer-copy'

/**
 * "If we're moving between spaces, we need to ask if it's a copy or move."
 *
 * The owner's sentence, as a menu at the pointer (transfer.md §1). It is the
 * `ContextMenu` primitive, not a `ConfirmDialog`: a confirm has one confirm
 * action and this is a three-way choice made at the point of a gesture, which
 * is where Finder itself puts it. Escape, an outside press and Cancel all abort
 * with nothing sent — the primitive owns the first two through `useOverlay`.
 *
 * The two headings above the items are the feature. The audience line says who
 * will be able to read the items in their new home, and the sharing line says
 * the blunt thing a move out of a personal space does: every share on the
 * subtree is deleted. `acknowledged: true` on the request is the claim that
 * both were on screen, so they are rendered before the items, unconditionally
 * for the audience and whenever there is a share for the other.
 *
 * A refusal replaces the two operations with its own sentence and "OK"; the
 * server writes those sentences to the character and this shows them verbatim.
 */

export type TransferRefusal = { code?: string; message?: string }

export type TransferPromptProps = {
  /** null = closed. A point anchor, taken from the drop. */
  anchor: ContextMenuAnchor | null
  /** Where the rows were dropped. */
  destination: TransferDestination
  /** Rows in the drag, not their descendants. */
  count: number
  /** The one row's name, for the heading, when the drag carried one row. */
  title?: string
  /** Shares on the dragged rows that a move would end; 0 hides the line. */
  sharesEnding: number
  /**
   * False when the person may read the source but not write it — a grantee
   * dragging out of a shared folder. Copy stays; Move is shown disabled with
   * the reason, because a missing item is not an explanation.
   */
  canMove: boolean
  moveDisabledReason?: string
  /** A refusal from a request that was already sent, shown in place of both. */
  refusal?: TransferRefusal | null
  onChoose: (operation: 'move' | 'copy') => void
  onClose: () => void
  /** The row that was dragged; focus goes back to it on Escape (F-XFER-16). */
  returnFocusRef: RefObject<HTMLElement | null>
}

export const transferPromptItems = (
  props: Pick<
    TransferPromptProps,
    'canMove' | 'count' | 'destination' | 'moveDisabledReason' | 'onChoose' | 'onClose'
    | 'refusal' | 'sharesEnding' | 'title'
  >,
): ContextMenuItem[] => {
  if (props.refusal) {
    return [
      { kind: 'heading', label: transferRefusalSentence(props.refusal.code, props.refusal.message) },
      { id: 'transfer-ok', kind: 'item', label: 'OK', onSelect: props.onClose },
    ]
  }
  const sharing = transferSharingLine(props.sharesEnding)
  return [
    {
      kind: 'heading',
      label: transferPromptHeading({
        count: props.count,
        destinationName: props.destination.name,
        title: props.title,
      }),
    },
    { kind: 'heading', label: transferAudienceLine(props.destination, props.count) },
    ...(sharing ? [{ kind: 'heading' as const, label: sharing }] : []),
    { kind: 'separator' },
    // Move first, and first is where focus lands: a drag is a move everywhere
    // else in this browser, and ⌥ is how a person says copy without asking.
    {
      disabled: !props.canMove,
      disabledReason: props.moveDisabledReason,
      icon: faRightLeft,
      id: 'transfer-move',
      kind: 'item',
      label: 'Move here',
      onSelect: () => props.onChoose('move'),
    },
    {
      icon: faCopy,
      id: 'transfer-copy',
      kind: 'item',
      label: 'Copy here',
      onSelect: () => props.onChoose('copy'),
    },
    { kind: 'separator' },
    { id: 'transfer-cancel', kind: 'item', label: 'Cancel', onSelect: props.onClose },
  ]
}

export const TransferPrompt = ({
  anchor,
  canMove,
  count,
  destination,
  moveDisabledReason,
  onChoose,
  onClose,
  refusal,
  returnFocusRef,
  sharesEnding,
  title,
}: TransferPromptProps) => (
  <ContextMenu
    anchor={anchor}
    items={transferPromptItems({
      canMove,
      count,
      destination,
      moveDisabledReason,
      onChoose,
      onClose,
      refusal,
      sharesEnding,
      title,
    })}
    label="Move or copy"
    onClose={onClose}
    returnFocusRef={returnFocusRef}
  />
)

/**
 * The same three lines under Move to…'s tree, where there is no menu to put
 * headings in. Not a card: the dialog is already the surface, and a bordered
 * box inside a bordered box is the nesting the design system forbids.
 */
export const TransferConsequenceLines = ({
  destination,
  count,
  sharesEnding,
}: {
  destination: TransferDestination
  count: number
  sharesEnding: number
}): ReactNode => {
  const sharing = transferSharingLine(sharesEnding)
  return (
    <div
      className="flex items-start gap-2 border-t border-[color:var(--sep)] pt-3 text-xs
        text-[color:var(--tx2)]"
      data-transfer-consequences
    >
      <FontAwesomeIcon
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--tx3)]"
        icon={faCircleInfo}
      />
      <span className="min-w-0">
        <span className="block">{transferAudienceLine(destination, count)}</span>
        {sharing ? <span className="block font-medium text-[color:var(--tx)]">{sharing}</span> : null}
      </span>
    </div>
  )
}
