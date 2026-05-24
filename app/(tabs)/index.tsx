import React, { useState } from 'react';
import { ScrollView, RefreshControl, Alert } from 'react-native';
import { 
  YStack, 
  XStack, 
  Text, 
  Card, 
  Button, 
  H1, 
  H3, 
  Paragraph, 
  Theme, 
  Circle,
  useTheme,
  SafeArea,
  StatusBadge,
  BlinkDialog
} from '@blinkdotnew/mobile-ui';
import { Monitor, Power, Lock, RotateCcw, Volume2, Moon, Volume1, VolumeX } from '@blinkdotnew/mobile-ui';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { blink } from '@/lib/blink';
import { colors } from '@/constants/design';

type PCCommand = 'lock' | 'shutdown' | 'hibernate' | 'restart' | 'sound' | 'volume_up' | 'volume_down' | 'mute';

export default function ControlsScreen() {
  const queryClient = useQueryClient();
  const theme = useTheme();
  const [selectedPC, setSelectedPC] = useState<any>(null);

  const { data: computers, isLoading, refetch } = useQuery({
    queryKey: ['computers'],
    queryFn: async () => {
      const { user } = await blink.auth.me();
      if (!user) return [];
      return await blink.db.computers.list({
        where: { user_id: user.id }
      });
    }
  });

  const sendCommandMutation = useMutation({
    mutationFn: async ({ computerId, type }: { computerId: string, type: PCCommand }) => {
      return await blink.db.commands.create({
        id: crypto.randomUUID(),
        computer_id: computerId,
        type,
        status: 'pending'
      });
    },
    onSuccess: () => {
      Alert.alert('Success', 'Command sent successfully!');
    },
    onError: (error) => {
      Alert.alert('Error', 'Failed to send command. Please try again.');
      console.error(error);
    }
  });

  const handleCommand = (computer: any, type: PCCommand) => {
    const labels: Record<PCCommand, string> = {
      lock: 'Lock Screen',
      shutdown: 'Shutdown',
      hibernate: 'Hibernate',
      restart: 'Restart',
      sound: 'Play Sound',
      volume_up: 'Volume Up',
      volume_down: 'Volume Down',
      mute: 'Mute',
    };

    Alert.alert(
      'Confirm Action',
      `Are you sure you want to ${labels[type].toLowerCase()} on ${computer.name}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'Confirm', 
          onPress: () => sendCommandMutation.mutate({ computerId: computer.id, type }) 
        },
      ]
    );
  };

  if (isLoading) {
    return (
      <SafeArea flex={1} backgroundColor={colors.background} justifyContent="center" alignItems="center">
        <Paragraph>Loading your devices...</Paragraph>
      </SafeArea>
    );
  }

  return (
    <SafeArea flex={1} backgroundColor={colors.background}>
      <ScrollView 
        refreshControl={
          <RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={colors.primary} />
        }
      >
        <YStack padding="$4" gap="$4">
          <YStack gap="$1">
            <H1>Remote Control</H1>
            <Paragraph color="$color11">Control your Windows devices instantly</Paragraph>
          </YStack>

          {computers?.length === 0 ? (
            <Card padded bordered backgroundColor={colors.card}>
              <YStack alignItems="center" padding="$4" gap="$3">
                <Monitor size={48} color={colors.textTertiary} />
                <H3 textAlign="center">No devices found</H3>
                <Paragraph textAlign="center" color="$color11">
                  Connect your Windows PC by following the setup guide.
                </Paragraph>
              </YStack>
            </Card>
          ) : (
            computers?.map((pc: any) => (
              <Card key={pc.id} padded bordered backgroundColor={colors.card} elevation={2}>
                <YStack gap="$4">
                  <XStack justifyContent="space-between" alignItems="center">
                    <XStack gap="$3" alignItems="center">
                      <Circle size={40} backgroundColor={colors.primary + '20'}>
                        <Monitor size={20} color={colors.primary} />
                      </Circle>
                      <YStack>
                        <H3>{pc.name}</H3>
                        <XStack gap="$2" alignItems="center">
                          <Circle size={8} backgroundColor={colors.success} />
                          <Text size="$2" color="$color11">Online</Text>
                        </XStack>
                      </YStack>
                    </XStack>
                  </XStack>

                  <XStack flexWrap="wrap" gap="$3">
                    <ControlBtn 
                      icon={<Lock size={20} color="white" />} 
                      label="Lock" 
                      color={colors.primary}
                      onPress={() => handleCommand(pc, 'lock')}
                    />
                    <ControlBtn 
                      icon={<Power size={20} color="white" />} 
                      label="Shutdown" 
                      color={colors.error}
                      onPress={() => handleCommand(pc, 'shutdown')}
                    />
                    <ControlBtn 
                      icon={<Moon size={20} color="white" />} 
                      label="Hibernate" 
                      color={colors.warning}
                      onPress={() => handleCommand(pc, 'hibernate')}
                    />
                    <ControlBtn 
                      icon={<RotateCcw size={20} color="white" />} 
                      label="Restart" 
                      color={colors.info}
                      onPress={() => handleCommand(pc, 'restart')}
                    />
                    <ControlBtn 
                      icon={<Volume2 size={20} color="white" />} 
                      label="Find Me" 
                      color={colors.accent}
                      onPress={() => handleCommand(pc, 'sound')}
                    />
                    <ControlBtn 
                      icon={<Volume2 size={20} color="white" />} 
                      label="Vol Up" 
                      color={colors.success}
                      onPress={() => handleCommand(pc, 'volume_up')}
                    />
                    <ControlBtn 
                      icon={<Volume1 size={20} color="white" />} 
                      label="Vol Down" 
                      color={colors.success}
                      onPress={() => handleCommand(pc, 'volume_down')}
                    />
                    <ControlBtn 
                      icon={<VolumeX size={20} color="white" />} 
                      label="Mute" 
                      color={colors.textSecondary}
                      onPress={() => handleCommand(pc, 'mute')}
                    />
                  </XStack>
                </YStack>
              </Card>
            ))
          )}
        </YStack>
      </ScrollView>
    </SafeArea>
  );
}

function ControlBtn({ icon, label, color, onPress }: { icon: any, label: string, color: string, onPress: () => void }) {
  return (
    <Button 
      flex={1} 
      minWidth={100}
      backgroundColor={color} 
      onPress={onPress}
      paddingVertical="$3"
    >
      <YStack alignItems="center" gap="$1">
        {icon}
        <Text color="white" fontWeight="600" fontSize={12}>{label}</Text>
      </YStack>
    </Button>
  );
}
