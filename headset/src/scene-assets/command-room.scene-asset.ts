import {
  BoxGeometry, CylinderGeometry, ExtrudeGeometry, Group, Mesh,
  MeshStandardMaterial, Object3D, Shape,
} from '@iwsdk/core';

// Metres; operator at the origin facing -Z. Shared dimensions keep the
// console's outer edge flush with the three forward room facets.
const RADIUS = 2.2;
const HEIGHT = 2.8;
const surface = new MeshStandardMaterial({ color: '#303d4b', roughness: 0.65 });
const wall = new MeshStandardMaterial({ color: '#263444', roughness: 0.9 });
const floor = new MeshStandardMaterial({ color: '#141e2b', roughness: 0.95 });
const trim = new MeshStandardMaterial({ color: '#4a8291', emissive: '#246878', emissiveIntensity: 0.5 });

function box(name: string, size: [number, number, number], material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(new BoxGeometry(...size), material);
  mesh.name = name;
  return mesh;
}

// One continuous half-hexagonal worktop, with a matching recessed cabinet.
function consoleBand(outer: number, inner: number, thickness: number): Mesh {
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
  const geometry = new ExtrudeGeometry(outline, { depth: thickness, bevelEnabled: false, steps: 1, curveSegments: 1 });
  geometry.rotateX(-Math.PI / 2);
  return new Mesh(geometry, surface);
}

export function createCommandDesk(): Object3D {
  const desk = new Group();
  desk.name = 'Wraparound console';
  const top = consoleBand(RADIUS, 1.25, 0.055);
  top.name = 'Continuous three-facet worktop';
  top.position.y = 0.695;
  const cabinet = consoleBand(RADIUS - 0.04, 1.48, 0.63);
  cabinet.name = 'Recessed supporting cabinet';
  cabinet.position.y = 0.065;
  desk.add(top, cabinet);
  return desk;
}

export function createCommandRoom(): Object3D {
  const room = new Group();
  room.name = 'Hexagonal command room';
  const ground = new Mesh(new CylinderGeometry(RADIUS + 0.08, RADIUS + 0.08, 0.12, 6), floor);
  ground.rotation.y = Math.PI / 6;
  ground.name = 'Solid hexagonal floor';
  ground.position.y = -0.06;
  const ceiling = ground.clone();
  ceiling.name = 'Solid ceiling';
  ceiling.position.y = HEIGHT + 0.06;
  room.add(ground, ceiling);
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3;
    const apothem = RADIUS * Math.cos(Math.PI / 6);
    const panel = box(`Wall facet ${i + 1}`, [RADIUS + 0.08, HEIGHT, 0.12], wall);
    panel.position.set(Math.sin(angle) * apothem, HEIGHT / 2, -Math.cos(angle) * apothem);
    panel.rotation.y = -angle;
    const light = box(`Ceiling light ${i + 1}`, [RADIUS - 0.15, 0.035, 0.025], trim);
    light.position.set(Math.sin(angle) * (apothem - 0.075), HEIGHT - 0.16, -Math.cos(angle) * (apothem - 0.075));
    light.rotation.y = -angle;
    room.add(panel, light);
  }
  return room;
}
