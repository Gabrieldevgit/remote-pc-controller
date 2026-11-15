import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {useTheme} from '../theme/ThemeProvider';
import {shape, spacing, typography, withAlpha} from '../theme/tokens';
import {
  RESOLUTION_LIMITS,
  RESOLUTION_PRESETS,
  isValidSize,
  sizeLabel,
  type Size,
  type StreamResolution,
} from '../lib/resolution';
import TextField from './TextField';
import PrimaryButton from './PrimaryButton';

/**
 * Stream resolution list: Auto, presets (only those the PC can deliver once
 * its native size is known) and Custom width × height.
 */
export default function ResolutionPicker({
  value,
  onChange,
  native,
}: {
  value: StreamResolution;
  onChange: (next: StreamResolution) => void;
  /** The PC's real screen size, when connected. */
  native?: Size | null;
}) {
  const {palette} = useTheme();
  const [customOpen, setCustomOpen] = React.useState(value.mode === 'custom');
  const [w, setW] = React.useState(value.mode === 'custom' && value.width ? String(value.width) : '');
  const [h, setH] = React.useState(value.mode === 'custom' && value.height ? String(value.height) : '');
  const [error, setError] = React.useState<string | null>(null);

  const presets = React.useMemo(() => {
    const list = native
      ? RESOLUTION_PRESETS.filter(p => p.width <= native.width && p.height <= native.height)
      : RESOLUTION_PRESETS;
    if (native && !list.some(p => p.width === native.width && p.height === native.height)) {
      return [native, ...list];
    }
    return list;
  }, [native]);

  const option = (key: string, title: string, subtitle: string | null, selected: boolean, onPress: () => void) => (
    <Pressable
      key={key}
      accessibilityRole="radio"
      accessibilityState={{selected}}
      onPress={onPress}
      style={({pressed}) => [
        styles.option,
        {borderColor: selected ? palette.primary : palette.border},
        selected && {backgroundColor: withAlpha(palette.primary, 0.1)},
        pressed && {opacity: 0.8},
      ]}>
      <View style={[styles.radio, {borderColor: selected ? palette.primary : palette.borderStrong}]}>
        {selected ? <View style={[styles.radioDot, {backgroundColor: palette.primary}]} /> : null}
      </View>
      <View style={styles.optionText}>
        <Text style={[styles.optionTitle, {color: palette.textPrimary}]}>{title}</Text>
        {subtitle ? <Text style={[styles.optionSub, {color: palette.textSecondary}]}>{subtitle}</Text> : null}
      </View>
    </Pressable>
  );

  const applyCustom = () => {
    const width = Number(w);
    const height = Number(h);
    if (!isValidSize(width, height)) {
      setError(
        `Width ${RESOLUTION_LIMITS.minWidth}–${RESOLUTION_LIMITS.maxWidth}, height ${RESOLUTION_LIMITS.minHeight}–${RESOLUTION_LIMITS.maxHeight}.`,
      );
      return;
    }
    setError(null);
    onChange({mode: 'custom', width, height});
  };

  return (
    <View style={styles.list}>
      {option(
        'auto',
        'Auto',
        'Fits this phone’s screen and lowers itself on a slow connection.',
        value.mode === 'auto',
        () => {
          setCustomOpen(false);
          onChange({mode: 'auto'});
        },
      )}
      <View style={styles.grid}>
        {presets.map(p => {
          const selected = value.mode === 'preset' && value.width === p.width && value.height === p.height;
          const isNative = native != null && p.width === native.width && p.height === native.height;
          return (
            <View key={sizeLabel(p)} style={styles.gridCell}>
              {option(sizeLabel(p), sizeLabel(p), isNative ? 'Native' : null, selected, () => {
                setCustomOpen(false);
                onChange({mode: 'preset', width: p.width, height: p.height});
              })}
            </View>
          );
        })}
      </View>
      {option('custom', 'Custom', value.mode === 'custom' ? `${value.width} × ${value.height}` : 'Choose a width and height', value.mode === 'custom' || customOpen, () => setCustomOpen(true))}
      {customOpen ? (
        <View style={styles.custom}>
          <View style={styles.customFields}>
            <TextField label="Width" value={w} onChangeText={t => setW(t.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" style={styles.customField} />
            <TextField label="Height" value={h} onChangeText={t => setH(t.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" style={styles.customField} />
          </View>
          {error ? <Text style={[styles.optionSub, {color: palette.error.base}]}>{error}</Text> : null}
          <PrimaryButton label="Use this size" onPress={applyCustom} />
        </View>
      ) : null}
      <Text style={[styles.note, {color: palette.textSecondary}]}>
        The PC keeps its own resolution; the picture keeps the PC screen’s shape and is never enlarged beyond it.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  list: {gap: spacing.sm},
  grid: {flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -spacing.xs / 2},
  gridCell: {width: '50%', padding: spacing.xs / 2},
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: shape.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    minHeight: 48,
  },
  radio: {width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center'},
  radioDot: {width: 10, height: 10, borderRadius: 5},
  optionText: {flex: 1},
  optionTitle: {...typography.bodyLarge, fontWeight: '600', fontVariant: ['tabular-nums']},
  optionSub: {...typography.bodySmall},
  custom: {gap: spacing.sm},
  customFields: {flexDirection: 'row', gap: spacing.md},
  customField: {flex: 1},
  note: {...typography.bodySmall, marginTop: spacing.xs},
});
