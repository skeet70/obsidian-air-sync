export const PROTON_MODULE_VERSION = "0.1.0";

/** Host without scheme, the form the SDK's `ProtonDriveConfig.baseUrl` requires. */
export const PROTON_API_HOST = "drive-api.proton.me";
export const PROTON_API_BASE = `https://${PROTON_API_HOST}`;
export const PROTON_ACCOUNT_BASE = "https://account.proton.me";

/** `x-pm-appversion`: Proton's required shape for third-party clients. */
export const PROTON_APP_VERSION = `external-drive-air_sync@${PROTON_MODULE_VERSION}-alpha`;

/** Session-fork client id Proton assigns to third-party Drive clients. */
export const PROTON_AUTH_CLIENT_ID = "external-drive";
