package expo.modules.nessieimmersive

import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Nessie draws itself over the whole Android screen.
 *
 * Expo enforces edge-to-edge, which only moves the system bars *over* the app;
 * on a tablet that still leaves the status bar across the top and the system
 * taskbar — a strip of other apps — across the bottom, both of them inset from
 * the window so the shell reserves space for them. This hides the bars
 * outright and asks for the transient-by-swipe behaviour, so a swipe from an
 * edge shows them floating for a moment and they hide themselves again
 * without ever insetting the window. Android forgets the request across a
 * configuration change or a trip through the background, which is why the
 * shell re-applies it rather than calling this once at start-up.
 */
class NessieImmersiveModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NessieImmersive")

    Function("isSupported") { true }

    // The window belongs to the UI thread; `Queues.MAIN` is what lets the
    // shell call this from an effect without hopping threads itself.
    AsyncFunction("setFullScreen") { enabled: Boolean ->
      val window = appContext.throwingActivity.window
      val controller = WindowInsetsControllerCompat(window, window.decorView)
      if (enabled) {
        controller.systemBarsBehavior =
          WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
      } else {
        controller.show(WindowInsetsCompat.Type.systemBars())
      }
    }.runOnQueue(Queues.MAIN)
  }
}
