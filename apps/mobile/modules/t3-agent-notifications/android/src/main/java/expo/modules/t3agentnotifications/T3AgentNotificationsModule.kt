package expo.modules.t3agentnotifications

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AgentNotificationsModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var lifecycleApplication: Application? = null
  private var hostContext: AppContext? = null
  @Volatile private var destroyed = false
  private val activityCallbacks = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityResumed(activity: Activity) {
      if (!destroyed && activity === hostContext?.currentActivity) {
        AgentNotifications.onActivityResumed(activity)
      }
    }

    override fun onActivityPaused(activity: Activity) {
      AgentNotifications.onActivityPaused(activity)
    }

    override fun onActivityStopped(activity: Activity) {
      AgentNotifications.onActivityPaused(activity)
    }

    override fun onActivityDestroyed(activity: Activity) {
      AgentNotifications.onActivityPaused(activity)
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
  }

  override fun definition() = ModuleDefinition {
    Name("T3AgentNotifications")

    OnCreate {
      // Register and seed on the main thread so initialization cannot race a
      // pause. The module can be created after the host has already resumed.
      val context = appContext
      mainHandler.post {
        if (destroyed) return@post
        hostContext = context
        val application = (context.reactContext?.applicationContext as? Application)
          ?: context.currentActivity?.application
          ?: return@post
        lifecycleApplication = application
        application.registerActivityLifecycleCallbacks(activityCallbacks)
        val activity = context.currentActivity
        if (activity != null &&
          (activity as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(
            Lifecycle.State.RESUMED
          ) == true
        ) {
          AgentNotifications.onActivityResumed(activity)
        }
      }
    }

    OnDestroy {
      destroyed = true
      AgentNotifications.clearActivityVisibility()
      AgentNotifications.setThreadOnScreen(null)
      mainHandler.post {
        lifecycleApplication?.unregisterActivityLifecycleCallbacks(activityCallbacks)
        lifecycleApplication = null
        hostContext = null
      }
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
