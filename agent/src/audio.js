// Computer sound: WASAPI loopback capture of the default output device.
//
// A PowerShell worker compiles a small C# helper (COM interop with
// IMMDeviceEnumerator → IAudioClient in loopback mode → IAudioCaptureClient)
// and writes, on stdout:
//   [u32 sampleRate][u32 channels=2]   once
//   s16le interleaved stereo PCM       continuously
// The node side cuts it into 10 ms frames for wrtc's RTCAudioSource.
// No native modules and no virtual audio driver are needed.

import { spawnScript } from './powershell.js';

const WORKER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCo {}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient {
  int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
  int GetBufferSize(out uint frames);
  int GetStreamLatency(out long latency);
  int GetCurrentPadding(out uint padding);
  int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
  int GetMixFormat(out IntPtr format);
  int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
  int Start();
  int Stop();
  int Reset();
  int SetEventHandle(IntPtr handle);
  int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient {
  int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
  int ReleaseBuffer(uint frames);
  int GetNextPacketSize(out uint frames);
}

public static class AgentLoopback {
  static void Check(int hr, string what) { if (hr < 0) throw new Exception(what + " failed: 0x" + hr.ToString("X8")); }

  public static void Run() {
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCo());
    IMMDevice device;
    Check(enumerator.GetDefaultAudioEndpoint(0 /*eRender*/, 0 /*eConsole*/, out device), "GetDefaultAudioEndpoint");
    Guid iidClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    object o;
    Check(device.Activate(ref iidClient, 23 /*CLSCTX_ALL*/, IntPtr.Zero, out o), "Activate");
    var client = (IAudioClient)o;
    IntPtr fmt;
    Check(client.GetMixFormat(out fmt), "GetMixFormat");
    int channels = Marshal.ReadInt16(fmt, 2);
    int rate = Marshal.ReadInt32(fmt, 4);
    int bits = Marshal.ReadInt16(fmt, 14);
    int tag = (ushort)Marshal.ReadInt16(fmt, 0);
    bool isFloat = tag == 3;
    if (tag == 0xFFFE) {
      // WAVEFORMATEXTENSIBLE: SubFormat GUID at offset 24; first 4 bytes = 3 for IEEE float.
      isFloat = Marshal.ReadInt32(fmt, 24) == 3;
    }
    Check(client.Initialize(0 /*shared*/, 0x00020000 /*LOOPBACK*/, 2000000, 0, fmt, IntPtr.Zero), "Initialize");
    Guid iidCapture = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    object c;
    Check(client.GetService(ref iidCapture, out c), "GetService");
    var capture = (IAudioCaptureClient)c;

    var output = Console.OpenStandardOutput();
    var header = new byte[8];
    BitConverter.GetBytes(rate).CopyTo(header, 0);
    BitConverter.GetBytes(2).CopyTo(header, 4);
    output.Write(header, 0, 8);
    output.Flush();

    Check(client.Start(), "Start");
    byte[] buffer = new byte[0];
    int bytesPerSample = bits / 8;
    while (true) {
      Thread.Sleep(5);
      uint packet;
      Check(capture.GetNextPacketSize(out packet), "GetNextPacketSize");
      while (packet > 0) {
        IntPtr data; uint frames; uint flags; ulong p1; ulong p2;
        Check(capture.GetBuffer(out data, out frames, out flags, out p1, out p2), "GetBuffer");
        int outBytes = (int)frames * 4;
        if (buffer.Length < outBytes) buffer = new byte[outBytes];
        bool silent = (flags & 2) != 0;
        for (int f = 0; f < frames; f++) {
          for (int ch = 0; ch < 2; ch++) {
            int src = channels == 1 ? 0 : ch;
            short s = 0;
            if (!silent) {
              int offset = (f * channels + src) * bytesPerSample;
              if (isFloat && bits == 32) {
                float v = BitConverter.ToSingle(BitConverter.GetBytes(Marshal.ReadInt32(data, offset)), 0);
                if (v > 1f) v = 1f; if (v < -1f) v = -1f;
                s = (short)(v * 32767f);
              } else if (bits == 16) {
                s = Marshal.ReadInt16(data, offset);
              } else if (bits == 24) {
                int v = (Marshal.ReadByte(data, offset) | (Marshal.ReadByte(data, offset + 1) << 8) | ((sbyte)Marshal.ReadByte(data, offset + 2) << 16));
                s = (short)(v >> 8);
              } else if (bits == 32) {
                s = (short)(Marshal.ReadInt32(data, offset) >> 16);
              }
            }
            int o2 = (f * 2 + ch) * 2;
            buffer[o2] = (byte)(s & 0xFF);
            buffer[o2 + 1] = (byte)((s >> 8) & 0xFF);
          }
        }
        output.Write(buffer, 0, outBytes);
        Check(capture.ReleaseBuffer(frames), "ReleaseBuffer");
        Check(capture.GetNextPacketSize(out packet), "GetNextPacketSize");
      }
      output.Flush();
    }
  }
}
"@
[AgentLoopback]::Run()
`;

/**
 * Loopback capture producing 10 ms stereo s16 frames:
 *   onFrame({ samples: Int16Array, sampleRate, channelCount: 2, numberOfFrames })
 */
export class AudioCapture {
  constructor({ onFrame, log } = {}) {
    this.onFrame = onFrame;
    this.log = log ?? (() => {});
    this.child = null;
    this.rate = 0;
    this.pending = Buffer.alloc(0);
    this.stopped = false;
  }

  start() {
    if (this.child) return;
    this.stopped = false;
    this.rate = 0;
    this.pending = Buffer.alloc(0);
    const child = spawnScript(WORKER, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.on('data', (d) => {
      const line = String(d).trim();
      if (line) this.log(`audio worker: ${line.slice(0, 240)}`);
    });
    child.on('close', (code) => {
      if (this.child === child) this.child = null;
      if (!this.stopped && code !== 0 && code !== null) this.log(`audio capture stopped (code ${code})`);
    });
  }

  onData(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    if (!this.rate) {
      if (this.pending.length < 8) return;
      this.rate = this.pending.readUInt32LE(0);
      this.pending = this.pending.subarray(8);
      this.log(`computer sound: capturing at ${this.rate} Hz`);
    }
    const frames = Math.round(this.rate / 100); // 10 ms
    const bytes = frames * 2 * 2;
    while (this.pending.length >= bytes) {
      // Each frame needs its own exactly-sized ArrayBuffer: wrtc validates
      // samples.buffer.byteLength, and Buffer slices share Node's pool.
      const own = new ArrayBuffer(bytes);
      new Uint8Array(own).set(this.pending.subarray(0, bytes));
      this.pending = this.pending.subarray(bytes);
      const samples = new Int16Array(own);
      try {
        this.onFrame?.({ samples, sampleRate: this.rate, channelCount: 2, bitsPerSample: 16, numberOfFrames: frames });
      } catch { /* consumer's problem */ }
    }
  }

  stop() {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.kill(); } catch { /* gone */ }
    }
  }
}
