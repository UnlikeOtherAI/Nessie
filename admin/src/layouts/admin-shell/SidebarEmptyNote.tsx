import type { ReactNode } from 'react';

type SidebarEmptyNoteProps = {
  children: ReactNode;
  // A section nested inside a project (its channel list) rather than one of the
  // sidebar's top-level sections, so the note keeps the indent its rows have.
  nested?: boolean;
};

/**
 * What a sidebar section says when it holds nothing.
 *
 * It borrows the row geometry (`admin-sb-item`) rather than inventing its own
 * box, so the sentence starts exactly where `#general` starts and a section
 * that empties does not shift its own left edge. It is deliberately not a
 * button: the dashed call-to-action that used to sit here read as an error
 * state, and the "+" beside the section header is already the way in.
 */
export const SidebarEmptyNote = ({ children, nested }: SidebarEmptyNoteProps) => (
  <p
    className={[
      'admin-sb-item admin-sb-empty',
      nested ? 'sidebar-child' : '',
    ].join(' ')}
  >
    {children}
  </p>
);
