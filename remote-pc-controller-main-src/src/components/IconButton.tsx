import React from 'react';
import {
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import {useTheme} from '../theme/ThemeProvider';
import {mix, stateOpacity} from '../theme/tokens';
import AppIcon, {type AppIconName} from './AppIcon';

interface IconButtonProps {
  /** Icon from the app set; alternatively pass custom children. */
  icon?: AppIconName;
  children?: React.ReactNode;
  /** Icon color; defaults to the secondary text color. */
  color?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Diameter of the touch target in dp. Defaults to 40. */
  size?: number;
  iconSize?: number;
  disabled?: boolean;
  /** Filled background (used for toggled-on toolbar buttons). */
  active?: boolean;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
}

/** Transparent circular icon button with a soft pressed state. */
export default function IconButton({
  icon,
  children,
  color,
  onPress,
  onLongPress,
  size = 40,
  iconSize = 20,
  disabled = false,
  active = false,
  accessibilityLabel,
  style,
}: IconButtonProps) {
  const {palette} = useTheme();
  const tint = color ?? palette.textSecondary;
  const base = active ? palette.surfaceContainerHigh : 'transparent';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{disabled, selected: active}}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={4}
      style={({pressed}) => [
        styles.button,
        {width: size, height: size, borderRadius: size / 2, backgroundColor: base},
        pressed && !disabled
          ? {backgroundColor: mix(palette.textPrimary, palette.surface, stateOpacity.pressed)}
          : undefined,
        disabled ? styles.disabled : undefined,
        style,
      ]}>
      {icon ? <AppIcon name={icon} color={tint} size={iconSize} /> : children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: stateOpacity.disabled,
  },
});
