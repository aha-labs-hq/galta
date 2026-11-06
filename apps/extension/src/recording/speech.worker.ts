import { prepareSpeechAudio } from '@galta/capture'

self.onmessage = (event: MessageEvent<Float32Array>) => {
  try {
    const audio = prepareSpeechAudio(event.data)
    self.postMessage({ audio }, { transfer: [audio.wav.buffer] })
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Audio preparation failed.' }) }
}
