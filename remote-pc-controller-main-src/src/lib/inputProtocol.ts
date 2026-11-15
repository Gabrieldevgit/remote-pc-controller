/**
 * Input event shapes sent over the WebRTC data channel during a remote
 * session.
 *
 * The binding contract for the data channel is `docs/DATA_CHANNEL.md` at the
 * repo root — this file mirrors the client side of it. The data channel is
 * peer-to-peer and never touches the relay, so relay/PROTOCOL.md does not
 * define these shapes. Keep this file in sync with the agent (agent/src/
 * session.js) via that doc.
 *
 * Every frame is one JSON object: `{ t: <kind>, ...fields }`.
 *
 * Key codes: `key.code` is a Web KeyboardEvent.code value (e.g. 'Escape',
 * 'ArrowUp', 'Enter', 'Tab', 'KeyA', 'Digit3', 'ControlLeft'). The agent maps
 * each code onto its internal key names; the supported set is listed in
 * docs/DATA_CHANNEL.md. Modifiers are 'ctrl' | 'alt' | 'shift' | 'meta'.
 */

export type PointerButton = 'left' | 'right' | 'middle';

/** Relative pointer movement in on-screen pixels. */
export interface PointerMoveMessage {
  t: 'pointer.move';
  dx: number;
  dy: number;
}

/** Absolute pointer position, normalized 0..1 against the remote screen. */
export interface PointerAbsMessage {
  t: 'pointer.abs';
  x: number;
  y: number;
}

export interface ClickMessage {
  t: 'click';
  button: PointerButton;
  /** Double click (two presses) at the position. */
  double?: boolean;
  /** When present, click at this absolute position (0..1) first. */
  x?: number;
  y?: number;
}

/** Press or release a mouse button (used for drag). */
export interface ButtonMessage {
  t: 'button';
  button: PointerButton;
  down: boolean;
}

export interface WheelMessage {
  t: 'wheel';
  dx: number;
  dy: number;
}

export type ModifierName = 'ctrl' | 'alt' | 'shift' | 'meta';

export interface KeyMessage {
  t: 'key';
  /** Web-style key code, e.g. 'Escape', 'ArrowUp', 'Enter', 'Tab'. */
  code: string;
  down: boolean;
  modifiers?: ModifierName[];
}

/** Unicode text injection (keyboard bar text field). */
export interface TextMessage {
  t: 'text';
  text: string;
}

/** Request the remote clipboard contents. Agent replies with ClipboardSet. */
export interface ClipboardGetMessage {
  t: 'clipboard.get';
}

/** Push text to the remote clipboard. */
export interface ClipboardSetMessage {
  t: 'clipboard.set';
  text: string;
}

/** Change the agent's capture quality (width / fps / JPEG quality). */
export interface QualitySetMessage {
  t: 'quality.set';
  level: 'high' | 'medium' | 'low' | 'adaptive';
}

/** Liveness + RTT report; the agent adapts quality from `rttMs` in adaptive mode. */
export interface StatsPingMessage {
  t: 'stats.ping';
  seq?: number;
  rttMs?: number;
}

/** Best-effort Secure Attention Sequence (Windows usually blocks it). */
export interface CtrlAltDelMessage {
  t: 'input.ctrlaltdel';
}

export type MediaKeyName =
  | 'volume_up'
  | 'volume_down'
  | 'volume_mute'
  | 'play_pause'
  | 'next_track'
  | 'prev_track';

export interface MediaKeyMessage {
  t: 'input.media';
  key: MediaKeyName;
}

/** Remote Access PIN, verified on the PC (never stored in the cloud). */
export interface AuthPinMessage {
  t: 'auth.pin';
  pin: string;
}

/** Turn computer sound streaming on/off. */
export interface AudioSetMessage {
  t: 'audio.set';
  on: boolean;
}

/** Curtain mode: black out the PC's own screen during the session. */
export interface CurtainSetMessage {
  t: 'curtain.set';
  on: boolean;
}

/** Ask the PC to open its "Open file" dialog and send the chosen file. */
export interface FileRequestMessage {
  t: 'file.request';
}

export type InputMessage =
  | AuthPinMessage
  | AudioSetMessage
  | CurtainSetMessage
  | FileRequestMessage
  | PointerMoveMessage
  | PointerAbsMessage
  | ClickMessage
  | ButtonMessage
  | WheelMessage
  | KeyMessage
  | TextMessage
  | ClipboardGetMessage
  | ClipboardSetMessage
  | QualitySetMessage
  | StatsPingMessage
  | CtrlAltDelMessage
  | MediaKeyMessage;

export const DATA_CHANNEL_LABEL = 'input';

export function sendInput(
  channel: {readyState: string; send: (data: string) => void} | null,
  message: InputMessage,
) {
  if (!channel || channel.readyState !== 'open') {
    return;
  }
  try {
    channel.send(JSON.stringify(message));
  } catch {
    // Channel closed mid-send; the session teardown path handles it.
  }
}
