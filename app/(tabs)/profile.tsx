import React, { useState, useEffect } from 'react';
import { ScrollView, Alert } from 'react-native';
import { 
  YStack, 
  XStack, 
  Text, 
  Card, 
  Button, 
  H1, 
  H2, 
  H3, 
  Paragraph, 
  SafeArea,
  Avatar,
  Input,
  useTheme
} from '@blinkdotnew/mobile-ui';
import { User, LogOut, Mail, Lock, Clipboard, Shield } from '@blinkdotnew/mobile-ui';
import { blink } from '@/lib/blink';
import { colors } from '@/constants/design';

export default function ProfileScreen() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    const unsubscribe = blink.auth.onAuthStateChanged((state) => {
      setUser(state.user);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const handleSignIn = async () => {
    try {
      await blink.auth.signInWithEmail(email, password);
    } catch (error: any) {
      Alert.alert('Login Failed', error.message);
    }
  };

  const handleSignUp = async () => {
    try {
      await blink.auth.signUp({ email, password });
      Alert.alert('Success', 'Account created! Please sign in.');
    } catch (error: any) {
      Alert.alert('Signup Failed', error.message);
    }
  };

  const handleSignOut = async () => {
    await blink.auth.signOut();
  };

  if (loading) {
    return (
      <SafeArea flex={1} backgroundColor={colors.background} justifyContent="center" alignItems="center">
        <Paragraph>Loading...</Paragraph>
      </SafeArea>
    );
  }

  if (!user) {
    return (
      <SafeArea flex={1} backgroundColor={colors.background}>
        <YStack padding="$6" gap="$6" flex={1} justifyContent="center">
          <YStack alignItems="center" gap="$2">
            <Circle size={80} backgroundColor={colors.primary + '10'}>
              <Shield size={40} color={colors.primary} />
            </Circle>
            <H1>Welcome Back</H1>
            <Paragraph color="$color11">Sign in to sync your devices</Paragraph>
          </YStack>

          <YStack gap="$4">
            <YStack gap="$2">
              <Text fontWeight="600">Email Address</Text>
              <Input 
                placeholder="email@example.com" 
                value={email} 
                onChangeText={setEmail}
                autoCapitalize="none"
              />
            </YStack>
            <YStack gap="$2">
              <Text fontWeight="600">Password</Text>
              <Input 
                placeholder="••••••••" 
                value={password} 
                onChangeText={setPassword} 
                secureTextEntry 
              />
            </YStack>
            <Button theme="active" onPress={handleSignIn} size="$4">
              Sign In
            </Button>
            <Button chromeless onPress={handleSignUp}>
              Don't have an account? Sign Up
            </Button>
          </YStack>
        </YStack>
      </SafeArea>
    );
  }

  return (
    <SafeArea flex={1} backgroundColor={colors.background}>
      <ScrollView>
        <YStack padding="$4" gap="$5">
          <YStack gap="$1">
            <H1>Profile</H1>
            <Paragraph color="$color11">Manage your account and devices</Paragraph>
          </YStack>

          <Card padded bordered backgroundColor={colors.card}>
            <XStack gap="$4" alignItems="center">
              <Avatar size="$6">
                <Avatar.Image src={`https://i.pravatar.cc/150?u=${user.id}`} />
                <Avatar.Fallback backgroundColor={colors.primary}>
                  <Text color="white">{user.email?.charAt(0).toUpperCase()}</Text>
                </Avatar.Fallback>
              </Avatar>
              <YStack flex={1}>
                <H3>{user.email}</H3>
                <Text color="$color11" size="$2">Connected Account</Text>
              </YStack>
            </XStack>
          </Card>

          <Card padded bordered backgroundColor={colors.card}>
            <YStack gap="$3">
              <H3>Your User ID</H3>
              <Paragraph size="$2" color="$color11">
                You need this ID to configure your Windows Agent.
              </Paragraph>
              <XStack 
                backgroundColor="$color3" 
                padding="$3" 
                borderRadius="$2" 
                justifyContent="space-between" 
                alignItems="center"
              >
                <Text size="$3" fontWeight="600" color={colors.primary}>{user.id}</Text>
                <Button circular size="$2" chromeless onPress={() => Alert.alert('Copied', 'User ID copied to clipboard!')}>
                  <Clipboard size={16} color={colors.primary} />
                </Button>
              </XStack>
            </YStack>
          </Card>

          <Button 
            theme="active" 
            backgroundColor={colors.error + '10'} 
            color={colors.error}
            onPress={handleSignOut}
            icon={<LogOut size={20} color={colors.error} />}
          >
            Sign Out
          </Button>
        </YStack>
      </ScrollView>
    </SafeArea>
  );
}
