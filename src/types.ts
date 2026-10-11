export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
}

export interface Waypoint {
  id: string;
  /** normalized 0..1 */
  x: number;
  /** normalized 0..1 */
  y: number;
  label: string;
}

export interface TapState {
  /** absolute seconds since first tap */
  taps: number[];
}

export interface SpeedCurveState {
  /** seconds for the preview / remotion timing */
  duration: number;
  /** cubic-bezier control points [x1, y1, x2, y2] */
  bezier: [number, number, number, number];
}

export interface StageBg {
  url: string;
  updatedAt: string;
}

export interface StrokePoint {
  /** normalized 0..1 */
  x: number;
  /** normalized 0..1 */
  y: number;
  /** seconds since pen-down — this is the speed profile */
  t: number;
}

export interface Stroke {
  id: string;
  label: string;
  points: StrokePoint[];
}

export type Vec3 = [number, number, number];

export type SurfaceKind = 'plane' | 'sphere' | 'cube' | 'cylinder' | 'torus' | 'cone';

export interface Marker3D {
  id: string;
  label: string;
  /** world-space point on the surface */
  position: Vec3;
  /** surface normal there (for orienting things in Remotion) */
  normal: Vec3;
}

export interface PlaneView {
  /** world-space camera position — the rotation angle you left the plane at */
  position: Vec3;
  /** orbit target */
  target: Vec3;
}

export interface HelperContext {
  updatedAt: string;
  project: ProjectSettings;
  waypoints: Waypoint[];
  strokes: Stroke[];
  markers3d: Marker3D[];
  surface: SurfaceKind;
  planeView: PlaneView;
  taps: TapState;
  speedCurve: SpeedCurveState;
  stageBg: StageBg | null;
}
