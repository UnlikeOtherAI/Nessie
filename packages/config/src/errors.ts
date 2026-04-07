export type ConfigIssue = {
  path: string
  message: string
}

export class NessieConfigError extends Error {
  issues: ConfigIssue[]

  constructor(message: string, issues: ConfigIssue[]) {
    super(message)
    this.name = 'NessieConfigError'
    this.issues = issues
  }
}

export function formatConfigIssues(issues: ConfigIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n')
}
