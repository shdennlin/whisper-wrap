import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Build output goes to ../app/static/app/ so FastAPI's StaticFiles can serve it
// at /app/ without any extra copy step.
export default defineConfig({
  base: "/app/",
  build: {
    outDir: "../app/static/app",
    emptyOutDir: true,
    sourcemap: true,
  },
  plugins: [
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icons/icon-192.png", "icons/icon-512.png"],
      manifest: {
        name: "whisper-wrap",
        short_name: "wwrap",
        description: "Live captioning + Gemini Q&A for whisper-wrap",
        start_url: "/app/",
        scope: "/app/",
        display: "standalone",
        background_color: "#0f1115",
        theme_color: "#0f1115",
        icons: [
          {
            src: "icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Backend routes are runtime-cached as networkOnly so the PWA never
        // serves stale model responses. The PWA shell + assets use
        // staleWhileRevalidate for fast loads.
        navigateFallback: "/app/index.html",
        navigateFallbackDenylist: [
          /^\/listen/,
          /^\/transcribe/,
          /^\/ask/,
          /^\/status/,
          /^\/actions/,
          /^\/v1\//,
        ],
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.pathname === "/listen" ||
              url.pathname.startsWith("/ask") ||
              url.pathname.startsWith("/transcribe") ||
              url.pathname.startsWith("/status") ||
              url.pathname.startsWith("/actions") ||
              url.pathname.startsWith("/v1/"),
            handler: "NetworkOnly",
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/app/"),
            handler: "StaleWhileRevalidate",
            options: { cacheName: "pwa-shell" },
          },
        ],
      },
    }),
  ],
  test: {
    environment: "happy-dom",
    globals: true,
  },
});
