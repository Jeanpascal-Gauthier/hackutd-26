import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Env files live at the repo root. Only VITE_* reaches the browser, plus the one key below.
  envDir: "..",
  envPrefix: "VITE_",
  define: {
    // The Maps browser key is public by design; expose only this exact root .env value.
    "import.meta.env.GOOGLE_MAPS_API_KEY": JSON.stringify(loadEnv(mode, "..", "GOOGLE_MAPS_API_KEY").GOOGLE_MAPS_API_KEY ?? ""),
  },
  server: { port: 5173 },
}));
