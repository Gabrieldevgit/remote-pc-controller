package com.remotepccontroller.phonehost

import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.media.AudioManager
import android.os.PowerManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.provider.Settings
import android.util.DisplayMetrics
import android.view.Display
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.oney.WebRTCModule.WebRTCModule
import com.remotepccontroller.R
import org.webrtc.ScreenCapturerAndroid

/**
 * JS bridge for "PC controls this phone" (src/lib/phoneHost.ts):
 * accessibility status, input (via [RemoteControlService]), display size,
 * live stream size and phone sound (via react-native-webrtc's screen
 * capturer), the availability service and request notifications.
 */
class PhoneHostModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  override fun getName() = "PhoneHost"

  private var audio: PlaybackAudio? = null
  private var displayListener: DisplayManager.DisplayListener? = null

  private fun emit(event: String, payload: Any?) {
    if (!ctx.hasActiveReactInstance()) return
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(event, payload)
  }

  @ReactMethod fun addListener(eventName: String) {
    if (eventName == "PhoneHostDisplay") watchDisplay()
  }

  @ReactMethod fun removeListeners(count: Int) {}

  // ---- setup ----------------------------------------------------------------------

  @ReactMethod
  fun isAccessibilityEnabled(promise: Promise) {
    promise.resolve(RemoteControlService.instance != null)
  }

  @ReactMethod
  fun openAccessibilitySettings() {
    ctx.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  /** App info page (Android 13+: ⋮ → "Allow restricted settings"). */
  @ReactMethod
  fun openAppDetails() {
    ctx.startActivity(
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

  // ---- display ----------------------------------------------------------------------

  private fun displayInfo(): WritableMap {
    val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    val map = Arguments.createMap()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val b = wm.maximumWindowMetrics.bounds
      map.putInt("width", b.width())
      map.putInt("height", b.height())
    } else {
      val m = DisplayMetrics()
      @Suppress("DEPRECATION") wm.defaultDisplay.getRealMetrics(m)
      map.putInt("width", m.widthPixels)
      map.putInt("height", m.heightPixels)
    }
    @Suppress("DEPRECATION") map.putInt("rotation", wm.defaultDisplay.rotation * 90)
    map.putDouble("density", ctx.resources.displayMetrics.density.toDouble())
    return map
  }

  private fun displaySize(): Pair<Float, Float> {
    val info = displayInfo()
    return Pair(info.getInt("width").toFloat(), info.getInt("height").toFloat())
  }

  @ReactMethod
  fun getDisplayInfo(promise: Promise) {
    promise.resolve(displayInfo())
  }

  private fun watchDisplay() {
    if (displayListener != null) return
    val dm = ctx.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    val listener = object : DisplayManager.DisplayListener {
      override fun onDisplayAdded(displayId: Int) {}
      override fun onDisplayRemoved(displayId: Int) {}
      override fun onDisplayChanged(displayId: Int) {
        if (displayId == Display.DEFAULT_DISPLAY) emit("PhoneHostDisplay", displayInfo())
      }
    }
    dm.registerDisplayListener(listener, android.os.Handler(android.os.Looper.getMainLooper()))
    displayListener = listener
  }

  // ---- input ------------------------------------------------------------------------

  private fun service(promise: Promise? = null): RemoteControlService? {
    val s = RemoteControlService.instance
    if (s == null) promise?.reject("no_accessibility", "Turn on Remote PC in Settings → Accessibility to allow control.")
    return s
  }

  /** x, y are 0..1 of the screen. */
  @ReactMethod
  fun touch(phase: String, x: Double, y: Double) {
    val s = service() ?: return
    val (w, h) = displaySize()
    s.touch(phase, (x.coerceIn(0.0, 1.0) * (w - 1)).toFloat(), (y.coerceIn(0.0, 1.0) * (h - 1)).toFloat())
  }

  /** (x, y) start 0..1; (dx, dy) fraction of the screen to swipe. */
  @ReactMethod
  fun scroll(x: Double, y: Double, dx: Double, dy: Double) {
    val s = service() ?: return
    val (w, h) = displaySize()
    val px = (x.coerceIn(0.0, 1.0) * w).toFloat()
    val py = (y.coerceIn(0.0, 1.0) * h).toFloat()
    val ex = (px + dx.coerceIn(-0.9, 0.9) * w).toFloat().coerceIn(1f, w - 1)
    val ey = (py + dy.coerceIn(-0.9, 0.9) * h).toFloat().coerceIn(1f, h - 1)
    s.scroll(px, py, ex - px, ey - py)
  }

  /** A complete tap (mouse click) at x, y (0..1). */
  @ReactMethod
  fun tap(x: Double, y: Double) {
    val s = service() ?: return
    val (w, h) = displaySize()
    s.tap((x.coerceIn(0.0, 1.0) * (w - 1)).toFloat(), (y.coerceIn(0.0, 1.0) * (h - 1)).toFloat())
  }

  // ---- emulator-style hardware buttons ----------------------------------------------

  /** Media volume up / down, showing Android's volume bar. No permission needed. */
  @ReactMethod
  fun volume(dir: String, promise: Promise) {
    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val direction = if (dir == "up") AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER
    android.os.Handler(android.os.Looper.getMainLooper()).post {
      am.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI)
    }
    promise.resolve(true)
  }

  /**
   * Power button: screen on → lock it (Android 9+); screen off → wake it
   * (the lock screen stays). long = the power menu.
   */
  @ReactMethod
  fun power(long: Boolean, promise: Promise) {
    if (long) {
      val s = service(promise) ?: return
      promise.resolve(s.nav("power"))
      return
    }
    val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
    if (pm.isInteractive) {
      val s = service(promise) ?: return
      promise.resolve(s.nav("lock"))
    } else {
      @Suppress("DEPRECATION")
      val wl = pm.newWakeLock(
        PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
        "RemotePC:wake",
      )
      wl.acquire(3_000)
      promise.resolve(true)
    }
  }

  // Rotation needs "Modify system settings" (Settings.System.canWrite). The
  // user's auto-rotate choice is saved before the first change and put back
  // by restoreRotation() when the session ends.
  private var savedAutoRotate: Int? = null
  private var savedUserRotation: Int? = null

  @ReactMethod
  fun canRotate(promise: Promise) {
    promise.resolve(Settings.System.canWrite(ctx))
  }

  @ReactMethod
  fun openRotationSettings() {
    ctx.startActivity(
      Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:${ctx.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

  /** dir: "left" (counter-clockwise) or "right" (clockwise). */
  @ReactMethod
  fun rotate(dir: String, promise: Promise) {
    if (!Settings.System.canWrite(ctx)) {
      promise.reject("no_rotate_permission", "Allow \"Modify system settings\" for Remote PC on the phone to rotate it from the PC.")
      return
    }
    val cr = ctx.contentResolver
    if (savedAutoRotate == null) {
      savedAutoRotate = Settings.System.getInt(cr, Settings.System.ACCELEROMETER_ROTATION, 1)
      savedUserRotation = Settings.System.getInt(cr, Settings.System.USER_ROTATION, 0)
    }
    val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    @Suppress("DEPRECATION") val current = wm.defaultDisplay.rotation
    val next = if (dir == "left") (current + 1) % 4 else (current + 3) % 4
    Settings.System.putInt(cr, Settings.System.ACCELEROMETER_ROTATION, 0)
    Settings.System.putInt(cr, Settings.System.USER_ROTATION, next)
    promise.resolve(next * 90)
  }

  @ReactMethod
  fun restoreRotation() {
    val auto = savedAutoRotate ?: return
    if (!Settings.System.canWrite(ctx)) return
    val cr = ctx.contentResolver
    Settings.System.putInt(cr, Settings.System.USER_ROTATION, savedUserRotation ?: 0)
    Settings.System.putInt(cr, Settings.System.ACCELEROMETER_ROTATION, auto)
    savedAutoRotate = null
    savedUserRotation = null
  }

  @ReactMethod
  fun nav(action: String, promise: Promise) {
    val s = service(promise) ?: return
    promise.resolve(s.nav(action))
  }

  @ReactMethod
  fun typeText(text: String, promise: Promise) {
    val s = service(promise) ?: return
    promise.resolve(s.typeText(text.take(4000)))
  }

  @ReactMethod
  fun key(code: String, promise: Promise) {
    val s = service(promise) ?: return
    promise.resolve(s.key(code))
  }

  // ---- screen capture (react-native-webrtc) ---------------------------------------------
  // getDisplayMedia() keeps its ScreenCapturerAndroid private; it is found by
  // reflection to change the stream size live and to reuse the
  // MediaProjection for phone sound. If the library changes, these features
  // report "unavailable" instead of failing the session.

  private fun field(target: Any, name: String): Any? {
    var cls: Class<*>? = target.javaClass
    while (cls != null) {
      try {
        val f = cls.getDeclaredField(name)
        f.isAccessible = true
        return f.get(target)
      } catch (_: NoSuchFieldException) {
        cls = cls.superclass
      }
    }
    return null
  }

  private fun screenCapturer(): ScreenCapturerAndroid? = try {
    val webrtc = ctx.getNativeModule(WebRTCModule::class.java)
    val gum = webrtc?.let { field(it, "getUserMediaImpl") }
    val tracks = gum?.let { field(it, "tracks") } as? Map<*, *>
    tracks?.values?.firstNotNullOfOrNull { tp ->
      val vcc = tp?.let { field(it, "videoCaptureController") }
      vcc?.let { field(it, "videoCapturer") } as? ScreenCapturerAndroid
    }
  } catch (_: Exception) {
    null
  }

  @ReactMethod
  fun setCaptureSize(width: Int, height: Int, fps: Int, promise: Promise) {
    val capturer = screenCapturer()
    if (capturer == null) {
      promise.resolve(false)
      return
    }
    try {
      capturer.changeCaptureFormat(width.coerceIn(160, 4096), height.coerceIn(160, 4096), fps.coerceIn(5, 60))
      promise.resolve(true)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun startAudio(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      promise.reject("unsupported", "Phone sound needs Android 10 or newer.")
      return
    }
    if (audio != null) {
      promise.resolve(PlaybackAudio.SAMPLE_RATE)
      return
    }
    val projection = screenCapturer()?.mediaProjection
    if (projection == null) {
      promise.reject("no_projection", "Phone sound is not available on this phone.")
      return
    }
    try {
      audio = PlaybackAudio(projection) { chunk -> emit("PhoneHostAudio", chunk) }.also { it.start() }
      promise.resolve(PlaybackAudio.SAMPLE_RATE)
    } catch (e: Exception) {
      audio = null
      promise.reject("audio_failed", e.message ?: "Could not capture the phone's sound.")
    }
  }

  @ReactMethod
  fun stopAudio() {
    audio?.stop()
    audio = null
  }

  // ---- keep the network awake during a session -------------------------------------------
  // Without these, Android's Wi-Fi power saving / Doze can pause the phone's
  // network while it is being controlled: the PC's picture freezes and the
  // link drops.

  private var wifiLock: WifiManager.WifiLock? = null
  private var cpuLock: PowerManager.WakeLock? = null

  @ReactMethod
  fun keepConnection(on: Boolean) {
    try {
      if (on) {
        if (wifiLock == null) {
          val wifi = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
          @Suppress("DEPRECATION")
          val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
          wifiLock = wifi.createWifiLock(mode, "RemotePC:session").apply { setReferenceCounted(false); acquire() }
        }
        if (cpuLock == null) {
          val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
          // Safety cap; the JS side re-arms it while the session lasts.
          cpuLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RemotePC:session").apply {
            setReferenceCounted(false)
            acquire(4 * 60 * 60 * 1000L)
          }
        }
      } else {
        wifiLock?.let { if (it.isHeld) it.release() }
        wifiLock = null
        cpuLock?.let { if (it.isHeld) it.release() }
        cpuLock = null
      }
    } catch (_: Exception) {
      // Best effort: the session still works without the locks.
    }
  }

  // ---- availability + notifications -----------------------------------------------------

  @ReactMethod
  fun startAvailability(title: String, text: String) {
    val intent = Intent(ctx, PhoneAvailabilityService::class.java).putExtra("title", title).putExtra("text", text)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent) else ctx.startService(intent)
  }

  @ReactMethod
  fun stopAvailability() {
    ctx.stopService(Intent(ctx, PhoneAvailabilityService::class.java))
  }

  /** Heads-up notification: a PC asks to control this phone. */
  @ReactMethod
  fun showRequest(sessionId: String, pcName: String) {
    PhoneAvailabilityService.ensureChannels(ctx)
    val open = PhoneAvailabilityService.openAppIntent(ctx, "remotepc://phone-request/$sessionId")
    val n = NotificationCompat.Builder(ctx, PhoneAvailabilityService.CHANNEL_REQUESTS)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("$pcName wants to control this phone")
      .setContentText("Tap to allow or decline.")
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setAutoCancel(true)
      .setContentIntent(open)
      .setFullScreenIntent(open, true)
      .build()
    try {
      NotificationManagerCompat.from(ctx).notify(PhoneAvailabilityService.REQUEST_NOTIFICATION_ID, n)
    } catch (_: SecurityException) {
      // Notifications not allowed; the app shows the request when opened.
    }
  }

  @ReactMethod
  fun clearRequest() {
    NotificationManagerCompat.from(ctx).cancel(PhoneAvailabilityService.REQUEST_NOTIFICATION_ID)
  }

  override fun invalidate() {
    keepConnection(false)
    stopAudio()
    restoreRotation()
    displayListener?.let { (ctx.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).unregisterDisplayListener(it) }
    displayListener = null
    super.invalidate()
  }
}
