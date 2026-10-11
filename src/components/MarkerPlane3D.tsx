import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Marker3D, PlaneView, SurfaceKind, Vec3 } from '../types';
import { markers3DToRemotion } from '../lib/remotionExport';

interface Props {
  markers: Marker3D[];
  setMarkers: (m: Marker3D[]) => void;
  view: PlaneView;
  setView: (v: PlaneView) => void;
  surface: SurfaceKind;
  setSurface: (s: SurfaceKind) => void;
}

export const SURFACES: SurfaceKind[] = ['plane', 'sphere', 'cube', 'cylinder', 'torus', 'cone'];

export const DEFAULT_PLANE_VIEW: PlaneView = {
  position: [1.1, -1.7, 1.5],
  target: [0, 0, 0],
};

const round4 = (v: Vec3): Vec3 => v.map((n) => +n.toFixed(4)) as Vec3;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

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

const dotGeo = new THREE.SphereGeometry(0.035, 24, 16);
const dotMat = new THREE.MeshBasicMaterial({ color: '#ff6b35' });
const solidMat = new THREE.MeshBasicMaterial({ color: '#14161d' });
const edgeMat = new THREE.LineBasicMaterial({ color: '#4a5168' });
const frameMat = new THREE.LineBasicMaterial({ color: '#ffb703' });
const wireMat = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.14 });

const SHARED_GEO = new Set<THREE.BufferGeometry>([dotGeo]);
const SHARED_MAT = new Set<THREE.Material>([dotMat, solidMat, edgeMat, frameMat, wireMat]);

/** Dispose only per-instance resources (surface geos, label textures); shared ones survive. */
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

/** Build the pickable surface mesh plus its decoration; caller owns disposal. */
function buildSurface(kind: SurfaceKind): { mesh: THREE.Mesh; extras: THREE.Object3D[] } {
  const solid = (geo: THREE.BufferGeometry) => new THREE.Mesh(geo, solidMat);
  switch (kind) {
    case 'sphere': {
      const mesh = solid(new THREE.SphereGeometry(1, 48, 32));
      const wire = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(1, 12, 8)), wireMat);
      return { mesh, extras: [wire] };
    }
    case 'cube': {
      const geo = new THREE.BoxGeometry(1.6, 1.6, 1.6);
      const mesh = solid(geo);
      return { mesh, extras: [new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat)] };
    }
    case 'cylinder': {
      const geo = new THREE.CylinderGeometry(0.8, 0.8, 1.6, 36);
      const mesh = solid(geo);
      return { mesh, extras: [new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), edgeMat)] };
    }
    case 'torus': {
      const mesh = solid(new THREE.TorusGeometry(0.7, 0.25, 24, 56));
      const wire = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.TorusGeometry(0.7, 0.25, 8, 24)),
        wireMat,
      );
      return { mesh, extras: [wire] };
    }
    case 'cone': {
      const geo = new THREE.ConeGeometry(0.85, 1.7, 36);
      const mesh = solid(geo);
      return { mesh, extras: [new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), edgeMat)] };
    }
    case 'plane':
    default: {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: '#12141b' }));
      const grid = new THREE.GridHelper(2, 20, '#4a5168', '#262c3d');
      grid.rotation.x = Math.PI / 2;
      grid.position.z = 0.001;
      const frameGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-1, -1, 0.002),
        new THREE.Vector3(1, -1, 0.002),
        new THREE.Vector3(1, 1, 0.002),
        new THREE.Vector3(-1, 1, 0.002),
      ]);
      return { mesh, extras: [grid, new THREE.LineLoop(frameGeo, frameMat)] };
    }
  }
}

