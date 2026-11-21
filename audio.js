import { sha256 } from './registry.js';

async function openAudioStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('voice-rights-audio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('submissions');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开浏览器音频存储'));
  });
}

async function audioTransaction(mode, operation) {
  const database = await openAudioStore();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('submissions', mode);
      const request = operation(transaction.objectStore('submissions'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(new Error('音频读写失败，请检查浏览器空间后重试'));
    });
  } finally {
    database.close();
  }
}

export const storeAudio = (id, file) => audioTransaction('readwrite', store => store.put(file, id));
export const findAudio = id => audioTransaction('readonly', store => store.get(id));
export const removeAudio = id => audioTransaction('readwrite', store => store.delete(id));

export async function fingerprint(file) {
  if (!file?.size) throw new Error('请选择非空音频文件');
  if (file.type && !file.type.startsWith('audio/') && !/\.(wav|mp3|m4a|aac|ogg|flac|opus|webm)$/i.test(file.name)) {
    throw new Error('请选择音频文件');
  }
  return sha256(await file.arrayBuffer());
}

export function sampleAudio(version) {
  const sampleRate = 16000;
  const samples = sampleRate;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const header = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const encoder = new TextEncoder();
  bytes.set(encoder.encode('RIFF'), 0);
  header.setUint32(4, buffer.byteLength - 8, true);
  bytes.set(encoder.encode('WAVEfmt '), 8);
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  bytes.set(encoder.encode('data'), 36);
  header.setUint32(40, samples * 2, true);
  const frequency = version === 'v2' ? 550 : 440;
  for (let index = 0; index < samples; index++) {
    const envelope = Math.sin(Math.PI * index / samples);
    const value = 5000 * envelope * Math.sin(2 * Math.PI * frequency * index / sampleRate);
    header.setInt16(44 + index * 2, value, true);
  }
  return new File([buffer], `演示样音-${version}.wav`, { type: 'audio/wav' });
}
