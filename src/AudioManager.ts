/**
 * BubbleAudioManager
 * - 页面加载时立即 prefetch 所有音频文件（无需用户手势）
 * - 尝试自动播放 BGM，若被浏览器策略阻止则在首次交互时恢复
 * - Caps simultaneous voices to avoid clipping on rapid drags.
 */
class BubbleAudioManager {
  private audioContext: AudioContext | null = null;
  private activeSounds = 0;
  private maxConcurrent = 10;
  private recoverBuffer: AudioBuffer | null = null;
  private recoverSpecialBuffer: AudioBuffer | null = null;
  private squeezeBuffer: AudioBuffer | null = null;
  private popBuffer: AudioBuffer | null = null;
  private bgmBuffer: AudioBuffer | null = null;
  private bgmStarted = false;

  // 预加载的原始 ArrayBuffer（页面加载时即开始 fetch）
  private rawBuffers: Promise<Record<string, ArrayBuffer>>;

  // 点击音效可调参数
  popRate = 1.0;
  popHighpass = 0;
  popLowpass = 7000;
  popGain = 0.6;

  constructor() {
    // 页面加载时立即 fetch 所有音频文件（仅下载，不需要 AudioContext）
    this.rawBuffers = this.prefetchAll();
    // fetch 完成后尝试自动播放 BGM
    this.rawBuffers.then(() => this.tryAutoplay());
  }

  private async prefetchAll(): Promise<Record<string, ArrayBuffer>> {
    const base = import.meta.env.BASE_URL;
    const files: Record<string, string> = {
      bgm: `${base}bgm.mp3`,
      pop: `${base}pop.mp4`,
      recover: `${base}recover.mp4`,
      recoverSpecial: `${base}recover-special.mp4`,
      squeeze: `${base}squeeze.mp4`,
    };
    const entries = await Promise.all(
      Object.entries(files).map(async ([key, url]) => {
        const resp = await fetch(url);
        return [key, await resp.arrayBuffer()] as [string, ArrayBuffer];
      })
    );
    return Object.fromEntries(entries);
  }

  /** 尝试自动播放 BGM，若被浏览器策略阻止则静默失败 */
  private async tryAutoplay() {
    try {
      this.ensureContext();
      await this.decodeAll();
      this.startBGMInternal();
    } catch {
      // 浏览器阻止了自动播放，等待用户交互时恢复
    }
  }

  /** 用户首次交互时调用：恢复被阻止的 AudioContext 并播放 BGM */
  async resume() {
    this.ensureContext();
    if (!this.popBuffer) {
      await this.decodeAll();
    }
    this.startBGMInternal();
  }

  private ensureContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }

  private async decodeAll() {
    if (this.popBuffer) return; // 已解码过
    const raw = await this.rawBuffers;
    const [bgm, pop, recover, recoverSpecial, squeeze] = await Promise.all([
      this.audioContext!.decodeAudioData(raw.bgm.slice(0)),
      this.audioContext!.decodeAudioData(raw.pop.slice(0)),
      this.audioContext!.decodeAudioData(raw.recover.slice(0)),
      this.audioContext!.decodeAudioData(raw.recoverSpecial.slice(0)),
      this.audioContext!.decodeAudioData(raw.squeeze.slice(0)),
    ]);
    this.bgmBuffer = bgm;
    this.popBuffer = pop;
    this.recoverBuffer = recover;
    this.recoverSpecialBuffer = recoverSpecial;
    this.squeezeBuffer = squeeze;
  }

  private startBGMInternal() {
    if (this.bgmStarted || !this.bgmBuffer) return;
    this.bgmStarted = true;
    const source = this.audioContext!.createBufferSource();
    source.buffer = this.bgmBuffer;
    source.loop = true;
    const gainNode = this.audioContext!.createGain();
    gainNode.gain.value = 0.3;
    source.connect(gainNode);
    gainNode.connect(this.audioContext!.destination);
    source.start();
  }

  play() {
    this.ensureContext();
    if (!this.popBuffer) return; // buffer 未就绪时静默跳过
    if (this.activeSounds >= this.maxConcurrent) return;
    this.activeSounds++;
    const ctx = this.audioContext!;
    const source = ctx.createBufferSource();
    source.buffer = this.popBuffer;
    source.playbackRate.value = this.popRate - 0.15 + Math.random() * 0.15;

    const gainNode = ctx.createGain();
    gainNode.gain.value = this.popGain;

    let head: AudioNode = source;
    if (this.popHighpass > 0) {
      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = this.popHighpass;
      source.connect(highpass);
      head = highpass;
    }
    if (this.popLowpass > 0 && this.popLowpass < 20000) {
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = this.popLowpass;
      head.connect(lowpass);
      head = lowpass;
    }
    head.connect(gainNode);
    gainNode.connect(ctx.destination);
    source.start(0, 0.1);
    source.stop(ctx.currentTime + 0.6);
    source.onended = () => { this.activeSounds--; };
  }

  playRecover(highPitch = false) {
    this.ensureContext();
    if (highPitch) {
      if (!this.recoverSpecialBuffer) return;
      const source = this.audioContext!.createBufferSource();
      source.buffer = this.recoverSpecialBuffer;
      source.playbackRate.value = 0.8 + Math.random() * 0.15;
      const gainNode = this.audioContext!.createGain();
      gainNode.gain.value = 0.6;
      source.connect(gainNode);
      gainNode.connect(this.audioContext!.destination);
      source.start();
    } else {
      if (!this.recoverBuffer) return;
      const source = this.audioContext!.createBufferSource();
      source.buffer = this.recoverBuffer;
      source.playbackRate.value = 0.8 + Math.random() * 0.15;
      const gainNode = this.audioContext!.createGain();
      gainNode.gain.value = 0.6;
      source.connect(gainNode);
      gainNode.connect(this.audioContext!.destination);
      source.start();
    }
  }

  playSqueeze(): { stop: () => void } {
    this.ensureContext();
    let source: AudioBufferSourceNode | null = null;
    if (this.squeezeBuffer) {
      source = this.audioContext!.createBufferSource();
      source.buffer = this.squeezeBuffer;
      source.playbackRate.value = 0.9 + Math.random() * 0.2;
      const squeezeGain = this.audioContext!.createGain();
      squeezeGain.gain.value = 1.5;
      source.connect(squeezeGain);
      squeezeGain.connect(this.audioContext!.destination);
      source.start();
    }
    return {
      stop: () => { if (source) { try { source.stop(); } catch {} } }
    };
  }

  playDrop() {
    this.playRecover();
  }
}

export const audioManager = new BubbleAudioManager();
