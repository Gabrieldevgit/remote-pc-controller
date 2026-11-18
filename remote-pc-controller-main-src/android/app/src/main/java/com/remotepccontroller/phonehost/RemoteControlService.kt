package com.remotepccontroller.phonehost

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Accessibility service that performs the input a PC sends while it
 * controls this phone (Remote PC Host → phone). The user turns it on once in
 * Settings → Accessibility → Remote PC. It never reads screen content for
 * itself; it only acts on explicit messages of an accepted session.
 *
 *  - touch down / move / up → one live finger (continued gesture strokes)
 *  - scroll                 → short swipe
 *  - nav                    → Back, Home, Recents, notifications …
 *  - text / key             → edit the focused text field
 */
class RemoteControlService : AccessibilityService() {

  companion object {
    @Volatile var instance: RemoteControlService? = null
      private set

    private const val STROKE_MS = 16L
    private const val TAP_MS = 40L
    private const val NUDGE_PX = 0.5f
    private const val TAG = "RemotePcInput"
  }

  private val main = Handler(Looper.getMainLooper())

  override fun onServiceConnected() {
    instance = this
  }

  override fun onUnbind(intent: android.content.Intent?): Boolean {
    instance = null
    return super.onUnbind(intent)
  }

  override fun onDestroy() {
    instance = null
    super.onDestroy()
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

  override fun onInterrupt() {}

  // ---- live finger --------------------------------------------------------------
  // A continued stroke can only be dispatched after the previous part has
  // completed, so moves are coalesced: we keep the latest target point and
  // send it when the running part finishes. While the finger rests nothing is
  // sent: the continued stroke keeps it pressed (Android's long press).

  private var stroke: GestureDescription.StrokeDescription? = null
  private var dispatching = false
  private var lastX = 0f
  private var lastY = 0f
  private var targetX = 0f
  private var targetY = 0f
  private var upPending = false
  private var sentX = 0f
  private var sentY = 0f
  private var fingerDown = false

  fun touch(phase: String, x: Float, y: Float) = main.post {
    when (phase) {
      "down" -> {
        cancelFinger()
        fingerDown = true
        upPending = false
        lastX = x; lastY = y; targetX = x; targetY = y; sentX = x; sentY = y
        val first = GestureDescription.StrokeDescription(segment(x, y, x, y), 0, STROKE_MS, continuable())
        dispatchPart(first)
      }
      "move" -> if (fingerDown) {
        targetX = x; targetY = y
        if (!dispatching) continueFinger()
      }
      "up" -> if (fingerDown) {
        targetX = x; targetY = y
        upPending = true
        if (!dispatching) continueFinger()
      }
    }
  }

  private fun continuable() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O

  private var nudge = NUDGE_PX

  /**
   * Path for one part of the live finger, ending where the next part starts
   * (lastX/lastY are updated to the real end). A part that does not move gets
   * a half-pixel nudge: Android cannot take an end point from a zero-length
   * path, so it cancelled the continuation and drags never moved. Half a
   * pixel, alternating, is far below the touch slop: a held finger is still.
   */
  private fun segment(fromX: Float, fromY: Float, toX: Float, toY: Float): Path {
    var endX = toX
    if (toX == fromX && toY == fromY) {
      endX = fromX + nudge
      nudge = -nudge
    }
    lastX = endX
    lastY = toY
    return Path().apply { moveTo(fromX, fromY); lineTo(endX, toY) }
  }

  private fun continueFinger() {
    val prev = stroke
    if (prev == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      // Android 7: no live strokes — finish with a single swipe/tap.
      if (upPending) {
        val path = Path().apply { moveTo(lastX, lastY); lineTo(targetX, targetY) }
        dispatchGesture(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, 120)).build(), null, null)
        fingerDown = false
      }
      return
    }
    val path = segment(lastX, lastY, targetX, targetY)
    val next = prev.continueStroke(path, 0, STROKE_MS, !upPending)
    sentX = targetX; sentY = targetY
    if (upPending) {
      fingerDown = false
      upPending = false
    }
    dispatchPart(next)
  }

  private fun dispatchPart(part: GestureDescription.StrokeDescription) {
    stroke = part
    dispatching = true
    if (Log.isLoggable(TAG, Log.DEBUG)) Log.d(TAG, "part to ($lastX, $lastY) dur=${part.duration} continues=${part.willContinue()}")
    val ok = dispatchGesture(
      GestureDescription.Builder().addStroke(part).build(),
      object : GestureResultCallback() {
        override fun onCompleted(gestureDescription: GestureDescription?) {
          dispatching = false
          if (!fingerDown) {
            stroke = null
          } else if (upPending || targetX != sentX || targetY != sentY) {
            continueFinger()
          }
          // Otherwise the finger simply stays down (a continued stroke is not
          // released until the next part) until the next move or the release;
          // Android's own long press fires while it rests.
        }

        override fun onCancelled(gestureDescription: GestureDescription?) {
          Log.w(TAG, "live finger cancelled by the system")
          dispatching = false
          stroke = null
          fingerDown = false
        }
      },
      main,
    )
    if (!ok) {
      Log.w(TAG, "live finger part rejected")
      dispatching = false
      stroke = null
      fingerDown = false
    }
  }

  private fun cancelFinger() {
    stroke = null
    dispatching = false
    fingerDown = false
  }

  /**
   * A complete tap in one gesture (a mouse click on the PC). Sending a click
   * as a live finger (down … network … up) kept the finger pressed past
   * Android's long-press timeout, so launchers opened their long-press menu.
   */
  fun tap(x: Float, y: Float) = main.post {
    if (fingerDown) cancelFinger()
    val path = Path().apply { moveTo(x, y) }
    dispatchGesture(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, TAP_MS)).build(), null, null)
  }

  /** Swipe of (dx, dy) pixels starting at (x, y). */
  fun scroll(x: Float, y: Float, dx: Float, dy: Float) = main.post {
    val path = Path().apply { moveTo(x, y); lineTo(x + dx, y + dy) }
    dispatchGesture(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, 180)).build(), null, null)
  }

  // ---- navigation -----------------------------------------------------------------

  fun nav(action: String): Boolean {
    val id = when (action) {
      "back" -> GLOBAL_ACTION_BACK
      "home" -> GLOBAL_ACTION_HOME
      "recents" -> GLOBAL_ACTION_RECENTS
      "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
      "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
      "power" -> GLOBAL_ACTION_POWER_DIALOG
      "lock" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) GLOBAL_ACTION_LOCK_SCREEN else return false
      "screenshot" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) GLOBAL_ACTION_TAKE_SCREENSHOT else return false
      else -> return false
    }
    return performGlobalAction(id)
  }

  // ---- typing ---------------------------------------------------------------------

  private fun focusedField(): AccessibilityNodeInfo? {
    val node = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return null
    return if (node.isEditable) node else null
  }

  private fun currentText(node: AccessibilityNodeInfo): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && node.isShowingHintText) return ""
    return node.text?.toString() ?: ""
  }

  private fun setText(node: AccessibilityNodeInfo, text: String, cursor: Int): Boolean {
    val args = Bundle().apply {
      putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    }
    val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    val sel = Bundle().apply {
      putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
      putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
    }
    node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)
    return ok
  }

  private fun selection(node: AccessibilityNodeInfo, length: Int): Pair<Int, Int> {
    var start = node.textSelectionStart
    var end = node.textSelectionEnd
    if (start < 0 || end < 0) { start = length; end = length }
    return Pair(minOf(start, end).coerceIn(0, length), maxOf(start, end).coerceIn(0, length))
  }

  /** Insert text at the cursor of the focused field. */
  fun typeText(insert: String): Boolean {
    val node = focusedField() ?: return false
    val text = currentText(node)
    val (start, end) = selection(node, text.length)
    val next = text.substring(0, start) + insert + text.substring(end)
    return setText(node, next, start + insert.length)
  }

  /** Editing keys that have no text of their own. */
  fun key(code: String): Boolean {
    if (code == "Escape") return nav("back")
    val node = focusedField() ?: return false
    val text = currentText(node)
    val (start, end) = selection(node, text.length)
    return when (code) {
      "Backspace" -> when {
        start != end -> setText(node, text.substring(0, start) + text.substring(end), start)
        start > 0 -> setText(node, text.substring(0, start - 1) + text.substring(end), start - 1)
        else -> true
      }
      "Delete" -> when {
        start != end -> setText(node, text.substring(0, start) + text.substring(end), start)
        end < text.length -> setText(node, text.substring(0, start) + text.substring(end + 1), start)
        else -> true
      }
      "Enter", "NumpadEnter" -> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
          node.actionList.any { it.id == android.R.id.accessibilityActionImeEnter }
        ) {
          node.performAction(android.R.id.accessibilityActionImeEnter)
        } else {
          typeText("\n")
        }
      }
      "ArrowLeft", "ArrowRight", "Home", "End" -> {
        val pos = when (code) {
          "ArrowLeft" -> (start - 1).coerceAtLeast(0)
          "ArrowRight" -> (end + 1).coerceAtMost(text.length)
          "Home" -> 0
          else -> text.length
        }
        val sel = Bundle().apply {
          putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, pos)
          putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, pos)
        }
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)
      }
      "SelectAll" -> {
        val sel = Bundle().apply {
          putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 0)
          putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, text.length)
        }
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)
      }
      "Paste" -> node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
      "Copy" -> node.performAction(AccessibilityNodeInfo.ACTION_COPY)
      "Cut" -> node.performAction(AccessibilityNodeInfo.ACTION_CUT)
      else -> false
    }
  }
}
