/** A short click scheduled on the audio device, locked to media time. */

interface FollowSpec {
  media: number;
  rate: number;
  beat: number;
  bar: number;
  subdivisions: number;
  grid?: readonly [time: number, downbeat: boolean][];
}

export function clickGrouping(signature?: string): { bar: number; subdivisions: number } {
  switch (signature) {
    case "2/4": return { bar: 2, subdivisions: 1 };
    case "3/4": return { bar: 3, subdivisions: 1 };
    case "4/4": return { bar: 4, subdivisions: 1 };
    case "6/8": return { bar: 2, subdivisions: 3 };
    case "12/8": return { bar: 4, subdivisions: 3 };
    default: return { bar: 0, subdivisions: 1 };
  }
}

function firstBeat(grid: NonNullable<FollowSpec["grid"]>, time: number) {
  let lo = 0, hi = grid.length;
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    if (grid[middle][0] < time) lo = middle + 1;
    else hi = middle;
  }
  return lo;
}

export class PracticeMetronome {
  private ctx: AudioContext | null = null;
  private timer = 0;
  private generation = 0;
  private scheduledUntil = 0;
  private lastMedia: number | null = null;
  private read: (() => FollowSpec | null) | null = null;

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = globalThis.AudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  private async resume(): Promise<AudioContext | null> {
    const ctx = this.context();
    if (!ctx) return null;
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch { return null; }
    }
    return ctx;
  }

  private click(when: number, accent: boolean, subdivision = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = accent ? 1320 : subdivision ? 660 : 880;
    gain.gain.setValueAtTime(accent ? 0.22 : subdivision ? 0.055 : 0.12, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.04);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.05);
  }

  /** One bar of clicks before playback. Resolves false if cancelled. */
  async countIn(bar: number, wallSeconds: number, subdivisions = 1): Promise<boolean> {
    const count = bar || 4;
    const step = Math.max(0.12, wallSeconds);
    const ctx = await this.resume();
    if (!ctx) return false;
    const token = ++this.generation;
    const start = ctx.currentTime + 0.06;
    for (let i = 0; i < count * subdivisions; i++) {
      this.click(start + i * step / subdivisions, bar > 0 && i === 0, i % subdivisions !== 0);
    }
    await new Promise(resolve => setTimeout(resolve, (count * step + 0.06) * 1000));
    return token === this.generation;
  }

  cancel() {
    this.generation++;
  }

  follow(read: () => FollowSpec | null) {
    this.read = read;
    if (this.timer) return;
    void this.resume();
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  stopFollow() {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
    this.read = null;
    this.scheduledUntil = 0;
    this.lastMedia = null;
  }

  dispose() {
    this.cancel();
    this.stopFollow();
    void this.ctx?.close();
    this.ctx = null;
  }

  private schedule() {
    const spec = this.read?.();
    const ctx = this.ctx;
    if (!spec || !ctx || !(spec.beat > 0) || !(spec.rate > 0)) return;
    if (this.lastMedia != null && Math.abs(spec.media - this.lastMedia) > Math.min(.18, spec.beat / 2)) this.scheduledUntil = 0;
    this.lastMedia = spec.media;
    const horizon = ctx.currentTime + 0.2;
    const scheduleTick = (atMedia: number, accent: boolean, subdivision: boolean) => {
      const when = ctx.currentTime + (atMedia - spec.media) / spec.rate;
      if (when >= ctx.currentTime && when > this.scheduledUntil) {
        this.click(when, accent, subdivision);
      }
    };
    const untilMedia = spec.media + .2 * spec.rate;
    if (spec.grid?.length) {
      const grid = spec.grid;
      for (let index = Math.max(0, firstBeat(grid, spec.media) - 1);
        index < grid.length && grid[index][0] <= untilMedia; index++) {
        const [at, accent] = grid[index];
        scheduleTick(at, accent, false);
        const interval = (grid[index + 1]?.[0] ?? Infinity) - at;
        if (interval < spec.beat * 1.5) {
          for (let inner = 1; inner < spec.subdivisions; inner++) {
            const subAt = at + interval * inner / spec.subdivisions;
            if (subAt <= untilMedia) scheduleTick(subAt, false, true);
          }
        }
      }
    } else {
      const step = spec.beat / spec.subdivisions;
      const perBar = spec.bar * spec.subdivisions;
      for (let index = Math.ceil(spec.media / step); index * step <= untilMedia; index++) {
        scheduleTick(index * step, perBar > 0 && index % perBar === 0, index % spec.subdivisions !== 0);
      }
    }
    this.scheduledUntil = horizon;
  }
}
