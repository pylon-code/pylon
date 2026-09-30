package expo.modules.pylonsubscriptionwidget

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date

class SubscriptionUsageWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    ids.forEach { update(context, manager, it) }
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action == EXPIRE) updateAll(context)
  }

  override fun onDisabled(context: Context) {
    context.getSystemService(AlarmManager::class.java).cancel(expiryIntent(context))
  }

  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    id: Int,
    options: Bundle
  ) {
    update(context, manager, id)
  }

  companion object {
    const val PREFERENCES = "pylon_subscription_widget"
    private const val EXPIRE = "expo.modules.pylonsubscriptionwidget.EXPIRE"

    private fun expiryIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
      context,
      0,
      Intent(context, SubscriptionUsageWidget::class.java).setAction(EXPIRE),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      manager.getAppWidgetIds(ComponentName(context, SubscriptionUsageWidget::class.java))
        .forEach { update(context, manager, it) }
    }

    private fun update(context: Context, manager: AppWidgetManager, id: Int) {
      val saved = context.getSharedPreferences(PREFERENCES, 0).getString("snapshot", null)
      val snapshot = runCatching { JSONObject(saved.orEmpty()) }.getOrNull()
      val providers = snapshot?.optJSONArray("providers")
      val now = System.currentTimeMillis()
      var nextExpiry = Long.MAX_VALUE
      var totalRows = 0
      val groups = (0 until (providers?.length() ?: 0)).mapNotNull { index ->
        val provider = providers?.optJSONObject(index) ?: return@mapNotNull null
        val windows = provider.optJSONArray("windows")
        val expiresAt = provider.optLong("expiresAt")
        if (expiresAt > now && windows != null && windows.length() > 0) {
          nextExpiry = minOf(nextExpiry, expiresAt)
          totalRows += provider.optInt("totalWindows", windows.length())
          (0 until windows.length()).map { provider to windows.optJSONObject(it) }
        } else {
          totalRows++
          listOf(provider to null)
        }
      }
      // Show each provider before filling spare space with its other windows.
      val rows = (0 until (groups.maxOfOrNull { it.size } ?: 0)).flatMap { index ->
        groups.mapNotNull { it.getOrNull(index) }
      }
      val views = RemoteViews(context.packageName, R.layout.pylon_subscription_widget)
      openAppIntent(context, id, snapshot)?.let {
        views.setOnClickPendingIntent(R.id.pylon_widget_root, it)
      }
      val checkedAt = snapshot?.optLong("checkedAt") ?: 0
      // Android 12L is the first release whose collection widgets need no compat service;
      // layout-v32 supplies the scrolling list, older releases keep the fitted rows.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S_V2) {
        val template = openAppIntent(context, id, snapshot, forCollection = true)
        bindScrollingRows(context, views, rows, template, checkedAt)
      } else if (rows.isNotEmpty()) {
        val options = manager.getAppWidgetOptions(id)
        // Match the default 200dp widget height, which fits one row per provider.
        val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 200)
        val count = bindFittedRows(context, views, rows, height)
        views.setTextViewText(
          R.id.pylon_widget_footer,
          fittedFooter(context, checkedAt, totalRows - count)
        )
      }
      val alarms = context.getSystemService(AlarmManager::class.java)
      alarms.cancel(expiryIntent(context))
      // Inexact and non-wakeup: the timestamp remains visible if Android delays expiry.
      if (nextExpiry != Long.MAX_VALUE) {
        alarms.set(AlarmManager.RTC, nextExpiry, expiryIntent(context))
      }
      manager.updateAppWidget(id, views)
    }

    private fun bindScrollingRows(
      context: Context,
      views: RemoteViews,
      rows: List<Pair<JSONObject, JSONObject?>>,
      template: PendingIntent?,
      checkedAt: Long
    ) {
      // Count limits only; "Open app to refresh" placeholders are not entries.
      val limits = rows.count { (_, window) -> window != null }
      // Without limits the layout's plain title stays.
      if (limits > 0) {
        views.setTextViewText(
          R.id.pylon_widget_title,
          context.getString(R.string.pylon_subscription_widget_title_count, limits)
        )
        views.setContentDescription(
          R.id.pylon_widget_title,
          context.resources.getQuantityString(
            R.plurals.pylon_subscription_widget_title_description,
            limits,
            limits
          )
        )
      }
      template?.let { views.setPendingIntentTemplate(R.id.pylon_widget_rows, it) }
      val items = RemoteViews.RemoteCollectionItems.Builder()
      rows.forEachIndexed { index, (provider, window) ->
        val row = rowView(context, provider, window)
        row.setOnClickFillInIntent(R.id.pylon_widget_row, Intent())
        items.addItem(index.toLong(), row)
      }
      views.setRemoteAdapter(R.id.pylon_widget_rows, items.build())
      views.setEmptyView(R.id.pylon_widget_rows, R.id.pylon_widget_empty)
      val checked = if (checkedAt > 0) {
        val formatted = DateFormat.getDateTimeInstance(
          DateFormat.SHORT,
          DateFormat.SHORT
        ).format(Date(checkedAt))
        context.getString(R.string.pylon_subscription_widget_last_checked, formatted)
      } else {
        context.getString(R.string.pylon_subscription_widget_unknown_check)
      }
      views.setTextViewText(R.id.pylon_widget_footer, checked)
    }

    /** Adds as many rows as the widget height fits and returns that count. */
    private fun bindFittedRows(
      context: Context,
      views: RemoteViews,
      rows: List<Pair<JSONObject, JSONObject?>>,
      height: Int
    ): Int {
      views.removeAllViews(R.id.pylon_widget_rows)
      val count = ((height - 64) / 66).coerceIn(1, 12).coerceAtMost(rows.size)
      for ((provider, window) in rows.take(count)) {
        views.addView(R.id.pylon_widget_rows, rowView(context, provider, window))
      }
      return count
    }

    private fun fittedFooter(context: Context, checkedAt: Long, remaining: Int): String {
      val more = if (remaining > 0) {
        context.getString(R.string.pylon_subscription_widget_more, remaining)
      } else {
        ""
      }
      val checked = if (checkedAt > 0) {
        val formatted = DateFormat.getDateTimeInstance(
          DateFormat.SHORT,
          DateFormat.SHORT
        ).format(Date(checkedAt))
        context.getString(R.string.pylon_subscription_widget_as_of, formatted)
      } else {
        context.getString(R.string.pylon_subscription_widget_unknown_check)
      }
      return checked + more
    }

    private fun openAppIntent(
      context: Context,
      id: Int,
      snapshot: JSONObject?,
      forCollection: Boolean = false
    ): PendingIntent? {
      // Target this variant's launcher so co-installed builds cannot steal the tap.
      val intent =
        context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
      // A missing snapshot opens this variant's app normally. Do not send a
      // production-only scheme to a co-installed development/preview build.
      snapshot?.optString("url")?.takeIf { it.isNotBlank() }?.let { deepLink ->
        intent.action = Intent.ACTION_VIEW
        intent.data = Uri.parse(deepLink)
      }
      intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      return PendingIntent.getActivity(
        context,
        id * 2 + if (forCollection) 1 else 0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or if (forCollection) {
          // Collection rows use fill-in intents with an explicit app target.
          PendingIntent.FLAG_MUTABLE
        } else {
          PendingIntent.FLAG_IMMUTABLE
        }
      )
    }

    private fun rowView(context: Context, provider: JSONObject, window: JSONObject?): RemoteViews {
      val child = RemoteViews(context.packageName, R.layout.pylon_subscription_widget_row)
      val remaining = window?.optInt("remaining")?.coerceIn(0, 100)
      val expired = provider.optLong("expiresAt") > 0 &&
        provider.optLong("expiresAt") <= System.currentTimeMillis()
      val detail =
        if (expired) {
          context.getString(R.string.pylon_subscription_widget_refresh)
        } else {
          provider.optString("detail")
        }
      val label = provider.optString("name")
      val windowLabel = window?.optString("label") ?: detail
      child.setTextViewText(R.id.pylon_widget_label, label)
      child.setTextViewText(R.id.pylon_widget_window, windowLabel)
      val percent = remaining?.let {
        context.getString(R.string.pylon_subscription_widget_remaining, it)
      } ?: "—"
      child.setTextViewText(R.id.pylon_widget_percent, percent)
      val visibility = if (remaining == null) View.GONE else View.VISIBLE
      child.setViewVisibility(R.id.pylon_widget_progress, visibility)
      if (remaining != null) child.setProgressBar(R.id.pylon_widget_progress, 100, remaining, false)
      val reset = window?.optString("reset")
        ?: context.getString(R.string.pylon_subscription_widget_refresh)
      child.setTextViewText(R.id.pylon_widget_reset, reset)
      child.setContentDescription(
        R.id.pylon_widget_row,
        "$label. $windowLabel. $percent. $reset. $detail"
      )
      return child
    }
  }
}
