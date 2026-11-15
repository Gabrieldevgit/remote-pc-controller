import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import {useTheme} from '../theme/ThemeProvider';
import {spacing, typography} from '../theme/tokens';

interface SectionHeaderProps {
  title: string;
  /** Optional trailing action text, e.g. 'See all'. */
  action?: string;
  onActionPress?: () => void;
  style?: StyleProp<ViewStyle>;
  titleStyle?: StyleProp<TextStyle>;
}

/** Quiet sentence-case section label ("Remote devices", "This device"). */
export default function SectionHeader({
  title,
  action,
  onActionPress,
  style,
  titleStyle,
}: SectionHeaderProps) {
  const {palette} = useTheme();

  return (
    <View style={[styles.row, style]}>
      <Text
        accessibilityRole="header"
        style={[styles.title, {color: palette.textSecondary}, titleStyle]}
        numberOfLines={1}>
        {title}
      </Text>
      {action && onActionPress ? (
        <Pressable accessibilityRole="button" onPress={onActionPress} hitSlop={8}>
          {({pressed}) => (
            <Text
              style={[styles.action, {color: palette.primary, opacity: pressed ? 0.7 : 1}]}>
              {action}
            </Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  title: {
    ...typography.titleSmall,
    fontWeight: '600',
    flexShrink: 1,
  },
  action: {
    ...typography.labelLarge,
    fontWeight: '600',
  },
});
