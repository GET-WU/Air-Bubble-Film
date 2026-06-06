/**
 * BubbleAudioManager
 * - Synthesizes a "pop" via white-noise burst + downward sine sweep.
 * - Lazy-creates AudioContext to comply with iOS gesture-required policy.
 * - Caps simultaneous voices to avoid clipping on rapid drags.
 */
class BubbleAudioManager {
  private audioContext: AudioContext | null = null;
  private activeSounds = 0;
  private maxConcurrent = 10;

  private ensureContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }

  play() {
    this.ensureContext();
    if (this.activeSounds >= this.maxConcurrent) return;

    const ctx = this.audioContext!;
    const now = ctx.currentTime;
    const pitch = 0.8 + Math.random() * 0.4;
    const volume = 0.85 + Math.random() * 0.3;

    this.activeSounds++;

    // ── white-noise burst (the crisp "snap") ────────────────────
    const bufferSize = ctx.sampleRate * 0.12;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const highPass = ctx.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 2000;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0, now);
    noiseGain.gain.linearRampToValueAtTime(volume * 0.4, now + 0.005);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

    noise.connect(highPass);
    highPass.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noise.start(now);
    noise.stop(now + 0.1);

    // ── sine "thud" (the body of the pop) ───────────────────────
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.frequency.setValueAtTime(600 * pitch, now);
    osc.frequency.exponentialRampToValueAtTime(100 * pitch, now + 0.08);
    oscGain.gain.setValueAtTime(volume * 0.3, now);
    oscGain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.08);

    setTimeout(() => {
      this.activeSounds--;
    }, 150);
  }

  /** 水滴音效：上行正弦波 + 微弱混响，模拟气泡充气恢复 */
  playDrop() {
    this.ensureContext();
    if (this.activeSounds >= this.maxConcurrent) return;

    const ctx = this.audioContext!;
    const now = ctx.currentTime;
    const pitch = 0.9 + Math.random() * 0.2;

    this.activeSounds++;

    // 上行正弦波（水滴的“叮”）
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800 * pitch, now);
    osc.frequency.exponentialRampToValueAtTime(2000 * pitch, now + 0.06);
    osc.frequency.exponentialRampToValueAtTime(1200 * pitch, now + 0.15);

    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.25, now);
    oscGain.gain.linearRampToValueAtTime(0.3, now + 0.02);
    oscGain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);

    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);

    setTimeout(() => {
      this.activeSounds--;
    }, 250);
  }
}

export const audioManager = new BubbleAudioManager();
