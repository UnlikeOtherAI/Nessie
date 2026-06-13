type ProjectOverviewPlaceholderProps = {
  projectName: string
}

export const ProjectOverviewPlaceholder = ({
  projectName,
}: ProjectOverviewPlaceholderProps) => (
  <div className="flex h-full min-h-0 items-center justify-center p-6">
    <section className="admin-card w-full max-w-xl p-6 text-center">
      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
        Project overview
      </div>
      <h1 className="mt-2 text-xl font-bold text-[color:var(--tx)]">{projectName}</h1>
      <p className="mt-3 text-sm leading-6 text-[color:var(--tx2)]">
        Overview coming soon.
      </p>
    </section>
  </div>
)
