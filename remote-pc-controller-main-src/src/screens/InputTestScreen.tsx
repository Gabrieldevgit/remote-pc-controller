/**
 * Debug builds only: checks the phone-host gestures on this device without a
 * PC. The buttons make RemoteControlService (accessibility) perform the same
 * gestures a PC sends — a tap, a long press (live finger held), a swipe —
 * on the targets below, and the counters show what Android recognised.
 */
import React from 'react';
import {
  PixelRatio,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  NativeModules,
  useWindowDimensions,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import {useTheme} from '../theme/ThemeProvider';
import {shape, spacing, typography} from '../theme/tokens';
import {ScreenHeader} from '../components/Header';
import SecondaryButton from '../components/SecondaryButton';
import {debugInput, refreshAccessibility, usePhoneHostStore} from '../lib/phoneHost';
import type {RootStackParamList} from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'InputTest'>;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export default function InputTestScreen({navigation}: Props) {
  const {palette} = useTheme();
  const accessibility = usePhoneHostStore(s => s.accessibility);
  const {width} = useWindowDimensions();
  const [taps, setTaps] = React.useState(0);
  const [longs, setLongs] = React.useState(0);
  const [page, setPage] = React.useState(0);
  const [log, setLog] = React.useState<string[]>([]);
  const target = React.useRef<View>(null);
  const pager = React.useRef<View>(null);

  React.useEffect(() => {
    void refreshAccessibility();
  }, []);

  const note = (line: string) => setLog(l => [line, ...l].slice(0, 8));

  /** Centre of a view in 0..1 screen coordinates (what the PC sends). */
  const centre = (ref: React.RefObject<View | null>) =>
    new Promise<{x: number; y: number} | null>(resolve => {
      ref.current?.measureInWindow(async (x, y, w, h) => {
        const info = await NativeModules.PhoneHost?.getDisplayInfo?.();
        if (!info) {
          resolve(null);
          return;
        }
        const ratio = PixelRatio.get();
        const top = StatusBar.currentHeight ?? 0;
        resolve({
          x: ((x + w / 2) * ratio) / info.width,
          y: ((y + h / 2 + top) * ratio) / info.height,
        });
      });
    });

  const testTap = async () => {
    const c = await centre(target);
    if (c) {
      note(`tap at ${c.x.toFixed(3)}, ${c.y.toFixed(3)}`);
      debugInput.tap(c.x, c.y);
    }
  };
  const testLong = async () => {
    const c = await centre(target);
    if (c) {
      note('long press (live finger, 900 ms)');
      debugInput.touch('down', c.x, c.y);
      await sleep(900);
      debugInput.touch('up', c.x, c.y);
    }
  };
  const testSwipe = async () => {
    const c = await centre(pager);
    if (c) {
      note('swipe left (live finger)');
      debugInput.touch('down', c.x + 0.3, c.y);
      for (let i = 1; i <= 10; i++) {
        await sleep(16);
        debugInput.touch('move', c.x + 0.3 - i * 0.06, c.y);
      }
      debugInput.touch('up', c.x - 0.3, c.y);
    }
  };

  const reset = () => {
    setTaps(0);
    setLongs(0);
    setLog([]);
  };

  return (
    <SafeAreaView edges={['top']} style={[styles.root, {backgroundColor: palette.background}]}>
      <ScrollView contentContainerStyle={styles.content}>
        <ScreenHeader title="Input test" subtitle="Debug builds only" onBack={() => navigation.goBack()} />
        <Text style={[styles.body, {color: accessibility ? palette.textSecondary : palette.error.base}]}>
          {accessibility
            ? 'Accessibility service is on. Each button performs a real gesture on the targets below.'
            : 'Turn on Remote PC in Settings → Accessibility first.'}
        </Text>

        <View
          ref={target}
          collapsable={false}
          style={[styles.target, {borderColor: palette.borderStrong, backgroundColor: palette.surface}]}>
          <Pressable
            testID="input-target"
            onPress={() => setTaps(n => n + 1)}
            onLongPress={() => setLongs(n => n + 1)}
            style={styles.fill}>
            <Text style={[styles.big, {color: palette.textPrimary}]}>Taps: {taps}</Text>
            <Text style={[styles.big, {color: palette.textPrimary}]}>Long presses: {longs}</Text>
          </Pressable>
        </View>

        <View ref={pager} collapsable={false} style={[styles.pager, {borderColor: palette.borderStrong}]}>
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={e => setPage(Math.round(e.nativeEvent.contentOffset.x / Math.max(1, e.nativeEvent.layoutMeasurement.width)))}>
            {[0, 1, 2].map(i => (
              <View key={i} style={[styles.page, {width: width - spacing.md * 2 - 2}]}>
                <Text style={[styles.big, {color: palette.textPrimary}]}>Page {i + 1}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
        <Text style={[styles.body, {color: palette.textSecondary}]}>Current page: {page + 1}</Text>

        <View style={styles.buttons}>
          <SecondaryButton label="Tap" onPress={() => void testTap()} />
          <SecondaryButton label="Long press" onPress={() => void testLong()} />
          <SecondaryButton label="Swipe" onPress={() => void testSwipe()} />
          <SecondaryButton label="Reset" variant="text" onPress={reset} />
        </View>
        {log.map((line, i) => (
          <Text key={i} style={[styles.small, {color: palette.textTertiary}]}>{line}</Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  content: {padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl},
  body: {...typography.bodyMedium},
  small: {...typography.bodySmall},
  big: {...typography.titleLarge},
  target: {height: 200, borderWidth: 2, borderRadius: shape.lg},
  fill: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm},
  pager: {height: 140, borderWidth: 2, borderRadius: shape.lg, overflow: 'hidden'},
  page: {height: 136, alignItems: 'center', justifyContent: 'center'},
  buttons: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
});

