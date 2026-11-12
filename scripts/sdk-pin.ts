import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Final combined candidate, isolated offline consumer validation only. Version 0.5.9 alone never identifies this candidate. */
export const HANDOFF_SHA256 = "67d6a3fdd5b2858803485e29c4c6c29693b14bb47760f39c144992a5fb87c634";
export const PLATFORM_COMMIT = "252cba1d1e6642a5ea9f42ea4927f982423ed8e1";
export const CANDIDATE = "822346ac5b50313d493c951971695abbbab5cc1d5a48ca8868bc73421a609a40";
export const SDK_SHA256 = "4ae53dce669664bcf90e0c5939e0ac617db0ab24c101e3792fc659ac4494475a";
export const PROVENANCE_SHA256 = "9feb6034ccddf90c6cc16c81247c10d265094eef6d457e17cbe3f3ce5de8dd3c";
export const GATEWAY_MANIFEST_SHA256 = "8043058f5e55bf176597d70d3b83ebfebbef33eff436bb5739a602176d19b17a";
export const RELEASE_MANIFEST_SHA256 = "e61553bdaa541f2a6201d71f499062bafd342012efadb9c77692008352000066";
export const GATEWAY_IMAGE_ID = "sha256:9daf951d59ba40eb944d53a595ed214180254534b2e5c8cff93b448ad95dd195";
export const GATEWAY_IMAGE_ARCHIVE_SHA256 = "6e891b6502f574d34482a3e508b9acd95b146955ecdf387ff6beb4c3cd745f4e";
export const VENDOR = join(import.meta.dirname, "..", "vendor", "sdk", "final-252cba1");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

export function verifySdk() {
  check(digest(readFileSync(join(VENDOR, "handoff.json"))) === HANDOFF_SHA256, "Frozen handoff checksum mismatch");
  check(digest(readFileSync(join(VENDOR, "release.json"))) === RELEASE_MANIFEST_SHA256, "Release manifest checksum mismatch");
  const handoff = JSON.parse(readFileSync(join(VENDOR, "handoff.json"), "utf8"));
  check(handoff.gateway.image.imageId === GATEWAY_IMAGE_ID && handoff.gateway.image.archiveSha256 === GATEWAY_IMAGE_ARCHIVE_SHA256, "Gateway image pin mismatch");
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
