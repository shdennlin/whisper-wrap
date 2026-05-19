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
            // NetworkFirst for the shell so a hard reload picks up new builds
            // immediately when online (the old StaleWhileRevalidate kept users
            // on the cached shell for one extra open after each deploy, which
            // on iOS standalone PWAs effectively meant "force-close to refresh").
            // The 3-second timeout falls back to cache on slow/offline networks.
            urlPattern: ({ url }) => url.pathname.startsWith("/app/"),
            handler: "NetworkFirst",
            options: {
              cacheName: "pwa-shell",
              networkTimeoutSeconds: 3,
            },
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
