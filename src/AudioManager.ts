/**
 * BubbleAudioManager
 * - Plays audio files for pop, recover, squeeze, and BGM.
 * - Lazy-creates AudioContext to comply with iOS gesture-required policy.
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
  private preloaded = false;

  // 点击音效可调参数（外部直接修改）
  popRate = 1.0;
  popHighpass = 0;
  popLowpass = 7000;
  popGain = 0.6;

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
    const base = import.meta.env.BASE_URL;
    const fullUrl = url.startsWith('/') ? `${base}${url.slice(1)}` : url;
    const resp = await fetch(fullUrl);
    const arrayBuf = await resp.arrayBuffer();
    return this.audioContext!.decodeAudioData(arrayBuf);
  }

  /**
   * 首次用户交互时调用：初始化 AudioContext 并预加载所有音频 buffer。
   * BGM 加载完立即播放，其余 buffer 并行加载以消除后续首次播放延迟。
   */
  async activate() {
    if (this.preloaded) return;
    this.preloaded = true;
    this.ensureContext();
    // 并行预加载所有音频
    const [bgm, pop, recover, recoverSpecial, squeeze] = await Promise.all([
      this.loadBuffer('/bgm.mp3'),
      this.loadBuffer('/pop.mp4'),
      this.loadBuffer('/recover.mp4'),
      this.loadBuffer('/recover-special.mp4'),
      this.loadBuffer('/squeeze.mp4'),
    ]);
    this.bgmBuffer = bgm;
    this.popBuffer = pop;
    this.recoverBuffer = recover;
    this.recoverSpecialBuffer = recoverSpecial;
    this.squeezeBuffer = squeeze;
    // 立即播放 BGM
    this.startBGMInternal();
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

  /** 启动背景音乐（循环播放） - 兼容旧调用 */
  async startBGM() {
    if (this.bgmStarted) return;
    // 如果还未预加载，走旧逻辑
    this.ensureContext();
    if (!this.bgmBuffer) {
      this.bgmBuffer = await this.loadBuffer('/bgm.mp3');
    }
    this.startBGMInternal();
  }

  play() {
    this.ensureContext();
    if (!this.bgmStarted) this.startBGM();
    if (this.activeSounds >= this.maxConcurrent) return;
    this.activeSounds++;
    const startPlayback = async () => {
      if (!this.popBuffer) {
        this.popBuffer = await this.loadBuffer('/pop.mp4');
      }
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
    };
    startPlayback();
  }

  async playRecover(highPitch = false) {
    this.ensureContext();
    if (!this.bgmStarted) this.startBGM();
    if (highPitch) {
      // 特殊气泡用恢复3
      if (!this.recoverSpecialBuffer) {
        this.recoverSpecialBuffer = await this.loadBuffer('/recover-special.mp4');
      }
      const source = this.audioContext!.createBufferSource();
      source.buffer = this.recoverSpecialBuffer;
      source.playbackRate.value = 0.8 + Math.random() * 0.15;
      const gainNode = this.audioContext!.createGain();
      gainNode.gain.value = 0.6;
      source.connect(gainNode);
      gainNode.connect(this.audioContext!.destination);
      source.start();
    } else {
      if (!this.recoverBuffer) {
        this.recoverBuffer = await this.loadBuffer('/recover.mp4');
      }
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
    if (!this.bgmStarted) this.startBGM();
    let source: AudioBufferSourceNode | null = null;
    const startPlayback = async () => {
      if (!this.squeezeBuffer) {
        this.squeezeBuffer = await this.loadBuffer('/squeeze.mp4');
      }
      source = this.audioContext!.createBufferSource();
      source.buffer = this.squeezeBuffer;
      source.playbackRate.value = 0.9 + Math.random() * 0.2;
      const squeezeGain = this.audioContext!.createGain();
      squeezeGain.gain.value = 1.5;
      source.connect(squeezeGain);
      squeezeGain.connect(this.audioContext!.destination);
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
