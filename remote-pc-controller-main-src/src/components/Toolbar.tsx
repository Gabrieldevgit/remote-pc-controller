import React from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import {useTheme} from '../theme/ThemeProvider';
import {typography} from '../theme/tokens';
import AppIcon from './AppIcon';
import IconButton from './IconButton';

interface ToolbarProps {
  title: string;
  /** When provided, a back button is rendered on the leading edge. */
  onBack?: () => void;
  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** M3 top app bar with optional back action and trailing content. */
export default function Toolbar({title, onBack, trailing, style}: ToolbarProps) {
  const {palette} = useTheme();

  return (
    <View style={[styles.bar, {backgroundColor: palette.surface}, style]}>
      {onBack ? (
        <IconButton onPress={onBack} accessibilityLabel="Back">
          <AppIcon name="arrow-back" color={palette.textPrimary} />
        </IconButton>
      ) : null}
      <Text style={[styles.title, {color: palette.textPrimary}]} numberOfLines={1}>
        {title}
      </Text>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    gap: 4,
  },
  title: {
    ...typography.titleLarge,
    flex: 1,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
});
