// The visual affordance shared by every desktop column separator. The parent
// owns its geometry, label, keyboard behaviour, and persistence; this keeps
// the pill itself identical wherever a column can be resized.
export const ColumnResizeHandle = () => (
  <span aria-hidden="true" className="column-resize-handle">
    <span />
    <span />
    <span />
  </span>
)
