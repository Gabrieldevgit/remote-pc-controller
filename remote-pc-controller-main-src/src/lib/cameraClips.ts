/**
 * Webcam clips recorded on the PC (quick action "Record video") arrive as
 * MP4 files in private Storage. They are downloaded through a short-lived
 * signed link, copied to the public Downloads/Remote PC folder and can be
 * played with the phone's own video player — no extra native module.
 */
import {Platform} from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';

export interface SavedClip {
  /** Where the user finds it ("Downloads/Remote PC/…"). */
  location: string;
  /** Local copy used to open the clip in a player. */
  localPath: string;
}

export async function saveCameraClip(signedUrl: string, fileName: string): Promise<SavedClip> {
  const name = fileName.replace(/[\\/:*?"<>|]/g, '_');
  const res = await ReactNativeBlobUtil.config({fileCache: true, appendExt: 'mp4'}).fetch('GET', signedUrl);
  const status = res.info().status;
  if (status !== 200) {
    await ReactNativeBlobUtil.fs.unlink(res.path()).catch(() => {});
    throw new Error('The video could not be downloaded.');
  }
  const localPath = res.path();
  if (Platform.OS === 'android') {
    await ReactNativeBlobUtil.MediaCollection.copyToMediaStore(
      {name, parentFolder: 'Remote PC', mimeType: 'video/mp4'},
      'Download',
      localPath,
    );
    return {location: `Downloads/Remote PC/${name}`, localPath};
  }
  const dest = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/${name}`;
  await ReactNativeBlobUtil.fs.cp(localPath, dest);
  return {location: `Files › Remote PC › ${name}`, localPath: dest};
}

/** Open a saved clip in the phone's video player. */
export function playClip(localPath: string) {
  if (Platform.OS === 'android') {
    return ReactNativeBlobUtil.android.actionViewIntent(localPath, 'video/mp4');
  }
  return ReactNativeBlobUtil.ios.openDocument(localPath);
}
