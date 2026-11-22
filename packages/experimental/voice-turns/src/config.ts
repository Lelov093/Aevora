/** Explicit offline resource paths; activation never installs or loads models. */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

/** Validated deployment choices for managed VAD and endpoint inference. */
export interface Config {
  /** Whether the next continuous voice mode listens while its reply plays. */
  parallel: Volatile<boolean>
  /** Maximum concurrent recognition tasks, including an old task awaiting final text. */
  maxRecognitionTasks: number
  /** Deadline for one auxiliary semantic request; never determines user intent. */
  semanticTimeoutMs: number
  /** Maximum UTF-8 bytes in a semantic request snapshot. */
  maxContextBytes: number
  /** Maximum UTF-8 bytes retained from one semantic response. */
  maxJudgementBytes: number
  /** Absolute executable in the explicitly prepared project Python environment; empty disables inference. */
  pythonPath: Volatile<string>
  /** Absolute Smart Turn v3.1 CPU ONNX path matching the bundled reference preprocessing. */
  modelPath: Volatile<string>
  /** Absolute independently prepared sherpa-compatible Silero ONNX path. */
  vadModelPath: Volatile<string>
  /** Completion probability must exceed this threshold; it does not establish Chinese quality. */
  threshold: number
  /** Silero speech probability threshold. */
  vadThreshold: number
  /** Silence used to schedule endpoint inference, never to authorize submission alone. */
  silenceSeconds: Volatile<number>
  /** Minimum speech duration used by the VAD detector. */
  minSpeechSeconds: number
  /** CPU thread count for local inference. */
  threads: number
  /** Deadline for both managed processes to report successful model loading. */
  startupTimeoutMs: number
  /** Deadline for one local model command; failure pauses instead of submitting. */
  inferenceTimeoutMs: number
  /** Maximum gap between mode commands before local resources are released. */
  idleTimeoutMs: number
  /** Managed process termination grace period in milliseconds. */
  graceMs: number
  /** Maximum mono PCM16 samples in one authenticated input frame. */
  maxFrameSamples: number
  /** Maximum samples awaiting local VAD consumption. */
  maxPendingSamples: number
  /** Maximum worker reply and retained diagnostic bytes. */
  maxLogBytes: number
}

/** Absolute paths remain empty until resources have been prepared explicitly. */
export const Config = z.object({
  parallel: z.boolean().default(false).volatile(), maxRecognitionTasks: z.natural().min(2).max(8).default(2),
  semanticTimeoutMs: z.natural().min(100).max(120000).default(10000),
  maxContextBytes: z.natural().min(1024).max(1048576).default(32768),
  maxJudgementBytes: z.natural().min(128).max(65536).default(4096),
  pythonPath: z.string().pattern(/^(?:$|[A-Za-z]:[\\/]|\/|\\\\)/).default('').volatile(),
  modelPath: z.string().pattern(/^(?:$|(?=(?:[A-Za-z]:[\\/]|\/|\\\\)).*[\\/]smart-turn-v3\.1-cpu\.onnx$)/).default('').volatile(),
  vadModelPath: z.string().pattern(/^(?:$|[A-Za-z]:[\\/]|\/|\\\\)/).default('').volatile(),
  threshold: z.number().min(0).max(1).default(0.5), vadThreshold: z.number().min(0).max(1).default(0.5),
  silenceSeconds: z.number().min(0.1).max(5).default(0.5).volatile(), minSpeechSeconds: z.number().min(0).max(2).default(0.25),
  threads: z.natural().min(1).max(32).default(2), startupTimeoutMs: z.natural().min(1000).max(120000).default(30000),
  inferenceTimeoutMs: z.natural().min(100).max(30000).default(5000), idleTimeoutMs: z.natural().min(1000).max(120000).default(60000),
  graceMs: z.natural().min(1).max(10000).default(1000), maxFrameSamples: z.natural().min(128).max(1600).default(1600),
  maxPendingSamples: z.natural().min(1600).max(160000).default(32000), maxLogBytes: z.natural().min(128).max(65536).default(8192),
})
