import React from 'react';
import {ScrollView, Share, StyleSheet, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import Clipboard from '@react-native-clipboard/clipboard';

import {useTheme} from '../theme/ThemeProvider';
import {shape, spacing, typography} from '../theme/tokens';
import PrimaryButton from '../components/PrimaryButton';
import IconButton from '../components/IconButton';
import Toast, {useToast} from '../components/Toast';
import {ScreenHeader} from '../components/Header';
import type {RootStackParamList} from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

interface Step {
  title: string;
  body: string;
  /** Commands to run on the PC (Windows cmd syntax). */
  commands?: string[];
}

const STEPS: Step[] = [
  {
    title: 'Create your account',
    body: 'Account tab → Create account, then confirm your email. Every computer you pair belongs to this account.',
  },
  {
    title: 'Install Remote PC Host',
    body: 'On the Windows PC you want to reach (Node.js 20 or newer). No server to run — the host connects to the cloud on its own.',
    commands: ['cd agent', 'npm install', 'npm run desktop'],
  },
  {
    title: 'Get an access code',
    body: 'Computers tab → “Get a code”. The 6-digit code works once and expires after 5 minutes.',
  },
  {
    title: 'Pair the computer',
    body: 'Type the code into Remote PC Host and press Pair. Remote access turns on and the computer shows up online here.',
    commands: ['node src\\index.js pair     (command-line alternative)'],
  },
  {
    title: 'Connect',
    body: 'Tap the computer to see its screen and control it. Quick actions (lock, volume, screenshot…) work without opening a session.',
  },
];

export default function SetupScreen({navigation}: Props) {
  const {palette} = useTheme();
  const steps = STEPS;
  const {toast, notify} = useToast();

  const shareGuide = () => {
    const text = [
      'Remote PC — setup',
      '',
      ...steps.flatMap((step, index) => [
        `${index + 1}. ${step.title}`,
        `   ${step.body}`,
        ...(step.commands ?? []).map(command => `   > ${command}`),
        '',
      ]),
    ].join('\n');
    Share.share({message: text, title: 'Remote PC setup'}).catch(() => {
      // Share sheet dismissed.
    });
  };

  return (
    <SafeAreaView edges={['top', 'bottom']} style={[styles.root, {backgroundColor: palette.background}]}>
      <ScrollView contentContainerStyle={styles.body}>
        <ScreenHeader
          title="Setup guide"
          subtitle="Reach a Windows PC in five steps."
          onBack={() => navigation.goBack()}
        />

        <View style={styles.steps}>
          {steps.map((step, index) => {
            const last = index === steps.length - 1;
            return (
              <View key={step.title} style={styles.step}>
                <View style={styles.rail}>
                  <View style={[styles.badge, {borderColor: palette.accent}]}>
                    <Text style={[styles.badgeText, {color: palette.accent}]}>{index + 1}</Text>
                  </View>
                  {!last ? <View style={[styles.line, {backgroundColor: palette.border}]} /> : null}
                </View>
                <View style={[styles.stepBody, !last && styles.stepGap]}>
                  <Text style={[styles.stepTitle, {color: palette.textPrimary}]}>{step.title}</Text>
                  <Text style={[styles.stepText, {color: palette.textSecondary}]}>{step.body}</Text>
                  {step.commands ? (
                    <View
                      style={[
                        styles.code,
                        {backgroundColor: palette.surfaceContainer, borderColor: palette.border},
                      ]}>
                      <View style={styles.codeLines}>
                        {step.commands.map(command => (
                          <Text
                            key={command}
                            selectable
                            style={[styles.codeText, {color: palette.textPrimary}]}>
                            <Text style={{color: palette.textTertiary}}>{'> '}</Text>
                            {command}
                          </Text>
                        ))}
                      </View>
                      <IconButton
                        icon="copy"
                        size={36}
                        iconSize={18}
                        accessibilityLabel={`Copy commands for step ${index + 1}`}
                        onPress={() => {
                          Clipboard.setString(step.commands!.join('\n'));
                          notify('Commands copied', 'success');
                        }}
                      />
                    </View>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>

        <PrimaryButton label="Share these steps" icon="share" onPress={shareGuide} />
      </ScrollView>
      <Toast toast={toast} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  body: {
    padding: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
  },
  steps: {
    marginTop: spacing.sm,
  },
  step: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  rail: {
    alignItems: 'center',
    width: 32,
  },
  badge: {
    width: 32,
    height: 32,
    borderRadius: shape.full,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    ...typography.labelLarge,
    fontWeight: '700',
  },
  line: {
    flex: 1,
    width: 2,
    marginVertical: 4,
  },
  stepBody: {
    flex: 1,
    gap: spacing.xs,
    paddingTop: 4,
  },
  stepGap: {
    paddingBottom: spacing.lg,
  },
  stepTitle: {
    ...typography.titleMedium,
    fontSize: 17,
  },
  stepText: {
    ...typography.bodyMedium,
  },
  code: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: shape.md,
    borderWidth: 1,
    paddingLeft: spacing.md,
    paddingVertical: spacing.sm,
    paddingRight: spacing.xs,
    marginTop: spacing.xs,
  },
  codeLines: {
    flex: 1,
    gap: 2,
    paddingTop: 6,
  },
  codeText: {
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 20,
  },
});
