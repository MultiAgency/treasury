import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { LOGO_HEIGHT, LOGO_WIDTH, logoPath } from "./src/logo.ts";

/**
 * The mark as the favicon: seven bars, to read at 16px. Dark grey on a light tab, where the brand gold is too faint,
 * and the brand gold (`--brand-primary`) on a dark one.
 */
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LOGO_WIDTH} ${LOGO_HEIGHT}"><style>path{fill:#3f3f46}@media(prefers-color-scheme:dark){path{fill:#f5d68f}}</style><path d="${logoPath(7)}"/></svg>`;

export default defineConfig({
  plugins: [pluginReact()],
  // The app's pages, which only the app server serves (`apps/server/src/page.ts`, `TREASURY_PAGE_DIR`).
  source: { entry: { index: "./src/main.tsx" } },
  html: { template: "./src/index.html", title: "Agentic Treasury",
    tags: [{ tag: "link", attrs: { rel: "icon", type: "image/svg+xml", href: `data:image/svg+xml,${encodeURIComponent(FAVICON)}` } }] },
});
