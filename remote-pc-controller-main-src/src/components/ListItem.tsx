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

interface ListItemProps {
  title: string;
  subtitle?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

/** M3 list item row with optional leading/trailing content. */
export default function ListItem({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  style,
}: ListItemProps) {
  const {palette} = useTheme();

  const content = (
    <>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.textColumn}>
        <Text style={[styles.title, {color: palette.textPrimary}]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text
            style={[styles.subtitle, {color: palette.textSecondary}]}
            numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </>
  );

  if (!onPress) {
    return (
      <View style={[styles.row, style]}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({pressed}) => [
        styles.row,
        pressed
          ? {
              backgroundColor: mix(
                palette.textPrimary,
                palette.surface,
                stateOpacity.focus,
              ),
            }
          : undefined,
        style,
      ]}>
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: shape.md,
    gap: spacing.md,
  },
  leading: {
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textColumn: {
    flex: 1,
    gap: 2,
  },
  trailing: {
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  title: {
    ...typography.bodyLarge,
  },
  subtitle: {
    ...typography.bodyMedium,
  },
});
