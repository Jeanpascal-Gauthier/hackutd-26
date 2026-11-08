import assert from 'node:assert/strict';
/** Leaves a recoverable map error for the XR retry-button check. */
export default async function ({ page, frame }) {
  const base = new URL(frame.url()).origin;
  await frame.goto(`${base}/?view=fireeye&lat=91&lon=-96`);
  await frame.waitForFunction(()=>window.__fireeye?.state.phase==='error');
  const invalid=await frame.evaluate(()=>({phase:window.__fireeye.state.phase,map:!!window.__fireeye.system.map,room:window.__fireeye.system.room.visible,status:window.__fireeye.state.status}));
  assert.equal(invalid.map,false); assert.equal(invalid.room,true);
  assert.match(invalid.status,/Invalid coordinates/);
  const fail=route=>route.abort('failed');
  await page.route('https://tile.googleapis.com/**',fail);
  try {
    await frame.goto(`${base}/?view=fireeye`);
    await frame.waitForFunction(()=>window.__fireeye?.state.phase==='error',null,{timeout:20000});
    const offline=await frame.evaluate(()=>({phase:window.__fireeye.state.phase,room:window.__fireeye.system.room.visible,status:window.__fireeye.state.status}));
    assert.equal(offline.room,true); assert.match(offline.status,/Map unavailable/);
    console.log(JSON.stringify({invalid,offline}));
  } finally { await page.unroute('https://tile.googleapis.com/**',fail); }
}
