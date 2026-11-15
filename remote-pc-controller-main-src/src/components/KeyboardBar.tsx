import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextInputKeyPressEventData,
  type ViewStyle,
} from 'react-native';

import {useTheme} from '../theme/ThemeProvider';
import {mix, shape, spacing, stateOpacity, typography} from '../theme/tokens';
import type {ModifierName} from '../lib/inputProtocol';
import AppIcon from './AppIcon';

interface KeyboardBarProps {
  /** Unicode text typed on the phone keyboard. */
  onText: (text: string) => void;
  /** Special key press; modifiers are the currently held sticky modifiers. */
  onKey: (code: string, modifiers: ModifierName[]) => void;
  /** Ctrl+Alt+Del (sent as a dedicated message so the agent can try SAS). */
  onCtrlAltDel: () => void;
  onClose: () => void;
  style?: StyleProp<ViewStyle>;
}

interface SpecialKey {
  code: string;
  label: string;
}

/** Modifier keys toggle a sticky state applied to the next key, then clear. */
const MODIFIER_KEYS: {label: string; modifier: ModifierName}[] = [
  {label: 'Ctrl', modifier: 'ctrl'},
  {label: 'Alt', modifier: 'alt'},
  {label: 'Shift', modifier: 'shift'},
  {label: 'Win', modifier: 'meta'},
];

const SPECIAL_KEYS: SpecialKey[] = [
  {code: 'Escape', label: 'Esc'},
  {code: 'Tab', label: 'Tab'},
  {code: 'ArrowLeft', label: '←'},
  {code: 'ArrowUp', label: '↑'},
  {code: 'ArrowDown', label: '↓'},
  {code: 'ArrowRight', label: '→'},
  {code: 'Backspace', label: '⌫'},
  {code: 'Delete', label: 'Del'},
  {code: 'Home', label: 'Home'},
  {code: 'End', label: 'End'},
  {code: 'PageUp', label: 'PgUp'},
  {code: 'PageDown', label: 'PgDn'},
  ...Array.from({length: 12}, (_, i) => ({code: `F${i + 1}`, label: `F${i + 1}`})),
];

/** Letters that make sense as a shortcut target after a sticky modifier. */
const SHORTCUT_KEYS = 'ACVXZYSFWTRL'.split('').map(letter => ({
  code: `Key${letter}`,
  label: letter,
}));

/**
 * Live keyboard: whatever is typed on the phone keyboard is sent to the PC
 * immediately (deletions become Backspace), plus a scrollable row of special
 * keys with sticky Ctrl / Alt / Shift / Win. While a modifier is armed the
 * row also offers common shortcut letters (Ctrl+C, Ctrl+V, …).
 */
