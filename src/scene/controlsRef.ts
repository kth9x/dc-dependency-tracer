import type CameraControls from "camera-controls";

// Shared handle to the scene's CameraControls (original `lg.ctrl`),
// so the toolbar's "Reset view" can drive the camera.
export const controlsRef: { ctrl: CameraControls | null } = { ctrl: null };

export function resetView() {
  controlsRef.ctrl?.reset(true);
}
