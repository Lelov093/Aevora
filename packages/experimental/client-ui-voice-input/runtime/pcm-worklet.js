/** Private standalone AudioWorklet, served only through the authenticated fixed resource route. */
class AevoraPcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const { frameSamples, maxPendingSamples } = options.processorOptions
    this.frame = new Int16Array(frameSamples)
    this.capacity = maxPendingSamples
    this.at = 0
    this.sent = 0
    this.accepted = 0
    this.ended = false
    this.mode = 'live'
    this.request = undefined
    this.held = new Int16Array(maxPendingSamples)
    this.heldAt = 0
    this.port.onmessage = ({ data }) => {
      if (this.ended) return
      if (data.kind === 'credit') {
        if (!Number.isSafeInteger(data.samples) || data.samples < this.accepted || data.samples > this.sent) return this.fail()
        this.accepted = data.samples
      } else if (['park', 'checkpoint', 'lock'].includes(data.kind)) {
        if (this.request || (data.kind === 'park' ? this.mode !== 'live' : this.mode !== 'parked')) return this.fail()
        this.request = data.kind
        this.barrier()
      } else if (data.kind === 'resume') {
        if (this.request || this.mode === 'live') return this.fail()
        const held = this.held.slice(0, this.heldAt)
        this.heldAt = 0
        for (const sample of held) {
          this.frame[this.at++] = sample
          if (this.at === this.frame.length && !this.flush()) return
        }
        if (this.at > 0 && !this.flush()) return
        this.mode = 'live'
        this.port.postMessage({ kind: 'resumed', samples: this.sent })
      } else if (data.kind === 'commit') {
        if (this.mode !== 'frozen' || this.request) return this.fail()
        this.heldAt = 0; this.ended = true
        this.port.postMessage({ kind: 'finished', samples: this.sent })
      } else if (data.kind === 'finish') {
        if (this.mode !== 'live' || this.request) return this.fail()
        if (this.at > 0 && !this.flush()) return
        this.ended = true
        this.port.postMessage({ kind: 'finished', samples: this.sent })
      }
    }
  }

  barrier() {
    // Silero consumes real 512-sample windows; recoverable checks never pad its state.
    if (!this.request || (this.sent + this.at) % 512 !== 0) return true
    if (this.at > 0 && !this.flush()) return false
    const request = this.request
    this.request = undefined
    if (request === 'park') this.mode = 'parked'
    if (request === 'lock') this.mode = 'frozen'
    this.port.postMessage({ kind: request === 'park' ? 'parked' : request === 'lock' ? 'locked' : 'checkpointed', samples: this.sent })
    return true
  }

  fail() {
    this.ended = true
    this.port.postMessage({ kind: 'overflow' })
    return false
  }

  flush() {
    if (this.sent - this.accepted + this.at + this.heldAt > this.capacity) return this.fail()
    const pcm = this.frame.slice(0, this.at)
    const startSample = this.sent
    this.sent += this.at
    this.at = 0
    this.port.postMessage({ kind: this.mode === 'live' ? 'audio' : 'staged', startSample, pcm }, [pcm.buffer])
    return true
  }

  process(inputs) {
    if (this.ended) return false
    const channels = inputs[0]
    if (!channels || channels.length === 0) return true
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0
      for (const channel of channels) value += channel[i]
      value = Math.max(-1, Math.min(1, value / channels.length))
      const pcm = Math.round(value * (value < 0 ? 32768 : 32767))
      if (this.mode === 'frozen') {
        if (this.sent - this.accepted + this.heldAt >= this.capacity) return this.fail()
        this.held[this.heldAt++] = pcm
        continue
      }
      this.frame[this.at++] = pcm
      if (this.at === this.frame.length && !this.flush()) return false
      if (!this.barrier()) return false
    }
    return true
  }
}

registerProcessor('aevora-pcm-capture', AevoraPcmCapture)
