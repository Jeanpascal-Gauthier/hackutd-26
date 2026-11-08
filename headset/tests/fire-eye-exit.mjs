import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Exercise real city controls with a simulated headset and local map fixture (no API key required). */
export default async function ({ frame, workspaceRoot }) {
  const originalUrl = frame.url();
  const run = promisify(execFile);
  async function cli(domain, action, input = {}) {
    const { stdout } = await run('npx', ['@iwsdk/cli', domain, action, '--input-json', JSON.stringify(input)], { cwd: workspaceRoot });
    const output = JSON.parse(stdout);
    assert.equal(output.ok, true, JSON.stringify(output.error));
    return output.data.result;
  }
  async function enterSession() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const status = await cli('xr', 'status');
      if (status.sessionActive) return;
      if (status.sessionOffered) { await cli('xr', 'enter'); return; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.fail('The configured always-offered XR session did not become available');
  }
  async function press(id) {
    const { targets } = await cli('xr', 'list-targets');
    const target = targets.find(value => value.name === id);
    assert.ok(target, `Missing control ${id}`);
    await cli('xr', 'look-at', { device: 'controller-right', target: target.position });
    await cli('xr', 'select', { device: 'controller-right', duration: 0.2 });
  }
  async function openCity() {
    if (await frame.evaluate(() => window.__fireeye.state.phase === 'briefing')) await press('fireeye-resume');
    await frame.waitForFunction(() => window.__fireeye.state.phase === 'city');
  }
  async function assertBriefing() {
    await frame.waitForFunction(() => window.__fireeye.state.phase === 'briefing');
    assert.deepEqual(await frame.evaluate(() => ({
      room: window.__fireeye.system.room.visible,
      city: window.__fireeye.system.map.anchor.visible,
      paused: window.__fireeye.system.paused,
      manualPreview: window.__fireeye.system.manualPreview,
    })), { room: true, city: false, paused: true, manualPreview: false });
  }

  async function installFixture(state, initial = false) {
    return frame.evaluate(({ state, initial }) => {
      const system = window.__fireeye.system;
      if (initial) {
        // Disconnect only this browser's real feed so it cannot overwrite the fixture.
        system.socket?.close();
        system.connected = true;
        system.paused = true;
        system.buildingKey = `${state.building.id}:${state.building.version}`;
        // A changed building must reach resolveLocation's await even without a real key.
        // Its request is cancelled synchronously below, before any Google renderer starts.
        system.token ||= 'local-exit-test-not-a-google-key';
        const url = new URL(location.href);
        url.searchParams.delete('lat');
        url.searchParams.delete('lon');
        history.replaceState(null, '', url);
      }
      // State preparation only: all Exit/Preview/Briefing actions still use controllers.
      system.onState(state);
      const pausedAfterState = system.paused;
      system.generation++;
      system.abort?.abort();
      system.clearMap();
      const anchor = system.marker.clone();
      anchor.name = 'Exit test map fixture';
      anchor.visible = false;
      system.map = {
        anchor, ready: true, update: () => false, attribution: () => 'Local test fixture',
        tiles: { visibleTiles: new Set() }, dispose: () => {},
      };
      system.mapEntity = window.__world.createTransformEntity(anchor);
      // Do not assign paused here: preserve what the real state handler left behind.
      system.showBriefing();
      return { pausedAfterState, recommendations: system.actions.length, connected: system.connected };
    }, { state, initial });
  }

  await frame.waitForFunction(() => window.__fireeye?.system);
  const liveState = await frame.evaluate(async () => (await fetch('/fs-api/state')).json());
  const fixtureState = {
    ...liveState,
    building: {
      ...(liveState.building ?? { id: 'demo', name: 'Exit test building', layoutEstimated: true }),
      version: (liveState.building?.version ?? 0) + 1000,
    },
    recommendation: { actions: ['Exit test fixture: verify access with responders.'] },
  };
  const prepared = await installFixture(fixtureState, true);
  assert.equal(prepared.connected, true);
  assert.ok(prepared.recommendations > 0, 'The fixture must qualify for automatic city entry unless paused');
  await enterSession();
  try {
    await openCity();
    await mkdir(join(workspaceRoot, 'artifacts'), { recursive: true });
    await frame.locator('canvas').first().screenshot({ path: join(workspaceRoot, 'artifacts/fireeye-exit-city.png') });
    await press('fireeye-exit');
    await frame.waitForFunction(() => !window.__world.renderer.xr.isPresenting);
    await assertBriefing();
    // A new incident version must not override the user's decision to exit.
    fixtureState.building.version++;
    fixtureState.recommendation.actions = ['Updated exit test fixture: confirm the new incident location.'];
    const refreshed = await installFixture(fixtureState);
    assert.equal(refreshed.pausedAfterState, true, 'A building refresh must preserve the exit pause before replacing its map dependency');
    assert.equal(refreshed.connected, true);
    assert.ok(refreshed.recommendations > 0);
    await assertBriefing();
    // With a ready map, live connection and recommendations, only the pause prevents entry.
    await enterSession();
    await new Promise(resolve => setTimeout(resolve, 3500));
    await assertBriefing();
    await openCity();
    // The existing Briefing control still returns without ending the immersive session.
    await press('fireeye-back');
    await assertBriefing();
    assert.equal(await frame.evaluate(() => window.__world.renderer.xr.isPresenting), true);
    await press('fireeye-exit');
    await frame.waitForFunction(() => !window.__world.renderer.xr.isPresenting);
    await assertBriefing();
    console.log(JSON.stringify({ cityExit: true, buildingRefreshPaused: true, recommendationReadyReentryPaused: true, previewResumed: true, briefingPreserved: true, briefingExit: true }));
  } finally {
    if (await frame.evaluate(() => window.__world.renderer.xr.isPresenting)) await cli('xr', 'exit');
    await frame.goto(originalUrl);
  }
}
