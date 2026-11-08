import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

/** Run with iwsdk browser run tests/fire-eye-offline.mjs --timeout 90000.
 * Interrupts only a browser-local fixture; never changes the team's incident.
 * Button presses use emulated controller input, not private system methods.
 */
export default async function ({ page, frame, workspaceRoot }) {
  const base = new URL(frame.url()).origin;
  const source = await frame.evaluate(async () => ({
    state: await (await fetch('/fs-api/state')).json(),
    building: await (await fetch('/fs-api/building')).json(),
  }));
  const fixture = { ...source.state, recommendation: undefined };
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(source.building));
  });
  const sockets = new WebSocketServer({ server });
  const timers = new Set();
  let interrupt = false;
  let connections = 0;
  sockets.on('connection', socket => {
    connections++;
    socket.send(JSON.stringify({ type: 'state', state: fixture }));
    if (interrupt) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        socket.close(1012, 'Test fixture connection interruption');
      }, 50);
      timers.add(timer);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(18199, '127.0.0.1', resolve);
  });
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);

  const run = promisify(execFile);
  async function cli(domain, action, input = {}) {
    const { stdout } = await run('npx', ['@iwsdk/cli', domain, action, '--input-json', JSON.stringify(input)], { cwd: workspaceRoot });
    const output = JSON.parse(stdout);
    assert.equal(output.ok, true, JSON.stringify(output.error));
    return output.data.result;
  }
  async function clickButton(id) {
    const { targets } = await cli('xr', 'list-targets');
    const target = targets.find(candidate => candidate.name === id);
    assert.ok(target, `The control ${id} must be addressable`);
    await cli('xr', 'look-at', { device: 'controller-right', target: target.position });
    await cli('xr', 'select', { device: 'controller-right', duration: 0.2 });
  }

  try {
    const fixtureUrl = encodeURIComponent('http://127.0.0.1:18199');
    await frame.goto(`${base}/?view=fireeye&server=${fixtureUrl}`);
    await frame.waitForFunction(() => window.__fireeye?.system.map?.ready, null, { timeout: 65000 });
    assert.equal(await frame.evaluate(() => window.__fireeye.state.phase), 'briefing');
    assert.ok(connections > 0, 'The fixture must establish a teammate connection');

    await cli('xr', 'enter');
    await clickButton('fireeye-resume');
    await frame.waitForFunction(() => window.__fireeye.state.phase === 'countdown');
    // Close during the manual countdown. Later reconnects also close immediately.
    // Before the fix, the close event returned to the briefing and entry never completed.
    interrupt = true;
    for (const socket of sockets.clients) socket.close(1012, 'Test fixture connection interruption');
    await frame.waitForFunction(() => window.__fireeye.state.phase === 'city', null, { timeout: 10000 });
    await page.waitForTimeout(2500);
    const city = await frame.evaluate(() => ({
      phase: window.__fireeye.state.phase,
      roomVisible: window.__world.getSceneObject('briefing-room').visible,
      cityVisible: window.__fireeye.system.map.anchor.visible,
    }));
    assert.equal(city.phase, 'city', 'Reconnect attempts must not eject a manual city preview');
    assert.equal(city.roomVisible, false);
    assert.equal(city.cityVisible, true);
    assert.ok(connections >= 2, 'The test must include a reconnect, not only the initial disconnect');

    await clickButton('fireeye-back');
    await frame.waitForFunction(() => window.__fireeye.state.phase === 'briefing');
    const returned = await frame.evaluate(() => ({
      phase: window.__fireeye.state.phase,
      roomVisible: window.__world.getSceneObject('briefing-room').visible,
      cityVisible: window.__fireeye.system.map.anchor.visible,
    }));
    assert.equal(returned.roomVisible, true);
    assert.equal(returned.cityVisible, false);
    assert.deepEqual(errors, []);
    const result = { city, returned, connections, errors };
    await mkdir(join(workspaceRoot, 'artifacts'), { recursive: true });
    await writeFile(join(workspaceRoot, 'artifacts/fireeye-offline.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    page.off('pageerror', onError);
    // Leave the managed app on its live endpoint before destroying the fixture.
    try { await frame.goto(`${base}/?view=fireeye`); } catch { /* Preserve the original assertion failure. */ }
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
}
