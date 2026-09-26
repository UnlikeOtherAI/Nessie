import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { sidebarAriaCurrent } from '../../components/shared/row-a11y';

type SidebarNavLinkProps = {
  active: boolean;
  /** Work that needs attention behind this row, and how to announce it. */
  badge?: { count: number; label?: string; testId?: string };
  icon: ReactNode;
  label: string;
  to: string;
};

/**
 * One row of a page list in the secondary sidebar — Admin's groups and the Your
 * settings list draw the same row, so a page reads the same whichever list
 * holds it.
 */
export const SidebarNavLink = ({ active, badge, icon, label, to }: SidebarNavLinkProps) => (
  <Link
    aria-current={sidebarAriaCurrent(active)}
    className={['admin-sb-item', active ? 'active' : ''].join(' ')}
    to={to}
  >
    {icon}
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {badge && badge.count > 0 ? (
      <span
        className="rounded-full bg-[color:var(--danger-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--danger-text)]"
        data-testid={badge.testId}
        title={badge.label}
      >
        <span aria-hidden={Boolean(badge.label)}>{badge.count}</span>
        {badge.label ? <span className="sr-only">{badge.label}</span> : null}
      </span>
    ) : null}
  </Link>
);
