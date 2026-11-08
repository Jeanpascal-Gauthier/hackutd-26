import { lazy, Suspense } from "react";
import type { Building3DProps } from "./Building3D";

// three.js loads in its own chunk after first paint; nothing renders until it arrives.
const Building3D = lazy(() => import("./Building3D"));

export function Building3DPanel(props: Building3DProps) {
  return <Suspense fallback={<p className="map-hint" role="status">Loading 3D view…</p>}><Building3D {...props} /></Suspense>;
}
