// Webcam capture: a still photo (JPEG) or a short video clip (MP4, no sound)
// from the PC's default camera, through the built-in Windows.Media.Capture
// API driven from PowerShell — no native modules.
//
// Only the account that owns the PC can ask for this (device_commands RLS),
// never a Remote Support helper. Windows turns the camera light on while it
// is in use, and "Let desktop apps access your camera" must be allowed in
// Settings → Privacy & security → Camera.

import fs from 'node:fs';
import path from 'node:path';
import { SCREENSHOT_DIR } from './config.js';
import { runScript } from './powershell.js';

export const CAMERA_MAX_SECONDS = 30;
export const CAMERA_DEFAULT_SECONDS = 10;
const VIDEO_BITRATE = 2_000_000; // ≈ 7.5 MB for 30 s at 720p

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$dir = '__DIR__'
$name = '__NAME__'
$mode = '__MODE__'
$seconds = __SECONDS__
$bitrate = __BITRATE__

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$methods = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskOp = $methods | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' } | Select-Object -First 1
$asTaskAction = $methods | Where-Object { $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function Await($op, [Type]$type) {
  $task = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$task.Wait(-1)
  return $task.Result
}
function AwaitAction($action) {
  $task = $asTaskAction.Invoke($null, @($action))
  [void]$task.Wait(-1)
}

[void][Windows.Media.Capture.MediaCapture, Windows.Media.Capture, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Media.MediaProperties.MediaEncodingProfile, Windows.Media.MediaProperties, ContentType = WindowsRuntime]
[void][Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
[void][Windows.Media.MediaProperties.VideoEncodingQuality, Windows.Media.MediaProperties, ContentType = WindowsRuntime]
[void][Windows.Media.MediaProperties.ImageEncodingProperties, Windows.Media.MediaProperties, ContentType = WindowsRuntime]

$cameras = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync([Windows.Devices.Enumeration.DeviceClass]::VideoCapture)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
if ($cameras.Count -eq 0) { throw 'NO_CAMERA' }

$settings = New-Object Windows.Media.Capture.MediaCaptureInitializationSettings
$settings.StreamingCaptureMode = [Windows.Media.Capture.StreamingCaptureMode]::Video
$settings.VideoDeviceId = $cameras[0].Id
$capture = New-Object Windows.Media.Capture.MediaCapture
try {
  AwaitAction ($capture.InitializeAsync($settings))
} catch {
  throw ('INIT_FAILED ' + $_.Exception.InnerException.Message)
}
try {
  $folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($dir)) ([Windows.Storage.StorageFolder])
  $file = Await ($folder.CreateFileAsync($name, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
  if ($mode -eq 'photo') {
    # Give auto-exposure a moment so the first frame is not dark.
    Start-Sleep -Milliseconds 800
    $props = [Windows.Media.MediaProperties.ImageEncodingProperties]::CreateJpeg()
    AwaitAction ($capture.CapturePhotoToStorageFileAsync($props, $file))
  } else {
    $encoding = [Windows.Media.MediaProperties.MediaEncodingProfile]::CreateMp4([Windows.Media.MediaProperties.VideoEncodingQuality]::HD720p)
    $encoding.Audio = $null
    $encoding.Video.Bitrate = $bitrate
    AwaitAction ($capture.StartRecordToStorageFileAsync($encoding, $file))
    Start-Sleep -Seconds $seconds
    AwaitAction ($capture.StopRecordAsync())
  }
} finally {
  $capture.Dispose()
}
Write-Output ('OK ' + $cameras[0].Name)
`;

function friendlyError(err) {
  const text = `${err?.stderr ?? ''} ${err?.message ?? err}`;
  if (text.includes('NO_CAMERA')) return 'No camera was found on this PC.';
  if (/INIT_FAILED.*(denied|0x80070005)|access is denied/i.test(text)) {
    return 'Windows blocked the camera. On the PC, allow "Let desktop apps access your camera" in Settings → Privacy & security → Camera.';
  }
  if (text.includes('INIT_FAILED')) return 'The camera could not be started (it may be in use by another app).';
  if (err?.killed) return 'The camera did not respond in time.';
  // PowerShell puts the useful line in stderr; the exception text is just
  // "Command failed: powershell.exe …".
  const detail = String(err?.stderr ?? '').split('\n').map((l) => l.trim()).find(Boolean)
    ?? String(err?.message ?? err).split('\n')[0];
  return `Camera capture failed: ${detail.slice(0, 200)}`;
}

async function capture(mode, seconds) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = mode === 'photo' ? `camera-${stamp}.jpg` : `camera-${stamp}.mp4`;
  // Only fixed or validated values are substituted into the script.
  const script = SCRIPT
    .replace('__DIR__', SCREENSHOT_DIR.replace(/'/g, "''"))
    .replace('__NAME__', name)
    .replace('__MODE__', mode)
    .replace('__SECONDS__', String(seconds))
    .replace('__BITRATE__', String(VIDEO_BITRATE));
  let out;
  try {
    out = await runScript(script, { timeoutMs: (seconds + 30) * 1000 });
  } catch (err) {
    throw new Error(friendlyError(err));
  }
  const file = path.join(SCREENSHOT_DIR, name);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    throw new Error('The camera produced no picture.');
  }
  const camera = (out.match(/OK (.*)/)?.[1] ?? '').trim().slice(0, 80);
  return { path: file, camera, size: fs.statSync(file).size };
}

/** Take one photo with the default webcam. */
export function cameraPhoto() {
  return capture('photo', 0);
}

/** Record a silent clip of 1–30 seconds with the default webcam. */
export function cameraRecord(seconds = CAMERA_DEFAULT_SECONDS) {
  const s = Math.max(1, Math.min(CAMERA_MAX_SECONDS, Math.floor(Number(seconds)) || CAMERA_DEFAULT_SECONDS));
  return capture('record', s).then((r) => ({ ...r, seconds: s }));
}
