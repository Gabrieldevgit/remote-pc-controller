import React from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import {useTheme} from '../theme/ThemeProvider';
import {shape, spacing, typography} from '../theme/tokens';

interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  hint?: string;
  error?: string | null;
  style?: StyleProp<ViewStyle>;
  monospace?: boolean;
}

/** Labelled outlined input; the border turns copper while focused. */
const TextField = React.forwardRef<TextInput, TextFieldProps>(function TextField(
  {label, hint, error, style, monospace, onFocus, onBlur, ...inputProps},
  ref,
) {
  const {palette} = useTheme();
  const [focused, setFocused] = React.useState(false);
  const borderColor = error
    ? palette.error.base
    : focused
      ? palette.primary
      : palette.borderStrong;

  return (
    <View style={[styles.field, style]}>
      <Text style={[styles.label, {color: palette.textSecondary}]}>{label}</Text>
      <TextInput
        ref={ref}
        {...inputProps}
        accessibilityLabel={label}
        placeholderTextColor={palette.textTertiary}
        selectionColor={palette.primary}
        onFocus={event => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={event => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[
          styles.input,
          monospace && styles.mono,
          {
            borderColor,
            borderWidth: focused || error ? 2 : 1,
            paddingHorizontal: focused || error ? spacing.md - 1 : spacing.md,
            color: palette.textPrimary,
            backgroundColor: palette.background,
          },
        ]}
      />
      {error ? (
        <Text style={[styles.hint, {color: palette.error.base}]}>{error}</Text>
      ) : hint ? (
        <Text style={[styles.hint, {color: palette.textTertiary}]}>{hint}</Text>
      ) : null}
    </View>
  );
});

export default TextField;

const styles = StyleSheet.create({
  field: {
    gap: 6,
  },
  label: {
    ...typography.labelLarge,
    fontWeight: '600',
  },
  input: {
    ...typography.bodyLarge,
    minHeight: 50,
    borderRadius: shape.md,
    paddingVertical: 12,
  },
  mono: {
    fontFamily: 'monospace',
    letterSpacing: 0,
  },
  hint: {
    ...typography.bodySmall,
  },
});
