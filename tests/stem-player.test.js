const { test } = require("node:test");
const assert = require("node:assert/strict");
const { StemPlayer } = require("../public/stem-player.js");

function setup() {
  const starts = [];
  const context = {
    currentTime: 10,
    destination: {},
    async resume() {},
    async close() { this.closed = true; },
    createGain() {
      return { gain: { value: 1, setValueAtTime(value) { this.value = value; } }, connect() {}, disconnect() {} };
    },
    createBufferSource() {
      return {
        connect(gain) { return gain; }, disconnect() {}, stop() {},
        start(when, offset) { starts.push({ when, offset, source: this }); }
      };
    }
  };
  const player = new StemPlayer(() => context);
  player.setBuffer("vocal", { duration: 65 });
  player.setBuffer("mr", { duration: 70 });
  return { player, context, starts };
}

test("stems share exact start and seek timestamps, even past one minute", async () => {
  const { player, context, starts } = setup();
  await player.play();
  assert.equal(starts[0].when, starts[1].when);
  assert.equal(starts[0].offset, starts[1].offset);
  context.currentTime = 71.025;
  assert.ok(Math.abs(player.currentTime - 61) < 1e-9);
  player.currentTime = 63;
  assert.equal(starts[2].offset, 63);
  assert.equal(starts[3].offset, 63);
  assert.equal(starts[2].when, starts[3].when);
  player.pause();
  context.currentTime += 5;
  assert.equal(player.currentTime, 63);
  await player.play();
  assert.equal(starts.at(-1).offset, 63);
});

test("shorter vocal ending does not end MR; restarting resets both", async () => {
  const { player, starts } = setup();
  await player.play();
  starts[0].source.onended();
  assert.equal(player.paused, false);
  starts[1].source.onended();
  assert.equal(player.ended, true);
  assert.equal(player.currentTime, 70);
  await player.play();
  assert.equal(starts.at(-1).offset, 0);
  assert.equal(starts.at(-2).offset, 0);
});

test("seek into MR outro, mute and dispose do not retain vocal playback", async () => {
  const { player, context, starts } = setup();
  player.currentTime = 67;
  await player.play();
  assert.equal(starts.length, 1);
  assert.equal(player.sources[0].track, "mr");
  player.setVolume("mr", 0);
  assert.equal(player.sources[0].gain.gain.value, 0);
  await player.dispose();
  assert.equal(context.closed, true);
  assert.equal(player.sources.length, 0);
  assert.equal(player.duration, 0);
});

test("a pause while audio resume is pending cancels the play request", async () => {
  const { player, context, starts } = setup();
  let resume;
  context.resume = () => new Promise(resolve => { resume = resolve; });
  const playing = player.play();
  player.pause();
  resume();
  await playing;
  assert.equal(player.paused, true);
  assert.equal(starts.length, 0);
});
