import React from 'react';
import { ScrollView, Share, Platform } from 'react-native';
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
  Circle
} from '@blinkdotnew/mobile-ui';
import { Clipboard, Download, Check, Info, Server } from '@blinkdotnew/mobile-ui';
import { colors } from '@/constants/design';

const PYTHON_SCRIPT = `
import time
import os
import requests
import json
import subprocess

# --- CONFIGURATION ---
PROJECT_ID = "remote-pc-control-eous0gap"
SECRET_KEY = "REPLACE_WITH_YOUR_SECRET_KEY"
COMPUTER_ID = "my_pc_1" # Unique ID for this PC
COMPUTER_NAME = "Windows Desktop"
POLL_INTERVAL = 3 # Seconds

BASE_URL = f"https://api.blink.new/db/{PROJECT_ID}/rest/v1"
HEADERS = {
    "apikey": SECRET_KEY,
    "Authorization": f"Bearer {SECRET_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal"
}

def register_computer():
    print(f"Registering computer: {COMPUTER_NAME}...")
    data = {
        "id": COMPUTER_ID,
        "name": COMPUTER_NAME,
        "user_id": "YOUR_USER_ID" # You can get this from the app profile
    }
    try:
        requests.post(f"{BASE_URL}/computers?on_conflict=id", headers=HEADERS, json=data)
        print("Registration successful!")
    except Exception as e:
        print(f"Registration failed: {e}")

def execute_command(cmd_type):
    print(f"Executing command: {cmd_type}")
    if cmd_type == "lock":
        os.system("rundll32.exe user32.dll,LockWorkStation")
    elif cmd_type == "shutdown":
        os.system("shutdown /s /t 1")
    elif cmd_type == "hibernate":
        os.system("shutdown /h")
    elif cmd_type == "restart":
        os.system("shutdown /r /t 1")
    elif cmd_type == "volume_up":
        from ctypes import cast, POINTER
        from comtypes import CLSCTX_ALL
        from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
        devices = AudioUtilities.GetSpeakers()
        interface = devices.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
        volume = cast(interface, POINTER(IAudioEndpointVolume))
        current_volume = volume.GetMasterVolumeLevelScalar()
        volume.SetMasterVolumeLevelScalar(min(1.0, current_volume + 0.1), None)
    elif cmd_type == "volume_down":
        from ctypes import cast, POINTER
        from comtypes import CLSCTX_ALL
        from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
        devices = AudioUtilities.GetSpeakers()
        interface = devices.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
        volume = cast(interface, POINTER(IAudioEndpointVolume))
        current_volume = volume.GetMasterVolumeLevelScalar()
        volume.SetMasterVolumeLevelScalar(max(0.0, current_volume - 0.1), None)
    elif cmd_type == "mute":
        from ctypes import cast, POINTER
        from comtypes import CLSCTX_ALL
        from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
        devices = AudioUtilities.GetSpeakers()
        interface = devices.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
        volume = cast(interface, POINTER(IAudioEndpointVolume))
        volume.SetMute(not volume.GetMute(), None)
    elif cmd_type == "sound":
        # Plays a beep sound (Windows only)
        import winsound
        for _ in range(5):
            winsound.Beep(1000, 500)
            time.sleep(0.1)

def poll_commands():
    params = {
        "computer_id": f"eq.{COMPUTER_ID}",
        "status": "eq.pending",
        "select": "*"
    }
    try:
        response = requests.get(f"{BASE_URL}/commands", headers=HEADERS, params=params)
        if response.status_code == 200:
            commands = response.json()
            for cmd in commands:
                execute_command(cmd['type'])
                # Mark as completed
                requests.patch(
                    f"{BASE_URL}/commands?id=eq.{cmd['id']}", 
                    headers=HEADERS, 
                    json={"status": "completed"}
                )
    except Exception as e:
        print(f"Polling error: {e}")

if __name__ == "__main__":
    register_computer()
    print("Agent started. Listening for commands...")
    while True:
        poll_commands()
        time.sleep(POLL_INTERVAL)
`;

export default function SetupScreen() {
  const handleCopy = () => {
    // Clipboard handled by user via UI or Share
    Share.share({
      message: PYTHON_SCRIPT,
      title: 'Remote Control Agent Script'
    });
  };

  return (
    <SafeArea flex={1} backgroundColor={colors.background}>
      <ScrollView>
        <YStack padding="$4" gap="$5">
          <YStack gap="$1">
            <H1>Setup Guide</H1>
            <Paragraph color="$color11">Follow these steps to connect your Windows PC</Paragraph>
          </YStack>

          <Step 
            number={1} 
            title="Install Python" 
            description="Ensure you have Python 3.x installed on your Windows PC. You can download it from python.org." 
          />

          <Step 
            number={2} 
            title="Install Dependencies" 
            description="Open Command Prompt and run: pip install requests pycaw comtypes" 
          />

          <Step 
            number={3} 
            title="Download Agent Script" 
            description="Copy the script below and save it as 'agent.py' on your computer." 
          />

          <Card padded bordered backgroundColor={colors.card}>
            <YStack gap="$3">
              <XStack justifyContent="space-between" alignItems="center">
                <H3>Agent Script (Python)</H3>
                <Button size="$2" circular theme="active" onPress={handleCopy}>
                  <Clipboard size={16} color="white" />
                </Button>
              </XStack>
              <YStack backgroundColor="$color3" padding="$3" borderRadius="$2">
                <Text fontSize={10} fontFamily="monospace" color="$color11">
                  {PYTHON_SCRIPT.substring(0, 300)}...
                </Text>
              </YStack>
              <Paragraph size="$2" color="$color10">
                Tip: Replace 'YOUR_USER_ID' with your ID from the Profile tab.
              </Paragraph>
            </YStack>
          </Card>

          <Step 
            number={4} 
            title="Run the Agent" 
            description="Double-click agent.py or run 'python agent.py' in your terminal. Your PC will appear in the Controls tab instantly." 
          />

          <Card padded bordered backgroundColor={colors.info + '10'}>
            <XStack gap="$3">
              <Info color={colors.info} size={24} />
              <YStack flex={1}>
                <H3 color={colors.info}>Wake-on-LAN Note</H3>
                <Paragraph size="$2" color={colors.info}>
                  To turn on your PC remotely, ensure 'Wake on LAN' is enabled in your BIOS settings and the PC is connected via Ethernet.
                </Paragraph>
              </YStack>
            </XStack>
          </Card>
        </YStack>
      </ScrollView>
    </SafeArea>
  );
}

function Step({ number, title, description }: { number: number, title: string, description: string }) {
  return (
    <XStack gap="$4">
      <Circle size={32} backgroundColor={colors.primary}>
        <Text color="white" fontWeight="700">{number}</Text>
      </Circle>
      <YStack flex={1} gap="$1">
        <H3>{title}</H3>
        <Paragraph size="$2" color="$color11">{description}</Paragraph>
      </YStack>
    </XStack>
  );
}
