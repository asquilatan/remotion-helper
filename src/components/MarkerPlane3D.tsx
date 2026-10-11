import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { PlaneMarker, PlaneView, Shape3D, ShapeKind, Vec3 } from '../types';
import { markers3DToRemotion } from '../lib/remotionExport';

interface Props {
  markers: PlaneMarker[];
  setMarkers: (m: PlaneMarker[]) => void;
  view: PlaneView;
  setView: (v: PlaneView) => void;
  shapes: Shape3D[];
  setShapes: (s: Shape3D[]) => void;
}

export const DEFAULT_PLANE_VIEW: PlaneView = {
  position: [1.1, -1.7, 1.5],
  target: [0, 0, 0],
};

const round3 = (v: Vec3): Vec3 => v.map((n) => +n.toFixed(4)) as Vec3;

let n = 0;
const nid = () => `m3d${Date.now().toString(36)}${(n++).toString(36)}`;

function makeLabel(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0e0f13';
  g.beginPath();
  g.arc(64, 64, 54, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = 'bold 62px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sp.scale.set(0.17, 0.17, 1);
  return sp;
}

const sphereGeo = new THREE.SphereGeometry(0.035, 24, 16);
const sphereMat = new THREE.MeshBasicMaterial({ color: '#ff6b35' });

export const SHAPE_KINDS: ShapeKind[] = ['cube', 'sphere', 'pyramid', 'cylinder', 'torus'];

const shapeGeos: Record<ShapeKind, THREE.BufferGeometry> = {
  cube: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 32, 16),
  pyramid: new THREE.ConeGeometry(0.5, 1, 4),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 24),
  torus: new THREE.TorusGeometry(0.4, 0.15, 12, 32),
};

const shapeMats: Record<ShapeKind, THREE.Material> = {
  cube: new THREE.MeshBasicMaterial({ color: '#ff6b35' }),
  sphere: new THREE.MeshBasicMaterial({ color: '#ffb703' }),
  pyramid: new THREE.MeshBasicMaterial({ color: '#ff8c42' }),
  cylinder: new THREE.MeshBasicMaterial({ color: '#f4a259' }),
  torus: new THREE.MeshBasicMaterial({ color: '#e56b6f' }),
};

const wireMat = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.22 });

const SHARED_GEO = new Set<THREE.BufferGeometry>([sphereGeo, ...Object.values(shapeGeos)]);
const SHARED_MAT = new Set<THREE.Material>([sphereMat, ...Object.values(shapeMats), wireMat]);

/** Dispose only per-instance resources (label textures); shared geo/mats survive. */
function disposeDynamic(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry && !SHARED_GEO.has(mesh.geometry as THREE.BufferGeometry)) {
      mesh.geometry.dispose();
    }
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
      if (SHARED_MAT.has(m)) continue;
      const sm = m as THREE.SpriteMaterial;
      if (sm.map) sm.map.dispose();
      m.dispose();
    }
  });
}

