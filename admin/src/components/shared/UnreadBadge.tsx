import { UnreadBadge as PrimitiveUnreadBadge } from '../primitives/UnreadBadge'

type UnreadBadgeProps = {
  count: number
}

export const UnreadBadge = ({ count }: UnreadBadgeProps) => (
  <PrimitiveUnreadBadge value={count} />
)
