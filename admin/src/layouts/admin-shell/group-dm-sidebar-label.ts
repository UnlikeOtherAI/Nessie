export type GroupDmSidebarLabel = {
  hiddenParticipantCount: number
  text: string
}

const participantNames = (label: string): string[] =>
  label
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)

const abbreviateLastName = (name: string): string => {
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length < 2) return name

  const lastName = words.at(-1)
  return `${words.slice(0, -1).join(' ')} ${lastName?.slice(0, 1)}.`
}

const uniqueLabels = (labels: GroupDmSidebarLabel[]): GroupDmSidebarLabel[] =>
  labels.filter((label, index) => labels.findIndex((candidate) => candidate.text === label.text) === index)

/**
 * The sidebar gives every group DM three readable fallbacks: the complete
 * participant list, the same list with surnames initialised, then a visible
 * prefix with an explicit count of the remaining people. The caller measures
 * these candidates in its rendered font and chooses the first that fits.
 */
export const groupDmSidebarLabelCandidates = (label: string): GroupDmSidebarLabel[] => {
  const names = participantNames(label)
  if (names.length < 2) return [{ hiddenParticipantCount: 0, text: label }]

  const abbreviatedNames = names.map(abbreviateLastName)
  const candidates: GroupDmSidebarLabel[] = [
    { hiddenParticipantCount: 0, text: names.join(', ') },
    { hiddenParticipantCount: 0, text: abbreviatedNames.join(', ') },
  ]

  for (
    let visibleParticipantCount = abbreviatedNames.length - 1;
    visibleParticipantCount > 0;
    visibleParticipantCount -= 1
  ) {
    const hiddenParticipantCount = abbreviatedNames.length - visibleParticipantCount
    candidates.push({
      hiddenParticipantCount,
      text: `${abbreviatedNames.slice(0, visibleParticipantCount).join(', ')} … +${hiddenParticipantCount}`,
    })
  }

  candidates.push({
    hiddenParticipantCount: abbreviatedNames.length,
    text: `… +${abbreviatedNames.length}`,
  })

  return uniqueLabels(candidates)
}

export const selectGroupDmSidebarLabel = (
  candidates: GroupDmSidebarLabel[],
  availableWidth: number,
  measure: (text: string) => number,
): GroupDmSidebarLabel =>
  candidates.find((candidate) => measure(candidate.text) <= availableWidth)
    ?? candidates.at(-1)
    ?? { hiddenParticipantCount: 0, text: '' }
