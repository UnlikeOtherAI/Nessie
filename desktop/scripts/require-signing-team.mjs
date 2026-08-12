const teamId = process.env.NESSIE_DESKTOP_SIGNING_TEAM_ID

if (!teamId || !/^[A-Za-z0-9]+$/.test(teamId)) {
  throw new Error('Set NESSIE_DESKTOP_SIGNING_TEAM_ID to the trusted Apple Developer team identifier before creating a release bundle.')
}
