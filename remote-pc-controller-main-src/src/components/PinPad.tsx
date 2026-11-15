import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import {useTheme} from '../theme/ThemeProvider';
import {mix, shape, spacing, stateOpacity, typography} from '../theme/tokens';

interface PinPadProps {
  /** Current PIN digits, controlled by the parent. */
  value: string;
  onChange: (next: string) => void;
  /** Required PIN length. Defaults to 6. */
  length?: number;
  disabled?: boolean;
  /** Called once when the PIN reaches `length` digits. */
  onComplete?: (pin: string) => void;
  style?: StyleProp<ViewStyle>;
}

const DIGIT_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
];

/** Numeric keypad for PIN entry (used for device pairing). */
export default function PinPad({
  value,
  onChange,
  length = 6,
  disabled = false,
  onComplete,
  style,
}: PinPadProps) {
  const {palette} = useTheme();

  const press = (key: string) => {
    if (disabled) {
      return;
    }
    if (key === 'back') {
      onChange(value.slice(0, -1));
      return;
    }
    if (value.length >= length) {
      return;
    }
    const next = value + key;
    onChange(next);
    if (next.length === length) {
      onComplete?.(next);
    }
  };

  const keyStyle = ({pressed}: {pressed: boolean}) => [
    styles.key,
    {backgroundColor: palette.surfaceContainerHigh},
    pressed && !disabled
      ? {
          backgroundColor: mix(
            palette.textPrimary,
            palette.surfaceContainerHigh,
            stateOpacity.pressed,
          ),
        }
      : undefined,
  ];

  return (
    <View style={[styles.container, disabled && styles.disabled, style]}>
      <View style={styles.dotsRow}>
        {Array.from({length}, (_, index) => (
          <View
            key={index}
            style={[
              styles.dot,
              index < value.length
                ? {backgroundColor: palette.primary}
                : {
                    backgroundColor: 'transparent',
                    borderColor: palette.borderStrong,
                  },
            ]}
          />
        ))}
      </View>

      <View style={styles.grid}>
        {DIGIT_ROWS.map((row, rowIndex) => (
          <View key={rowIndex} style={styles.row}>
            {row.map(digit => (
              <Pressable
                key={digit}
                accessibilityRole="button"
                accessibilityLabel={`Digit ${digit}`}
                disabled={disabled}
                onPress={() => press(digit)}
                style={keyStyle}>
                <Text style={[styles.keyText, {color: palette.textPrimary}]}>
                  {digit}
                </Text>
              </Pressable>
            ))}
          </View>
        ))}

        <View style={styles.row}>
          <View style={styles.keySpacer} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Digit 0"
            disabled={disabled}
            onPress={() => press('0')}
            style={keyStyle}>
            <Text style={[styles.keyText, {color: palette.textPrimary}]}>0</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete last digit"
            disabled={disabled}
            onPress={() => press('back')}
            style={keyStyle}>
            <Text style={[styles.keyText, {color: palette.textPrimary}]}>⌫</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: spacing.lg,
  },
  disabled: {
    opacity: stateOpacity.disabled,
  },
  dotsRow: {
    flexDirection: 'row',
    gap: spacing.sm + 4,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
  },
  grid: {
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  keySpacer: {
    width: 72,
    height: 56,
  },
  key: {
    width: 72,
    height: 56,
    borderRadius: shape.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyText: {
    ...typography.titleLarge,
  },
});
