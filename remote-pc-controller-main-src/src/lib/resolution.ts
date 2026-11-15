/**
 * Stream resolution — the size of the PC picture sent to this phone. The
 * PC's own display is never changed (docs/DATA_CHANNEL.md, quality.set).
 *
 *   auto   — fit this phone's screen; adaptive quality may lower it on a
 *            slow network
 *   preset — one of RESOLUTION_PRESETS
 *   custom — any width × height within the limits below
 * The agent always keeps the PC screen's shape and never upscales.
 */
import {Dimensions, PixelRatio} from 'react-native';

export type ResolutionMode = 'auto' | 'preset' | 'custom';

export interface StreamResolution {
  mode: ResolutionMode;
  width?: number;
  height?: number;
}

export interface Size {
  width: number;
  height: number;
}

export const RESOLUTION_LIMITS = {minWidth: 320, maxWidth: 3840, minHeight: 240, maxHeight: 2160};

export const RESOLUTION_PRESETS: Size[] = [
  {width: 3840, height: 2160},
  {width: 2560, height: 1600},
  {width: 2560, height: 1440},
  {width: 1920, height: 1200},
  {width: 1920, height: 1080},
  {width: 1680, height: 1050},
  {width: 1600, height: 900},
  {width: 1536, height: 864},
  {width: 1440, height: 900},
  {width: 1366, height: 768},
  {width: 1280, height: 800},
  {width: 1280, height: 720},
  {width: 1024, height: 768},
  {width: 960, height: 540},
  {width: 854, height: 480},
  {width: 640, height: 360},
];

export const AUTO_RESOLUTION: StreamResolution = {mode: 'auto'};

export function sizeLabel(size: Size): string {
  return `${size.width} × ${size.height}`;
}

export function resolutionLabel(res: StreamResolution): string {
  if (res.mode === 'auto' || !res.width || !res.height) {
    return 'Auto';
  }
  return res.mode === 'custom' ? `Custom · ${res.width} × ${res.height}` : `${res.width} × ${res.height}`;
}

export function isValidSize(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= RESOLUTION_LIMITS.minWidth &&
    width <= RESOLUTION_LIMITS.maxWidth &&
    height >= RESOLUTION_LIMITS.minHeight &&
    height <= RESOLUTION_LIMITS.maxHeight
  );
}

/** Keep stored values safe (AsyncStorage may hold anything). */
export function sanitizeResolution(raw: unknown): StreamResolution {
  const r = (raw ?? {}) as Partial<StreamResolution>;
  if ((r.mode === 'preset' || r.mode === 'custom') && isValidSize(Number(r.width), Number(r.height))) {
    return {mode: r.mode, width: Number(r.width), height: Number(r.height)};
  }
  return AUTO_RESOLUTION;
}

/** This phone's screen in physical pixels (used by Auto). */
export function phoneScreenPixels(): Size {
  const {width, height} = Dimensions.get('screen');
  const ratio = PixelRatio.get();
  return {width: Math.round(width * ratio), height: Math.round(height * ratio)};
}

/** Message fields sent with quality.set. */
export function resolutionPayload(res: StreamResolution): {resolution: StreamResolution; client: Size} {
  return {
    resolution: res.mode === 'auto' ? {mode: 'auto'} : {mode: res.mode, width: res.width, height: res.height},
    client: phoneScreenPixels(),
  };
}
