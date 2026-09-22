// Both stems use one AudioContext clock, including seeks and pauses.
class StemPlayer extends EventTarget {
  constructor(contextFactory = () => new AudioContext()) {
    super();
    this.contextFactory = contextFactory;
    this.context = null;
    this.buffers = { vocal: null, mr: null };
    this.levels = { vocal: 1, mr: 1 };
    this.sources = [];
    this.position = 0;
    this.startedAt = 0;
    this.paused = true;
    this.ended = false;
    this.seeking = false;
    this.playbackRate = 1;
    this.generation = 0;
    this.disposed = false;
  }

  get duration() {
    return Math.max(...Object.values(this.buffers).map(buffer => buffer?.duration || 0));
  }

  get currentTime() {
    if (this.paused || !this.context) return this.position;
    return Math.min(this.duration, this.position + Math.max(0, this.context.currentTime - this.startedAt));
  }

  set currentTime(value) {
    const playing = !this.paused;
    this.stopSources();
    this.position = Math.max(0, Math.min(this.duration, Number(value) || 0));
    this.ended = false;
    this.paused = true;
    if (playing && this.position < this.duration) this.startSources();
    this.dispatchEvent(new Event("seeked"));
    if (playing && this.paused) this.dispatchEvent(new Event("pause"));
  }

  async decode(file) {
    if (this.disposed) throw new Error("Player is closed.");
    this.context ||= this.contextFactory();
    return this.context.decodeAudioData(await file.arrayBuffer());
  }

  setBuffer(track, buffer) {
    if (!(track in this.buffers)) throw new Error("Unknown track.");
    this.pause();
    this.buffers[track] = buffer;
    this.position = 0;
    this.ended = false;
    this.dispatchEvent(new Event("loadedmetadata"));
    this.dispatchEvent(new Event("seeked"));
  }

  setVolume(track, value) {
    this.levels[track] = Math.max(0, Math.min(1, Number(value) || 0));
    for (const entry of this.sources) {
      if (entry.track === track) entry.gain.gain.setValueAtTime(this.levels[track], this.context.currentTime);
    }
  }

  startSources() {
    const generation = ++this.generation;
    const when = this.context.currentTime + 0.025;
    this.startedAt = when;
    this.paused = false;
    this.ended = false;
    for (const [track, buffer] of Object.entries(this.buffers)) {
      if (!buffer || this.position >= buffer.duration) continue;
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      source.buffer = buffer;
      gain.gain.value = this.levels[track];
      source.connect(gain).connect(this.context.destination);
      const entry = { track, source, gain };
      this.sources.push(entry);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        this.sources = this.sources.filter(item => item !== entry);
        if (generation !== this.generation || this.sources.length || this.paused) return;
        this.position = this.duration;
        this.paused = true;
        this.ended = true;
        this.dispatchEvent(new Event("pause"));
        this.dispatchEvent(new Event("ended"));
      };
      source.start(when, this.position);
    }
  }

  async play() {
    if (this.disposed || !this.duration || !this.paused) return;
    this.context ||= this.contextFactory();
    const generation = this.generation;
    await this.context.resume();
    if (this.disposed || generation !== this.generation || !this.paused) return;
    if (this.position >= this.duration) this.position = 0;
    this.startSources();
    this.dispatchEvent(new Event("play"));
  }

  stopSources() {
    ++this.generation;
    for (const { source, gain } of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
      gain.disconnect();
    }
    this.sources = [];
  }

  pause() {
    this.position = this.currentTime;
    const wasPlaying = !this.paused;
    this.stopSources();
    this.paused = true;
    if (wasPlaying) this.dispatchEvent(new Event("pause"));
  }

  dispose() {
    this.pause();
    this.disposed = true;
    this.buffers = { vocal: null, mr: null };
    return this.context?.close().catch(() => {});
  }
}

if (typeof module !== "undefined") module.exports = { StemPlayer };
