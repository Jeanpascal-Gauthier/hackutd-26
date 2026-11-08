import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the real browser transport without importing the SDK renderer.
const source = ts.transpileModule(readFileSync(new URL('../src/incident-client.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { IncidentSocket, incidentEndpoints, fetchBuilding } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const location = (search = '') => { globalThis.window = { location: { origin: 'https://headset.test', search } }; };
class Socket {
  static OPEN = 1;
  static instances = [];
  readyState = 0;
  listeners = {};
  sent = [];
  constructor(url) { this.url = url; Socket.instances.push(this); }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  emit(name, value) { for (const fn of this.listeners[name] ?? []) fn(value); }
  open() { this.readyState = 1; this.emit('open'); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
}
const state = { simMinute: 0, rooms: [], reports: [], occupants: [] };

test('same-origin proxy and remote HTTP/WSS URLs resolve consistently', () => {
  location();
  assert.deepEqual(incidentEndpoints(), { building: 'https://headset.test/fs-api/building', socket: 'wss://headset.test/fs-ws' });
  for (const value of ['https://server.test/', 'wss://server.test/']) {
    location(`?server=${encodeURIComponent(value)}`);
    assert.deepEqual(incidentEndpoints(), { building: 'https://server.test/building', socket: 'wss://server.test' });
  }
  location('?server=javascript:alert(1)');
  assert.throws(incidentEndpoints, /Server URL/);
});

test('building fetch rejects an empty payload and propagates cancellation', async () => {
  location();
  const previous = globalThis.fetch;
  let signal;
  globalThis.fetch = async (_url, options) => { signal = options.signal; return { ok: true, json: async () => ({ building: { rooms: [] } }) }; };
  try {
    const abort = new AbortController();
    await assert.rejects(fetchBuilding(abort.signal), /no building rooms/);
    assert.equal(signal, abort.signal);
  } finally { globalThis.fetch = previous; }
});

test('disconnect reconnects once, ignores stale/malformed state, and never replays offline commands', async () => {
  location();
  globalThis.WebSocket = Socket;
  const oldSet = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
  const timers = new Map(); let timerId = 0;
  globalThis.setTimeout = (fn) => { timers.set(++timerId, fn); return timerId; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const states = [], statuses = [];
  const client = new IncidentSocket(s => states.push(s), s => statuses.push(s));
  try {
    client.connect(); client.connect();
    const first = Socket.instances.at(-1);
    assert.equal(Socket.instances.length, 1);
    assert.equal(client.send({ type: 'acceptRecommendation' }), false);
    first.open();
    first.emit('message', { data: 'null' });
    first.emit('message', { data: '{broken' });
    first.emit('message', { data: JSON.stringify({ type: 'state', state: {} }) });
    first.emit('message', { data: JSON.stringify({ type: 'state', state }) });
    assert.equal(states.length, 1);
    assert.equal(client.send({ type: 'dispatch', roomId: '7-break' }), true);
    assert.deepEqual(first.sent, [{ type: 'dispatch', roomId: '7-break' }]);
    first.close(); first.close();
    assert.equal(timers.size, 1);
    assert.equal(client.send({ type: 'dispatch', roomId: '8-east' }), false);
    const retry = [...timers.values()][0]; timers.clear(); retry();
    const second = Socket.instances.at(-1); second.open();
    assert.equal(Socket.instances.length, 2);
    assert.deepEqual(second.sent, []);
    first.emit('message', { data: JSON.stringify({ type: 'state', state }) });
    assert.equal(states.length, 1);
    client.close();
    assert.equal(timers.size, 0);
    assert.equal(statuses.at(-1), 'disconnected');
  } finally {
    client.close(); globalThis.setTimeout = oldSet; globalThis.clearTimeout = oldClear;
  }
});
