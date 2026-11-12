import { Component, lazy, type ReactNode } from "react";

/** The 3D vault's own chunk (three.js and react-three-fiber): only a signed-out visitor with WebGL downloads it. */
export const loadScene = () => import("./vault-scene");
export const VaultScene = lazy(loadScene);

/** Whether this browser draws WebGL 2: without it, the landing keeps its CSS glow. The test context is released at once. */
export function hasWebGL() {
  try {
    const context = document.createElement("canvas").getContext("webgl2");
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return Boolean(context);
  } catch {
    return false;
  }
}

/** If the 3D vault fails, the page keeps its CSS glow and the intro still finishes. */
export class SceneBoundary extends Component<{ children: ReactNode; onError?: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError?.(); }
  render() { return this.state.failed ? null : this.props.children; }
}
