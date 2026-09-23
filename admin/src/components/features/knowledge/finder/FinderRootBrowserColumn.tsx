import type { ComponentProps, HTMLAttributes } from 'react'
import { ColumnBrowserColumn } from '../../../shared/column-browser/ColumnBrowserColumn'
import type { PageHeaderAction } from '../../../shared/ResponsivePageHeader'
import { FinderRootColumn } from './FinderRootColumn'

type FinderRootBrowserColumnProps = ComponentProps<typeof FinderRootColumn> & {
  actions?: PageHeaderAction[]
  refuseProps: HTMLAttributes<HTMLDivElement>
  resize: ComponentProps<typeof ColumnBrowserColumn>['resize']
}

/** The route-owned Documents root and the transfer-refusing drop surface inside it. */
export const FinderRootBrowserColumn = ({
  actions,
  refuseProps,
  resize,
  ...rootProps
}: FinderRootBrowserColumnProps) => (
  <ColumnBrowserColumn
    actions={actions}
    key="root"
    resize={resize}
    screen
    scrollKey="finder:root"
    title="Documents"
  >
    <div className="h-full" {...refuseProps}>
      <FinderRootColumn {...rootProps} />
    </div>
  </ColumnBrowserColumn>
)
