/** Silero execution stays outside the Host; no recognizer or model download is created. */
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
const { Vad } = createRequire(import.meta.url)('sherpa-onnx-node')
const config = JSON.parse(process.argv[2])
const detector = new Vad({ sileroVad: { model: config.vadModelPath, threshold: config.vadThreshold,
  minSilenceDuration: config.silenceSeconds, minSpeechDuration: config.minSpeechSeconds,
  maxSpeechDuration: 120, windowSize: 512 }, sampleRate: 16000, numThreads: config.threads, provider: 'cpu', debug: 0 }, 9)
const reply = value => process.stdout.write(`${JSON.stringify(value)}\n`)
reply({ ready: true })
let receivedSamples = 0
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line)
  if (command.kind === 'reset') { detector.reset(); receivedSamples = 0; reply({ speaking: false, ended: false }); continue }
  if (command.kind === 'flush') {
    const tail = receivedSamples % 512
    if (tail) detector.acceptWaveform(new Float32Array(512 - tail))
    reply({ speaking: detector.isDetected(), ended: false }); continue
  }
  const pcm = Buffer.from(command.audioBase64, 'base64')
  const samples = Float32Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2) / 32768)
  receivedSamples += samples.length
  detector.acceptWaveform(samples)
  const speaking = detector.isDetected()
  let ended = false
  while (!detector.isEmpty()) { ended = true; detector.pop() }
  reply({ speaking, ended })
}
