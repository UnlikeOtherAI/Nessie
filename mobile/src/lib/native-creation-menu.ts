export const shouldDismissNativeCreationMenu = ({
  creationOpen,
  dismissVersion,
  previousDismissVersion,
}: {
  creationOpen: boolean
  dismissVersion: number
  previousDismissVersion: number
}): boolean => creationOpen && dismissVersion !== previousDismissVersion
