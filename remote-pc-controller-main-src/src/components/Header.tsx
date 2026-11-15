import React from 'react';
import {Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle} from 'react-native';

import {useTheme} from '../theme/ThemeProvider';
import {shape, spacing, typography} from '../theme/tokens';
import AppIcon from './AppIcon';
import IconButton from './IconButton';

/** Square copper mark with a monitor glyph — the app's logo. */
export function BrandMark({size = 30}: {size?: number}) {
  const {palette} = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        backgroundColor: palette.accent,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <AppIcon name="computer" color="#FFFFFF" size={size * 0.58} />
    </View>
  );
}

/**
 * Top app bar for the main tabs: logo + wordmark on the left, the account
 * avatar on the right (initial on a slate disc).
 */
export function AppBar({
  email,
  onAvatarPress,
}: {
  email: string | null;
  onAvatarPress?: () => void;
}) {
  const {palette} = useTheme();
  const initial = email ? email.trim().charAt(0).toUpperCase() : null;
  return (
    <View style={[styles.appBar, {borderBottomColor: palette.border}]}>
      <BrandMark />
      <Text style={[styles.wordmark, {color: palette.textPrimary}]}>
        Remote PC
      </Text>
      <View style={styles.spacer} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={email ? `Account ${email}` : 'Sign in'}
        onPress={onAvatarPress}
        hitSlop={6}
        style={({pressed}) => [
          styles.avatar,
          {
            backgroundColor: initial ? palette.surfaceContainerHigh : 'transparent',
            borderColor: palette.borderStrong,
            borderWidth: initial ? 0 : 1,
            opacity: pressed ? 0.8 : 1,
          },
        ]}>
        {initial ? (
          <Text style={[styles.avatarText, {color: palette.textPrimary}]}>{initial}</Text>
        ) : (
          <AppIcon name="person" color={palette.textSecondary} size={18} />
        )}
      </Pressable>
    </View>
  );
}

/** Large page title with optional back button, subtitle and trailing slot. */
export function ScreenHeader({
  title,
  subtitle,
  onBack,
  trailing,
  style,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const {palette} = useTheme();
  return (
    <View style={[styles.screenHeader, style]}>
      {onBack ? (
        <IconButton
          icon="arrow-back"
          color={palette.textPrimary}
          accessibilityLabel="Back"
          onPress={onBack}
          style={styles.back}
        />
      ) : null}
      <View style={styles.titleRow}>
        <Text
          accessibilityRole="header"
          style={[styles.title, {color: palette.textPrimary}]}>
          {title}
        </Text>
        {trailing}
      </View>
      {subtitle ? (
        <Text style={[styles.subtitle, {color: palette.textSecondary}]}>{subtitle}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  appBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    height: 60,
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
  },
  wordmark: {
    ...typography.titleLarge,
    fontWeight: '600',
    fontSize: 20,
  },
  spacer: {flex: 1},
  avatar: {
    width: 36,
    height: 36,
    borderRadius: shape.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    ...typography.titleMedium,
    fontWeight: '600',
  },
  screenHeader: {
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  back: {
    marginLeft: -spacing.sm,
    marginBottom: spacing.xs,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  title: {
    ...typography.headlineLarge,
    flexShrink: 1,
  },
  subtitle: {
    ...typography.bodyLarge,
  },
});
