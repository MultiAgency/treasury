import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".json": "application/json", ".txt": "text/plain; charset=utf-8",
};
/** Built under `static/` with their content's hash in the name, so they may be cached for good. */
const ASSETS = "/static/";

export type PageFile = { body: Buffer; headers: Record<string, string> };
/** The proposals page's file for a GET or HEAD of `pathname`; undefined under `/api/` and for a missing asset. */
export type Page = (pathname: string) => PageFile | undefined;

/**
 * The proposals page's build (`web/dist`), read once from `dir` at startup and then served from memory by
 * exact path, so no request reaches the file system. Only regular files are read: no dotfile, no symbolic link, no
 * type outside `TYPES`, and no listing. Any path outside `/api/` and `static/` that names no file is the page itself
 * (`index.html`), which routes itself. The page is never stored by a cache, may not be framed (it asks the owner's
 * wallet to sign) and sends no referrer.
 */
export async function loadPage(dir: string): Promise<Page> {
  const root = resolve(dir);
  const files = new Map<string, PageFile>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name), name = `/${relative(root, path).split(sep).join("/")}`;
    const type = TYPES[extname(entry.name)];
    if (!entry.isFile() || !type || name.split("/").some(part => part.startsWith("."))) continue;
    files.set(name, { body: await readFile(path), headers: { "content-type": type, "x-content-type-options": "nosniff",
      "cache-control": name.startsWith(ASSETS) ? "public, max-age=31536000, immutable" : "no-store" } });
  }
  const html = files.get("/index.html");
  if (!html) throw new Error(`${root} has no index.html: build web/ first`);
  const page: PageFile = { body: html.body, headers: { ...html.headers,
    "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } };
  files.set("/index.html", page);
  return pathname => pathname === "/api" || pathname.startsWith("/api/") ? undefined
    : files.get(pathname) ?? (pathname.startsWith(ASSETS) ? undefined : page);
}
