import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Exact 0.6.0 platform/SDK pair. Production qualification is recorded separately. */
export const HANDOFF_SHA256 = "10912c1b95a595ee4ef9aa06fcc9450eb4b836e3b20c7cd79a6f8c375d21ff65";
export const PLATFORM_COMMIT = "f4729f4a7244a4e415d03678535328960b695d71";
export const CANDIDATE = "c1a3ae617f7c2ff64dc4a976e1493b96bceec56cf6c98d675d1c863cbd817509";
export const SDK_SHA256 = "aa3d4325bde4f74604280c577fac99b50acea805d27214a89899a77e1132af9a";
export const PROVENANCE_SHA256 = "b54a4a7a7e0d1ebdcf3ef9447f3356ec37fad211d6c3fac650a1e41f18bca699";
export const GATEWAY_MANIFEST_SHA256 = "0e9e6e437c8e38dbda478540f4204e4a35391939e92eec6f0d164c77977509b6";
export const RELEASE_MANIFEST_SHA256 = "717b6223c1fa65f1d9ff3f0b3b4128888162b738e71ed3b3b37ffacdd4664d9b";
export const GATEWAY_IMAGE_ID = "sha256:42cc85bd61eb2b6b1e978698be98e81061a887e00a688b74e82a159d70b2fac1";
export const GATEWAY_IMAGE_ARCHIVE_SHA256 = "4820ecd0de73ca5b5d9f448339e538d28247d1529de6e7435d6b273f5d089fbd";
export const VENDOR = join(import.meta.dirname, "..", "vendor", "sdk", "candidate-c1a3ae61");
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
