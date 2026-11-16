export type PlayerListener = (t: number, playing: boolean) => void;

export class AudioPlayer {
  private audio: HTMLAudioElement;
  private raf = 0;
  private listeners = new Set<PlayerListener>();
  private objectUrl: string | null = null;
  private cancelLoad: (() => void) | null = null;
  private outputClock: AudioContext | null = null;
  /** True once playback is pulled through the audio graph, so both latencies apply. */
  private routed = false;
  private loopRegion: { start: number; end: number } | null = null;
  private frameListeners = new Set<(t: number) => void>();

  constructor() {
    this.audio = new Audio();
    this.audio.preload = "auto";
    // timeupdate is about 4 Hz. It must not position the playhead.
    for (const event of ["seeked", "loadedmetadata", "emptied"]) {
      this.audio.addEventListener(event, () => this.emit());
    }
    this.audio.addEventListener("play", () => {
      this.startRaf();
      this.emit();
    });
    for (const event of ["pause", "ended"]) {
      this.audio.addEventListener(event, () => {
        this.stopRaf();
        this.emit();
      });
    }
  }

  private emit() {
    const playing = !this.audio.paused && !this.audio.ended;
    const t = this.displayTime(playing);
    for (const l of this.listeners) l(t, playing);
  }

  /**
   * currentTime is the sample handed to the audio device. The speakers trail
   * that sample. Once the element plays through the audio graph, the trail is
   * the graph buffer plus the device buffer. A disconnected context only knows
   * the device buffer.
   */
  private displayTime(playing: boolean, presentIn = 0): number {
    const raw = this.audio.currentTime;
    if (!playing) return raw;
    const delay = this.outputDelay();
    const heard = raw - delay + presentIn * (this.audio.playbackRate || 1);
    return Math.max(0, heard);
  }

  private outputDelay(): number {
    const clock = this.outputClock;
    if (!clock) return 0;
    const output = clock.outputLatency || 0;
    const base = this.routed ? clock.baseLatency || 0 : 0;
    const delay = output + base;
    if (!Number.isFinite(delay) || delay <= 0 || delay >= 0.5) return 0;
    return delay;
  }

  /** Decoder time while paused, speaker time while playing. */
  audibleTime(): number {
    return this.displayTime(!this.audio.paused && !this.audio.ended);
  }

  /** Positioning clock. Keep per-frame updates out of the full dashboard render. */
  onFrame(fn: (t: number) => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  private prepareOutputClock() {
    if (this.outputClock) return;
    const Ctor = globalThis.AudioContext;
    if (!Ctor) return;
    try {
      const clock = new Ctor();
      try {
        if (typeof clock.createMediaElementSource === "function") {
          clock.createMediaElementSource(this.audio).connect(clock.destination);
          this.routed = true;
        }
      } catch {
        this.routed = false;
      }
      void clock.resume();
      this.outputClock = clock;
    } catch {
      this.outputClock = null;
      this.routed = false;
    }
  }

  private tick = (frameTime?: number) => {
    let presentIn = 0;
    if (typeof frameTime === "number" && Number.isFinite(frameTime)) {
      const lead = (frameTime - performance.now()) / 1000;
      if (lead > 0 && lead < 0.05) presentIn = lead;
    }
    let t = this.displayTime(true, presentIn);
    const loop = this.loopRegion;
    if (loop && t >= loop.end) {
      this.seek(loop.start);
      t = loop.start;
    }
    for (const listener of this.frameListeners) listener(t);
    if (!this.audio.paused && !this.audio.ended) this.raf = requestAnimationFrame(this.tick);
  };

  private startRaf() {
    this.stopRaf();
    this.raf = requestAnimationFrame(this.tick);
  }

  private stopRaf() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  subscribe(fn: PlayerListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async loadObjectUrl(url: string): Promise<void> {
    this.pause();
    this.cancelLoad?.();
    if (this.objectUrl && this.objectUrl !== url) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = url;
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.audio.removeEventListener("canplay", ready);
          this.audio.removeEventListener("error", failed);
          this.audio.removeEventListener("abort", aborted);
          this.cancelLoad = null;
        };
        const ready = () => {
          cleanup();
          this.emit();
          resolve();
        };
        const failed = () => {
          const message = this.audio.error?.message || "The audio decoder cannot play this file.";
          cleanup();
          reject(new Error(message));
        };
        const aborted = () => {
          cleanup();
          reject(new DOMException("Audio load cancelled", "AbortError"));
        };
        this.cancelLoad = aborted;
        this.audio.addEventListener("canplay", ready);
        this.audio.addEventListener("error", failed);
        this.audio.addEventListener("abort", aborted);
        this.audio.src = url;
        this.audio.load();
      });
    } catch (e) {
      if (this.objectUrl === url) this.clear();
      throw e;
    }
  }

  async loadFromBytes(bytes: Uint8Array, mime = "audio/wav"): Promise<string> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const url = URL.createObjectURL(new Blob([copy.buffer], { type: mime }));
    await this.loadObjectUrl(url);
    return url;
  }

  async play(): Promise<void> {
    this.prepareOutputClock();
    if (this.outputClock?.state === "suspended") {
      try { await this.outputClock.resume(); } catch { /* play the element anyway */ }
    }
    await this.audio.play();
  }

  pause() {
    this.audio.pause();
  }

  async toggle(): Promise<void> {
    if (this.audio.paused) await this.play();
    else this.pause();
  }

  /** Repeat a region. A span shorter than a fifth of a second is ignored. */
  setLoop(region: { start: number; end: number } | null) {
    if (!region || !(region.end > region.start + 0.2)) {
      this.loopRegion = null;
      return;
    }
    const limit = this.duration || region.end;
    this.loopRegion = {
      start: Math.max(0, Math.min(region.start, limit)),
      end: Math.max(0, Math.min(region.end, limit)),
    };
  }

  seek(t: number) {
    const limit = this.duration;
    const target = Math.max(0, Math.min(t, limit));
    const playing = !this.audio.paused && !this.audio.ended;
    // While playing, hand the device the sample it must hold so the speakers
    // reach the requested time after the output buffer.
    const delay = playing ? this.outputDelay() : 0;
    this.audio.currentTime = Math.max(0, Math.min(target + delay, limit));
    this.emit();
  }

  clear() {
    this.loopRegion = null;
    this.cancelLoad?.();
    this.pause();
    this.stopRaf();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.emit();
  }

  set volume(v: number) { this.audio.volume = Math.max(0, Math.min(1, v)); }
  get currentTime() { return this.audio.currentTime; }
  get duration() { return Number.isFinite(this.audio.duration) ? this.audio.duration : 0; }
  get paused() { return this.audio.paused; }
  set playbackRate(r: number) { this.audio.playbackRate = r; }
  get playbackRate() { return this.audio.playbackRate; }

  dispose() {
    this.clear();
    void this.outputClock?.close();
    this.outputClock = null;
    this.routed = false;
    this.listeners.clear();
    this.frameListeners.clear();
  }
}
