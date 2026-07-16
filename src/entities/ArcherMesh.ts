/**
 * Low-poly stylized archer mesh — isometric-readable, ~800 triangles.
 *
 * Built entirely from Three.js primitives. Designed for group-scale
 * multiplication (e.g. scale=3 for a ~6-unit-tall hero).
 */
import * as THREE from 'three';

// ── Palette (from spec) ──────────────────────────────────────────
const C = {
  hair:     0x4A3526,
  skin:     0xD7B48A,
  cape:     0x5A7F39,
  tunic:    0x6D8F45,
  leather:  0x7A5530,
  darkBrown:0x4A3320,
  metal:    0xBFC4C9,
  bow:      0x8B5A2B,
  pants:    0x8B7D5C,
  shaft:    0x8B6B4A,
  fletching:0xD0D0C0,
  headGrey: 0x909090,
};

function blendColor(base: number, tint: number, factor: number): number {
  const r0 = (base >> 16) & 0xff, g0 = (base >> 8) & 0xff, b0 = base & 0xff;
  const r1 = (tint >> 16) & 0xff, g1 = (tint >> 8) & 0xff, b1 = tint & 0xff;
  const r = Math.round(r0 + (r1 - r0) * factor);
  const g = Math.round(g0 + (g1 - g0) * factor);
  const b = Math.round(b0 + (b1 - b0) * factor);
  return (r << 16) | (g << 8) | b;
}

function mat(color: number, rough = 0.7, metal = 0.0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, flatShading: true });
}

// ── Helpers ──────────────────────────────────────────────────────

function cyl(
  rTop: number, rBot: number, h: number, segs = 8, color: number, rough = 0.7, metal = 0.0,
): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(rTop, rBot, h, segs);
  const m = mat(color, rough, metal);
  const mesh = new THREE.Mesh(geo, m);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function box(
  w: number, h: number, d: number, color: number, rough = 0.7, metal = 0.0,
): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, h, d);
  const m = mat(color, rough, metal);
  const mesh = new THREE.Mesh(geo, m);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function sphere(r: number, segs = 10, color: number, rough = 0.7, metal = 0.0): THREE.Mesh {
  const geo = new THREE.SphereGeometry(r, segs, segs / 2);
  const m = mat(color, rough, metal);
  const mesh = new THREE.Mesh(geo, m);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Thin tube along a list of points. */
function tube(
  pts: THREE.Vector3[], radius: number, segs = 6, color: number, rough = 0.7,
): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo = new THREE.TubeGeometry(curve, pts.length * 4, radius, segs, false);
  const m = mat(color, rough);
  const mesh = new THREE.Mesh(geo, m);
  mesh.castShadow = true;
  return mesh;
}

// ── Builder ──────────────────────────────────────────────────────

