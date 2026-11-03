import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { Shell } from "./frame";
import { BASE } from "./location";
import { PAGES, type Page } from "./pages";

/** A page the prototype has and this app doesn't yet: it moves here feature by feature. Each page has one `<h1>`. */
function Pending({ title }: { title: string }) {
  return <>
    <h1 className="text-2xl font-semibold">{title}</h1>
    <p className="text-sm text-muted-foreground">{title} moves here from the Treasury prototype, one feature at a time.</p>
  </>;
}

const root = createRootRoute({ component: Shell });
const page = (path: Page) => createRoute({ getParentRoute: () => root, path, component: () => <Pending title={PAGES[path]} /> });

export const router = createRouter({
  basepath: BASE || "/",
  routeTree: root.addChildren([
    ...(Object.keys(PAGES) as Page[]).map(page),
    // The funding page's first address: old links land on its new one.
    createRoute({ getParentRoute: () => root, path: "/treasury", beforeLoad: () => { throw redirect({ to: "/funding" }); } }),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
