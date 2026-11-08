import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Env files live at the repo root. Only VITE_* reaches the browser, plus the Maps key below.
const envDir = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, "");
  // The Maps browser key is public by design; expose only this explicitly selected key.
  const mapsKey = JSON.stringify(env.VITE_GOOGLE_MAPS_API_KEY ?? env.GOOGLE_MAPS_API_KEY ?? "");
  return {
    envDir,
    plugins: [react()],
    define: {
      "import.meta.env.GOOGLE_MAPS_API_KEY": mapsKey,
      "import.meta.env.VITE_GOOGLE_MAPS_API_KEY": mapsKey,
    },
    server: { port: 5173 },
  };
});
