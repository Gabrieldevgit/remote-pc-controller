import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';

import {useTheme} from '../theme/ThemeProvider';
import {mix, shape, spacing, stateOpacity, typography} from '../theme/tokens';
import type {InputMessage, PointerButton} from '../lib/inputProtocol';

interface TrackpadPanelProps {
  /** Sends an input message over the session data channel. */
  send: (message: InputMessage) => void;
  /** Fires a short haptic pulse when the setting is enabled. */
  haptic: () => void;
  style?: StyleProp<ViewStyle>;
}

/** Multiplier applied to one-finger deltas before they are sent. */
const POINTER_SENSITIVITY = 1.4;
/** Pixels of two-finger travel per wheel notch. */
const SCROLL_NOTCH_PX = 40;

/**
 * Laptop-style trackpad docked at the bottom of the session.
 *
 * - one-finger drag  -> relative pointer move
 * - tap              -> left click
 * - two-finger tap   -> right click
 * - two-finger drag  -> wheel scroll
 * - hold, then drag  -> left-button drag
 *
 * Every gesture callback runs on the JS thread (`runOnJS(true)`): they call
 * plain JS functions and mutate a ref, neither of which is allowed from a
 * UI-thread worklet.
 */
export default function TrackpadPanel({send, haptic, style}: TrackpadPanelProps) {
  const {palette} = useTheme();

  // Latest callbacks without rebuilding the gesture graph each render.
  const sendRef = React.useRef(send);
  const hapticRef = React.useRef(haptic);
  sendRef.current = send;
  hapticRef.current = haptic;

  const gesture = React.useMemo(() => {
    const state = {
      dragging: false,
      lastX: 0,
      lastY: 0,
      scrollRemainderX: 0,
      scrollRemainderY: 0,
      moved: false,
    };
    const emit = (message: InputMessage) => sendRef.current(message);
    const click = (button: PointerButton) => {
      hapticRef.current();
      emit({t: 'click', button});
    };
    const releaseDrag = () => {
      if (state.dragging) {
        state.dragging = false;
        emit({t: 'button', button: 'left', down: false});
      }
    };

    const pan = Gesture.Pan()
      .runOnJS(true)
      .minPointers(1)
      .maxPointers(2)
      .averageTouches(true)
      .onBegin(event => {
        state.lastX = event.absoluteX;
        state.lastY = event.absoluteY;
        state.scrollRemainderX = 0;
        state.scrollRemainderY = 0;
        state.moved = false;
      })
      .onUpdate(event => {
        const dxRaw = event.absoluteX - state.lastX;
        const dyRaw = event.absoluteY - state.lastY;
        state.lastX = event.absoluteX;
        state.lastY = event.absoluteY;
        if (event.numberOfPointers >= 2) {
          // Two-finger scroll: accumulate travel, emit whole wheel notches.
          state.scrollRemainderX += dxRaw;
          state.scrollRemainderY += dyRaw;
          const notchX = Math.trunc(state.scrollRemainderX / SCROLL_NOTCH_PX) * SCROLL_NOTCH_PX;
          const notchY = Math.trunc(state.scrollRemainderY / SCROLL_NOTCH_PX) * SCROLL_NOTCH_PX;
          if (notchX !== 0 || notchY !== 0) {
            state.scrollRemainderX -= notchX;
            state.scrollRemainderY -= notchY;
            emit({t: 'wheel', dx: -notchX, dy: -notchY});
          }
          state.moved = true;
          return;
        }
        const dx = dxRaw * POINTER_SENSITIVITY;
        const dy = dyRaw * POINTER_SENSITIVITY;
        if (dx !== 0 || dy !== 0) {
          state.moved = true;
          // While a long-press drag is active the left button is already
          // held down; only the movement is streamed.
          emit({t: 'pointer.move', dx, dy});
        }
      })
      .onFinalize(releaseDrag);

    const longPress = Gesture.LongPress()
      .runOnJS(true)
      .minDuration(400)
      .maxDistance(12)
      .onStart(() => {
        state.dragging = true;
        hapticRef.current();
        emit({t: 'button', button: 'left', down: true});
      });

    const oneFingerTap = Gesture.Tap()
      .runOnJS(true)
      .maxDuration(250)
      .onEnd((_event, success) => {
        if (success && !state.moved && !state.dragging) {
          click('left');
        }
      });

    const twoFingerTap = Gesture.Tap()
      .runOnJS(true)
      .minPointers(2)
      .maxDuration(300)
      .onEnd((_event, success) => {
        if (success) {
          click('right');
        }
      });

    return Gesture.Simultaneous(pan, longPress, Gesture.Exclusive(twoFingerTap, oneFingerTap));
  }, []);

  const buttonStyle = ({pressed}: {pressed: boolean}) => [
    styles.clickButton,
    pressed && {
      backgroundColor: mix(palette.textPrimary, palette.surfaceContainerHigh, stateOpacity.pressed),
    },
  ];

  return (
    <View
      style={[
        styles.panel,
        {backgroundColor: palette.surfaceContainerHigh, borderColor: palette.borderStrong},
        style,
      ]}>
      <GestureDetector gesture={gesture}>
        <View style={styles.surface} accessibilityLabel="Trackpad">
          <Text style={[styles.hint, {color: palette.textTertiary}]}>
            Drag to move · tap to click · two fingers to scroll or right-click · hold to drag
          </Text>
        </View>
      </GestureDetector>
      <View style={[styles.clickRow, {borderTopColor: palette.borderStrong}]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Left click"
          onPress={() => {
            haptic();
            send({t: 'click', button: 'left'});
          }}
          style={buttonStyle}
        />
        <View style={[styles.clickDivider, {backgroundColor: palette.borderStrong}]} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Right click"
          onPress={() => {
            haptic();
            send({t: 'click', button: 'right'});
          }}
          style={buttonStyle}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    height: 210,
    marginHorizontal: spacing.sm,
    marginBottom: spacing.sm,
    borderRadius: shape.lg + 4,
    borderWidth: StyleSheet.hairlineWidth * 2,
    overflow: 'hidden',
  },
  surface: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  hint: {
    ...typography.labelSmall,
    textAlign: 'center',
  },
  clickRow: {
    height: 52,
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth * 2,
  },
  clickButton: {
    flex: 1,
  },
  clickDivider: {
    width: StyleSheet.hairlineWidth * 2,
  },
});
