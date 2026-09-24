package expo.modules.pylonsubscriptionwidget

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class PylonSubscriptionWidgetModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PylonSubscriptionWidget")
    Function("updateSnapshot") { snapshot: String ->
      val context = appContext.reactContext ?: return@Function
      JSONObject(snapshot) // Reject malformed writes before replacing the saved snapshot.
      check(context.getSharedPreferences(SubscriptionUsageWidget.PREFERENCES, 0)
        .edit().putString("snapshot", snapshot).commit()) {
        "Could not save subscription usage widget snapshot"
      }
      SubscriptionUsageWidget.updateAll(context)
    }
  }
}
