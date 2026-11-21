import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // KRITVA_API_URL points the dev proxy at another local server (for example a second instance on 8788).
    proxy: { "/api": process.env.KRITVA_API_URL ?? "http://127.0.0.1:8787" },
  },
});
