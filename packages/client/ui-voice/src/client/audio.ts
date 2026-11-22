/** Shared PCM conversion for explicit complete and incremental playback. */

/** Decode mono PCM16-LE into the browser's audio representation.
 * @param audio - destination context.
 * @param encoded - base64 PCM, not a compressed audio container.
 * @param sampleRate - provider sample rate.
 * @returns a buffer retaining the original sample count.
 */
export function decodePcm(audio: AudioContext, encoded: string, sampleRate: number): AudioBuffer {
  const bytes = atob(encoded)
  if (!bytes.length || bytes.length % 2 || !Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error('Invalid PCM audio')
  const buffer = audio.createBuffer(1, bytes.length / 2, sampleRate)
  const samples = buffer.getChannelData(0)
  for (let index = 0; index < samples.length; index++) {
    const value = bytes.charCodeAt(index * 2) | bytes.charCodeAt(index * 2 + 1) << 8
    samples[index] = (value >= 32768 ? value - 65536 : value) / 32768
  }
  return buffer
}
