import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Run after a real pointer/controller press opens the city, with an immersive session active. */
export default async function ({ frame, workspaceRoot }) {
  const run=promisify(execFile);
  async function cli(domain,action,input={}) {
    const {stdout}=await run('npx',['@iwsdk/cli',domain,action,'--input-json',JSON.stringify(input)],{cwd:workspaceRoot});
    const output=JSON.parse(stdout);assert.equal(output.ok,true,JSON.stringify(output.error));return output.data.result;
  }
  async function press(id) {
    const {targets}=await cli('xr','list-targets');
    const target=targets.find(value=>value.name===id);assert.ok(target,`Missing control ${id}`);
    await cli('xr','look-at',{device:'controller-right',target:target.position});
    await cli('xr','select',{device:'controller-right',duration:0.2});
  }
  await frame.waitForFunction(()=>window.__fireeye?.system.map?.ready,null,{timeout:65000});
  await cli('xr','enter');
  if(await frame.evaluate(()=>window.__fireeye.state.phase==='briefing'))await press('fireeye-resume');
  await frame.waitForFunction(() => window.__fireeye?.state.phase === 'city');
  const results=[];
  for(const view of ['north','east','south','west','overview']) {
    await press(`fireeye-${view}`);
    await new Promise(resolve=>setTimeout(resolve,500));
  await frame.waitForFunction(() => {
    const stats=window.__fireeye.system.map.tiles.stats;
    return stats.downloading===0 && stats.parsing===0 && stats.queued===0;
  },null,{timeout:45000});
  const result=await frame.evaluate(async()=>{
    const w=window.__world,map=window.__fireeye.system.map,tiles=map.tiles;
    let changes=0,maxTriangles=0,minTriangles=Infinity;
    const track=()=>changes++;
    tiles.addEventListener('tile-visibility-change',track);
    try {
      for(let i=0;i<25;i++) {
        await new Promise(resolve=>setTimeout(resolve,100));
        const count=w.renderer.info.render.triangles;
        maxTriangles=Math.max(maxTriangles,count);minTriangles=Math.min(minTriangles,count);
      }
    } finally { tiles.removeEventListener('tile-visibility-change',track); }
    const seen=new Set();let totalTextures=0,mipmappedTextures=0,maxTexture=0,maxAnisotropy=0,tileMaterials=0,fogMaterials=0;
    tiles.group.traverse(object=>{
      for(const material of Array.isArray(object.material)?object.material:[object.material]) {
        if(!material)continue;
        tileMaterials++;if(material.fog)fogMaterials++;
        for(const value of Object.values(material)) {
          if(!value?.isTexture||seen.has(value))continue;
          seen.add(value);totalTextures++;
          if(value.generateMipmaps && value.minFilter===1008)mipmappedTextures++;
          maxTexture=Math.max(maxTexture,value.image?.width??0,value.image?.height??0);
          maxAnisotropy=Math.max(maxAnisotropy,value.anisotropy);
        }
      }
    });
    return {perspective:window.__fireeye.state.perspective,phase:window.__fireeye.state.phase,xr:w.renderer.xr.isPresenting,stereoSelection:map.selectionCamera?.isArrayCamera??false,
      near:w.camera.near,far:w.camera.far,anchor:{x:map.anchor.position.x,y:map.anchor.position.y,z:map.anchor.position.z},
      errorTarget:tiles.errorTarget,cameraCount:tiles.cameras.length,preloadRegistered:map.preloadRegistered,
      visible:tiles.visibleTiles.size,loaded:tiles.stats.loaded,failed:tiles.stats.failed,
      settledVisibilityChanges:changes,minTriangles,maxTriangles,totalTextures,mipmappedTextures,maxTexture,maxAnisotropy,
      tileMaterials,fogMaterials,fog:w.scene.fog?{near:w.scene.fog.near,far:w.scene.fog.far,color:w.scene.fog.color.getHexString()}:null,atmosphereActive:window.__fireeye.system.atmosphere.active};
  });
  results.push(result);
  console.log(JSON.stringify(result));
  assert.equal(result.xr,true,'The rendering test must exercise stereo selection');
  assert.equal(result.stereoSelection,true);
  assert.equal(result.preloadRegistered,false);
  assert.equal(result.cameraCount,1,'Only the current stereo camera should select visible tiles');
  assert.equal(result.near,0.5);assert.equal(result.far,3000);
  assert.equal(result.totalTextures,result.mipmappedTextures,'All map textures need trilinear mipmaps');
  assert.ok(result.totalTextures>0);assert.ok(result.maxTexture<=1024);
  assert.ok(result.maxAnisotropy<=4);
  assert.ok(result.maxTriangles<100000,'The tested viewpoint must fit the Quest triangle budget');
  assert.equal(result.failed,0);
  assert.equal(result.atmosphereActive,true);
  assert.equal(result.tileMaterials,result.fogMaterials);
  assert.deepEqual(result.fog,{near:450,far:1400,color:'e4e8eb'});
  assert.equal(result.settledVisibilityChanges,0,'Tiles must not alternate while the camera is stationary and loading has settled');
  }
  await cli('xr','exit');
  await frame.waitForFunction(()=>window.__fireeye.system.map.selectionCamera===window.__world.camera);
  assert.equal(await frame.evaluate(()=>window.__fireeye.state.phase),'briefing');
  assert.equal(await frame.evaluate(()=>window.__world.scene.fog),null);
  await cli('xr','enter');
  await press('fireeye-resume');
  await frame.waitForFunction(()=>window.__fireeye.state.phase==='city');
  await mkdir(join(workspaceRoot,'artifacts'),{recursive:true});
  await writeFile(join(workspaceRoot,'artifacts/fireeye-stability.json'),JSON.stringify({views:results,exitCameraRestored:true},null,2));
}
