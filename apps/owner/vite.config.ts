import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// dev.mjs передаёт реальный порт API через переменную окружения: он может
// отличаться от 3001, если этот порт занят другим проектом на машине.
const apiPort = process.env.API_PORT ?? "3001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5174,
    proxy: { "/v1": { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
});
