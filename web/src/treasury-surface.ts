/** Build-time presentation scope. Server authorization remains authoritative. */
export const TREASURY_ONLY = process.env.PUBLIC_TREASURY_ONLY === "true";
