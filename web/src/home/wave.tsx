// A water-like divider between two differently coloured sections. The edge
// stays flat for the first third of the width, then breaks into two layered
// waves: a translucent swell behind and a solid crest in front, both filled
// with the colour of the section below.

const shapes = {
  rise: {
    back: 'M0 84 L520 84 C600 84 640 58 720 52 S860 20 960 24 S1110 72 1200 66 S1360 14 1440 22 L1440 120 L0 120 Z',
    front: 'M0 84 L480 84 C560 84 600 62 670 56 S790 92 880 90 S1010 38 1090 36 S1220 88 1300 84 S1410 48 1440 50 L1440 120 L0 120 Z',
  },
  fall: {
    back: 'M0 84 L500 84 C590 84 630 64 700 48 S830 12 930 18 S1060 76 1160 70 S1330 26 1440 30 L1440 120 L0 120 Z',
    front: 'M0 84 L470 84 C540 84 590 70 650 60 S760 34 850 42 S980 96 1070 92 S1210 44 1300 50 S1400 78 1440 70 L1440 120 L0 120 Z',
  },
}

type WaveProps = { top: string; bottom: string; shape?: keyof typeof shapes }

export function Wave({ top, bottom, shape = 'rise' }: WaveProps) {
  const paths = shapes[shape]
  // No wave dips below 80% of the height, so painting the bottom strip in the
  // lower colour hides the sub-pixel seam where the scaled SVG meets its box.
  const background = `linear-gradient(${top} 82%, ${bottom} 82%)`
  return (
    <div aria-hidden="true" className="n-wave" style={{ background }}>
      <svg preserveAspectRatio="none" viewBox="0 0 1440 120">
        <path d={paths.back} fill={bottom} opacity="0.45" />
        <path d={paths.front} fill={bottom} />
      </svg>
    </div>
  )
}
