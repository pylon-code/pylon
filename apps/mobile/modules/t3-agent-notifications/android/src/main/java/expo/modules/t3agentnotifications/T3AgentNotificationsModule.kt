package expo.modules.t3agentnotifications

import android.app.Activity
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AgentNotificationsModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  // Resolve at Expo lifecycle delivery, after React updates the host Activity.
  internal var activityProvider: () -> Activity? = { appContext.currentActivity }
  @Volatile private var destroyed = false

  override fun definition() = ModuleDefinition {
    Name("T3AgentNotifications")

    OnCreate {
      // Seed on the main thread if the module loads after the host resumed.
      mainHandler.post {
        if (destroyed) return@post
        val activity = activityProvider()
        if (activity != null &&
          (activity as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(
            Lifecycle.State.RESUMED
          ) == true
        ) {
          AgentNotifications.onActivityResumed(activity)
        } else {
          AgentNotifications.clearActivityVisibility()
        }
      }
    }

    OnActivityEntersForeground {
      if (!destroyed) {
        val activity = activityProvider()
        if (activity != null) {
          AgentNotifications.onActivityResumed(activity)
        } else {
          // No confirmed host means alerts must remain visible.
          AgentNotifications.clearActivityVisibility()
        }
      }
    }

    OnActivityEntersBackground {
      // Expo dispatches this during host pause, without the process delay.
      AgentNotifications.clearActivityVisibility()
    }

    OnDestroy {
      destroyed = true
      AgentNotifications.clearActivityVisibility()
      AgentNotifications.setThreadOnScreen(null)
    }

    Function("configure") {
        deviceId: String,
        userId: String,
        scheme: String,
        ongoingEnabled: Boolean
      ->
      appContext.reactContext?.let {
        AgentNotifications.configure(it, deviceId, userId, scheme, ongoingEnabled)
      }
    }

    Function("setThreadOnScreen") { path: String? ->
      AgentNotifications.setThreadOnScreen(path)
    }

    Function("clear") {
      appContext.reactContext?.let { AgentNotifications.clear(it) }
    }
  }
}
