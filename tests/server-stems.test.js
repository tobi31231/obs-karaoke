const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("analysis accepts vocal only, retains style, and shutdown also stops model checks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obs-stems-test-"));
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  await fs.mkdir(path.join(root, "work"));
  await fs.copyFile(path.join(__dirname, "../server.js"), path.join(root, "server.js"));
  await fs.writeFile(path.join(root, "work/model_align.py"), `
    const fs = require('fs');
    if (process.argv.includes('--check')) {
      fs.writeFileSync('check.pid', String(process.pid));
      setInterval(() => {}, 1000);
    } else {
      const input = fs.readFileSync(process.argv[process.argv.indexOf('--audio') + 1], 'utf8');
      console.log(JSON.stringify({ok: input === 'VOCAL_TEST_ONLY', duration: 4,
        lyrics: ['test'], timeline: [{text:'test', start:1, end:2}], matchedLines:1}));
    }
  `);
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root, windowsHide: true, stdio: "ignore",
    env: { ...process.env, PORT: String(port), PYTHON: process.execPath }
  });
  const exited = once(child, "exit");
  const base = `http://127.0.0.1:${port}`;
  let checkPid;
  try {
    for (let i = 0; i < 60; ++i) {
      if (await fetch(`${base}/api/state`).then(r => r.ok).catch(() => false)) break;
      await delay(50);
    }
    const invalid = new FormData();
    invalid.append("mr", new Blob(["MR"]), "mr.wav");
    invalid.append("lyrics", "test");
    assert.equal((await fetch(`${base}/api/model-align`, {method: "POST", body: invalid})).status, 400);
    const valid = new FormData();
    valid.append("vocal", new Blob(["VOCAL_TEST_ONLY"]), "vocal.wav");
    valid.append("inputKind", "vocal-stem");
    valid.append("lyrics", "test");
    valid.append("duration", "8");
    const result = await fetch(`${base}/api/model-align`, {method: "POST", body: valid}).then(r => r.json());
    assert.equal(result.ok, true);
    assert.equal(result.duration, 8);
    assert.equal(result.timeline[0].end, 2);
    const style = await fetch(`${base}/api/style`, {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({karaokeFill:false})}).then(r=>r.json());
    assert.equal(style.style.karaokeFill, false);
    const check = fetch(`${base}/api/model-status`).catch(() => null);
    for (let i = 0; i < 60; ++i) {
      checkPid = Number(await fs.readFile(path.join(root, "check.pid"), "utf8").catch(() => 0));
      if (checkPid) break;
      await delay(50);
    }
    assert.ok(checkPid);
    await fetch(`${base}/api/shutdown`, {method:"POST"});
    await Promise.race([exited, delay(4000).then(() => { throw new Error("Server did not stop"); })]);
    await check;
    assert.throws(() => process.kill(checkPid, 0));
    assert.deepEqual(await fs.readdir(path.join(root, "work/uploads")), []);
  } finally {
    if (child.exitCode === null) child.kill();
    if (checkPid) { try { process.kill(checkPid); } catch {} }
    await fs.rm(root, { recursive:true, force:true });
  }
});
