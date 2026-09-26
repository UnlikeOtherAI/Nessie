const { withAppBuildGradle } = require('expo/config-plugins')

// Expo's generated release build uses the debug keystore by default. Replace
// that one signing reference on every prebuild; credentials stay outside Git.
module.exports = (config) => withAppBuildGradle(config, (mod) => {
  const source = mod.modResults.contents
  const debugReference = 'signingConfig signingConfigs.debug'
  const references = source.match(/signingConfig signingConfigs\.debug/g) || []
  if (references.length !== 2 || !source.includes('    signingConfigs {')) {
    throw new Error('Expo Android signing template changed; inspect app/build.gradle before building')
  }

  const releaseConfig = `        nessieRelease {
            def names = [
                'NESSIE_ANDROID_KEYSTORE_PATH',
                'NESSIE_ANDROID_KEYSTORE_PASSWORD',
                'NESSIE_ANDROID_KEY_ALIAS',
                'NESSIE_ANDROID_KEY_PASSWORD'
            ]
            if (gradle.startParameter.taskNames.any { it.toLowerCase().contains('release') }) {
                def missing = names.findAll { !System.getenv(it) }
                if (!missing.isEmpty()) {
                    throw new GradleException("Missing Android release signing environment: \${missing.join(', ')}")
                }
            }
            def keystorePath = System.getenv('NESSIE_ANDROID_KEYSTORE_PATH')
            if (keystorePath) storeFile file(keystorePath)
            storePassword System.getenv('NESSIE_ANDROID_KEYSTORE_PASSWORD') ?: ''
            keyAlias System.getenv('NESSIE_ANDROID_KEY_ALIAS') ?: ''
            keyPassword System.getenv('NESSIE_ANDROID_KEY_PASSWORD') ?: ''
        }
`
  let contents = source.replace('    signingConfigs {', `    signingConfigs {\n${releaseConfig}`)
  const releaseReference = contents.lastIndexOf(debugReference)
  contents = `${contents.slice(0, releaseReference)}signingConfig signingConfigs.nessieRelease${contents.slice(releaseReference + debugReference.length)}`
  mod.modResults.contents = contents
  return mod
})
