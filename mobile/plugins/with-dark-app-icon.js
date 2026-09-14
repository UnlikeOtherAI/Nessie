const fs = require('fs')
const path = require('path')
const { withDangerousMod, withXcodeProject } = require('expo/config-plugins')

/**
 * Compiles the dark Home Screen icon into the iOS asset catalog as an
 * alternate icon set, so `setAlternateIconName('AppIconDark')` can select it
 * (modules/nessie-app-icon). The light icon stays the primary `AppIcon`.
 *
 * An asset-catalog alternate needs no hand-written `CFBundleAlternateIcons`:
 * actool writes those Info.plist keys when the set is named in
 * ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES.
 */
const ICON_SET = 'AppIconDark'

const withDarkAppIcon = (config, { image }) => {
  config = withDangerousMod(config, ['ios', async (mod) => {
    const { platformProjectRoot, projectName, projectRoot } = mod.modRequest
    const iconSet = path.join(platformProjectRoot, projectName, 'Images.xcassets', `${ICON_SET}.appiconset`)
    fs.mkdirSync(iconSet, { recursive: true })
    fs.copyFileSync(path.resolve(projectRoot, image), path.join(iconSet, 'App-Icon-1024x1024@1x.png'))
    fs.writeFileSync(path.join(iconSet, 'Contents.json'), `${JSON.stringify({
      images: [{ filename: 'App-Icon-1024x1024@1x.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
      info: { author: 'expo', version: 1 },
    }, null, 2)}\n`)
    return mod
  }])

  return withXcodeProject(config, (mod) => {
    const configurations = mod.modResults.pbxXCBuildConfigurationSection()
    for (const entry of Object.values(configurations)) {
      const settings = entry && entry.buildSettings
      // Only the app target carries the primary icon setting.
      if (!settings || !settings.ASSETCATALOG_COMPILER_APPICON_NAME) continue
      settings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = ICON_SET
    }
    return mod
  })
}

module.exports = withDarkAppIcon
