import { Empty } from "../ui";
import type { MapsStatus } from "./loader";

const TEXT: Record<string, { title: string; text: string }> = {
  "missing-key": {
    title: "Map needs a Google key",
    text: "Set GOOGLE_MAPS_API_KEY in the root .env and enable the Maps JavaScript API for it. The rest of the console works without it.",
  },
  loading: { title: "Loading map", text: "Connecting to Google Maps." },
  network: {
    title: "Map unavailable",
    text: "Google Maps could not be reached. The rest of the console keeps working.",
  },
  auth: {
    title: "Google Maps rejected the key",
    text: "Check that GOOGLE_MAPS_API_KEY is valid, that the Maps JavaScript API is enabled, and that this address is allowed for the key.",
  },
};

/** Fills its positioned parent with the message for every state except "ready". */
export function MapsMessage({ status }: { status: MapsStatus }) {
  const copy = TEXT[status.state === "error" ? status.reason : status.state];
  if (!copy) return null;
  return <div className="fw-map-message"><Empty title={copy.title} text={copy.text} /></div>;
}
