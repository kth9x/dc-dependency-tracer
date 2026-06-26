import type CameraControls from "camera-controls";

// Shared handle to the scene's CameraControls (original `lg.ctrl`),
// so the toolbar's "Reset view" can drive the camera.
export const controlsRef: { ctrl: CameraControls | null } = { ctrl: null };

export function resetView() {
  controlsRef.ctrl?.reset(true);
}

/** Fly the camera to a node at floor position (x, z) — used by the SPOF audit. */
export function focusNode(x: number, z: number) {
  controlsRef.ctrl?.setLookAt(x + 3, 5, z + 3, x, 0.3, z, true);
}
