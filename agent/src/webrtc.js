// WebRTC backend selection for the agent.
//
// Capability tiers (first that installs wins):
//   1. @roamhq/wrtc — native WebRTC with prebuilt Windows binaries. Its
//      getDisplayMedia is a fake-device stub, so the video track is fed by
//      our own software capture: a PowerShell worker produces BGRA frames
//      (capture.js), which are converted to I420 and pushed into an
//      RTCVideoSource — a real WebRTC video track at capture speed.
//   2. werift — pure-JS WebRTC (no native build). Data channel only; JPEG
//      frames are streamed over the channel at reduced fps ("jpeg" mode).
//   3. none — sessions are rejected with capture_unavailable.
//
// The backend never throws at import time: everything is behind dynamic
// imports so a missing native module only degrades features.

const STUN_URLS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

let cached = null;

async function tryImport(name) {
  try {
    const mod = await import(name);
    // CJS packages surface their exports on `default` under ESM import.
    const lib = mod.default && (mod.default.RTCPeerConnection || mod.default.nonstandard) ? mod.default : mod;
    return { module: lib, error: null };
  } catch (err) {
    return { module: null, error: err };
  }
}

/** Detect the best available backend. Result is cached for the process. */
export async function detect() {
  if (cached) return cached;

  const wrtc = await tryImport('@roamhq/wrtc');
  if (wrtc.module && typeof wrtc.module.RTCPeerConnection === 'function'
    && typeof wrtc.module.nonstandard?.RTCVideoSource === 'function') {
    cached = {
      mode: 'native',
      reason: null,
      wrtc: wrtc.module,
      capture: { kind: 'rtcVideoSource' },
    };
    return cached;
  }

  const werift = await tryImport('werift');
  if (werift.module && typeof werift.module.RTCPeerConnection === 'function') {
    cached = {
      mode: 'jpeg',
      reason: `@roamhq/wrtc could not be used (${wrtc.error?.message ?? 'missing or incomplete'})`
        + ' — degraded mode: pure-JS WebRTC data channel with JPEG frames at reduced fps',
      wrtc: null,
      capture: null,
      werift: werift.module,
    };
    return cached;
  }

  cached = {
    mode: 'none',
    reason: `feature unavailable: no WebRTC backend (@roamhq/wrtc: ${wrtc.error?.message ?? 'missing'};`
      + ` werift: ${werift.error?.message ?? 'missing'}) — sessions will be rejected`,
    wrtc: null,
    capture: null,
  };
  return cached;
}

/** Create the backend object used by session.js. */
export async function createBackend({ log = console.log, iceServers } = {}) {
  const info = await detect();
  const servers = iceServers ?? STUN_URLS.map((urls) => ({ urls }));

  if (info.mode === 'none') {
    log(info.reason);
    return { mode: 'none', reason: info.reason, createPeer: null };
  }
  if (info.wrtc) return createWrtcBackend(info, servers, log);
  return createWeriftBackend(info, servers, log);
}

function candidateFields(c) {
  return {
    candidate: c.candidate,
    sdpMid: c.sdpMid ?? undefined,
    sdpMLineIndex: c.sdpMLineIndex ?? undefined,
    usernameFragment: c.usernameFragment ?? undefined,
  };
}

/** Swap B/R channels in-place-ish: PowerShell gives BGRA, libyuv wants RGBA. */
function bgraToRgba(bgra, pixelCount) {
  const rgba = Buffer.from(bgra); // copy — the pump reuses its buffer
  for (let i = 0; i < pixelCount * 4; i += 4) {
    const b = rgba[i];
    rgba[i] = rgba[i + 2];
    rgba[i + 2] = b;
  }
  return rgba;
}

// ---- @roamhq/wrtc adapter -------------------------------------------------------

