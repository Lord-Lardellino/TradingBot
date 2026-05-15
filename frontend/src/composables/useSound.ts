import { ref } from 'vue'

const audioCtx = ref<AudioContext | null>(null)
export const soundEnabled = ref(true)

// Browser requires a user gesture before AudioContext can play
// Call this once on a button click to "arm" audio
export function armAudio() {
  if (!audioCtx.value) {
    audioCtx.value = new AudioContext()
  }
  if (audioCtx.value.state === 'suspended') {
    audioCtx.value.resume()
  }
}

function beep(frequency: number, duration: number, volume: number, type: OscillatorType = 'sine') {
  if (!soundEnabled.value || !audioCtx.value) return
  const ctx = audioCtx.value
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.connect(gain)
  gain.connect(ctx.destination)

  osc.type = type
  osc.frequency.setValueAtTime(frequency, ctx.currentTime)
  gain.gain.setValueAtTime(volume, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)

  osc.start(ctx.currentTime)
  osc.stop(ctx.currentTime + duration)
}

export function useSound() {
  function playPump() {
    // Ascending alert — two quick rising tones
    beep(660, 0.15, 0.4, 'sine')
    setTimeout(() => beep(880, 0.25, 0.4, 'sine'), 150)
    setTimeout(() => beep(1100, 0.3, 0.35, 'sine'), 300)
  }

  function playDump() {
    // Descending alert — two quick falling tones
    beep(880, 0.15, 0.35, 'sine')
    setTimeout(() => beep(660, 0.25, 0.35, 'sine'), 150)
    setTimeout(() => beep(440, 0.3, 0.3, 'sine'), 300)
  }

  function playSignal(type: 'PUMP' | 'DUMP') {
    if (type === 'PUMP') playPump()
    else playDump()
  }

  return { playSignal, playPump, playDump, soundEnabled, armAudio }
}
