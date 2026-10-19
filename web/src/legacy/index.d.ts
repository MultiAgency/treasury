/**
 * `@legacy` is resolved per build by web/rsbuild.config.ts: ./surface for PUBLIC_TREASURY_ONLY=false,
 * ./absent otherwise, so the Treasury bundle never contains the shared Payables/Portfolio modules.
 */
declare module "@legacy" {
  export const legacy: import("./contract").Legacy;
}
