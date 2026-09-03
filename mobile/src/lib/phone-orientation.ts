export const LARGE_PHONE_LANDSCAPE_MIN_LONG_EDGE_DP = 900

type PhoneDimensions = {
  height: number
  width: number
}

type NativePhoneOrientationTarget = PhoneDimensions & {
  isPad: boolean
  platform: string
}

// The 900dp long-edge gate admits the current Max-class iPhones (for example,
// iPhone 16 Pro Max at 956dp) without making ordinary 6.1–6.7 inch phones
// rotate into a cramped two-column team.
export const supportsLargePhoneLandscape = ({
  height,
  isPad,
  platform,
  width,
}: NativePhoneOrientationTarget): boolean => (
  platform === 'ios'
  && !isPad
  && Math.max(width, height) >= LARGE_PHONE_LANDSCAPE_MIN_LONG_EDGE_DP
)

export const isLandscape = ({ height, width }: PhoneDimensions): boolean => width > height
