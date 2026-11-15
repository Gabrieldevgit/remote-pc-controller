import React from 'react';
import {
  ActivityIndicator,
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

interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  /** 'error' renders the destructive tone. */
  tone?: 'primary' | 'error';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
  icon?: AppIconName;
}

/** Filled pill button in the copper accent (or the error tone). */
export default function PrimaryButton({
  label,
  onPress,
  tone = 'primary',
  disabled = false,
  loading = false,
  style,
  labelStyle,
  icon,
}: PrimaryButtonProps) {
  const {palette} = useTheme();

  const container = tone === 'error' ? palette.error.base : palette.primary;
  const content = tone === 'error' ? palette.error.onBase : palette.onPrimary;
  const inactive = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled: inactive, busy: loading}}
      disabled={inactive}
      onPress={onPress}
      style={({pressed}) => [
        styles.button,
        {
          backgroundColor:
            pressed && !inactive
              ? mix(content, container, stateOpacity.pressed)
              : container,
          opacity: disabled && !loading ? stateOpacity.disabled : 1,
        },
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={content} />
      ) : (
        <>
          {icon ? <AppIcon name={icon} color={content} size={18} /> : null}
          <Text style={[styles.label, {color: content}, labelStyle]} numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
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
  label: {
    ...typography.labelLarge,
    fontSize: 15,
    fontWeight: '600',
  },
});
