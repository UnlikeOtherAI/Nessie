import type { ReactNode } from 'react';

type SidebarEmptyNoteProps = {
  children: ReactNode;
  // Which row depth the note lines up with. Omitted for one of the sidebar's
  // top-level sections; 'child' for a list nested inside a project (its
  // channels, its sections) and 'grandchild' for one nested inside that (the
  // boards inside a project's Boards section), so the note keeps the indent
  // the rows it stands in for have.
  indent?: 'child' | 'grandchild';
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
export const SidebarEmptyNote = ({ children, indent }: SidebarEmptyNoteProps) => (
  <p
    className={[
      'admin-sb-item admin-sb-empty',
      indent ? `sidebar-${indent}` : '',
    ].join(' ')}
  >
    {children}
  </p>
);
