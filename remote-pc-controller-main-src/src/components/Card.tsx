import React from 'react';
import {StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';

import {useTheme} from '../theme/ThemeProvider';
import {elevation, shape, spacing} from '../theme/tokens';

interface CardProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Whether to apply the default inner padding. Defaults to true. */
  padded?: boolean;
}

/** Flat surface card: 1px border, rounded 16, a barely-there shadow. */
export default function Card({children, style, padded = true}: CardProps) {
  const {palette} = useTheme();

  return (
    <View
      style={[
        styles.card,
        palette.mode === 'light' ? elevation.level1 : undefined,
        {backgroundColor: palette.surface, borderColor: palette.border},
        padded && styles.padded,
        style,
      ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: shape.lg,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  padded: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
});
