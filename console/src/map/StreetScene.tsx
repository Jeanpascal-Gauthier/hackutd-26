import { useEffect, useRef, useState } from "react";
import type { GeoPoint } from "@firewatch/shared/types";
import { Empty } from "../ui";
import { useMapsStatus } from "./loader";
import { MapsMessage } from "./MapsMessage";
import "./map.css";

const SEARCH_RADIUS_METERS = 100;

/** Compass bearing from the camera to the incident, so the view opens facing it. */
function headingTo(from: google.maps.LatLng, to: google.maps.LatLngLiteral): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const fromLat = radians(from.lat());
  const toLat = radians(to.lat);
  const deltaLng = radians(to.lng - from.lng());
  const y = Math.sin(deltaLng) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function StreetScene({ location, label }: { location: GeoPoint; label: string }): JSX.Element {
  const status = useMapsStatus();
  const ready = status.state === "ready";
  const canvas = useRef<HTMLDivElement>(null);
  const panorama = useRef<google.maps.StreetViewPanorama | null>(null);
  const [imagery, setImagery] = useState<"searching" | "found" | "none">("searching");
  const { lat, lon } = location;

  // Keyed on the numbers: every state broadcast brings a new `location` object.
  useEffect(() => {
    if (!ready || !canvas.current) return;
    let current = true;
    setImagery("searching");
    panorama.current ??= new google.maps.StreetViewPanorama(canvas.current, {
      visible: false,
      addressControl: false,
      fullscreenControl: false,
      motionTracking: false,
      motionTrackingControl: false,
      panControl: false,
      enableCloseButton: false,
      showRoadLabels: false,
      imageDateControl: true,
    });
    const view = panorama.current;
    const target = { lat, lng: lon };
    new google.maps.StreetViewService()
      .getPanorama({
        location: target,
        radius: SEARCH_RADIUS_METERS,
        sources: [google.maps.StreetViewSource.OUTDOOR],
        preference: google.maps.StreetViewPreference.NEAREST,
      })
      .then(({ data }) => {
        if (!current) return;
        const pano = data.location?.pano;
        const camera = data.location?.latLng;
        if (!pano || !camera) { setImagery("none"); return; }
        view.setPano(pano);
        view.setPov({ heading: headingTo(camera, target), pitch: 0 });
        view.setVisible(true);
        setImagery("found");
      })
      .catch(() => { if (current) setImagery("none"); }); // ZERO_RESULTS arrives as a rejection
    return () => { current = false; };
  }, [ready, lat, lon]);

  useEffect(() => {
    const element = canvas.current;
    return () => {
      if (panorama.current) {
        panorama.current.setVisible(false);
        google.maps.event.clearInstanceListeners(panorama.current);
        panorama.current = null;
      }
      element?.replaceChildren();
    };
  }, []);

  const showing = ready && imagery === "found";
  return (
    <div className="fw-street" role="region" aria-label={`Street view: ${label}`}>
      <div ref={canvas} className={`fw-street-canvas${showing ? "" : " is-hidden"}`} />
      {showing && <span className="fw-street-label">{label}<small>Historical imagery · Scene context only</small></span>}
      {!ready && <MapsMessage status={status} />}
      {ready && imagery === "searching" && (
        <div className="fw-map-message"><Empty title="Finding street imagery" text="Looking for the nearest street view." /></div>
      )}
      {ready && imagery === "none" && (
        <div className="fw-map-message"><Empty title="No street imagery" text="No street imagery is available here." /></div>
      )}
    </div>
  );
}
