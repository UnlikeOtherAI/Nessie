// Screenshot helpers, re-exported under the name the other phases' cases
// import. `shot` takes either `(page, name)` or `(page, group, name)`: the
// second form writes `group-name.png`, so a case that captures several moments
// of one flow keeps them together on disk without inventing a directory.
import { shot as writeShot, SCREENSHOT_DIR } from './grid.mjs'

export { SCREENSHOT_DIR }

export const shot = (page, first, second) =>
  writeShot(page, second === undefined ? first : `${first}-${second}`)
