import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'

type RailButtonProps = {
  icon: ReactNode
  label: string
  to: string
}

export const RailButton = ({ icon, label, to }: RailButtonProps) => (
  <NavLink
    to={to}
    className={({ isActive }) =>
      `flex flex-col items-center gap-2 rounded-[1.25rem] px-3 py-4 text-xs font-medium transition ${
        isActive
          ? 'bg-[color:var(--ink)] text-white shadow-[0_12px_24px_rgba(31,26,23,0.15)]'
          : 'text-[color:var(--muted)] hover:bg-white/60 hover:text-[color:var(--ink)]'
      }`
    }
  >
    <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/70 text-[color:var(--ink)]">
      {icon}
    </span>
    <span>{label}</span>
  </NavLink>
)
