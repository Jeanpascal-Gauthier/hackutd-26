// Starts the QR fallback form.
//   npm run form -w agent        # http://0.0.0.0:8090 ; QR page at /qr
// Env: FORM_PORT (default 8090); FORM_PUBLIC_URL to encode a tunnel URL in the QR
// (e.g. https://xyz.trycloudflare.com/). The server must be running (npm run demo).
// With PHOTON_PROJECT_ID + PHOTON_API_KEY the page also offers iMessage sign-up (Photon 2.0 shared
// line); FORM_MAX_REGISTRATIONS caps new sign-ups per run (default 40, each uses a paid seat).
import { ingest } from "../core/ingest.ts";
import { serverUrl } from "../core/server.ts";
import { assignApiFromEnv, assignHandle } from "../photon/assign.ts";
import { createFormServer, lanAddress, type FormOptions } from "./server.ts";

const port = Number(process.env.FORM_PORT ?? 8090);
const lan = lanAddress();
const publicUrl = process.env.FORM_PUBLIC_URL ?? (lan ? `http://${lan}:${port}/` : undefined);

// iMessage sign-up is optional: anything wrong with Photon leaves the form running without it.
let register: FormOptions["register"];
let imessage: string;
try {
  const photon = assignApiFromEnv();
  if (photon) {
    register = (handle) => assignHandle(photon.api, photon.projectId, handle);
    imessage = "on (Photon 2.0 shared line)";
  } else {
    imessage = "off (set PHOTON_PROJECT_ID and PHOTON_API_KEY in the root .env)";
  }
} catch (err) {
  imessage = `off (${err instanceof Error ? err.message : String(err)})`;
}

createFormServer({ ingest, publicUrl, register }).listen(port, "0.0.0.0", () => {
  console.log(`[form] report page: http://localhost:${port}/${publicUrl ? `  phones: ${publicUrl}` : ""}`);
  console.log(`[form] QR for the table card: http://localhost:${port}/qr   reports go to ${serverUrl()}/ingest`);
  console.log(`[form] iMessage sign-up ${imessage}`);
});
