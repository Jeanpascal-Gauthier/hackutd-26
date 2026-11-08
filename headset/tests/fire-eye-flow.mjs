import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

/** Browser-local teammate fixture. Never changes the live incident or sends commands. */
export default async function ({ page, frame, workspaceRoot }) {
  const base = new URL(frame.url()).origin;
  const source = await frame.evaluate(async () => ({
    state: await (await fetch('/fs-api/state')).json(),
    building: await (await fetch('/fs-api/building')).json(),
  }));
  const fixture = { ...source.state, recommendation: undefined };
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(source.building));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', socket => socket.send(JSON.stringify({ type: 'state', state: fixture })));
  await new Promise(resolve => server.listen(18198, '127.0.0.1', resolve));
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const folder = join(workspaceRoot, 'artifacts');
  await mkdir(folder, { recursive: true });
  try {
    await frame.goto(`${base}/?view=fireeye&server=${encodeURIComponent('http://127.0.0.1:18198')}`);
    await frame.waitForFunction(() => window.__fireeye?.system?.map?.ready, null, { timeout: 65000 });
    const briefing = await frame.evaluate(() => ({ ...window.__fireeye.state, roomVisible:window.__fireeye.system.room.visible }));
    assert.equal(briefing.phase, 'briefing');
    assert.equal(briefing.roomVisible, true);
    await frame.locator('canvas').first().screenshot({ path: join(folder, 'fireeye-briefing.png') });
    const started = Date.now();
    assert.ok(wss.clients.size, 'The app must connect to the teammate WebSocket');
    fixture.recommendation = { actions: ['Test fixture: establish a safe perimeter.', 'Test fixture: confirm access with responders.'] };
    for(const socket of wss.clients) socket.send(JSON.stringify({ type: 'state', state: fixture }));
    await frame.waitForFunction(() => window.__fireeye?.state.phase === 'countdown');
    await page.waitForTimeout(1000);
    assert.equal(await frame.evaluate(() => window.__fireeye.state.phase), 'countdown', 'The timer must not finish early');
    await frame.waitForFunction(() => window.__fireeye?.state.phase === 'city', null, { timeout: 10000 });
    const result = await frame.evaluate(() => {
      const f=window.__fireeye,w=window.__world,m=f.system.map;
      let maxTexture=0;
      m.tiles.group.traverse(o=>{
        for(const mat of Array.isArray(o.material)?o.material:[o.material]) {
          if(!mat) continue;
          for(const value of Object.values(mat)) if(value?.isTexture&&value.image) maxTexture=Math.max(maxTexture,value.image.width??0,value.image.height??0);
        }
      });
      return {phase:f.state.phase,panelY:f.system.panel.position.y,roomVisible:f.system.room.visible,cityVisible:m.anchor.visible,
        maxTexture,triangles:w.renderer.info.render.triangles,attribution:m.attribution(),failed:m.tiles.stats.failed};
    });
    assert.equal(result.roomVisible,false);
    assert.equal(result.cityVisible,true);
    assert.ok(result.panelY>2,'The screen must rise above its briefing position');
    assert.ok(result.maxTexture<=1024,'Tile textures must fit the Quest texture budget');
    assert.ok(result.attribution.length>0,'Streamed tile providers must be attributed');
    assert.deepEqual(errors,[]);
    const output={briefing,city:result,transitionMs:Date.now()-started,errors};
    await writeFile(join(folder,'fireeye-flow.json'),JSON.stringify(output,null,2));
    console.log(JSON.stringify(output));
  } finally {
    page.off('pageerror',onError);
    // Restore the live endpoint before closing the isolated fixture.
    try { await frame.goto(`${base}/?view=fireeye`); } catch { /* Keep the original failure. */ }
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve=>wss.close(resolve));
    await new Promise(resolve=>server.close(resolve));
  }
}
