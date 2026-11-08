import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Load the dependency-free modules without the SDK renderer.
const load = async (file) => {
  const source = ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};
const { StreetViewClient, tileGrid, parseMetadata, STREET_VIEW_ZOOM } = await load('street-view-client.ts');
const { PullGesture, PULL_DISTANCE } = await load('pull-gesture.ts');

// Shape of a live response near UTD (Nov 2026), trimmed.
const raw = {
  panoId: '9VP5kAbbB0UvO5tqrkBNRQ', lat: 32.9856, lng: -96.7503, imageHeight: 6656, imageWidth: 13312,
  tileHeight: 512, tileWidth: 512, copyright: 'From the Owner, Photo by: Google', heading: 112.34858, tilt: 87.86, roll: 358.2, date: '2014-05',
  addressComponents: [{ longName: '800', types: ['street_number'] }, { longName: 'West Campbell Road', shortName: 'W Campbell Rd', types: ['route'] }],
  links: [{ panoId: 'a', heading: 123.5, text: '' }, { panoId: 'b', heading: 270.3, text: 'Franklyn Jenifer Dr' }, { heading: 4 }],
};

test('tile grid matches the grids the live API serves', () => {
  // Measured: z1 2x1, z2 4x2, z3 7x4 tiles; content heights 416, 832, 1664 px.
  assert.deepEqual(tileGrid(raw, 0), { width: 416, height: 208, columns: 1, rows: 1 });
  assert.deepEqual(tileGrid(raw, 1), { width: 832, height: 416, columns: 2, rows: 1 });
  assert.deepEqual(tileGrid(raw, 2), { width: 1664, height: 832, columns: 4, rows: 2 });
  assert.deepEqual(tileGrid(raw, 3), { width: 3328, height: 1664, columns: 7, rows: 4 });
  assert.ok(tileGrid(raw, STREET_VIEW_ZOOM).width <= 4096, 'The panorama texture must fit Quest texture limits');
});

test('metadata parsing keeps valid links and the street name', () => {
  const meta = parseMetadata(raw);
  assert.equal(meta.street, 'W Campbell Rd');
  assert.deepEqual(meta.links.map(link => link.panoId), ['a', 'b']);
  assert.equal(meta.links[1].text, 'Franklyn Jenifer Dr');
  assert.throws(() => parseMetadata({ ...raw, heading: undefined }), /heading/);
});

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('nearest() creates one session, returns null without imagery', async () => {
  const calls = [];
  const client = new StreetViewClient('KEY', async (url, init) => {
    calls.push({ url, init });
    if (url.includes('createSession')) return reply(200, { session: 'S1' });
    if (url.includes('lat=0')) return reply(404, { error: { code: 404 } });
    return reply(200, raw);
  });
  const found = await client.nearest(32.98, -96.75, 50);
  assert.equal(found.panoId, raw.panoId);
  assert.equal(await client.nearest(0, -140, 50), null);
  assert.equal(calls.filter(c => c.url.includes('createSession')).length, 1, 'The session token is reused');
  const session = JSON.parse(calls[0].init.body);
  assert.equal(session.mapType, 'streetview');
  assert.match(calls[1].url, /streetview\/metadata\?session=S1&key=KEY&lat=32\.98&lng=-96\.75&radius=50$/);
});

test('an expired session is replaced once', async () => {
  let sessions = 0, metadataCalls = 0;
  const client = new StreetViewClient('KEY', async (url) => {
    if (url.includes('createSession')) return reply(200, { session: `S${++sessions}` });
    metadataCalls++;
    return url.includes('session=S1') ? reply(403, {}) : reply(200, raw);
  });
  assert.equal((await client.metadata('abc')).panoId, raw.panoId);
  assert.equal(sessions, 2);
  assert.equal(metadataCalls, 2);
});

test('a failed session request is retried on the next call', async () => {
  let attempt = 0;
  const client = new StreetViewClient('KEY', async (url) => {
    if (url.includes('createSession')) return ++attempt === 1 ? reply(403, {}) : reply(200, { session: 'S' });
    return reply(200, raw);
  });
  await assert.rejects(client.metadata('abc'), /Map Tiles API/);
  assert.equal((await client.metadata('abc')).panoId, raw.panoId);
});

test('pulling the pinched hand back toward the body commits', () => {
  const gesture = new PullGesture();
  // Pointing forward and down at the city (-Z is forward).
  gesture.begin({ x: 0.2, y: 1.2, z: -0.4 }, { x: 0, y: -0.7, z: -0.7 });
  assert.equal(gesture.update({ x: 0.2, y: 1.2, z: -0.35 }, true), 'pulling');
  assert.ok(gesture.progress > 0.3 && gesture.progress < 0.4);
  // Vertical travel alone does not count.
  assert.equal(gesture.update({ x: 0.2, y: 1.5, z: -0.35 }, true), 'pulling');
  assert.equal(gesture.update({ x: 0.2, y: 1.3, z: -0.4 + PULL_DISTANCE }, true), 'commit');
  assert.equal(gesture.active, false);
});

test('releasing early or pushing forward cancels', () => {
  const gesture = new PullGesture();
  gesture.begin({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 });
  assert.equal(gesture.update({ x: -0.05, y: 1, z: 0 }, false), 'cancel');
  gesture.begin({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 });
  assert.equal(gesture.update({ x: 0.1, y: 1, z: 0 }, true), 'cancel');
  assert.equal(gesture.update({ x: 0, y: 1, z: 0 }, true), 'idle');
});
