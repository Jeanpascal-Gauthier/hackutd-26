import { useEffect, useState } from "react";
import type { BuildingLookup } from "@firewatch/shared/types";
import { useBuilding } from "./activeBuilding";
import { PinIcon, ReplayIcon } from "./Icons";
import { Empty } from "./ui";
import { findOutdoorPanorama, loadStreetView, type StreetPanorama } from "./maps/streetView";
import "./SurroundingsMap.css";

const apiKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim();

/** Geographic context for the searched address; floor and forecast changes leave the map alone. */
export function SurroundingsMap({ lookup }: { lookup?: BuildingLookup }) {
  const { profile } = useBuilding();
  const match = lookup?.status !== "failed" ? lookup?.match : undefined;
  const location = match ?? profile.location;
  const address = match?.formatted ?? profile.address;
  const hasCoordinates = location && Number.isFinite(location.lat) && Number.isFinite(location.lon)
    && Math.abs(location.lat) <= 90 && Math.abs(location.lon) <= 180;
  const center = hasCoordinates ? `${location.lat},${location.lon}` : undefined;
  const query = address ?? center;
  const label = address ?? profile.name;
  const [mapType, setMapType] = useState<"roadmap" | "satellite" | "streetview">("roadmap");
  const [revision, setRevision] = useState(0);
  const streetView = mapType === "streetview" && Boolean(center);
  const [streetResult, setStreetResult] = useState<{
    center: string;
    status: "loading" | "ready" | "unavailable" | "error";
    panorama?: StreetPanorama;
  } | null>(null);
  const panorama = streetResult && streetResult.center === center && streetResult.status === "ready" ? streetResult.panorama : undefined;

  useEffect(() => {
    if (!streetView || !center || !apiKey) return;
    let disposed = false;
    setStreetResult({ center, status: "loading" });
    const [lat, lng] = center.split(",").map(Number);
    void (async () => {
      try {
        const { StreetViewService } = await loadStreetView(apiKey);
        if (disposed) return;
        const panorama = await findOutdoorPanorama(new StreetViewService(), { lat, lng });
        if (!disposed) setStreetResult(panorama ? { center, status: "ready", panorama } : { center, status: "unavailable" });
      } catch {
        if (!disposed) setStreetResult({ center, status: "error" });
      }
    })();
    return () => { disposed = true; };
  }, [streetView, center, revision]);

  if (!query) return <div className="surroundings-empty"><Empty title="Explore the surrounding area" text="Find an incident address to see nearby streets and buildings." /></div>;

  const external = new URL(streetView && panorama ? "https://www.google.com/maps/@" : "https://www.google.com/maps/search/");
  external.search = new URLSearchParams(streetView && panorama
    ? { api: "1", map_action: "pano", pano: panorama.pano }
    : { api: "1", query: center ?? query }).toString();
  const embed = new URL(`https://www.google.com/maps/embed/v1/${streetView ? "streetview" : "place"}`);
  embed.search = new URLSearchParams(streetView ? {
    // Only display the verified panorama. No location fallback that could select an indoor tour.
    key: apiKey ?? "", pano: panorama?.pano ?? "", heading: String(panorama?.heading ?? 0), pitch: "0",
  } : {
    key: apiKey ?? "", q: query, zoom: "16", maptype: mapType === "satellite" ? "satellite" : "roadmap",
    ...(center ? { center } : {}),
  }).toString();

  return <div className="surroundings-map">
    <div className="surroundings-toolbar">
      <p className="surroundings-address"><PinIcon size={17} /><span>{label}</span></p>
      {apiKey && <div className="surroundings-controls">
        <div className="view-switch" role="group" aria-label="Map imagery">
          <button aria-pressed={!streetView && mapType !== "satellite"} onClick={() => setMapType("roadmap")}>Street map</button>
          <button aria-pressed={mapType === "satellite"} onClick={() => setMapType("satellite")}>Satellite</button>
          <button aria-pressed={streetView} disabled={!center} title={!center ? "Street View needs a mapped location" : undefined} onClick={() => setMapType("streetview")}>Street View</button>
        </div>
        <button className="text-button surroundings-recenter" onClick={() => setRevision(value => value + 1)}><ReplayIcon size={15} />Recenter</button>
      </div>}
    </div>
    {apiKey ? (streetView && !panorama ? <div className="surroundings-frame">
      {!streetResult || streetResult.center !== center || streetResult.status === "loading"
        ? <p className="surroundings-loading" role="status">Finding outdoor street imagery…</p>
        : <div className="surroundings-message"><Empty
          title={streetResult.status === "unavailable" ? "No outdoor street imagery nearby" : "Street imagery could not be loaded"}
          text={streetResult.status === "unavailable" ? "Try Street map or Satellite to explore this area." : "Try Recenter, or switch to Street map or Satellite."} /></div>}
    </div> : <MapFrame key={`${embed.href}:${revision}`} src={embed.href} title={streetView ? `Google Street View near ${label}` : `Google Maps surroundings of ${label}`} />)
      : <div className="surroundings-empty"><Empty title="Surroundings map unavailable" text="Open this location in Google Maps to explore the area." /></div>}
    <div className="surroundings-caption">
      <span>{streetView ? "Street-level imagery near the building" : "Nearby streets and buildings"}</span>
      <a href={external.href} target="_blank" rel="noopener noreferrer">Open in Google Maps ↗</a>
    </div>
  </div>;
}

function MapFrame({ src, title }: { src: string; title: string }) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  return <div className="surroundings-frame">
    {failed ? <Empty title="Map could not be loaded" text="Use the Google Maps link below to open this location." /> : <>
      {loading && <p className="surroundings-loading" role="status">Loading surroundings…</p>}
      <iframe title={title} src={src} allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin" onLoad={() => setLoading(false)} onError={() => { setLoading(false); setFailed(true); }} />
    </>}
  </div>;
}
