import {
  BoxGeometry, CylinderGeometry, ExtrudeGeometry, Group, Mesh,
  MeshStandardMaterial, Object3D, Shape,
} from '@iwsdk/core';
import { studioMaterials as materials } from './studio-materials.js';

// Metres; operator at the origin facing -Z. Shared dimensions keep the
// console's outer edge flush with the three forward room facets.
const RADIUS = 2.2;
const HEIGHT = 2.8;

function box(name: string, size: [number, number, number], material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(new BoxGeometry(...size), material);
  mesh.name = name;
  return mesh;
}

// One continuous half-hexagonal worktop, with a matching recessed cabinet.
function consoleBand(outer: number, inner: number, thickness: number, material: MeshStandardMaterial, bevel = false): Mesh {
  const outline = new Shape();
  const angles = [-90, -30, 30, 90];
  angles.forEach((angle, i) => {
    const a = angle * Math.PI / 180;
    const x = outer * Math.sin(a), z = -outer * Math.cos(a);
    if (i === 0) outline.moveTo(x, -z); else outline.lineTo(x, -z);
  });
  for (const angle of [...angles].reverse()) {
    const a = angle * Math.PI / 180;
    outline.lineTo(inner * Math.sin(a), inner * Math.cos(a));
  }
  outline.closePath();
  const geometry = new ExtrudeGeometry(outline, {
    depth: thickness, bevelEnabled: bevel, bevelThickness: 0.005,
    bevelSize: 0.008, bevelSegments: 2, steps: 1, curveSegments: 1,
  });
  geometry.rotateX(-Math.PI / 2);
  return new Mesh(geometry, material);
}

export function createCommandDesk(): Object3D {
  const desk = new Group();
  desk.name = 'Wraparound console';
  const top = consoleBand(RADIUS, 1.25, 0.045, materials.oak, true);
  top.name = 'Continuous three-facet worktop';
  top.position.y = 0.695;
  const cabinet = consoleBand(RADIUS - 0.04, 1.48, 0.56, materials.cabinet);
  cabinet.name = 'Recessed supporting cabinet';
  cabinet.position.y = 0.13;
  const toeKick = consoleBand(RADIUS - 0.1, 1.54, 0.13, materials.graphite);
  toeKick.name = 'Recessed graphite toe kick';
  const shadowGap = consoleBand(RADIUS - 0.035, 1.47, 0.012, materials.graphite);
  shadowGap.name = 'Worktop shadow reveal';
  shadowGap.position.y = 0.683;
  desk.add(top, cabinet, toeKick, shadowGap);
  return desk;
}

export function createCommandRoom(): Object3D {
  const room = new Group();
  room.name = 'Hexagonal command room';
  const ground = new Mesh(new CylinderGeometry(RADIUS + 0.08, RADIUS + 0.08, 0.12, 6), materials.floor);
  ground.rotation.y = Math.PI / 6;
  ground.name = 'Solid hexagonal floor';
  ground.position.y = -0.06;
  const ceiling = ground.clone();
  ceiling.material = materials.plaster;
  ceiling.name = 'Solid ceiling';
  ceiling.position.y = HEIGHT + 0.06;
  room.add(ground, ceiling);
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3;
    const apothem = RADIUS * Math.cos(Math.PI / 6);
    const panel = box(`Wall facet ${i + 1}`, [RADIUS + 0.08, HEIGHT, 0.12], materials.plaster);
    panel.position.set(Math.sin(angle) * apothem, HEIGHT / 2, -Math.cos(angle) * apothem);
    panel.rotation.y = -angle;
    const light = box(`Ceiling light ${i + 1}`, [RADIUS - 0.15, 0.045, 0.035], materials.light);
    light.position.set(Math.sin(angle) * (apothem - 0.075), HEIGHT - 0.16, -Math.cos(angle) * (apothem - 0.075));
    light.rotation.y = -angle;
    const skirting = box(`Oak skirting ${i + 1}`, [RADIUS - 0.04, 0.085, 0.025], materials.oak);
    skirting.position.set(Math.sin(angle) * (apothem - 0.065), 0.043, -Math.cos(angle) * (apothem - 0.065));
    skirting.rotation.y = -angle;
    const fabric = box(`Inset textile wall panel ${i + 1}`, [RADIUS - 0.3, 1.22, 0.025], materials.fabric);
    fabric.position.set(Math.sin(angle) * (apothem - 0.075), 1.62, -Math.cos(angle) * (apothem - 0.075));
    fabric.rotation.y = -angle;
    room.add(panel, light, skirting, fabric);
  }
  const ceilingPanel = box('Diffuse ceiling light panel', [1.5, 0.025, 1.0], materials.light);
  ceilingPanel.position.set(0, HEIGHT - 0.04, -0.2);
  room.add(ceilingPanel);
  return room;
}
