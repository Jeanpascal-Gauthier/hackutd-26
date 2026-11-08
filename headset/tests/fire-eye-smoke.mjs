import assert from 'node:assert/strict';
/** Preserved command-room regression; ends on the live FireEye briefing. */
export default async function ({frame}) {
 const base=new URL(frame.url()).origin;
 await frame.goto(`${base}/?view=firewatch`);
 await frame.waitForFunction(()=>window.__world?.scene.getObjectByName('Incident Building'),null,{timeout:25000});
 const old=await frame.evaluate(()=>({
   building:!!window.__world.scene.getObjectByName('Incident Building'),
   room:window.__world.getSceneObject('command-room').visible,
   briefing:window.__world.getSceneObject('briefing-room').visible,
   panel:window.__world.getSceneObject('fire-eye-panel').visible,
 }));
 assert.equal(old.building,true);assert.equal(old.room,true);assert.equal(old.briefing,false);assert.equal(old.panel,false);
 await frame.goto(`${base}/`);
 await frame.waitForFunction(()=>window.__fireeye?.system.map?.ready,null,{timeout:65000});
 assert.equal(await frame.evaluate(()=>window.__fireeye.state.phase),'briefing');
 console.log(JSON.stringify({firewatch:old,liveFireEye:'briefing',ready:true}));
}
