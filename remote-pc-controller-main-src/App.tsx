import React from 'react';
import {StatusBar, StyleSheet, View} from 'react-native';
import {
  NavigationContainer,
  DefaultTheme,
  type Theme as NavigationTheme,
} from '@react-navigation/native';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {SafeAreaProvider, useSafeAreaInsets} from 'react-native-safe-area-context';

import DevicesScreen from './src/screens/DevicesScreen';
import RemoteSessionScreen from './src/screens/RemoteSessionScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import SupportScreen from './src/screens/SupportScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import SetupScreen from './src/screens/SetupScreen';
import {ThemeProvider, useTheme} from './src/theme/ThemeProvider';
import {bindRelay} from './src/lib/relayBootstrap';
import type {RootStackParamList, TabParamList} from './src/navigation/types';
import AppIcon, {type AppIconName} from './src/components/AppIcon';

const Tab = createBottomTabNavigator<TabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

const TAB_META: Record<keyof TabParamList, {label: string; icon: AppIconName}> = {
  Devices: {label: 'Computers', icon: 'devices'},
  Support: {label: 'Support', icon: 'connect'},
  Settings: {label: 'Settings', icon: 'settings'},
  Profile: {label: 'Account', icon: 'person'},
};

function MainTabs() {
  const {palette} = useTheme();
  // A fixed height overrides the navigator's own inset handling, so add the
  // gesture-bar / home-indicator inset explicitly.
  const insets = useSafeAreaInsets();

  return (
    <Tab.Navigator
      screenOptions={({route}) => ({
        headerShown: false,
        tabBarLabel: TAB_META[route.name].label,
        tabBarActiveTintColor: palette.textPrimary,
        tabBarInactiveTintColor: palette.textTertiary,
        tabBarLabelStyle: {fontSize: 12, fontWeight: '600'},
        tabBarStyle: {
          backgroundColor: palette.surface,
          borderTopColor: palette.border,
          borderTopWidth: StyleSheet.hairlineWidth * 2,
          elevation: 0,
          height: 64 + insets.bottom,
          paddingTop: 6,
          paddingBottom: insets.bottom + 6,
        },
        tabBarIcon: ({color, focused}) => (
          <View
            style={[
              styles.tabIcon,
              focused && {backgroundColor: palette.primaryContainer},
            ]}>
            <AppIcon
              name={TAB_META[route.name].icon}
              color={focused ? palette.onPrimaryContainer : color}
              size={20}
            />
          </View>
        ),
      })}>
      <Tab.Screen name="Devices" component={DevicesScreen} />
      <Tab.Screen name="Support" component={SupportScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

function RootNavigator() {
  const {palette, mode} = useTheme();

  React.useEffect(() => {
    // One-time wiring: relay <-> stores, hydration, connection.
    bindRelay();
  }, []);

  const navigationTheme: NavigationTheme = {
    ...DefaultTheme,
    dark: mode === 'dark',
    colors: {
      ...DefaultTheme.colors,
      primary: palette.primary,
      background: palette.background,
      card: palette.surface,
      text: palette.textPrimary,
      border: palette.border,
      notification: palette.primary,
    },
  };

  return (
    <View style={[styles.root, {backgroundColor: palette.background}]}>
      <NavigationContainer theme={navigationTheme}>
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            contentStyle: {backgroundColor: palette.background},
            animation: 'slide_from_right',
          }}>
          <Stack.Screen name="Tabs" component={MainTabs} />
          <Stack.Screen
            name="RemoteSession"
            component={RemoteSessionScreen}
            options={{
              orientation: 'portrait',
              animation: 'fade',
            }}
          />
          <Stack.Screen name="Setup" component={SetupScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar
        barStyle={mode === 'dark' ? 'light-content' : 'dark-content'}
        backgroundColor={palette.background}
      />
    </View>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider>
          <RootNavigator />
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  tabIcon: {
    width: 56,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
