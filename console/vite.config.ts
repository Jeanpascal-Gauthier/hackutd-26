import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const envDir = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, "");
  return {
    envDir,
    plugins: [react()],
    // Google Maps browser keys are public; publish only this explicitly selected key.
    define: {
      "import.meta.env.VITE_GOOGLE_MAPS_API_KEY": JSON.stringify(env.VITE_GOOGLE_MAPS_API_KEY ?? env.GOOGLE_MAPS_API_KEY ?? ""),
    },
    server: { port: 5173 },
  };
});
