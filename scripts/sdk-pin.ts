import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Development compatibility input only. Version 0.5.9 alone never identifies this candidate. */
export const HANDOFF_SHA256 = "b1501a3c75d00d4e5ae5fcb3257f500e3c857c5d5a84fb32cc78777c03882306";
export const PLATFORM_COMMIT = "6f9ef3ae9decb9b073843a9f9c8cfc869ffff49e";
export const CANDIDATE = "e7f171abb42baa5dc6b05d3bb72eb6f3bb43d5d17a80a66c135914bce885be01";
export const SDK_SHA256 = "58d27ef7398770b1c44265b41a165abfda186239711d9979749d7e276c744505";
export const PROVENANCE_SHA256 = "09dad5e5043431155875b0a588ad215e5f6e1f2950ed5e1d3daaff7806fe9b70";
export const GATEWAY_MANIFEST_SHA256 = "61b81847cafdd65145ea1e556d2d611211b434baacebe42ccdc1b0bbe8818f89";
export const VENDOR = join(import.meta.dirname, "..", "vendor", "sdk", "pr86-6f9ef3a");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

export function verifySdk() {
  check(digest(readFileSync(join(VENDOR, "handoff.json"))) === HANDOFF_SHA256, "Frozen handoff checksum mismatch");
  const tarball = join(VENDOR, "multiagency-sdk-0.5.9.tgz");
  check(digest(readFileSync(tarball)) === SDK_SHA256, "SDK tarball checksum mismatch");
  const sidecar = readFileSync(join(VENDOR, "multiagency-sdk-0.5.9.provenance.json"));
  check(digest(sidecar) === PROVENANCE_SHA256, "SDK provenance checksum mismatch");
  const embedded = execFileSync("tar", ["-xOf", tarball, "package/provenance.json"]);
  check(embedded.equals(sidecar), "Embedded SDK provenance differs from sidecar");
  const provenance = JSON.parse(sidecar.toString());
  check(provenance.sourceHead === PLATFORM_COMMIT && provenance.snapshot?.runDigest === CANDIDATE
    && provenance.snapshot.overlayDiffSha256 === null && provenance.sourcesDirty.length === 0 && provenance.dirtyPaths.length === 0, "SDK source/candidate identity mismatch");
  const gatewayBytes = readFileSync(join(VENDOR, "gateway-manifest.json"));
  check(digest(gatewayBytes) === GATEWAY_MANIFEST_SHA256, "Gateway manifest checksum mismatch");
  const gateway = JSON.parse(gatewayBytes.toString()) as { revisions: { platform: string }; files: Record<string, string> };
  check(gateway.revisions.platform === PLATFORM_COMMIT, "Gateway source identity mismatch");
  return { provenance: provenance as { sources: Record<string, string> }, gateway };
}

/** Accept a clean exact-commit checkout or its frozen snapshot; verify runtime bytes in either case. */
export function verifyPlatform(platform: string) {
  const { provenance, gateway } = verifySdk();
  const snapshotFile = join(platform, "SNAPSHOT.json");
  if (existsSync(snapshotFile)) {
    const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
    check(snapshot.sourceHead === PLATFORM_COMMIT && snapshot.runDigest === CANDIDATE
      && snapshot.overlayDiffSha256 === null, "Platform snapshot identity mismatch");
  } else {
    const head = execFileSync("git", ["-C", platform, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    check(head === PLATFORM_COMMIT, `Platform must be ${PLATFORM_COMMIT}, got ${head}`);
  }
  for (const [file, sha] of Object.entries({ ...provenance.sources, ...gateway.files })) {
    // Packaged dependency/build files differ from a source checkout; runtime source must match exactly.
    if (file.startsWith("src/")) check(digest(readFileSync(join(platform, file))) === sha, `Platform source mismatch: ${file}`);
  }
}
