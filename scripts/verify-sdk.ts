import { verifySdk, PLATFORM_COMMIT, CANDIDATE, SDK_SHA256, GATEWAY_MANIFEST_SHA256 } from "./sdk-pin.ts";
verifySdk();
console.log(JSON.stringify({ developmentOnly: true, releaseHold: true, source: PLATFORM_COMMIT,
  candidate: CANDIDATE, sdkSha256: SDK_SHA256, gatewayManifestSha256: GATEWAY_MANIFEST_SHA256 }));
