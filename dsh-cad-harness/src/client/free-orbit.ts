// Free orbit for the CAD viewports.
//
// This is deliberately NOT TrackballControls. The user's description of the
// old (OrbitControls) feel is the spec: left-button drag turns the model as if
// the grabbed point followed the cursor, regardless of where on the model the
// drag started; right-button drag pans at the old speed. OrbitControls gets
// both from linear screen formulas that never look at the pointer's absolute
// position:
//
//   yaw   = 2π · dx / clientHeight · rotateSpeed      (left drag)
//   pitch = 2π · dy / clientHeight · rotateSpeed      (left drag)
//   pan   = 2 · delta · distance · tan(fov/2) / clientHeight (right drag)
//   wheel: distance *= 0.95 ^ (−deltaY / 100)          (zoom)
//
// Trackball instead maps the cursor onto a virtual ball: the same pixel drag
// turns less near the centre/edges, and its pan gain felt much faster. This
// controller keeps the OrbitControls mapping but applies it with quaternions,
// so the camera can keep going over the poles (no polar clamp).
//
// Every pointermove is applied immediately; nothing is sampled once per frame.
//
// Normal drags keep `camera.up` at world up, so vertical dragging does not
// roll the horizon (the old turntable feel). Crossing the pole is the one
// discontinuity: at the exact pole `lookAt` has to choose a screen orientation,
// so the picture flips 180° there. `复原` restores the starting pose.
import * as THREE from 'three';

export interface FreeOrbitEventMap {
  start: { type: 'start' };
  end: { type: 'end' };
  change: { type: 'change' };
}

const _startEvent: FreeOrbitEventMap['start'] = { type: 'start' };
const _endEvent: FreeOrbitEventMap['end'] = { type: 'end' };
const _changeEvent: FreeOrbitEventMap['change'] = { type: 'change' };

type DragMode = 'none' | 'rotate' | 'pan' | 'dolly';

