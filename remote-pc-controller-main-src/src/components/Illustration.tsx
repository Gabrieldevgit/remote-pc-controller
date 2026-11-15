import React from 'react';
import {StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import Svg, {Circle, Path, Rect} from 'react-native-svg';

import {useTheme} from '../theme/ThemeProvider';
import AppIcon from './AppIcon';

export type IllustrationKind = 'setup' | 'connect' | 'welcome';

interface IllustrationProps {
  kind: IllustrationKind;
  style?: StyleProp<ViewStyle>;
}

/**
 * Flat editorial illustration used at the top of feature cards: a laptop on
 * a tinted panel with two soft organic shapes. Pure palette fills — no
 * gradients — so it reads the same in light and dark mode.
 */
export function Illustration({kind, style}: IllustrationProps) {
  const {palette} = useTheme();
  const screen = kind === 'connect' ? palette.accent : palette.primaryContainer;
  const glyph = kind === 'connect' ? palette.onPrimary : palette.accent;

  return (
    <View style={[styles.art, {backgroundColor: palette.surfaceContainer}, style]}>
      <Svg width="100%" height="100%" viewBox="0 0 320 160" preserveAspectRatio="xMidYMid slice">
        {/* organic shapes */}
        <Path d="M-10 128 C 26 96, 74 112, 92 170 L -10 170 Z" fill={palette.accent} opacity={kind === 'connect' ? 0.35 : 0.9} />
        <Path d="M262 -8 C 318 -10, 336 44, 318 70 C 292 58, 258 36, 262 -8 Z" fill={palette.borderStrong} />
        <Circle cx={kind === 'welcome' ? 70 : 248} cy={kind === 'welcome' ? 34 : 30} r={4} fill={palette.accent} />
        {/* laptop */}
        <Rect x={104} y={36} width={112} height={74} rx={6} fill={palette.surface} stroke={palette.borderStrong} strokeWidth={2} />
        <Rect x={115} y={46} width={90} height={54} rx={3} fill={screen} />
        <Path d="M92 116 h136" stroke={palette.borderStrong} strokeWidth={4} strokeLinecap="round" />
        {kind === 'setup' ? (
          <>
            <Path d="M146 63 l12 9 -12 9 z" fill={glyph} />
            <Path d="M166 82 h18" stroke={glyph} strokeWidth={4} strokeLinecap="round" />
          </>
        ) : kind === 'connect' ? (
          <>
            <Circle cx={150} cy={73} r={6} fill="none" stroke={glyph} strokeWidth={3} />
            <Circle cx={172} cy={73} r={6} fill="none" stroke={glyph} strokeWidth={3} />
            <Path d="M156 73 h10" stroke={glyph} strokeWidth={3} strokeLinecap="round" />
          </>
        ) : (
          <>
            <Rect x={128} y={58} width={30} height={30} rx={4} fill={glyph} opacity={0.85} />
            <Path d="M166 64 h26 M166 74 h20 M166 84 h24" stroke={palette.borderStrong} strokeWidth={3} strokeLinecap="round" />
          </>
        )}
      </Svg>
    </View>
  );
}

/**
 * Organic badge shown next to each computer (online = copper, offline =
 * muted). The asymmetric corner radii give the soft "pebble" silhouette.
 */
export function DeviceBadge({online, size = 64}: {online: boolean; size?: number}) {
  const {palette} = useTheme();
  const bg = online ? palette.accent : palette.surfaceContainerHigh;
  const fg = online ? '#FFFFFF' : palette.textTertiary;
  return (
    <View
      style={{
        width: size,
        height: size * 0.88,
        backgroundColor: bg,
        borderTopLeftRadius: size * 0.5,
        borderTopRightRadius: size * 0.36,
        borderBottomRightRadius: size * 0.5,
        borderBottomLeftRadius: size * 0.3,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <AppIcon name="computer" color={fg} size={size * 0.42} />
    </View>
  );
}

const styles = StyleSheet.create({
  art: {
    height: 150,
    overflow: 'hidden',
  },
});