export default function KeyboardBar({onText, onKey, onCtrlAltDel, onClose, style}: KeyboardBarProps) {
  const {palette} = useTheme();
  const [sticky, setSticky] = React.useState<ModifierName[]>([]);
  // A sentinel character keeps Backspace detectable on an "empty" field.
  const SENTINEL = ' ';
  const [value, setValue] = React.useState(SENTINEL);
  const inputRef = React.useRef<TextInput>(null);

  React.useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 150);
    return () => clearTimeout(timer);
  }, []);

  const toggleModifier = (modifier: ModifierName) => {
    setSticky(current =>
      current.includes(modifier) ? current.filter(m => m !== modifier) : [...current, modifier],
    );
  };

  const sendKey = (code: string) => {
    onKey(code, sticky);
    // Sticky modifiers apply to exactly one key press.
    if (sticky.length > 0) {
      setSticky([]);
    }
  };

  const handleChange = (next: string) => {
    const previous = value;
    if (next.startsWith(previous)) {
      const added = next.slice(previous.length);
      if (added) {
        if (sticky.length > 0 && added.length === 1 && /[a-z0-9]/i.test(added)) {
          // Armed modifier + single character → send as a shortcut.
          const code = /\d/.test(added) ? `Digit${added}` : `Key${added.toUpperCase()}`;
          sendKey(code);
        } else if (added === '\n') {
          sendKey('Enter');
        } else {
          onText(added);
        }
      }
    } else if (previous.startsWith(next)) {
      for (let i = 0; i < previous.length - next.length; i++) {
        onKey('Backspace', []);
      }
    } else {
      // Autocorrect replaced a word: erase the old tail, type the new one.
      let common = 0;
      while (common < next.length && common < previous.length && next[common] === previous[common]) {
        common++;
      }
      for (let i = 0; i < previous.length - common; i++) {
        onKey('Backspace', []);
      }
      if (next.length > common) {
        onText(next.slice(common));
      }
    }
    // Keep the buffer short; the PC is the source of truth for the text.
    setValue(next.length > 40 || next.length === 0 ? SENTINEL + next.slice(-8) : next);
  };

  const onKeyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    // The sentinel keeps a character to delete; this catches the edge case
    // where the field was emptied entirely.
    if (event.nativeEvent.key === 'Backspace' && value.length === 0) {
      onKey('Backspace', []);
    }
  };

  const keyStyle = (active: boolean) => ({pressed}: {pressed: boolean}) => [
    styles.key,
    {
      backgroundColor: active
        ? palette.primary
        : pressed
          ? mix(palette.textPrimary, palette.surfaceContainerHigh, stateOpacity.pressed)
          : palette.surfaceContainerHigh,
    },
  ];

  return (
    <View style={[styles.container, {backgroundColor: palette.surface, borderTopColor: palette.border}, style]}>
      <View style={styles.topRow}>
        <View style={[styles.liveField, {borderColor: palette.borderStrong, backgroundColor: palette.background}]}>
          <AppIcon name="keyboard" color={palette.textTertiary} size={18} />
          <TextInput
            ref={inputRef}
            style={[styles.input, {color: palette.textPrimary}]}
            value={value}
            onChangeText={handleChange}
            onKeyPress={onKeyPress}
            onSubmitEditing={() => sendKey('Enter')}
            submitBehavior="submit"
            returnKeyType="send"
            autoCorrect={false}
            autoCapitalize="none"
            spellCheck={false}
            selectionColor={palette.primary}
            accessibilityLabel="Type on the remote computer"
            placeholder="Type to send keys…"
            placeholderTextColor={palette.textTertiary}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hide keyboard"
          onPress={onClose}
          hitSlop={6}
          style={({pressed}) => [
            styles.close,
            {backgroundColor: pressed ? palette.surfaceContainerHigh : 'transparent'},
          ]}>
          <AppIcon name="chevron-down" color={palette.textSecondary} size={22} />
        </Pressable>
      </View>

      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.keyRow}>
        {MODIFIER_KEYS.map(key => {
          const active = sticky.includes(key.modifier);
          return (
            <Pressable
              key={key.modifier}
              accessibilityRole="button"
              accessibilityLabel={`${key.label} modifier`}
              accessibilityState={{selected: active}}
              onPress={() => toggleModifier(key.modifier)}
              style={keyStyle(active)}>
              <Text style={[styles.keyText, {color: active ? palette.onPrimary : palette.textPrimary}]}>
                {key.label}
              </Text>
            </Pressable>
          );
        })}
        <View style={[styles.separator, {backgroundColor: palette.border}]} />
        {(sticky.length > 0 ? [...SHORTCUT_KEYS, ...SPECIAL_KEYS] : SPECIAL_KEYS).map(key => (
          <Pressable
            key={key.code}
            accessibilityRole="button"
            accessibilityLabel={key.code}
            onPress={() => sendKey(key.code)}
            style={keyStyle(false)}>
            <Text style={[styles.keyText, {color: palette.textPrimary}]}>{key.label}</Text>
          </Pressable>
        ))}
        <View style={[styles.separator, {backgroundColor: palette.border}]} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Ctrl Alt Delete"
          onPress={onCtrlAltDel}
          style={keyStyle(false)}>
          <Text style={[styles.keyText, {color: palette.textPrimary}]}>Ctrl+Alt+Del</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth * 2,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm + 4,
    gap: spacing.xs,
  },
  liveField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: shape.full,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    height: 44,
  },
  input: {
    flex: 1,
    ...typography.bodyLarge,
    paddingVertical: 0,
  },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyRow: {
    paddingHorizontal: spacing.sm + 4,
    gap: 6,
    alignItems: 'center',
  },
  key: {
    minWidth: 44,
    paddingHorizontal: spacing.sm + 4,
    height: 40,
    borderRadius: shape.sm + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyText: {
    ...typography.labelLarge,
    fontWeight: '600',
  },
  separator: {
    width: 1,
    height: 24,
    marginHorizontal: 4,
  },
});
