/**
 * The Finder's menus, at the import path the columns already use.
 *
 * Wave 2B mounted `useFinderMenus` from this path against a declared seam
 * while 2A was still building the real one. The implementation lives in
 * `FinderContextMenus.tsx` — the hook and the dialogs it owns are one piece
 * and splitting them would put a `ReactNode` in a `.ts` file — so this is the
 * seam kept as a re-export rather than a second copy of the shape.
 */
export {
  useFinderMenus,
  type FinderBackgroundMenuProps,
  type FinderMenuColumnRef,
  type FinderMenuRowRef,
  type FinderMenus,
  type FinderMoveToRequest,
  type FinderRowMenuProps,
  type UseFinderMenusOptions,
} from './FinderContextMenus'
