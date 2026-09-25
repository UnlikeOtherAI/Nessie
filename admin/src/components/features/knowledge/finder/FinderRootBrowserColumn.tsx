import type { ComponentProps, HTMLAttributes } from 'react'
import { ColumnBrowserColumn } from '../../../shared/column-browser/ColumnBrowserColumn'
import type { PageHeaderAction } from '../../../shared/ResponsivePageHeader'
import { FinderRootColumn } from './FinderRootColumn'

type FinderRootBrowserColumnProps = ComponentProps<typeof FinderRootColumn> & {
  actions?: PageHeaderAction[]
  refuseProps: HTMLAttributes<HTMLDivElement>
  resize: ComponentProps<typeof ColumnBrowserColumn>['resize']
  title: string
}

/** The route-owned Knowledge navigation and its transfer-refusing drop surface. */
export const FinderRootBrowserColumn = ({
  actions,
  refuseProps,
  resize,
  title,
  ...rootProps
}: FinderRootBrowserColumnProps) => (
  <ColumnBrowserColumn
    actions={actions}
    key="root"
    resize={resize}
    screen
    scrollKey="finder:root"
    title={title}
  >
    <div className="h-full" {...refuseProps}>
      <FinderRootColumn {...rootProps} />
    </div>
  </ColumnBrowserColumn>
)
