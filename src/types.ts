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

export interface HelperContext {
  updatedAt: string;
  project: ProjectSettings;
  waypoints: Waypoint[];
  taps: TapState;
  speedCurve: SpeedCurveState;
}

export type ToolTab = 'waypoints' | 'timer' | 'curve';
