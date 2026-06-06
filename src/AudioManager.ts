/**
 * BubbleAudioManager
 * - Plays audio files for pop, recover, and squeeze effects.
 * - Lazy-creates AudioContext to comply with iOS gesture-required policy.
 * - Caps simultaneous voices to avoid clipping on rapid drags.
 */
class BubbleAudioManager {
  private audioContext: AudioContext | null = null;
  private activeSounds = 0;
  private maxConcurrent = 10;
  private recoverBuffer: AudioBuffer | null = null;
  private squeezeBuffer: AudioBuffer | null = null;
  private popBuffer: AudioBuffer | null = null;

  private ensureContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }

  private async loadBuffer(url: string): Promise<AudioBuffer> {
    const resp = await fetch(url);
    const arrayBuf = await resp.arrayBuffer();
    return this.audioContext!.decodeAudioData(arrayBuf);
  }

  play() {
    this.ensureContext();
    if (this.activeSounds >= this.maxConcurrent) return;
    this.activeSounds++;
    const startPlayback = async () => {
      if (!this.popBuffer) {
        this.popBuffer = await this.loadBuffer('/pop.mp4');
      }
      const source = this.audioContext!.createBufferSource();
      source.buffer = this.popBuffer;
      source.playbackRate.value = 0.95 + Math.random() * 0.2;
      // 高通滤波增强清脆感
      const highpass = this.audioContext!.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 800;
      source.connect(highpass);
      highpass.connect(this.audioContext!.destination);
      source.start();
      source.onended = () => { this.activeSounds--; };
    };
    startPlayback();
  }

  async playRecover() {
    this.ensureContext();
    if (!this.recoverBuffer) {
      this.recoverBuffer = await this.loadBuffer('/recover.mp4');
    }
    const source = this.audioContext!.createBufferSource();
    source.buffer = this.recoverBuffer;
    source.playbackRate.value = 0.9 + Math.random() * 0.2;
    source.connect(this.audioContext!.destination);
    source.start();
  }

  playSqueeze(): { stop: () => void } {
    this.ensureContext();
    let source: AudioBufferSourceNode | null = null;
    const startPlayback = async () => {
      if (!this.squeezeBuffer) {
        this.squeezeBuffer = await this.loadBuffer('/squeeze.mp4');
      }
      source = this.audioContext!.createBufferSource();
      source.buffer = this.squeezeBuffer;
      source.connect(this.audioContext!.destination);
      source.start();
    };
    startPlayback();
    return {
      stop: () => { if (source) { try { source.stop(); } catch {} } }
    };
  }

  playDrop() {
    this.playRecover();
  }
}

export const audioManager = new BubbleAudioManager();
