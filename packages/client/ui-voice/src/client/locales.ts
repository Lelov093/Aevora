/** Voice settings and read-aloud copy. */
import { providerSettingsEn, providerSettingsZh } from '@deepseek-ai/dsh-client-ui-primitives'

/** English copy, including the shared provider controls. */
export const en = {
  ...providerSettingsEn,
  title: 'Voice', synthesis: 'Speech synthesis', recognition: 'Speech recognition',
  description: 'Manage speech recognition and synthesis. Add online providers when needed; saving makes no request.',
  nativeName: 'Native voice input', legacyName: 'Existing Qwen configuration',
  asrHint: 'Enable native voice input to add online recognition here. Local model preparation remains a separate choice.',
  asrSettings: 'Open native voice input', provider: 'Provider: Alibaba Cloud Model Studio · Qwen',
  endpoint: 'Service endpoint (region-specific)', endpointHint: 'Full wss:// endpoint from your Model Studio workspace. The API key, model and voice must belong to the same region.',
  model: 'Model', modelHint: 'Recommended: qwen-audio-3.1-tts-flash. Only Qwen-Audio-TTS task protocol models are supported.',
  voice: 'Voice', voiceHint: 'Enter a voice supported by this model and region; the initial voice is a configurable example.',
  rate: 'Speaking rate', rateHint: '0.5–2; 1 is the normal rate.',
  apiKey: 'API key', apiKeyHint: 'Stored through Host credentials. Leave blank to keep the current key; the saved value is never returned.',
  keySet: 'A key is configured; connection and audio quality have not been verified.', keyUnset: 'No voice API key is configured.', keyUnknown: 'Credential status could not be read. Check the connection before saving.',
  save: 'Save', saving: 'Saving…', saveFailed: 'Settings were not accepted. Check the fields and connection.',
  unavailable: 'Voice settings are unavailable.', readOnly: 'This deployment stores settings read-only.',
  overridden: 'Overridden', reset: 'Reset', invalid: 'Enter a valid value.',
  read: 'Read aloud', stop: 'Stop reading', preparing: 'Synthesizing · stop reading',
  speechConfigurationFailed: 'No usable voice provider. Select and configure one in voice settings.',
  speechAuthenticationFailed: 'Voice authorization failed. Check the key and service region in voice settings.',
  speechNetworkFailed: 'The voice connection was lost. Reading stopped; check the connection.',
  speechProtocolFailed: 'The voice response could not be processed. Reading stopped; keep this notice for diagnosis.',
  speechProviderFailed: 'The voice service refused this read. Check its status and usage limits.',
  speechLimitFailed: 'Reading exceeded a resource limit and stopped. Check the speech resource configuration.',
  speechTimeoutFailed: 'The voice service did not finish in time. Reading stopped; check the connection and service status.',
  speechPlaybackFailed: 'Audio playback failed. Check the audio device and playback permission.',
  speechUnknownFailed: 'Reading stopped unexpectedly. Keep this notice for diagnosis; text generation is unaffected.',
  close: 'Dismiss',
  streamToggle: 'Read while generating',
  streamHint: 'Read new replies in this conversation. Starts with your next message.',
  streamEnabled: 'Reading new replies. Turn off to stop automatic speech.',
  streamUnavailable: 'Select a voice provider with streaming support in voice settings.',
  streamPartial: 'Partly played',
  streamPause: 'Pause reading', streamResume: 'Resume reading',
  streamPausedHint: 'Reading paused. Long pauses may reach the voice service or resource timeout.',
  streamRetried: 'The answer was retried, so speech stopped. You can read the completed reply manually.',
} as const

/** Typed voice dictionary keys. */
export type VoiceKey = keyof typeof en

/** Simplified Chinese copy. */
export const zh: Record<VoiceKey, string> = {
  ...providerSettingsZh,
  title: '语音', synthesis: '语音合成', recognition: '语音识别',
  description: '管理语音识别与合成，按需添加在线提供商；保存配置不会发起调用',
  nativeName: '原生语音输入', legacyName: '已有 Qwen 配置',
  asrHint: '启用原生语音输入插件后，可在此添加在线识别；本地模型按需单独准备',
  asrSettings: '打开原生语音输入', provider: '提供方：阿里云百炼 · Qwen',
  endpoint: '服务端点（对应地域）', endpointHint: '填写百炼工作空间的完整 wss:// 地址，密钥、模型与音色需匹配同一地域',
  model: '模型', modelHint: '推荐 qwen-audio-3.1-tts-flash，仅支持 Qwen-Audio-TTS 任务协议的模型',
  voice: '音色', voiceHint: '填写该模型与地域支持的音色，初始音色仅为可修改示例',
  rate: '语速', rateHint: '范围 0.5–2，1 为正常语速',
  apiKey: 'API Key', apiKeyHint: '通过原生凭据服务保存，留空保留现有密钥，已保存的值不会回显',
  keySet: '密钥已配置，尚不代表连接或听感已验证', keyUnset: '尚未配置语音 API Key', keyUnknown: '无法读取密钥状态，请检查连接后再保存',
  save: '保存', saving: '保存中…', saveFailed: '设置未保存，请检查输入与连接',
  unavailable: '语音设置暂不可用', readOnly: '当前设置为只读', overridden: '已覆盖', reset: '恢复默认', invalid: '请输入有效值',
  read: '朗读', stop: '停止朗读', preparing: '合成中 · 停止朗读', close: '关闭提示',
  streamToggle: '边生成边朗读',
  speechConfigurationFailed: '没有可用的语音提供商，请在语音设置中选择并配置',
  speechAuthenticationFailed: '语音服务认证失败，请检查语音设置中的密钥与服务地域',
  speechNetworkFailed: '语音连接已断开，朗读已停止，请检查连接',
  speechProtocolFailed: '语音响应无法处理，朗读已停止，请保留提示以便排查',
  speechProviderFailed: '语音服务拒绝了本次朗读，请检查服务状态与用量限制',
  speechLimitFailed: '本次朗读超过资源限制，语音已停止，请检查语音资源配置',
  speechTimeoutFailed: '语音服务未能及时完成，朗读已停止，请检查连接与服务状态',
  speechPlaybackFailed: '音频播放失败，请检查音频设备与播放权限',
  speechUnknownFailed: '朗读意外停止，请保留提示以便排查，文字生成不受影响',
  streamHint: '朗读当前会话的新回答，从你下一次发送消息开始生效',
  streamEnabled: '已开启新回答朗读，关闭即可停止自动播报',
  streamUnavailable: '请在语音设置中选择支持流式播报的提供商',
  streamPartial: '部分已播放',
  streamPause: '暂停朗读', streamResume: '继续朗读',
  streamPausedHint: '朗读已暂停，长时间暂停可能因语音服务或资源期限停止',
  streamRetried: '回答发生重试，语音已停止，完成后可手动朗读',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { voice: VoiceKey }
}
