import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// `process` exists at config-eval time (Node), but @types/node is deliberately
// out of tsconfig `types` to keep src DOM-only — declare it file-locally.
declare const process: { env: Record<string, string | undefined> };

// Build output goes to ../app/static/app/ so FastAPI's StaticFiles can serve it
// at /app/ without any extra copy step.

// Dev-server backend target. In dev the PWA is served by Vite (:5173) while the
// engine runs separately (make dev / make server), so the frontend's API + WS
// calls — which go to window.location.origin = :5173 — must be proxied to the
// engine. Defaults to the repo's API_PORT (12000); override with
// VITE_DEV_BACKEND when the engine listens elsewhere.
const DEV_BACKEND = process.env.VITE_DEV_BACKEND ?? "http://localhost:12000";

// Every backend route prefix (mirrors engine/server route registration). `/`
// and `/app/` stay with Vite; `/listen` upgrades to WebSocket.
const API_PREFIXES = [
  "/transcribe",
  "/ask",
  "/status",
  "/actions",
  "/items",
  "/runs",
  "/models",
  "/aux-models",
  "/config",
  "/v1",
];

export default defineConfig({
  base: "/app/",
  server: {
    proxy: {
      ...Object.fromEntries(
        API_PREFIXES.map((p) => [
          p,
          { target: DEV_BACKEND, changeOrigin: true },
        ]),
      ),
      "/listen": { target: DEV_BACKEND, ws: true, changeOrigin: true },
    },
  },
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
    // vitest owns the unit/component tier (src/**). Playwright owns e2e/**.
    // Narrowing include keeps vitest from collecting e2e/*.spec.ts (which would
    // fail in happy-dom — no browser). The two runners stay disjoint.
    include: ["src/**/*.test.ts"],
  },
});
