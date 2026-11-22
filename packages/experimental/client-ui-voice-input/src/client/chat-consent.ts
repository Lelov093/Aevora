/** Browser-side approval of continuous voice for the selected speech provider. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'

/** Build one consent record for the mounted plugin and this browser profile. */
export function createChatConsent() {
  const approved = new Set<SpeechProviderId>()
  const persisted = createSnapshotStore<readonly string[]>([], {
    persist: { name: 'dsh.voice-input.chat-consent.v1' },
  })
  const remembered = () => {
    const saved = persisted.getSnapshot()
    return Array.isArray(saved) ? saved.filter(id => typeof id === 'string') : []
  }
  return {
    has: (id: SpeechProviderId) => approved.has(id) || remembered().includes(id),
    confirm(id: SpeechProviderId, remember: boolean): void {
      approved.add(id)
      if (!remember) return
      const previous = remembered()
      if (!previous.includes(id)) persisted.set([...previous, id])
    },
  }
}
