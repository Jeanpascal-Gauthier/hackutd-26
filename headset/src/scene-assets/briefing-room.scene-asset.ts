import { BoxGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, TorusGeometry } from '@iwsdk/core';

/** Quiet square shell: floor at Y=0, clear standing space, 10 m wall envelope. */
export function createBriefingRoom(): Group {
  const room = new Group();
  room.name = 'FireEye briefing room';
  const floor = new Mesh(new BoxGeometry(2000, 0.02, 2000), new MeshBasicMaterial({ color: '#e4e8eb' }));
  floor.name = 'Endless white floor';
  floor.position.y = -0.02;
  room.add(floor);
  const glass = new MeshBasicMaterial({ color: '#8ba5b2', transparent: true, opacity: 0.035, depthWrite: false, side: DoubleSide });
  const edge = new MeshBasicMaterial({ color: '#acbdc5', transparent: true, opacity: 0.22, depthWrite: false });
  for (let side = 0; side < 4; side++) {
    const wall = new Group();
    wall.name = `Clear wall ${side + 1}`;
    const pane = new Mesh(new BoxGeometry(10, 3, 0.01), glass);
    pane.position.set(0, 1.5, -5);
    const seam = new Mesh(new BoxGeometry(10, 0.012, 0.012), edge);
    seam.position.set(0, 0.01, -5);
    wall.add(pane, seam);
    wall.rotation.y = side * Math.PI / 2;
    room.add(wall);
  }
  return room;
}

/** Selected-coordinate marker, not a claim about an incident's measured footprint. */
export function createIncidentMarker(): Group {
  const marker = new Group();
  marker.name = 'Selected incident coordinate';
  const material = new MeshBasicMaterial({ color: '#27d8ef', depthTest: false });
  const ring = new Mesh(new TorusGeometry(10, 0.6, 4, 32), material);
  ring.name = 'Location ring'; ring.rotation.x = Math.PI / 2; ring.position.y = 1;
  const stem = new Mesh(new CylinderGeometry(0.7, 0.7, 12, 8), material);
  stem.name = 'Location beacon'; stem.position.y = 6;
  marker.add(ring, stem);
  marker.renderOrder = 10;
  return marker;
}
