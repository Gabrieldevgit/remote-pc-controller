import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import {useTheme} from '../theme/ThemeProvider';
import {mix, shape, spacing, stateOpacity, typography} from '../theme/tokens';
import AppIcon, {type AppIconName} from './AppIcon';

interface SecondaryButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
  icon?: AppIconName;
  /**
   * 'outlined' (default): bordered pill. 'text': borderless, accent label.
   * 'danger': bordered pill with the error tone label.
   */
  variant?: 'outlined' | 'text' | 'danger';
}

/** Quiet companion to PrimaryButton: outlined or text-only pill. */
export default function SecondaryButton({
  label,
  onPress,
  disabled = false,
  style,
  labelStyle,
  icon,
  variant = 'outlined',
}: SecondaryButtonProps) {
  const {palette} = useTheme();
  const content =
    variant === 'text'
      ? palette.primary
      : variant === 'danger'
        ? palette.error.base
        : palette.textPrimary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled}}
      disabled={disabled}
      onPress={onPress}
      style={({pressed}) => [
        styles.button,
        variant !== 'text' && {borderWidth: 1, borderColor: palette.borderStrong},
        variant === 'text' && styles.textVariant,
        {
          backgroundColor:
            pressed && !disabled
              ? mix(content, palette.surface, stateOpacity.hover)
              : 'transparent',
          opacity: disabled ? stateOpacity.disabled : 1,
        },
        style,
      ]}>
      {icon ? <AppIcon name={icon} color={content} size={18} /> : null}
      <Text style={[styles.label, {color: content}, labelStyle]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: shape.full,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  textVariant: {
    paddingHorizontal: spacing.md,
  },
  label: {
    ...typography.labelLarge,
    fontSize: 15,
    fontWeight: '600',
  },
});