export class FreeOrbitControls extends THREE.EventDispatcher<FreeOrbitEventMap> {
  enabled = true;
  target = new THREE.Vector3();
  minDistance = 0;
  maxDistance = Infinity;
  /** 1 = the old OrbitControls angular gain. */
  rotateSpeed = 1;
  /** 1 = the old OrbitControls pan gain. */
  panSpeed = 1;
  /** 1 = a 5% dolly per standard wheel notch. */
  zoomSpeed = 1;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private activePointer: number | null = null;
  private mode: DragMode = 'none';
  private lastX = 0;
  private lastY = 0;
  private pinchDistance = 0;
  /** Screen-right captured at pointerdown; kept across the pole so the pitch axis cannot flip. */
  private readonly dragRight = new THREE.Vector3(1, 0, 0);
  private readonly pinchMid = new THREE.Vector2();

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    super();
    this.camera = camera;
    this.domElement = domElement;
    domElement.style.touchAction = 'none';
    domElement.addEventListener('pointerdown', this.onPointerDown);
    domElement.addEventListener('wheel', this.onWheel, { passive: false });
    domElement.addEventListener('contextmenu', this.onContextMenu);
  }

  // ---------------------------------------------------------------- lifecycle

  dispose = (): void => {
    this.stop();
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('wheel', this.onWheel);
    this.domElement.removeEventListener('contextmenu', this.onContextMenu);
  };

  /** No cached rect: every handler uses live client coordinates. */
  handleResize = (): void => { /* nothing to cache */ };

  /** The render loop calls this; it also repairs the pose after 复原. */
  update = (): void => {
    this.camera.lookAt(this.target);
  };

  // ---------------------------------------------------------------- pointer

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    event.preventDefault();
    // Make sure the camera quaternion matches the current position before a
    // gesture reads its basis (the first frame after a fit may not have run yet).
    this.camera.lookAt(this.target);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.pointers.size === 1) {
      this.activePointer = event.pointerId;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      this.mode = event.pointerType === 'touch'
        ? 'rotate'
        : event.button === 0 ? 'rotate' : event.button === 2 ? 'pan' : event.button === 1 ? 'dolly' : 'none';
      window.addEventListener('pointermove', this.onPointerMove, { passive: false });
      window.addEventListener('pointerup', this.onPointerUp);
      window.addEventListener('pointercancel', this.onPointerUp);
      window.addEventListener('blur', this.onBlur);
      if (this.mode === 'rotate') {
        // Capture the screen-right axis once per drag. Recomputing it from
        // world-up × back flips sign at the pole and traps the camera there.
        this.dragRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();
      }
      this.dispatchEvent(_startEvent);
    } else if (this.pointers.size === 2) {
      // Two fingers: pinch to dolly, midpoint drag to pan.
      this.mode = 'none';
      this.initPinch();
    }

    try { this.domElement.setPointerCapture(event.pointerId); } catch { /* synthetic events */ }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.enabled || !this.pointers.has(event.pointerId)) return;
    event.preventDefault();

    if (this.pointers.size >= 2) {
      this.updatePinch(event);
      return;
    }
    if (event.pointerId !== this.activePointer) return;

    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    if (dx === 0 && dy === 0) return;

    const height = Math.max(1, this.domElement.clientHeight);
    if (this.mode === 'rotate') this.rotate(dx, dy, height);
    else if (this.mode === 'pan') this.pan(dx, dy, height);
    else if (this.mode === 'dolly') this.dolly(dy);
    else return;

    this.dispatchEvent(_changeEvent);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.delete(event.pointerId);
    try { this.domElement.releasePointerCapture(event.pointerId); } catch { /* not captured */ }

    if (this.pointers.size === 0) {
      this.stop();
      return;
    }
    // Back from pinch to a one-finger rotate.
    const [id, p] = [...this.pointers.entries()][0]!;
    this.activePointer = id;
    this.lastX = p.x;
    this.lastY = p.y;
    this.mode = 'rotate';
    this.pinchDistance = 0;
    this.dragRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();
  };

  private onBlur = (): void => { this.stop(); };

  private stop = (): void => {
    for (const id of this.pointers.keys()) {
      try { this.domElement.releasePointerCapture(id); } catch { /* not captured */ }
    }
    this.pointers.clear();
    this.activePointer = null;
    this.mode = 'none';
    this.pinchDistance = 0;
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('blur', this.onBlur);
    this.dispatchEvent(_endEvent);
  };

  // ---------------------------------------------------------------- gestures

  private rotate(dx: number, dy: number, height: number): void {
    const worldUp = new THREE.Vector3(0, 1, 0);
    const back = this.camera.position.clone().sub(this.target);
    const up = this.camera.up.clone().normalize();

    // Yaw around world Y (OrbitControls' azimuth); the up turns with it so the
    // screen does not roll on a horizontal drag.
    const yaw = (-2 * Math.PI * dx / height) * this.rotateSpeed;
    const qYaw = new THREE.Quaternion().setFromAxisAngle(worldUp, yaw);
    back.applyQuaternion(qYaw);
    up.applyQuaternion(qYaw);
    this.dragRight.applyQuaternion(qYaw).normalize();

    // Pitch around the per-drag screen-right axis. Because the axis is fixed
    // for the whole drag, it stays continuous when the view passes the pole;
    // recomputing it from worldUp × back would flip sign and stop the camera
    // at the pole (the camera would oscillate around it instead of crossing).
    const pitch = (-2 * Math.PI * dy / height) * this.rotateSpeed;
    const qPitch = new THREE.Quaternion().setFromAxisAngle(this.dragRight, pitch);
    back.applyQuaternion(qPitch);
    up.applyQuaternion(qPitch);

    // Re-level toward world up when the view is far enough from a pole. Near
    // the pole the projection collapses, so the pitch-rotated up is kept
    // instead: that is what makes the crossing continuous. Re-leveling with
    // the sign of the current up (rather than always +worldUp) prevents the
    // 180° mirror flip that `lookAt` produced when up stayed exactly worldUp.
    const view = back.clone().normalize();
    const projected = worldUp.clone().addScaledVector(view, -worldUp.dot(view));
    const len = projected.length();
    if (len > 1e-6) {
      projected.divideScalar(len);
      if (projected.dot(up) < 0) projected.negate();
      const blend = THREE.MathUtils.clamp((len - 0.15) / 0.2, 0, 1);
      if (blend > 0) up.lerp(projected, blend).normalize();
    }
    up.normalize();

    this.camera.position.copy(this.target).add(back);
    this.camera.up.copy(up);
    this.camera.lookAt(this.target);
  }

  private pan(dx: number, dy: number, height: number): void {
    // OrbitControls pans along the camera's own X/Y columns, not world up:
    // after a lookAt the local up is orthogonal to the view, while world up is
    // not. Use the quaternion basis so the screen pan matches exactly.
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
    // OrbitControls pans in world units proportional to the half-height of the
    // view frustum, not the raw camera distance. Missing tan(fov/2) made the
    // pan ~2.4x too fast at 45°.
    const distance = this.camera.position.distanceTo(this.target)
      * Math.tan((this.camera.fov / 2) * Math.PI / 180);
    // OrbitControls signs: drag right moves the model right (camera left);
    // drag down moves the model down (camera up).
    const mx = (-2 * dx * distance / height) * this.panSpeed;
    const my = (2 * dy * distance / height) * this.panSpeed;
    const move = right.multiplyScalar(mx).add(up.multiplyScalar(my));
    this.camera.position.add(move);
    this.target.add(move);
  }

  private dolly(dy: number): void {
    const distance = this.camera.position.distanceTo(this.target);
    this.setDistance(distance * Math.exp(dy * 0.01));
  }

  private initPinch(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    this.pinchDistance = Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1;
    this.pinchMid.set((a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
  }

  private updatePinch(event: PointerEvent): void {
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1;
    const mid = new THREE.Vector2((a!.x + b!.x) / 2, (a!.y + b!.y) / 2);

    const current = this.camera.position.distanceTo(this.target);
    this.setDistance(current * (this.pinchDistance / distance));
    this.pan(mid.x - this.pinchMid.x, mid.y - this.pinchMid.y, Math.max(1, this.domElement.clientHeight));

    this.pinchDistance = distance;
    this.pinchMid.copy(mid);
    this.dispatchEvent(_changeEvent);
  }

  /** Move the camera along its current view ray, clamped to the distance range. */
  private setDistance(distance: number): void {
    const offset = this.camera.position.clone().sub(this.target);
    const length = offset.length() || 1e-6;
    const next = Math.min(this.maxDistance, Math.max(this.minDistance, distance));
    this.camera.position.copy(this.target).addScaledVector(offset, next / length);
  }

  // ---------------------------------------------------------------- wheel

  private onWheel = (event: WheelEvent): void => {
    if (!this.enabled) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    const distance = this.camera.position.distanceTo(this.target);
    // One standard notch (deltaY −100) = 5% closer, matching the old control.
    this.setDistance(distance * Math.pow(0.95, (-event.deltaY * unit / 100) * this.zoomSpeed));
    this.dispatchEvent(_startEvent);
    this.dispatchEvent(_endEvent);
    this.dispatchEvent(_changeEvent);
  };

  private onContextMenu = (event: Event): void => { event.preventDefault(); };
}

export interface FreeOrbitOptions {
  /** World point the camera orbits. */
  target: THREE.Vector3;
  minDistance: number;
  maxDistance: number;
  rotateSpeed?: number;
  panSpeed?: number;
  zoomSpeed?: number;
}

export interface FreeOrbit {
  controls: FreeOrbitControls;
  dispose: () => void;
}

export function createFreeOrbit(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement,
  opts: FreeOrbitOptions,
): FreeOrbit {
  const controls = new FreeOrbitControls(camera, domElement);
  controls.target.copy(opts.target);
  controls.minDistance = opts.minDistance;
  controls.maxDistance = opts.maxDistance;
  controls.rotateSpeed = opts.rotateSpeed ?? 1;
  controls.panSpeed = opts.panSpeed ?? 1;
  controls.zoomSpeed = opts.zoomSpeed ?? 1;
  return { controls, dispose: controls.dispose };
}
