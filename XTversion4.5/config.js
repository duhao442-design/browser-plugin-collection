(() => {
  "use strict";
  const API_ROUTES_V3 = Object.freeze({
    activate: "/api/activate",
    heartbeat: "/api/heartbeat",
    clientConfig: "/api/client-config",
    cPolicy: "/api/v3c/policy",
    cPolicyWatch: "/api/v3c/policy/watch",
    v24Start: "/api/v3c/server/start",
    v24Stop: "/api/v3c/server/stop",
    v24Settings: "/api/v3c/server/settings",
    v24BrowserStatus: "/api/v3/browser/status",
    v24BrowserNameAck: "/api/v3/browser/name-ack",
    v24BrowserLoginPhone: "/api/v3/browser/login/phone",
    v24BrowserLoginCode: "/api/v3/browser/login/code",
    v24BrowserLogout: "/api/v3/browser/logout",
    v24RelayPoll: "/api/v3c/server/relay/poll",
    v24RelayResult: "/api/v3c/server/relay/result",
    v24Poll: "/api/v3c/server/poll",
    v24Claim: "/api/v3c/server/claim",
    v24Confirm: "/api/v3c/server/confirm",
  });
  const API_ROUTES_V24_COMPAT = Object.freeze({
    activate: "/api/activate",
    heartbeat: "/api/heartbeat",
    clientConfig: "/api/client-config",
    cPolicy: "/api/v3c/policy",
    cPolicyWatch: "/api/v3c/policy/watch",
    v24Start: "/api/v3c/server/start",
    v24Stop: "/api/v3c/server/stop",
    v24Settings: "/api/v3c/server/settings",
    v24BrowserStatus: "/api/v24/browser/status",
    v24BrowserNameAck: "/api/v24/browser/name-ack",
    v24BrowserLoginPhone: "/api/v24/browser/login/phone",
    v24BrowserLoginCode: "/api/v24/browser/login/code",
    v24BrowserLogout: "/api/v24/browser/logout",
    v24RelayPoll: "/api/v3c/server/relay/poll",
    v24RelayResult: "/api/v3c/server/relay/result",
    v24Poll: "/api/v3c/server/poll",
    v24Claim: "/api/v3c/server/claim",
    v24Confirm: "/api/v3c/server/confirm",
  });
  const SERVER_PROFILES = Object.freeze({
    primary: Object.freeze({
      apiBase: "https://8.135.29.12/sv-v3",
      routes: API_ROUTES_V3,
    }),
    v24Compatibility: Object.freeze({
      apiBase: "https://8.135.29.12/sv-v24b",
      routes: API_ROUTES_V24_COMPAT,
    }),
  });
  const ACTIVE_SERVER_PROFILE = "primary";
  const ACTIVE_SERVER = SERVER_PROFILES[ACTIVE_SERVER_PROFILE];
  globalThis.XiaotianV24Config = Object.freeze({
    SERVER_PROFILES,
    ACTIVE_SERVER_PROFILE,
    EXECUTION_MODE: "autonomous",
    PLATFORM_TRANSPORT_MODE: "c-hybrid",
    CLAIM_STRATEGY: "availability-watch",
    NORMAL_DISPATCH_MODE: "local-command",
    API_BASE: ACTIVE_SERVER.apiBase,
    API_ROUTES: ACTIVE_SERVER.routes,
    STATE_KEY: "xiaotianV3CState",
    SESSION_KEY: "xiaotianV3CSession",
    REQUEST_TIMEOUT_MS: 10000,
    LOGIN_REQUEST_TIMEOUT_MS: 90000,
    RELAY_WORKERS: 3,
    RELAY_BATCH_SIZE: 3,
    RELAY_RETRY_MS: 150,
    LOCAL_TASK_REFRESH_MS: 100,
    MIN_REQUEST_INTERVAL_MS: 0.000000001,
    LOGIN_STATUS_REFRESH_MS: 500,
    // Keep the panel and server-side working state in sync at the same
    // cadence as the 2.2 client. This is display/control polling only; it
    // does not change the server-provided claim interval.
    STATUS_REFRESH_MS: 1000,
    HEARTBEAT_MINUTES: 1,
    HEARTBEAT_ALARM: "xiaotian-v24-heartbeat",
    C_POLICY_PUBLIC_KEY_SPKI_BASE64: "MCowBQYDK2VwAyEAEH2dr7+x50FX5JX87qfkf0oIp0+U1V1d3M7ooCxzodE=",
    CLIENT_CONFIG_REFRESH_MS: 10 * 60 * 1000,
    C_POLICY_REFRESH_MIN_MS: 10 * 60 * 1000,
    C_POLICY_REFRESH_JITTER_MS: 0,
    C_POLICY_MAX_AGE_MS: 10 * 60 * 1000,
    FULL_PAGE_REFRESH_FALLBACK: false
  });
})();
