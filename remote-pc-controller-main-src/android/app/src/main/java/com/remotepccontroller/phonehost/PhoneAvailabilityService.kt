package com.remotepccontroller.phonehost

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.remotepccontroller.MainActivity
import com.remotepccontroller.R

/**
 * Keeps the app running while the phone is "Available to your PCs", so a
 * PC's request reaches it even when the app is in the background. The user
 * turns it on/off in the app; the notification says so at all times.
 */
class PhoneAvailabilityService : Service() {

  companion object {
    const val CHANNEL_STATUS = "phone_host_status"
    const val CHANNEL_REQUESTS = "phone_host_requests"
    private const val NOTIFICATION_ID = 4101
    const val REQUEST_NOTIFICATION_ID = 4102

    fun ensureChannels(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = context.getSystemService(NotificationManager::class.java)
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_STATUS, "Available to your PCs", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shown while your PCs can ask to control this phone."
        },
      )
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_REQUESTS, "Control requests", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "A PC asks to control this phone."
        },
      )
    }

    fun openAppIntent(context: Context, uri: String?): PendingIntent {
      val intent = Intent(context, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        if (uri != null) {
          action = Intent.ACTION_VIEW
          data = Uri.parse(uri)
        }
      }
      return PendingIntent.getActivity(
        context,
        uri?.hashCode() ?: 0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ensureChannels(this)
    val title = intent?.getStringExtra("title") ?: "Available to your PCs"
    val text = intent?.getStringExtra("text") ?: "Your PCs can ask to control this phone. You'll be asked to allow each time."
    val notification: Notification = NotificationCompat.Builder(this, CHANNEL_STATUS)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setOngoing(true)
      .setContentIntent(openAppIntent(this, "remotepc://phone-host"))
      .build()
    val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
    return START_STICKY
  }
}
