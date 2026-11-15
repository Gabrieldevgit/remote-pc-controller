import React from 'react';
import {Image, StyleSheet, View} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';

import {RTCView} from '../lib/sessionClient';
import type {InputMessage} from '../lib/inputProtocol';
import type {PointerColor} from '../store/settings';
import CursorOverlay, {type CursorShape} from './CursorOverlay';

export type SurfaceMode = 'mouse' | 'touch' | 'trackpad' | 'view';

export interface RemoteCursor {
  x: number;
  y: number;
  visible: boolean;
  shape: CursorShape;
}

export interface RemoteSurfaceHandle {
  resetZoom: () => void;
}

interface RemoteSurfaceProps {
  streamUrl: string | null;
  jpegFrame: string | null;
  /** Remote frame size (from stats); letterboxing math needs it. */
  videoSize: {width: number; height: number} | null;
  mode: SurfaceMode;
  remoteCursor: RemoteCursor | null;
  pointerSize: number;
  pointerColor: PointerColor;
  pointerSpeed: number;
  send: (message: InputMessage) => void;
  haptic: () => void;
  /** Single tap in trackpad / view mode (reveals the toolbar). */
  onSurfaceTap: () => void;
  onZoomChange?: (zoom: number) => void;
  children?: React.ReactNode;
}

const MAX_ZOOM = 4;
const SEND_INTERVAL_MS = 16;
/** After a local move, ignore agent cursor reports for this long. */
const LOCAL_AUTHORITY_MS = 450;
const SCROLL_NOTCH_PX = 36;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The live remote screen with a big, fully controllable pointer.
 *
 * Mouse mode (default):
 *  - touch ON the pointer and drag   → the pointer follows the finger
 *  - drag anywhere else              → relative move × pointer speed
 *  - tap / double tap                → left click / double click at the pointer
 *  - long-press, then drag           → hold the left button (drag & drop, select)
 *  - two-finger tap                  → right click
 *  - two-finger drag                 → scroll
 *  - pinch                           → zoom 1–4×, view follows the pointer
 * Touch mode: tap clicks where you touch, drag drags there.
 * Trackpad mode: the docked trackpad drives input; the surface zooms only.
 *
 * Gesture callbacks run on the JS thread (runOnJS(true)): they read refs and
 * call plain JS functions.
 */
