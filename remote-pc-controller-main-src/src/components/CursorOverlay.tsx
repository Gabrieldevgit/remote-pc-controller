import React from 'react';
import {StyleSheet, View} from 'react-native';
import Svg, {Circle, G, Path} from 'react-native-svg';

import {brand} from '../theme/tokens';
import type {PointerColor} from '../store/settings';

export type CursorShape =
  | 'arrow'
  | 'ibeam'
  | 'hand'
  | 'wait'
  | 'progress'
  | 'cross'
  | 'size-ns'
  | 'size-we'
  | 'size-nwse'
  | 'size-nesw'
  | 'size-all'
  | 'no';

/** Hotspot of each shape as a fraction of the 24×24 drawing box. */
const HOTSPOT: Record<CursorShape, [number, number]> = {
  arrow: [3 / 24, 2 / 24],
  progress: [3 / 24, 2 / 24],
  hand: [9 / 24, 2 / 24],
  ibeam: [0.5, 0.5],
  wait: [0.5, 0.5],
  cross: [0.5, 0.5],
  'size-ns': [0.5, 0.5],
  'size-we': [0.5, 0.5],
  'size-nwse': [0.5, 0.5],
  'size-nesw': [0.5, 0.5],
  'size-all': [0.5, 0.5],
  no: [0.5, 0.5],
};

export function cursorHotspot(shape: CursorShape, size: number): {x: number; y: number} {
  const [hx, hy] = HOTSPOT[shape] ?? HOTSPOT.arrow;
  return {x: hx * size, y: hy * size};
}

function colors(color: PointerColor) {
  switch (color) {
    case 'black':
      return {fill: brand.charcoal, outline: '#FFFFFF'};
    case 'copper':
      return {fill: brand.copper, outline: '#FFFFFF'};
    default:
      return {fill: '#FFFFFF', outline: brand.charcoal};
  }
}

const ARROW = 'M3 2 L3 19.2 L7.4 15 L10.3 21.6 L13.4 20.2 L10.6 13.8 L16.8 13.8 Z';
const HAND =
  'M9 2.2c1 0 1.7.8 1.7 1.8v6.2l.4-.1c.9-.2 1.8.3 2 1.2l.1.3.5-.1c.9-.1 1.7.5 1.9 1.4l.6-.1c.9 0 1.7.7 1.7 1.7v3.6c0 2.9-2.3 5.2-5.2 5.2h-1.9c-1.5 0-2.9-.7-3.9-1.8l-3.6-4.3c-.5-.6-.5-1.6.2-2.2.6-.5 1.5-.5 2.1.1l1.6 1.6V4c0-1 .8-1.8 1.8-1.8Z';

/** One pointer glyph drawn at `size` dp. */
export function CursorGlyph({
  shape,
  size,
  color,
}: {
  shape: CursorShape;
  size: number;
  color: PointerColor;
}) {
  const {fill, outline} = colors(color);
  // Stroke-only shapes get a wide outline under a narrower colored stroke.
  const strokeShape = (d: string) => (
    <G>
      <Path d={d} stroke={outline} strokeWidth={4.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={d} stroke={fill} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </G>
  );
  const body = (() => {
    switch (shape) {
      case 'hand':
        return <Path d={HAND} fill={fill} stroke={outline} strokeWidth={1.3} strokeLinejoin="round" />;
      case 'ibeam':
        return strokeShape('M8.5 3.5c2 0 3.5.8 3.5 2.2 0-1.4 1.5-2.2 3.5-2.2M12 5.7v12.6M8.5 20.5c2 0 3.5-.8 3.5-2.2 0 1.4 1.5 2.2 3.5 2.2');
      case 'wait':
        return (
          <G>
            <Circle cx={12} cy={12} r={7.5} stroke={outline} strokeWidth={4.6} fill="none" />
            <Circle cx={12} cy={12} r={7.5} stroke={fill} strokeWidth={2.4} fill="none" strokeDasharray="30 18" />
          </G>
        );
      case 'progress':
        return (
          <G>
            <Path d={ARROW} fill={fill} stroke={outline} strokeWidth={1.4} strokeLinejoin="round" />
            <Circle cx={18} cy={18} r={3.6} stroke={outline} strokeWidth={3} fill="none" />
            <Circle cx={18} cy={18} r={3.6} stroke={fill} strokeWidth={1.4} fill="none" strokeDasharray="14 9" />
          </G>
        );
      case 'cross':
        return strokeShape('M12 3v18M3 12h18');
      case 'size-ns':
        return strokeShape('M12 3v18M8.5 6.5 12 3l3.5 3.5M8.5 17.5 12 21l3.5-3.5');
      case 'size-we':
        return strokeShape('M3 12h18M6.5 8.5 3 12l3.5 3.5M17.5 8.5 21 12l-3.5 3.5');
      case 'size-nwse':
        return strokeShape('M5 5l14 14M5 10V5h5M19 14v5h-5');
      case 'size-nesw':
        return strokeShape('M19 5 5 19M14 5h5v5M10 19H5v-5');
      case 'size-all':
        return strokeShape('M12 3v18M3 12h18M9.5 5.5 12 3l2.5 2.5M9.5 18.5 12 21l2.5-2.5M5.5 9.5 3 12l2.5 2.5M18.5 9.5 21 12l-2.5 2.5');
      case 'no':
        return (
          <G>
            <Circle cx={12} cy={12} r={8} stroke={outline} strokeWidth={4.4} fill="none" />
            <Path d="M6.4 6.4l11.2 11.2" stroke={outline} strokeWidth={4.4} strokeLinecap="round" />
            <Circle cx={12} cy={12} r={8} stroke={fill} strokeWidth={2.2} fill="none" />
            <Path d="M6.4 6.4l11.2 11.2" stroke={fill} strokeWidth={2.2} strokeLinecap="round" />
          </G>
        );
      default:
        return <Path d={ARROW} fill={fill} stroke={outline} strokeWidth={1.4} strokeLinejoin="round" />;
    }
  })();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {body}
    </Svg>
  );
}

/**
 * Positioned pointer for the session surface. `x`/`y` are surface
 * coordinates of the hotspot; touches pass through.
 */
export default function CursorOverlay({
  x,
  y,
  shape,
  size,
  color,
  visible = true,
  pressed = false,
}: {
  x: number;
  y: number;
  shape: CursorShape;
  size: number;
  color: PointerColor;
  visible?: boolean;
  /** Shows a ring while the left button is held (drag). */
  pressed?: boolean;
}) {
  if (!visible) {
    return null;
  }
  const hot = cursorHotspot(shape, size);
  return (
    <View
      pointerEvents="none"
      style={[styles.anchor, {left: x - hot.x, top: y - hot.y, width: size, height: size}]}>
      {pressed ? (
        <View
          style={[
            styles.ring,
            {
              left: hot.x - size * 0.28,
              top: hot.y - size * 0.28,
              width: size * 0.56,
              height: size * 0.56,
              borderRadius: size * 0.28,
              borderColor: brand.copper,
            },
          ]}
        />
      ) : null}
      <CursorGlyph shape={shape} size={size} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: 'absolute',
  },
  ring: {
    position: 'absolute',
    borderWidth: 3,
    opacity: 0.85,
  },
});
