import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import WebSocket from 'ws';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync(new URL('../src/incident-client.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { IncidentSocket, fetchBuilding } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error('Timed out waiting for server state');
}

test('headset transport receives the real incident and confirms explicit actions', { timeout: 20000 }, async () => {
  const base = 'http://127.0.0.1:18081';
  const child = spawn(process.execPath, [require.resolve('tsx/cli'), 'src/index.ts'], {
    cwd: new URL('../../server/', import.meta.url),
    env: { ...process.env, PORT: '18081', MOCK: '0', AUTOPLAY: '0', AGENT: '0' },
    stdio: 'ignore',
  });
  let socket;
  try {
    await waitFor(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } });
    globalThis.window = { location: { origin: 'https://headset.test', search: `?server=${encodeURIComponent(base)}` } };
    globalThis.WebSocket = WebSocket;
    const building = await fetchBuilding();
    assert.equal(building.building.rooms.length, 108);
    const states = [];
    socket = new IncidentSocket(s => states.push(s));
    socket.connect();
    await waitFor(() => states.length > 0);
    const response = await fetch(`${base}/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caller: 'headset-integration', text: 'Fire in break room on floor 7', roomId: '7-break', confidence: 0.95, recommendation: { actions: ['Evacuate by Stairwell A'] } }),
    });
    assert.equal(response.status, 200);
    await waitFor(() => states.at(-1)?.recommendation);
    assert.equal(states.at(-1).accepted, undefined);
    assert.equal(states.at(-1).dispatches.length, 0);
    assert.equal(socket.send({ type: 'acceptRecommendation' }), true);
    await waitFor(() => states.at(-1)?.accepted);
    assert.equal(states.at(-1).recommendation, undefined);
    assert.equal(socket.send({ type: 'dispatch', roomId: '7-break' }), true);
    await waitFor(() => states.at(-1)?.dispatches.length === 1);
    assert.equal(states.at(-1).dispatches[0].roomId, '7-break');
    assert.ok(states.at(-1).log.some(entry => entry.kind === 'accepted'));
    assert.ok(states.at(-1).log.some(entry => entry.kind === 'dispatch'));
  } finally {
    socket?.close();
    if (child.exitCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  }
});
