import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Exact 0.6.0 platform/SDK pair. Production qualification is recorded separately. */
export const HANDOFF_SHA256 = "9ed12bfd365d3feedd5ffe5418d05e20ea9ab93736fc610ceed5fb992eafcca5";
export const PLATFORM_COMMIT = "ff4a17ffa6a0f6055692f9147e147ab01b03a58d";
export const CANDIDATE = "78902f135e5f23018bfc3a03ebfa105eb6ebb72ce03fade5720aebeef183b9ea";
export const SDK_SHA256 = "b7c45afaa4a3605eae9bcd9c174e3d1b0fbfb55b8285b2405828a9024f6a9f0c";
export const PROVENANCE_SHA256 = "228a70074bb2a0b064c1e04a896f0276dd2ad90a257d35c4eb63642bd7bc376f";
export const GATEWAY_MANIFEST_SHA256 = "05580d0356c7fef1b6c4e73ed5c3d665a53883261cb6d008b52cb0a0f1572837";
export const RELEASE_MANIFEST_SHA256 = "49dc6cb89b474825f98f542ec4d82604c93f9252b0bffe859d8bd525e295832d";
export const GATEWAY_IMAGE_ID = "sha256:087b9c2fec23f02290f0ccca03b4c42df15b6d503ce7b8d8470466428fe92f0d";
export const GATEWAY_IMAGE_ARCHIVE_SHA256 = "45c25d943a928803e4261fc08296c962abf3e3858f95edb6a3042189ad79b017";
export const VENDOR = join(import.meta.dirname, "..", "vendor", "sdk", "candidate-78902f13");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

export function verifySdk() {
  check(digest(readFileSync(join(VENDOR, "handoff.json"))) === HANDOFF_SHA256, "Frozen handoff checksum mismatch");
  check(digest(readFileSync(join(VENDOR, "release.json"))) === RELEASE_MANIFEST_SHA256, "Release manifest checksum mismatch");
  const handoff = JSON.parse(readFileSync(join(VENDOR, "handoff.json"), "utf8"));
  check(handoff.gateway.image.imageId === GATEWAY_IMAGE_ID && handoff.gateway.image.archiveSha256 === GATEWAY_IMAGE_ARCHIVE_SHA256, "Gateway image pin mismatch");
  const tarball = join(VENDOR, "multiagency-sdk-0.6.0.tgz");
  check(digest(readFileSync(tarball)) === SDK_SHA256, "SDK tarball checksum mismatch");
  const sidecar = readFileSync(join(VENDOR, "multiagency-sdk-0.6.0.provenance.json"));
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