export default function MarkerPlane3D({ markers, setMarkers, view, setView, surface, setSurface }: Props) {
  const [mode, setMode] = useState<'orbit' | 'place'>('orbit');
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const surfaceMeshRef = useRef<THREE.Mesh | null>(null);
  const surfaceGroupRef = useRef<THREE.Group | null>(null);
  const markerGroupRef = useRef<THREE.Group | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  // View captured at mount for camera init; later `view` changes (reset) are applied below.
  const initView = useRef(view);
  // Latest commit callback for the controls 'end' listener (bound once at mount).
  const commitRef = useRef(() => {});
  commitRef.current = () => {
    const cam = cameraRef.current;
    const ctl = controlsRef.current;
    if (!cam || !ctl) return;
    setView({
      position: round4([cam.position.x, cam.position.y, cam.position.z]),
      target: round4([ctl.target.x, ctl.target.y, ctl.target.z]),
    });
  };

  // Scene shell: built once. Surface + markers rebuild via effects below.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    box.appendChild(renderer.domElement);
    canvasRef.current = renderer.domElement;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0a0b0e');

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    camera.position.fromArray(initView.current.position);
    cameraRef.current = camera;

    const surfaceGroup = new THREE.Group();
    scene.add(surfaceGroup);
    surfaceGroupRef.current = surfaceGroup;

    const markerGroup = new THREE.Group();
    scene.add(markerGroup);
    markerGroupRef.current = markerGroup;

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
      cameraRef.current = null;
      surfaceMeshRef.current = null;
      surfaceGroupRef.current = null;
      markerGroupRef.current = null;
      controlsRef.current = null;
    };
  }, []);

  // Orbit only in orbit mode — in place mode drags/clicks hit the surface, not the camera.
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

  // Rebuild the surface when the kind changes.
  useEffect(() => {
    const sg = surfaceGroupRef.current;
    if (!sg) return;
    disposeDynamic(sg);
    sg.clear();
    const { mesh, extras } = buildSurface(surface);
    sg.add(mesh, ...extras);
    surfaceMeshRef.current = mesh;
  }, [surface]);

  // Rebuild marker meshes when the list changes (scene/camera untouched).
  useEffect(() => {
    const group = markerGroupRef.current;
    if (!group) return;
    disposeDynamic(group);
    group.clear();
    markers.forEach((m, i) => {
      const p = new THREE.Vector3(...m.position);
      const nv = new THREE.Vector3(...m.normal).normalize();
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.copy(p).addScaledVector(nv, 0.02);
      const tag = makeLabel(String(i + 1));
      tag.position.copy(p).addScaledVector(nv, 0.16);
      group.add(dot, tag);
    });
  }, [markers]);

  const raycastSurface = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const camera = cameraRef.current;
    const mesh = surfaceMeshRef.current;
    if (!canvas || !camera || !mesh) return null;
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    return ray.intersectObject(mesh)[0] ?? null;
  };

  const onCanvasDown = (e: React.PointerEvent) => {
    if (mode !== 'place') return;
    const hit = raycastSurface(e.clientX, e.clientY);
    if (!hit || !hit.face) return;
    // Surfaces never rotate themselves (only the camera orbits), so object = world space.
    const nv = hit.face.normal.clone().normalize();
    const position = round4([hit.point.x, hit.point.y, hit.point.z]);
    const normal = round4([nv.x, nv.y, nv.z]);
    setMarkers([...markers, { id: nid(), label: `M${markers.length + 1}`, position, normal }]);
  };

  const snippet = markers3DToRemotion(markers, view, surface);
  const fmt = (v: Vec3) => v.map((n) => n.toFixed(3)).join(', ');

  return (
    <div className="grid2">
      <div>
        <div className="row wrap" style={{ marginTop: 0, marginBottom: 10 }}>
          {SURFACES.map((s) => (
            <button
              key={s}
              className={surface === s ? 'btn' : 'btn ghost'}
              onClick={() => setSurface(s)}
            >
              {cap(s)}
            </button>
          ))}
        </div>
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
            ? `Drag to rotate the ${surface}, scroll to zoom, right-drag to pan.`
            : `Click anywhere on the ${surface} to drop a marker (world-space position + normal).`}
        </div>
        <div
          ref={boxRef}
          className="plane3d"
          style={{ cursor: mode === 'place' ? 'crosshair' : 'grab' }}
          onPointerDown={onCanvasDown}
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
        <h3>
          {cap(surface)} markers ({markers.length})
        </h3>
        <ol className="chain mono">
          {markers.map((m, i) => (
            <li key={m.id}>
              <code title={`normal: ${fmt(m.normal)}`}>
                {m.label}: {fmt(m.position)}
                <span className="dim"> · #{i + 1}</span>
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
        <h3>Remotion export</h3>
        <pre className="code">{snippet}</pre>
        <button className="btn" onClick={() => navigator.clipboard.writeText(snippet)}>
          Copy snippet
        </button>
      </div>
    </div>
  );
}