function createWrtcBackend(info, iceServers, log) {
  const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStream, nonstandard } = info.wrtc;

  async function createPeer({ offerSdp, sendSignal, onDataChannel }) {
    const pc = new RTCPeerConnection({ iceServers });

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) sendSignal('signal.ice', candidateFields(event.candidate));
    });
    pc.addEventListener('datachannel', (event) => {
      try {
        onDataChannel(event.channel);
      } catch (err) {
        log(`data channel wiring failed: ${err?.message ?? err}`);
      }
    });

    // Real video track fed by software capture (RTCVideoSource), plus an
    // audio track fed by WASAPI loopback (computer sound) in the same stream.
    const source = new nonstandard.RTCVideoSource({ isScreencast: true });
    const track = source.createTrack();
    const audioSource = new nonstandard.RTCAudioSource();
    const audioTrack = audioSource.createTrack();
    const stream = new MediaStream([track, audioTrack]);
    pc.addTrack(track, stream);
    pc.addTrack(audioTrack, stream);

    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal('signal.answer', { sdp: pc.localDescription.sdp });

    return {
      /** Feed a captured BGRA frame into the video track. */
      pushFrame({ width, height, data }) {
        try {
          const pixelCount = width * height;
          const rgba = bgraToRgba(data, pixelCount);
          const i420 = new Uint8Array(pixelCount * 3 / 2);
          nonstandard.rgbaToI420({ width, height, data: rgba }, { width, height, data: i420 });
          source.onFrame({ width, height, data: i420 });
        } catch (err) {
          log(`pushFrame failed: ${err?.message ?? err}`);
        }
      },
      /** Feed one 10 ms s16 PCM frame (see audio.js) into the audio track. */
      pushAudio(frame) {
        try {
          audioSource.onData(frame);
        } catch (err) {
          log(`pushAudio failed: ${err?.message ?? err}`);
        }
      },
      /** Extra reliable channel (file transfers); SCTP is already up. */
      createDataChannel(label) {
        const channel = pc.createDataChannel(label, { ordered: true });
        channel.binaryType = 'arraybuffer';
        return channel;
      },
      addIceCandidate(candidate) {
        if (candidate?.candidate) {
          pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
        }
      },
      close() {
        try { track.stop(); } catch { /* already stopped */ }
        try { audioTrack.stop(); } catch { /* already stopped */ }
        try { pc.close(); } catch { /* already closed */ }
      },
    };
  }

  return { mode: 'native', reason: info.reason, createPeer, audio: true };
}

// ---- werift adapter (pure-JS WebRTC, data channel only) -------------------------

function createWeriftBackend(info, iceServers, log) {
  const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = info.werift;

  async function createPeer({ offerSdp, sendSignal, onDataChannel }) {
    const pc = new RTCPeerConnection({ iceServers });

    pc.onIceCandidate?.subscribe?.((candidate) => {
      if (candidate) sendSignal('signal.ice', candidateFields(candidate));
    });
    pc.onDataChannel?.subscribe?.((channel) => {
      try {
        onDataChannel(wrapWeriftChannel(channel));
      } catch (err) {
        log(`data channel wiring failed: ${err?.message ?? err}`);
      }
    });

    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const localSdp = pc.localDescription?.sdp ?? answer.sdp;
    sendSignal('signal.answer', { sdp: localSdp });

    return {
      pushFrame() { /* no video track in this mode */ },
      pushAudio() { /* no audio track in this mode */ },
      createDataChannel(label) {
        return wrapWeriftChannel(pc.createDataChannel(label, { ordered: true }));
      },
      addIceCandidate(candidate) {
        if (candidate?.candidate) {
          pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
        }
      },
      close() {
        try { pc.close(); } catch { /* already closed */ }
      },
    };
  }

  return { mode: 'jpeg', reason: info.reason, createPeer, audio: false };
}

/**
 * werift's data channel exposes observable-style events; wrap it into the
 * same surface session.js expects (onmessage/onclose/onerror/send/readyState).
 */
function wrapWeriftChannel(channel) {
  const wrapper = {
    label: channel.label,
    readyState: channel.readyState,
    get bufferedAmount() { return channel.bufferedAmount ?? 0; },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      return channel.send(data);
    },
    close() {
      channel.close();
    },
  };
  channel.onMessage?.subscribe?.((data) => {
    wrapper.onmessage?.({ data: typeof data === 'string' ? data : Buffer.from(data) });
  });
  channel.stateChanged?.subscribe?.((state) => {
    wrapper.readyState = state;
    if (state === 'open') wrapper.onopen?.({});
    if (state === 'closed') wrapper.onclose?.({});
  });
  return wrapper;
}