const RemoteSurface = React.forwardRef<RemoteSurfaceHandle, RemoteSurfaceProps>(
  function RemoteSurface(props, ref) {
    const {
      streamUrl,
      jpegFrame,
      mode,
      remoteCursor,
      pointerSize,
      pointerColor,
      children,
    } = props;

    // Latest props for gesture callbacks (the gesture graph is built once per mode).
    const live = React.useRef(props);
    live.current = props;

    const [layout, setLayout] = React.useState({width: 0, height: 0});
    const [view, setView] = React.useState({zoom: 1, px: 0, py: 0});
    const viewRef = React.useRef(view);
    viewRef.current = view;
    const layoutRef = React.useRef(layout);
    layoutRef.current = layout;

    // Pointer position, normalized to the remote screen.
    const [cursor, setCursor] = React.useState({x: 0.5, y: 0.5});
    const cursorRef = React.useRef(cursor);
    const [pressed, setPressed] = React.useState(false);
    const localUntil = React.useRef(0);
    const touching = React.useRef(false);

    // ---- geometry -------------------------------------------------------

    /** Visible video rect at zoom 1 (letterboxed "contain"). */
    const baseRect = React.useCallback(() => {
      const {width: W, height: H} = layoutRef.current;
      const vs = live.current.videoSize;
      if (!vs || vs.width <= 0 || vs.height <= 0 || W <= 0 || H <= 0) {
        return {x: 0, y: 0, w: Math.max(1, W), h: Math.max(1, H)};
      }
      const s = Math.min(W / vs.width, H / vs.height);
      const w = vs.width * s;
      const h = vs.height * s;
      return {x: (W - w) / 2, y: (H - h) / 2, w, h};
    }, []);

    const toScreen = React.useCallback(
      (nx: number, ny: number) => {
        const r = baseRect();
        const {zoom, px, py} = viewRef.current;
        return {x: (r.x + nx * r.w) * zoom - px, y: (r.y + ny * r.h) * zoom - py};
      },
      [baseRect],
    );

    const toNorm = React.useCallback(
      (sx: number, sy: number) => {
        const r = baseRect();
        const {zoom, px, py} = viewRef.current;
        return {
          x: clamp(((sx + px) / zoom - r.x) / r.w, 0, 1),
          y: clamp(((sy + py) / zoom - r.y) / r.h, 0, 1),
        };
      },
      [baseRect],
    );

    const clampView = React.useCallback((zoom: number, px: number, py: number) => {
      const {width: W, height: H} = layoutRef.current;
      const z = clamp(zoom, 1, MAX_ZOOM);
      return {
        zoom: z,
        px: clamp(px, 0, Math.max(0, W * z - W)),
        py: clamp(py, 0, Math.max(0, H * z - H)),
      };
    }, []);

    const applyView = React.useCallback(
      (next: {zoom: number; px: number; py: number}) => {
        const v = clampView(next.zoom, next.px, next.py);
        const prev = viewRef.current;
        if (v.zoom === prev.zoom && v.px === prev.px && v.py === prev.py) {
          return;
        }
        viewRef.current = v;
        setView(v);
        if (v.zoom !== prev.zoom) {
          live.current.onZoomChange?.(v.zoom);
        }
      },
      [clampView],
    );

    /** When zoomed, scroll the view so the pointer stays comfortably visible. */
    const follow = React.useCallback(
      (nx: number, ny: number) => {
        const {zoom, px, py} = viewRef.current;
        if (zoom <= 1) {
          return;
        }
        const {width: W, height: H} = layoutRef.current;
        const p = toScreen(nx, ny);
        const mx = W * 0.18;
        const my = H * 0.18;
        let npx = px;
        let npy = py;
        if (p.x < mx) {
          npx -= mx - p.x;
        } else if (p.x > W - mx) {
          npx += p.x - (W - mx);
        }
        if (p.y < my) {
          npy -= my - p.y;
        } else if (p.y > H - my) {
          npy += p.y - (H - my);
        }
        applyView({zoom, px: npx, py: npy});
      },
      [applyView, toScreen],
    );

    // ---- pointer state + sending ---------------------------------------

    const lastSend = React.useRef(0);
    const pendingSend = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const sendPosition = React.useCallback((force = false) => {
      const flush = () => {
        pendingSend.current = null;
        lastSend.current = Date.now();
        live.current.send({t: 'pointer.abs', x: cursorRef.current.x, y: cursorRef.current.y});
      };
      if (force) {
        if (pendingSend.current) {
          clearTimeout(pendingSend.current);
        }
        flush();
        return;
      }
      if (pendingSend.current) {
        return;
      }
      const wait = Math.max(0, SEND_INTERVAL_MS - (Date.now() - lastSend.current));
      pendingSend.current = setTimeout(flush, wait);
    }, []);

    const moveCursorTo = React.useCallback(
      (nx: number, ny: number) => {
        const next = {x: clamp(nx, 0, 1), y: clamp(ny, 0, 1)};
        cursorRef.current = next;
        setCursor(next);
        localUntil.current = Date.now() + LOCAL_AUTHORITY_MS;
        sendPosition();
        follow(next.x, next.y);
      },
      [follow, sendPosition],
    );

    // Follow the real pointer when the user isn't driving it.
    React.useEffect(() => {
      if (!remoteCursor || touching.current || Date.now() < localUntil.current) {
        return;
      }
      const next = {x: remoteCursor.x, y: remoteCursor.y};
      cursorRef.current = next;
      setCursor(next);
    }, [remoteCursor]);

    React.useImperativeHandle(ref, () => ({
      resetZoom: () => applyView({zoom: 1, px: 0, py: 0}),
    }));

    // ---- gestures ----------------------------------------------------------

    const gesture = React.useMemo(() => {
      const g = {
        grab: false,
        offX: 0,
        offY: 0,
        lastX: 0,
        lastY: 0,
        dragging: false,
        pinching: false,
        pinchStart: {zoom: 1, px: 0, py: 0, fx: 0, fy: 0},
        scrollX: 0,
        scrollY: 0,
        lastScrollX: 0,
        lastScrollY: 0,
      };
      const send = (m: InputMessage) => live.current.send(m);
      const release = () => {
        if (g.dragging) {
          g.dragging = false;
          sendPosition(true);
          send({t: 'button', button: 'left', down: false});
          setPressed(false);
        }
      };
      const cur = () => cursorRef.current;

      // Pinch zoom around the focal point (all modes).
      const pinch = Gesture.Pinch()
        .runOnJS(true)
        .onStart(e => {
          const v = viewRef.current;
          g.pinchStart = {zoom: v.zoom, px: v.px, py: v.py, fx: e.focalX, fy: e.focalY};
        })
        .onUpdate(e => {
          if (Math.abs(e.scale - 1) > 0.06) {
            g.pinching = true;
          }
          if (!g.pinching) {
            return;
          }
          const s = g.pinchStart;
          const zoom = clamp(s.zoom * e.scale, 1, MAX_ZOOM);
          // Keep the content under the original focal point under the fingers.
          const cx = (s.fx + s.px) / s.zoom;
          const cy = (s.fy + s.py) / s.zoom;
          applyView({zoom, px: cx * zoom - e.focalX, py: cy * zoom - e.focalY});
        })
        .onFinalize(() => {
          setTimeout(() => {
            g.pinching = false;
          }, 80);
        });

      // Two-finger drag = scroll wheel.
      const scroll = Gesture.Pan()
        .runOnJS(true)
        .minPointers(2)
        .maxPointers(2)
        .averageTouches(true)
        .onBegin(e => {
          g.scrollX = 0;
          g.scrollY = 0;
          g.lastScrollX = e.x;
          g.lastScrollY = e.y;
        })
        .onUpdate(e => {
          const dx = e.x - g.lastScrollX;
          const dy = e.y - g.lastScrollY;
          g.lastScrollX = e.x;
          g.lastScrollY = e.y;
          if (g.pinching || live.current.mode === 'view') {
            return;
          }
          g.scrollX += dx;
          g.scrollY += dy;
          const nx = Math.trunc(g.scrollX / SCROLL_NOTCH_PX);
          const ny = Math.trunc(g.scrollY / SCROLL_NOTCH_PX);
          if (nx !== 0 || ny !== 0) {
            g.scrollX -= nx * SCROLL_NOTCH_PX;
            g.scrollY -= ny * SCROLL_NOTCH_PX;
            send({t: 'wheel', dx: -nx * SCROLL_NOTCH_PX, dy: -ny * SCROLL_NOTCH_PX});
          }
        });

      if (mode === 'trackpad' || mode === 'view') {
        const tap = Gesture.Tap()
          .runOnJS(true)
          .maxDuration(250)
          .onEnd((_e, ok) => {
            if (ok) {
              live.current.onSurfaceTap();
            }
          });
        return mode === 'view'
          ? Gesture.Simultaneous(pinch, tap)
          : Gesture.Simultaneous(pinch, scroll, tap);
      }

      // One-finger drag: move the pointer (mouse) or drag at the finger (touch).
      const drag = Gesture.Pan()
        .runOnJS(true)
        .maxPointers(1)
        .minDistance(2)
        .onBegin(e => {
          touching.current = true;
          g.lastX = e.x;
          g.lastY = e.y;
          if (live.current.mode === 'mouse') {
            const tip = toScreen(cur().x, cur().y);
            const size = live.current.pointerSize;
            // Touch on (or right around) the drawn pointer grabs it.
            g.grab =
              e.x >= tip.x - size * 0.35 &&
              e.x <= tip.x + size &&
              e.y >= tip.y - size * 0.35 &&
              e.y <= tip.y + size;
            g.offX = tip.x - e.x;
            g.offY = tip.y - e.y;
          }
        })
        .onStart(e => {
          if (live.current.mode === 'touch' && !g.dragging) {
            // Touch mode: pressing and moving drags at the finger.
            const p = toNorm(e.x, e.y);
            cursorRef.current = p;
            setCursor(p);
            sendPosition(true);
            send({t: 'button', button: 'left', down: true});
            g.dragging = true;
            setPressed(true);
          }
        })
        .onUpdate(e => {
          if (g.pinching) {
            return;
          }
          if (live.current.mode === 'touch') {
            const p = toNorm(e.x, e.y);
            moveCursorTo(p.x, p.y);
            return;
          }
          if (g.grab) {
            const p = toNorm(e.x + g.offX, e.y + g.offY);
            moveCursorTo(p.x, p.y);
          } else {
            const r = baseRect();
            const {zoom} = viewRef.current;
            const speed = live.current.pointerSpeed;
            const dx = ((e.x - g.lastX) * speed) / (r.w * zoom);
            const dy = ((e.y - g.lastY) * speed) / (r.h * zoom);
            moveCursorTo(cur().x + dx, cur().y + dy);
          }
          g.lastX = e.x;
          g.lastY = e.y;
        })
        .onFinalize(() => {
          touching.current = false;
          release();
          localUntil.current = Date.now() + LOCAL_AUTHORITY_MS;
        });

      // Long-press then drag: hold the left button (mouse mode) /
      // long-press = right click (touch mode).
      const hold = Gesture.LongPress()
        .runOnJS(true)
        .minDuration(380)
        .maxDistance(14)
        .onStart(e => {
          live.current.haptic();
          if (live.current.mode === 'touch') {
            const p = toNorm(e.x, e.y);
            moveCursorTo(p.x, p.y);
            send({t: 'click', button: 'right', x: p.x, y: p.y});
            return;
          }
          sendPosition(true);
          send({t: 'button', button: 'left', down: true});
          g.dragging = true;
          setPressed(true);
        })
        .onFinalize(() => {
          // Released without moving: still let go of the button.
          if (!touching.current) {
            release();
          }
        });

      const clickAt = (button: 'left' | 'right', double = false, sx?: number, sy?: number) => {
        live.current.haptic();
        let p = cur();
        if (live.current.mode === 'touch' && sx != null && sy != null) {
          p = toNorm(sx, sy);
          cursorRef.current = p;
          setCursor(p);
          localUntil.current = Date.now() + LOCAL_AUTHORITY_MS;
        }
        send({t: 'click', button, x: p.x, y: p.y, ...(double ? {double: true} : {})});
      };

      const tap = Gesture.Tap()
        .runOnJS(true)
        .maxDuration(250)
        .maxDistance(10)
        .onEnd((e, ok) => {
          if (ok) {
            clickAt('left', false, e.x, e.y);
          }
        });
      const doubleTap = Gesture.Tap()
        .runOnJS(true)
        .numberOfTaps(2)
        .maxDistance(16)
        .onEnd((e, ok) => {
          if (ok) {
            clickAt('left', true, e.x, e.y);
          }
        });
      const twoFingerTap = Gesture.Tap()
        .runOnJS(true)
        .minPointers(2)
        .maxDuration(300)
        .onEnd((_e, ok) => {
          if (ok) {
            clickAt('right');
          }
        });

      return Gesture.Simultaneous(
        drag,
        hold,
        scroll,
        pinch,
        Gesture.Exclusive(twoFingerTap, doubleTap, tap),
      );
    }, [mode, applyView, baseRect, moveCursorTo, sendPosition, toNorm, toScreen]);

    // ---- render -------------------------------------------------------------

    const {width: W, height: H} = layout;
    const videoStyle = {
      position: 'absolute' as const,
      left: -view.px,
      top: -view.py,
      width: W * view.zoom,
      height: H * view.zoom,
    };
    const tip = toScreen(cursor.x, cursor.y);
    const showPointer = W > 0 && (remoteCursor?.visible ?? true) && (streamUrl != null || jpegFrame != null);

    return (
      <GestureDetector gesture={gesture}>
        <View
          style={styles.root}
          collapsable={false}
          onLayout={e => {
            const {width, height} = e.nativeEvent.layout;
            const prev = layoutRef.current;
            if (prev.width === width && prev.height === height) {
              return;
            }
            setLayout({width, height});
            // Rotated or resized: refit the whole PC screen (zoom 1).
            if (prev.width > 0 && viewRef.current.zoom !== 1) {
              viewRef.current = {zoom: 1, px: 0, py: 0};
              setView(viewRef.current);
              live.current.onZoomChange?.(1);
            }
          }}>
          {W > 0 && streamUrl ? (
            <RTCView streamURL={streamUrl} style={videoStyle} objectFit="contain" zOrder={0} />
          ) : W > 0 && jpegFrame ? (
            <Image source={{uri: jpegFrame}} style={videoStyle} resizeMode="contain" fadeDuration={0} />
          ) : null}
          {showPointer ? (
            <CursorOverlay
              x={tip.x}
              y={tip.y}
              shape={remoteCursor?.shape ?? 'arrow'}
              size={pointerSize}
              color={pointerColor}
              pressed={pressed}
            />
          ) : null}
          {children}
        </View>
      </GestureDetector>
    );
  },
);

export default RemoteSurface;

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
});
