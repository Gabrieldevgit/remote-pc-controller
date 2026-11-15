package com.remotepccontroller.phonehost

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.os.Build
import android.util.Base64
import androidx.annotation.RequiresApi

/**
 * Phone sound for the PC (Android 10+): captures what apps play (media,
 * games, unknown) through the session's MediaProjection and hands 20 ms
 * chunks of 24 kHz mono 16-bit PCM (base64) to [onChunk]. Apps can opt out
 * of capture; calls and the microphone are never included.
 */
@RequiresApi(Build.VERSION_CODES.Q)
class PlaybackAudio(
  private val projection: MediaProjection,
  private val onChunk: (String) -> Unit,
) {
  companion object {
    const val SAMPLE_RATE = 24_000
    private const val CHUNK_BYTES = SAMPLE_RATE / 50 * 2 // 20 ms, 16-bit mono
  }

  private var record: AudioRecord? = null
  @Volatile private var running = false
  private var thread: Thread? = null

  @SuppressLint("MissingPermission") // RECORD_AUDIO is requested by JS first.
  fun start() {
    val config = AudioPlaybackCaptureConfiguration.Builder(projection)
      .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
      .addMatchingUsage(AudioAttributes.USAGE_GAME)
      .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
      .build()
    val format = AudioFormat.Builder()
      .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
      .setSampleRate(SAMPLE_RATE)
      .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
      .build()
    val min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val rec = AudioRecord.Builder()
      .setAudioFormat(format)
      .setBufferSizeInBytes(maxOf(min, CHUNK_BYTES * 8))
      .setAudioPlaybackCaptureConfig(config)
      .build()
    record = rec
    rec.startRecording()
    running = true
    thread = Thread({
      val buf = ByteArray(CHUNK_BYTES)
      while (running) {
        var filled = 0
        while (running && filled < CHUNK_BYTES) {
          val n = rec.read(buf, filled, CHUNK_BYTES - filled)
          if (n <= 0) break
          filled += n
        }
        if (filled == CHUNK_BYTES) onChunk(Base64.encodeToString(buf, Base64.NO_WRAP))
      }
    }, "remote-pc-phone-audio").apply { isDaemon = true; start() }
  }

  fun stop() {
    running = false
    try { record?.stop() } catch (_: Exception) {}
    record?.release()
    record = null
    thread = null
  }
}
