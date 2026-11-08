// Animated radar-style heat layer for the 2D floor plan: a transparent WebGL canvas that
// draws the shared heat field (shadow + two drifting layers) over the plan.
import { useEffect, useRef } from "react";
import { Mesh, OrthographicCamera, PlaneGeometry, Scene, WebGLRenderer } from "three";
import { createHeatMaterial, hasHeat, prefersReducedMotion, setHeatBounds, setHeatSources, STILL_TIME, type HeatRect, type HeatSource } from "./heatField";

interface HeatOverlayProps {
  sources: HeatSource[];
  /** Area the canvas covers and the building footprint, in building metres. */
  bounds: HeatRect;
  clip: HeatRect;
  /** Rendered size in CSS px. */
  width: number;
  height: number;
}

type Gl = { renderer: WebGLRenderer; scene: Scene; camera: OrthographicCamera; material: ReturnType<typeof createHeatMaterial>; geometry: PlaneGeometry };

export default function HeatOverlay({ sources, bounds, clip, width, height }: HeatOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gl = useRef<Gl | null>(null);
  const raf = useRef(0);
  const live = useRef({ active: false, visible: true });
  const active = hasHeat(sources);
  live.current.active = active;

  const kick = () => {
    if (raf.current || !gl.current) return;
    raf.current = requestAnimationFrame(function tick(now) {
      raf.current = 0;
      const g = gl.current;
      if (!g || !live.current.visible) return;
      const still = prefersReducedMotion();
      g.material.uniforms.uTime!.value = still ? STILL_TIME : now / 1000;
      g.renderer.render(g.scene, g.camera);
      if (live.current.active && !still) raf.current = requestAnimationFrame(tick);
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: "low-power" });
    } catch {
      return; // No WebGL: the plan's own fire/smoke tints still show state.
    }
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const geometry = new PlaneGeometry(2, 2);
    const material = createHeatMaterial({ composite: true });
    const scene = new Scene();
    scene.add(new Mesh(geometry, material));
    gl.current = { renderer, scene, camera: new OrthographicCamera(-1, 1, 1, -1, 0, 1), material, geometry };
    const observer = new IntersectionObserver(([entry]) => {
      live.current.visible = entry?.isIntersecting ?? true;
      if (live.current.visible) kick();
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      gl.current = null;
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, []);

  useEffect(() => {
    const g = gl.current;
    if (!g || width <= 0 || height <= 0) return;
    g.renderer.setSize(width, height, false);
    kick();
  }, [width, height]);

  const key = JSON.stringify([sources, bounds, clip]);
  useEffect(() => {
    const g = gl.current;
    if (!g) return;
    setHeatSources(g.material, sources);
    setHeatBounds(g.material, bounds, clip);
    kick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return <canvas ref={canvasRef} className="heat-overlay" style={{ display: active ? "block" : "none" }} aria-hidden="true" />;
}
