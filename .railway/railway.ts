import { defineRailway, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  // The live volume: its name, region and size as Railway holds them. Renaming it here doesn't rename it: apply creates a
  // new, empty volume and mounts it at /data, leaving the audit trail and stored requests on the old one, detached (the
  // plan marks this destructive). Volumes are never deleted by apply.
  const data = volume("server-volume", { region: "us-west2", sizeMB: 50000 });

  const server = service("server", {
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/api/health",
    healthcheckTimeout: 60,
    replicas: { "us-west2": 1 },
    // No restart policy: ON_FAILURE with 10 retries is Railway's default, which it stores as unset, so declaring it is a
    // change no apply clears. No requiredMountPath: apply accepts it, but Railway keeps it unset for this service, so the
    // server checks the volume itself (TREASURY_REQUIRED_MOUNT, apps/server/src/start.ts).
    volumeMounts: { "/data": data },
    // Values are set in Railway (docs/deploy.md), never here.
    env: {
      FASTNEAR_API_KEY: preserve(),
      TREASURY_AGENT_TOKENS_FILE: preserve(),
      TREASURY_ANCHOR_ACCOUNT: preserve(),
      TREASURY_ANCHOR_KEY: preserve(),
      TREASURY_ANCHOR_KEY_FILE: preserve(),
      TREASURY_ANCHOR_NETWORK: preserve(),
      TREASURY_AUDIT_FILE: preserve(),
      TREASURY_CREDENTIAL: preserve(),
      TREASURY_CREDENTIAL_FILE: preserve(),
      TREASURY_DAO_REQUESTS_FILE: preserve(),
      TREASURY_DEPLOYMENT: preserve(),
      TREASURY_PLATFORM_ORIGIN: preserve(),
      TREASURY_PUBLIC_ORIGIN: preserve(),
      TREASURY_REQUESTS_FILE: preserve(),
      TREASURY_REQUIRED_MOUNT: preserve(),
      TREASURY_STRATEGY_PROPOSALS_FILE: preserve(),
      TREASURY_TRUSTED_PROXY_HOPS: preserve(),
      TREASURY_WATCH_FILE: preserve(),
    },
  });

  return project("treasury", { resources: [server, data] });
});
