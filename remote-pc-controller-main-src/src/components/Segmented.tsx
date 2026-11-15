import React from 'react';
import {Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle} from 'react-native';

import {useTheme} from '../theme/ThemeProvider';
import {shape, typography} from '../theme/tokens';

interface SegmentedProps<T extends string> {
  options: {value: T; label: string}[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}

/** Single-choice segmented control: outlined track, solid selected segment. */
export default function Segmented<T extends string>({
  options,
  value,
  onChange,
  style,
}: SegmentedProps<T>) {
  const {palette} = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      style={[styles.track, {borderColor: palette.borderStrong}, style]}>
      {options.map(option => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{selected: active}}
            onPress={() => onChange(option.value)}
            style={[
              styles.segment,
              active ? {backgroundColor: palette.textPrimary} : undefined,
            ]}>
            <Text
              numberOfLines={1}
              style={[
                styles.label,
                {color: active ? palette.background : palette.textSecondary},
              ]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    borderRadius: shape.full,
    borderWidth: 1,
    padding: 3,
    gap: 2,
  },
  segment: {
    flex: 1,
    minHeight: 36,
    borderRadius: shape.full,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  label: {
    ...typography.labelLarge,
    fontWeight: '600',
  },
});