export default function MarkerPlane3D({ markers, setMarkers, view, setView, shapes, setShapes }: Props) {
  const [mode, setMode] = useState<'orbit' | 'place'>('orbit');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const planeRef = useRef<THREE.Mesh | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const shapeGroupRef = useRef<THREE.Group | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const downAt = useRef<[number, number] | null>(null);
  // View captured at mount for camera init; later `view` changes (reset) are applied below.
  const initView = useRef(view);
  // Latest commit callback for the controls 'end' listener (bound once at mount).
  const commitRef = useRef(() => {});
  commitRef.current = () => {
    const cam = cameraRef.current;
    const ctl = controlsRef.current;
    if (!cam || !ctl) return;
    setView({
      position: round3([cam.position.x, cam.position.y, cam.position.z]),
      target: round3([ctl.target.x, ctl.target.y, ctl.target.z]),
    });
  };

  // Scene: built once. Camera orbits; the plane itself never moves.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    box.appendChild(renderer.domElement);
    canvasRef.current = renderer.domElement;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0a0b0e');
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    camera.position.fromArray(initView.current.position);
    cameraRef.current = camera;

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ color: '#12141b' }),
    );
    scene.add(plane);
    planeRef.current = plane;

    const grid = new THREE.GridHelper(2, 20, '#4a5168', '#262c3d');
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0.001;
    scene.add(grid);

    const frameGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1, -1, 0.002),
      new THREE.Vector3(1, -1, 0.002),
      new THREE.Vector3(1, 1, 0.002),
      new THREE.Vector3(-1, 1, 0.002),
    ]);
    scene.add(new THREE.LineLoop(frameGeo, new THREE.LineBasicMaterial({ color: '#ffb703' })));

    const group = new THREE.Group();
    scene.add(group);
    groupRef.current = group;

    const shapeGroup = new THREE.Group();
    scene.add(shapeGroup);
    shapeGroupRef.current = shapeGroup;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance = 0.8;
    controls.maxDistance = 8;
    controls.target.fromArray(initView.current.target);
    controlsRef.current = controls;
    // Commit the angle to context once per interaction (release), never per move.
    const onEnd = () => commitRef.current();
    controls.addEventListener('end', onEnd);

    const fit = () => {
      const w = box.clientWidth || 1;
      const h = box.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);

    let raf = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.removeEventListener('end', onEnd);
      controls.dispose();
      renderer.dispose();
      box.removeChild(renderer.domElement);
      canvasRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      planeRef.current = null;
      groupRef.current = null;
      shapeGroupRef.current = null;
      controlsRef.current = null;
    };
  }, []);

  // Orbit only in orbit mode — in place mode drags/clicks hit the plane, not the camera.
  useEffect(() => {
    if (controlsRef.current) controlsRef.current.enabled = mode === 'orbit';
  }, [mode]);

  // Apply externally-changed views (e.g. Reset all) to the live camera.
  useEffect(() => {
    const cam = cameraRef.current;
    const ctl = controlsRef.current;
    if (!cam || !ctl) return;
    cam.position.fromArray(view.position);
    ctl.target.fromArray(view.target);
  }, [view]);

  // Rebuild marker meshes when the list changes (scene/camera untouched).
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    disposeDynamic(group);
    group.clear();
    markers.forEach((m, i) => {
      const wx = m.x * 2 - 1;
      const wy = 1 - m.y * 2;
      const dot = new THREE.Mesh(sphereGeo, sphereMat);
      dot.position.set(wx, wy, m.z + 0.03);
      const tag = makeLabel(String(i + 1));
      tag.position.set(wx, wy, m.z + 0.16);
      group.add(dot, tag);
    });
  }, [markers]);

  // Rebuild shape meshes on change; transforms come straight from state.
  useEffect(() => {
    const sg = shapeGroupRef.current;
    if (!sg) return;
    disposeDynamic(sg);
    sg.clear();
    shapes.forEach((s, si) => {
      const g = new THREE.Group();
      g.userData.shapeId = s.id;
      g.position.fromArray(s.position);
      g.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);
      g.scale.fromArray(s.scale);
      const geo = shapeGeos[s.kind];
      g.add(new THREE.Mesh(geo, shapeMats[s.kind]));
      g.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), wireMat));
      const tag = makeLabel(String(si + 1));
      tag.position.set(0, 0.95, 0);
      g.add(tag);
      sg.add(g);
    });
  }, [shapes]);

  const onCanvasDown = (e: React.PointerEvent) => {
    if (mode === 'orbit') {
      // Record for click-vs-drag detection (selection happens on pointer-up).
      downAt.current = [e.clientX, e.clientY];
      return;
    }
    const canvas = canvasRef.current;
    const camera = cameraRef.current;
    const plane = planeRef.current;
    if (!canvas || !camera || !plane) return;
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(plane)[0];
    if (!hit) return;
    const x = Math.min(1, Math.max(0, (hit.point.x + 1) / 2));
    const y = Math.min(1, Math.max(0, (1 - hit.point.y) / 2));
    setMarkers([...markers, { id: nid(), label: `M${markers.length + 1}`, x: +x.toFixed(4), y: +y.toFixed(4), z: 0 }]);
  };

  const raycastAt = (clientX: number, clientY: number, targets: THREE.Object3D[]) => {
    const canvas = canvasRef.current;
    const camera = cameraRef.current;
    if (!canvas || !camera) return null;
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(targets, true)[0] ?? null;
  };

  // Click (not drag) on a shape in orbit mode selects it; empty space deselects.
  const onCanvasUp = (e: React.PointerEvent) => {
    if (mode !== 'orbit' || !downAt.current) return;
    const [dx, dy] = downAt.current;
    downAt.current = null;
    if (Math.hypot(e.clientX - dx, e.clientY - dy) > 5) return;
    const sg = shapeGroupRef.current;
    if (!sg) return;
    const hit = raycastAt(e.clientX, e.clientY, sg.children);
    if (!hit) {
      setSelectedId(null);
      return;
    }
    let o: THREE.Object3D | null = hit.object;
    while (o && !o.userData.shapeId) o = o.parent;
    setSelectedId((o?.userData.shapeId as string | undefined) ?? null);
  };

  const cap = (k: ShapeKind) => k[0].toUpperCase() + k.slice(1);

  const addShape = (kind: ShapeKind) => {
    const s: Shape3D = {
      id: nid(),
      label: `${cap(kind)}${shapes.length + 1}`,
      kind,
      position: [0, 0, 0.4],
      rotation: [0, 0, 0],
      scale: [0.4, 0.4, 0.4],
    };
    setShapes([...shapes, s]);
    setSelectedId(s.id);
  };

  const setVec = (id: string, key: 'position' | 'rotation' | 'scale', axis: 0 | 1 | 2, v: number) => {
    setShapes(
      shapes.map((s) => {
        if (s.id !== id) return s;
        const next = [...s[key]] as Vec3;
        next[axis] = Number.isFinite(v) ? v : 0;
        return { ...s, [key]: next };
      }),
    );
  };

  const deleteShape = (id: string) => {
    if (selectedId === id) setSelectedId(null);
    setShapes(shapes.filter((s) => s.id !== id));
  };

  const selected = shapes.find((s) => s.id === selectedId) ?? null;
  const snippet = markers3DToRemotion(markers, view, shapes);

  return (
    <div className="grid2">
      <div>
        <div className="row" style={{ marginTop: 0, marginBottom: 10 }}>
          <button className={mode === 'orbit' ? 'btn' : 'btn ghost'} onClick={() => setMode('orbit')}>
            Orbit view
          </button>
          <button className={mode === 'place' ? 'btn' : 'btn ghost'} onClick={() => setMode('place')}>
            Place markers
          </button>
        </div>
        <div className="hint">
          {mode === 'orbit'
            ? 'Drag to rotate, scroll to zoom, right-drag to pan.'
            : 'Click anywhere on the plane to drop a marker (normalized 0..1, y-down like 2D).'}
        </div>
        <div
          ref={boxRef}
          className="plane3d"
          style={{ cursor: mode === 'place' ? 'crosshair' : 'grab' }}
          onPointerDown={onCanvasDown}
          onPointerUp={onCanvasUp}
        />
        <div className="row">
          <button className="btn ghost" onClick={() => setMarkers([])} disabled={!markers.length}>
            Clear markers
          </button>
          <button
            className="btn ghost"
            onClick={() => setMarkers(markers.slice(0, -1))}
            disabled={!markers.length}
          >
            Undo last
          </button>
        </div>
        <div className="hint mono" style={{ marginTop: 8 }}>
          cam [{view.position.map((v) => v.toFixed(2)).join(', ')}] → tgt [
          {view.target.map((v) => v.toFixed(2)).join(', ')}] · saved on release
        </div>
      </div>
      <div>
        <h3>Plane markers ({markers.length})</h3>
        <ol className="chain mono">
          {markers.map((m, i) => (
            <li key={m.id}>
              <code>
                {m.label}: {m.x.toFixed(4)}, {m.y.toFixed(4)}, {m.z.toFixed(4)}
                <span className="dim"> · #{i + 1} on plane</span>
              </code>
              <span className="mini-row">
                <button
                  className="mini danger"
                  onClick={() => setMarkers(markers.filter((x) => x.id !== m.id))}
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
          {markers.length === 0 && <li className="dim">No markers — switch to Place mode.</li>}
        </ol>
        <h3>Shapes ({shapes.length})</h3>
        <div className="row wrap" style={{ marginTop: 0 }}>
          {SHAPE_KINDS.map((k) => (
            <button
              key={k}
              className="mini"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => addShape(k)}
            >
              + {cap(k)}
            </button>
          ))}
        </div>
        <ol className="chain mono" style={{ marginTop: 8 }}>
          {shapes.map((s, i) => (
            <li key={s.id} className={selectedId === s.id ? 'sel' : ''}>
              <code onClick={() => setSelectedId(s.id)} style={{ cursor: 'pointer' }}>
                {s.label} · {s.kind} <span className="dim">#{i + 1}</span>
              </code>
              <span className="mini-row">
                <button className="mini danger" onClick={() => deleteShape(s.id)}>✕</button>
              </span>
            </li>
          ))}
          {shapes.length === 0 && <li className="dim">Add a preset shape above.</li>}
        </ol>
        {selected && (
          <>
            <h3>
              {selected.label} · {selected.kind}
            </h3>
            {(
              [
                ['position', 'Pos', 0.1],
                ['rotation', 'Rot°', 5],
                ['scale', 'Scale', 0.05],
              ] as const
            ).map(([key, label, step]) => (
              <div className="xform-row" key={key}>
                <span>{label}</span>
                {([0, 1, 2] as const).map((axis) => {
                  const raw = selected[key][axis];
                  const shown = key === 'rotation' ? +((raw * 180) / Math.PI).toFixed(1) : raw;
                  return (
                    <input
                      key={axis}
                      type="number"
                      step={step}
                      value={shown}
                      onChange={(e) => {
                        const v = +e.target.value;
                        setVec(selected.id, key, axis, key === 'rotation' ? (v * Math.PI) / 180 : v);
                      }}
                    />
                  );
                })}
              </div>
            ))}
            <div className="row">
              <button className="btn ghost" onClick={() => deleteShape(selected.id)}>
                Delete {selected.label}
              </button>
            </div>
          </>
        )}
        <h3>Remotion export</h3>
        <pre className="code">{snippet}</pre>
        <button className="btn" onClick={() => navigator.clipboard.writeText(snippet)}>
          Copy snippet
        </button>
      </div>
    </div>
  );
}
