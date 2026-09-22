const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");

function wav(seconds, frequency) {
  const samples = Math.round(seconds * 8000);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF"); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; ++i) buffer.writeInt16LE(Math.round(Math.sin(i * frequency * Math.PI * 2 / 8000) * 100), 44 + i * 2);
  return buffer;
}

(async () => {
  const server = spawn(process.execPath, ["server.js"], {cwd:path.join(__dirname, ".."), windowsHide:true, env:{...process.env, PORT:"5188"}, stdio:"ignore"});
  const serverExit = once(server, "exit");
  let browser;
  const base = "http://127.0.0.1:5188";
  const output = path.resolve(__dirname, "../../build/stem-validation");
  await fs.mkdir(output, { recursive:true });
  try {
    for (let i = 0; i < 50; ++i) {
      if (await fetch(`${base}/api/state`).then(r=>r.ok).catch(()=>false)) break;
      await new Promise(r=>setTimeout(r,100));
    }
    browser = await chromium.launch({channel:"msedge", headless:true});
    const page = await browser.newPage({viewport:{width:1366,height:900}});
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/model-status", route=>route.fulfill({json:{ok:true,engine:"test-fixture"}}));
    let uploaded = false;
    await page.route("**/api/model-align", async route => {
      const body = route.request().postDataBuffer().toString("latin1");
      assert.ok(body.includes('name="vocal"'));
      assert.ok(!body.includes('name="mr"'));
      uploaded = true;
      const state = await page.request.post(`${base}/api/project`, {data:{title:"Stem test",duration:65,
        lyrics:["First line", "Second line"],timeline:[{text:"First line",start:1,end:4},{text:"Second line",start:60,end:63}]}}).then(r=>r.json());
      await route.fulfill({json:{...state,ok:true,matchedLines:2}});
    });
    await page.goto(base);
    await page.locator("#audioFile").setInputFiles({name:"vocal.wav",mimeType:"audio/wav",buffer:wav(64,440)});
    await page.locator("#mrFile").setInputFiles({name:"mr.wav",mimeType:"audio/wav",buffer:wav(65,220)});
    await page.waitForFunction(()=>!document.querySelector("#generateSync").disabled);
    await page.locator("#lyricsText").fill("First line\nSecond line");
    await page.locator("#generateSync").click();
    await page.waitForFunction(()=>document.querySelector("#analysisStatus").textContent.includes("싱크 완료"));
    assert.ok(uploaded);
    await page.locator("#playPause").click();
    await page.waitForTimeout(400);
    await page.locator("#seekPosition").fill("61");
    await page.waitForTimeout(400);
    const time = await page.evaluate(()=>elements.audioPlayer.currentTime);
    assert.ok(time > 61 && time < 62);
    assert.equal(await page.locator("#previewCurrent").innerText(), "Second line");
    await page.locator("#playPause").click();
    const paused = await page.evaluate(()=>elements.audioPlayer.currentTime);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(()=>elements.audioPlayer.currentTime), paused);
    await page.locator("#karaokeFill").uncheck();
    await page.waitForFunction(()=>[...document.querySelectorAll("#previewCurrent .timed-char:not(.space-char)")].every(n=>n.style.getPropertyValue("--char-fill")==="0%"));
    const overlay = await browser.newPage({viewport:{width:1280,height:720}});
    await overlay.goto(`${base}/overlay`);
    await overlay.waitForFunction(()=>document.querySelector("#overlayCurrent").textContent==="Second line");
    assert.equal(await overlay.locator(".overlay-char").first().evaluate(n=>n.style.getPropertyValue("--char-fill")),"0%");
    await page.locator("#karaokeFill").check();
    await overlay.waitForFunction(()=>document.querySelector(".overlay-char").style.getPropertyValue("--char-fill")==="100%");
    await page.screenshot({path:path.join(output,"desktop.png"),fullPage:true});
    await overlay.screenshot({path:path.join(output,"overlay.png"),omitBackground:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(output,"mobile.png"),fullPage:true});
    const overflow = await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow,false);
    await page.locator("#restartPlayback").click();
    assert.equal(await page.evaluate(()=>elements.audioPlayer.currentTime),0);
    await page.unroute("**/api/model-align");
    await page.route("**/api/model-align", route=>route.fulfill({json:{ok:false,error:"test failure"}}));
    await page.locator("#generateSync").click();
    await page.waitForFunction(()=>document.querySelector("#analysisStatus").textContent.includes("싱크 생성 실패"));
    assert.equal(await page.evaluate(()=>app.timeline.length),0);
    assert.deepEqual(errors,[]);
    await overlay.close();
    await page.close();
    await Promise.race([serverExit,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Control close left server running")),5000))]);
    console.log(JSON.stringify({ok:true,checks:["vocal-only request","shared seek beyond 60s","pause/restart","animation toggle preview+overlay","no false fallback","mobile overflow","control close shutdown"],screenshots:output}));
  } finally {
    await browser?.close();
    if(server.exitCode===null) server.kill();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