export function buildArcherMesh(teamColor?: number): THREE.Group {
  const root = new THREE.Group();

  // Blend team color into tunic/cape/hood if provided.
  const tunic = teamColor != null ? blendColor(C.tunic, teamColor, 0.55) : C.tunic;
  const cape  = teamColor != null ? blendColor(C.cape,  teamColor, 0.55) : C.cape;

  // ── Legs (each leg is a group pivoted at the hip so it can swing) ──
  const bootH = 0.22;
  const bootR = 0.1;
  const footOffset = 0.1;
  const legLowerH = 0.35;
  const legUpperH = 0.35;
  const legR = 0.09;
  const legY0 = bootH;
  const thighY0 = legY0 + legLowerH;
  const hipY = thighY0 + legUpperH;

  function buildLeg(name: string, side: -1 | 1): THREE.Group {
    const leg = new THREE.Group();
    leg.name = name;
    leg.position.set(side * footOffset, hipY, 0);

    const boot = cyl(bootR, bootR * 0.85, bootH, 8, C.darkBrown);
    boot.position.y = bootH / 2 - hipY;
    leg.add(boot);

    const lower = cyl(legR * 0.95, legR, legLowerH, 8, C.pants);
    lower.position.y = legY0 + legLowerH / 2 - hipY;
    leg.add(lower);

    const thigh = cyl(legR, legR * 0.9, legUpperH, 8, C.pants);
    thigh.position.y = thighY0 + legUpperH / 2 - hipY;
    leg.add(thigh);

    return leg;
  }

  root.add(buildLeg('legL', -1));
  root.add(buildLeg('legR', 1));

  // ── Pelvis ──
  const pelvisY = hipY;
  const pelvis = cyl(0.14, 0.13, 0.10, 8, C.pants);
  pelvis.position.y = pelvisY + 0.05;
  root.add(pelvis);

  // ── Belt ──
  const beltY = pelvisY + 0.10;
  const belt = cyl(0.145, 0.145, 0.07, 12, C.leather);
  belt.position.y = beltY + 0.035;
  root.add(belt);

  // Belt buckle
  const buckle = box(0.06, 0.05, 0.04, C.metal, 0.4, 0.6);
  buckle.position.set(0, beltY + 0.035, 0.13);
  root.add(buckle);

  // ── Torso (heroBody — used for hit flash & dummy coloring) ──
  const torsoY0 = beltY + 0.07;
  const torsoH = 0.48;
  const torso = cyl(0.14, 0.13, torsoH, 8, tunic);
  torso.position.y = torsoY0 + torsoH / 2;
  torso.name = 'heroBody';
  root.add(torso);

  // ── Neck ──
  const neckY = torsoY0 + torsoH;
  const neck = cyl(0.06, 0.065, 0.09, 8, C.skin);
  neck.position.y = neckY + 0.045;
  root.add(neck);

  // ── Head ──
  const headY = neckY + 0.09;
  const headR = 0.16;
  const head = sphere(headR, 10, C.skin);
  head.position.y = headY + headR;
  head.name = 'heroHead';
  root.add(head);

  // ── Hair (wedges) ──
  const hairTop = headY + headR * 2;
  const hairMat = mat(C.hair, 0.9);

  // Back/sides hair (thick band wrapping around head)
  const hairBand = cyl(headR + 0.02, headR + 0.02, 0.08, 10, C.hair);
  hairBand.position.y = headY + headR * 1.7;
  root.add(hairBand);

  // Top wedge
  const hairWedge = box(0.18, 0.09, 0.16, C.hair);
  hairWedge.position.set(0, hairTop + 0.02, -0.04);
  hairWedge.rotation.x = -0.2;
  root.add(hairWedge);

  // Side tufts
  const lTuft = box(0.06, 0.06, 0.1, C.hair);
  lTuft.position.set(-0.12, headY + headR * 1.5, 0);
  lTuft.rotation.z = 0.5;
  root.add(lTuft);

  const rTuft = box(0.06, 0.06, 0.1, C.hair);
  rTuft.position.set(0.12, headY + headR * 1.5, 0);
  rTuft.rotation.z = -0.5;
  root.add(rTuft);

  // ── Arms (each arm is a group pivoted at the shoulder so it can swing) ──
  const shoulderY = torsoY0 + torsoH - 0.06;
  const shoulderX = 0.20;
  const upperArmLen = 0.32;
  const forearmLen = 0.30;

  // Left arm (bow arm — slightly forward)
  const armL = new THREE.Group();
  armL.name = 'armL';
  armL.position.set(-shoulderX, shoulderY, 0);

  const lUpper = cyl(0.06, 0.055, upperArmLen, 8, tunic);
  lUpper.position.set(0, -upperArmLen / 2, 0.04);
  lUpper.rotation.z = 0.45;
  lUpper.rotation.x = -0.15;
  armL.add(lUpper);

  const lForearm = cyl(0.065, 0.06, forearmLen, 8, C.darkBrown); // bracer
  lForearm.position.set(-0.22, -upperArmLen - forearmLen / 2 + 0.03, 0.08);
  lForearm.rotation.z = 0.15;
  armL.add(lForearm);

  const lHand = sphere(0.06, 6, C.skin);
  lHand.position.set(-0.27, -upperArmLen - forearmLen + 0.06, 0.09);
  lHand.name = 'leftHand';
  armL.add(lHand);

  root.add(armL);

  // Right arm (draw arm)
  const armR = new THREE.Group();
  armR.name = 'armR';
  armR.position.set(shoulderX, shoulderY, 0);

  const rUpper = cyl(0.06, 0.055, upperArmLen, 8, tunic);
  rUpper.position.set(0, -upperArmLen / 2, -0.02);
  rUpper.rotation.z = -0.35;
  armR.add(rUpper);

  const rForearm = cyl(0.065, 0.06, forearmLen, 8, C.darkBrown); // bracer
  rForearm.position.set(0.18, -upperArmLen - forearmLen / 2 + 0.02, -0.01);
  rForearm.rotation.z = -0.1;
  armR.add(rForearm);

  const rHand = sphere(0.06, 6, C.skin);
  rHand.position.set(0.22, -upperArmLen - forearmLen + 0.05, 0.0);
  rHand.name = 'rightHand';
  armR.add(rHand);

  root.add(armR);

  // ── Hood / Cape ──
  const collarY = neckY + 0.02;
  // Thick folded collar (torus-like ring)
  const collarGeo = new THREE.TorusGeometry(0.16, 0.06, 6, 12);
  const collar = new THREE.Mesh(collarGeo, mat(cape));
  collar.position.y = collarY;
  collar.rotation.x = Math.PI / 2;
  collar.castShadow = true;
  root.add(collar);

  // Cape drape on the back (two angled boxes)
  const cape1 = box(0.20, 0.25, 0.04, cape);
  cape1.position.set(0, collarY - 0.08, -0.18);
  cape1.rotation.x = 0.4;
  root.add(cape1);

  const cape2 = box(0.18, 0.20, 0.04, cape);
  cape2.position.set(0, collarY - 0.22, -0.24);
  cape2.rotation.x = 0.55;
  root.add(cape2);

  // ── Quiver ──
  const quiverLen = 0.65;
  const quiverW = 0.08;
  const quiverAngle = -0.55; // diagonal on back
  const quiverGroup = new THREE.Group();
  quiverGroup.position.set(0.18, collarY + 0.02, -0.22);
  quiverGroup.rotation.x = quiverAngle;

  const quiverBody = box(quiverW, quiverLen, quiverW, C.leather);
  quiverBody.position.y = -quiverLen / 2;
  quiverGroup.add(quiverBody);

  // Arrows sticking out
  for (let i = 0; i < 5; i++) {
    const arrowShaft = cyl(0.012, 0.012, 0.18, 6, C.shaft);
    arrowShaft.position.set((i - 2) * 0.03, 0.04, 0);
    quiverGroup.add(arrowShaft);

    const arrowHead = cyl(0.0, 0.018, 0.04, 4, C.metal);
    arrowHead.position.set((i - 2) * 0.03, 0.14, 0);
    quiverGroup.add(arrowHead);

    const fletch = box(0.02, 0.04, 0.006, C.fletching);
    fletch.position.set((i - 2) * 0.03, -0.02, 0);
    quiverGroup.add(fletch);
  }

  // Leather strap across chest
  const strap = box(0.03, 0.25, 0.02, C.darkBrown);
  strap.position.set(0.08, torsoY0 + torsoH * 0.65, 0.13);
  strap.rotation.z = -0.25;
  root.add(strap);

  root.add(quiverGroup);

  // ── Bow (left hand) ──
  const bowGroup = new THREE.Group();
  const bowPts = [
    new THREE.Vector3(0, -0.55, 0),
    new THREE.Vector3(0.06, -0.30, -0.04),
    new THREE.Vector3(0.08, 0, -0.06),
    new THREE.Vector3(0.06, 0.30, -0.04),
    new THREE.Vector3(0, 0.55, 0),
  ];
  const bowMesh = tube(bowPts, 0.025, 6, C.bow);
  bowGroup.add(bowMesh);

  // Bow grip
  const grip = cyl(0.035, 0.035, 0.12, 8, C.darkBrown);
  grip.position.set(0.04, 0, -0.03);
  grip.rotation.z = Math.PI / 2;
  bowGroup.add(grip);

  // Bowstring
  const stringPts = [
    new THREE.Vector3(0, -0.55, 0),
    new THREE.Vector3(-0.04, -0.30, -0.01),
    new THREE.Vector3(-0.05, 0, -0.02),
    new THREE.Vector3(-0.04, 0.30, -0.01),
    new THREE.Vector3(0, 0.55, 0),
  ];
  const stringMesh = tube(stringPts, 0.008, 4, 0xD0D0C0);
  bowGroup.add(stringMesh);

  // Position bow at left hand (inside the arm group so it swings with it)
  const lHandPos = lHand.position.clone();
  bowGroup.position.copy(lHandPos).add(new THREE.Vector3(0.02, -0.02, 0.05));
  bowGroup.rotation.set(0.1, 0, -0.15);
  bowGroup.name = 'bow';
  armL.add(bowGroup);

  return root;
}
