import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// dev.mjs передаёт реальный порт API через переменную окружения: он может
// отличаться от 3001, если этот порт занят другим проектом на машине.
const apiPort = process.env.API_PORT ?? "3001";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Касса ставится на компьютер как программа и открывается без интернета:
    // сама оболочка лежит в кэше, данные — в снимке зала, операции — в очереди.
    VitePWA({
      // Не "autoUpdate": касса не имеет права перезагрузиться сама посреди
      // расчёта с гостем. Обновление предлагаем кнопкой, применяет кассир.
      registerType: "prompt",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Касса · Баня",
        short_name: "Касса",
        description: "Рабочее место администратора бани и сауны",
        lang: "ru",
        start_url: "/",
        display: "standalone",
        orientation: "landscape",
        background_color: "#f2f1ee",
        theme_color: "#0f6e63",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // Запросы к API кэшировать нельзя: устаревший ответ на кассе опаснее
        // честной ошибки. Данные для офлайна кладёт сам код — снимком зала.
        navigateFallbackDenylist: [/^\/v1\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
            handler: "CacheFirst",
            options: {
              cacheName: "fonts",
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      // В разработке service worker только мешает: кэширует то, что вы
      // сейчас правите. Офлайн проверяем на собранной версии.
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Собранную версию смотрим тем же способом, что и разработку,
  // иначе прокси на API пришлось бы поднимать отдельно.
  preview: {
    port: 4173,
    proxy: { "/v1": { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
  server: {
    port: 5173,
    // Прокси на API убирает CORS из уравнения: касса и сервер выглядят одним origin.
    proxy: { "/v1": { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
});
