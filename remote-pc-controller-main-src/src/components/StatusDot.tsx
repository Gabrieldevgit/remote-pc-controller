import React from 'react';
import {StyleSheet, Text, View, type StyleProp, type ViewStyle} from 'react-native';

import {useTheme} from '../theme/ThemeProvider';
import {spacing, typography} from '../theme/tokens';

export type StatusDotStatus = 'online' | 'offline' | 'connecting';

interface StatusDotProps {
  status: StatusDotStatus;
  /** Optional label rendered next to the dot; defaults to the status name. */
  label?: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
}

/** Small semantic status indicator: online / offline / connecting. */
export default function StatusDot({
  status,
  label,
  size = 8,
  style,
}: StatusDotProps) {
  const {palette} = useTheme();

  const color =
    status === 'online'
      ? palette.success.base
      : status === 'connecting'
        ? palette.warning.base
        : palette.textTertiary;

  return (
    <View style={[styles.row, style]}>
      <View style={[styles.dot, {backgroundColor: color, width: size, height: size}]} />
      <Text style={[styles.label, {color: palette.textSecondary}]}>
        {label ?? status}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  dot: {
    borderRadius: 9999,
  },
  label: {
    ...typography.labelMedium,
  },
});
