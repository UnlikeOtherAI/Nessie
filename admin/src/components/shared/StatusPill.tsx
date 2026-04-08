import type { PropsWithChildren } from 'react'
import { StatusPill as PrimitiveStatusPill } from '../primitives/StatusPill'

type StatusPillProps = PropsWithChildren<{
  tone?: 'danger' | 'default' | 'success' | 'warning'
}>

const toneMap = {
  danger: 'danger',
  default: 'muted',
  success: 'success',
  warning: 'warning',
} as const

export const StatusPill = ({ children, tone = 'default' }: StatusPillProps) => (
  <PrimitiveStatusPill tone={toneMap[tone]}>{children}</PrimitiveStatusPill>
)
