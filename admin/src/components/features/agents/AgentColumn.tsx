import type { ComponentProps } from 'react'
import { ColumnBrowserColumn } from '../../shared/column-browser/ColumnBrowserColumn'

type AgentColumnProps = ComponentProps<typeof ColumnBrowserColumn>

export const AgentColumn = (props: AgentColumnProps) => (
  <ColumnBrowserColumn {...props} />
)
