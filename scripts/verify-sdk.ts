import { verifySdk, PLATFORM_COMMIT, CANDIDATE, SDK_SHA256, GATEWAY_MANIFEST_SHA256, GATEWAY_IMAGE_ID, RELEASE_MANIFEST_SHA256 } from "./sdk-pin.ts";
verifySdk();
console.log(JSON.stringify({ offlineConsumerValidationOnly: true, releaseHold: true, source: PLATFORM_COMMIT,
  candidate: CANDIDATE, sdkSha256: SDK_SHA256, gatewayManifestSha256: GATEWAY_MANIFEST_SHA256, gatewayImage: GATEWAY_IMAGE_ID, releaseManifestSha256: RELEASE_MANIFEST_SHA256 }));
