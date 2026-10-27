(function (root, factory) {
  "use strict";

  const api = Object.freeze(factory());
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else if (typeof define === "function" && define.amd) {
    define([], () => api);
  } else if (root) {
    Object.defineProperty(root, "XiaotianCPolicy", {
      value: api,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  }
})(typeof globalThis === "object" ? globalThis : this, () => {
  "use strict";

  const POLICY_VERSION = 1;
  const CLOCK_SKEW_MS = 60 * 1000;
  const MIN_POLICY_LIFETIME_MS = 60 * 1000;
  const MAX_POLICY_LIFETIME_MS = 10 * 60 * 1000;
  const REFRESH_MIN_MS = 10 * 60 * 1000;
  const REFRESH_JITTER_MS = 0;
  const MAX_TOKEN_LENGTH = 64 * 1024;
  const SIGNING_CONTEXT = "skyvendor-c-policy-v1\n";

  const NUMERIC_FIELDS = Object.freeze([
    "stopPackages",
    "ordinaryStartPackages",
    "preSubmitStopPackages",
    "claimConcurrency",
    "claimAmount",
    "preSubmitAmount",
    "preSubmitIntervalMs",
    "taskPages",
    "releaseAfterMinutes",
    "releasePackageLimit",
  ]);

  const BOOLEAN_FIELDS = Object.freeze([
    "ordinaryClaimEnabled",
    "acceptPartial",
    "preSubmitEnabled",
  ]);

  const PAYLOAD_FIELDS = Object.freeze([
    "policyVersion",
    "installId",
    "userName",
    "revision",
    "issuedAt",
    "expiresAt",
    "nonce",
    "routeMode",
    "delegated",
    "defaults",
    "bounds",
    "moduleUrl",
    "moduleHash",
  ]);

  function deepFreeze(value, seen = new WeakSet()) {
    if (!value || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
  }

  const HARD_SETTING_SCHEMA = deepFreeze({
    stopPackages: {type: "integer", min: 1, max: 10_000, fallback: 3},
    ordinaryStartPackages: {type: "integer", min: 1, max: 10_000, fallback: 1},
    preSubmitStopPackages: {type: "integer", min: 1, max: 10_000, fallback: 1},
    claimConcurrency: {type: "integer", min: 1, max: 64, fallback: 1},
    claimAmount: {type: "integer", min: 1, max: 1000, fallback: 1},
    preSubmitAmount: {type: "integer", min: 1, max: 1000, fallback: 1},
    preSubmitIntervalMs: {type: "number", min: 0.000000001, max: 60 * 60 * 1000, fallback: 50},
    taskPages: {type: "integer", min: 1, max: 500, fallback: 1},
    releaseAfterMinutes: {type: "integer", min: 0, max: 7 * 24 * 60, fallback: 30},
    releasePackageLimit: {type: "integer", min: 0, max: 10_000, fallback: 5},
    ordinaryClaimEnabled: {type: "boolean", fallback: false},
    acceptPartial: {type: "boolean", fallback: false},
    preSubmitEnabled: {type: "boolean", fallback: true},
  });

  const HARD_BOUNDS = deepFreeze(Object.fromEntries(
    NUMERIC_FIELDS.map((field) => [field, {
      min: HARD_SETTING_SCHEMA[field].min,
      max: HARD_SETTING_SCHEMA[field].max,
    }]),
  ));

  const DEFAULTS = deepFreeze(Object.fromEntries(
    [...NUMERIC_FIELDS, ...BOOLEAN_FIELDS].map((field) => [field, HARD_SETTING_SCHEMA[field].fallback]),
  ));

  let policyPublicKey = null;
  let currentPolicy = null;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function isRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function sameFieldSet(value, fields) {
    if (!isRecord(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
  }

  function canonicalJson(value) {
    const seen = new Set();

    function encode(current) {
      if (current === null) return "null";
      if (typeof current === "string" || typeof current === "boolean") return JSON.stringify(current);
      if (typeof current === "number") {
        if (!Number.isFinite(current)) throw fail("MALFORMED_PAYLOAD", "policy contains a non-finite number");
        return JSON.stringify(current);
      }
      if (Array.isArray(current)) {
        if (seen.has(current)) throw fail("MALFORMED_PAYLOAD", "policy contains a circular value");
        seen.add(current);
        try {
          return `[${current.map((item) => {
            if (item === undefined || typeof item === "function" || typeof item === "symbol") {
              throw fail("MALFORMED_PAYLOAD", "policy contains an unsupported array value");
            }
            return encode(item);
          }).join(",")}]`;
        } finally {
          seen.delete(current);
        }
      }
      if (isRecord(current)) {
        if (seen.has(current)) throw fail("MALFORMED_PAYLOAD", "policy contains a circular value");
        seen.add(current);
        try {
          return `{${Object.keys(current).sort().map((key) => {
            const item = current[key];
            if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
              throw fail("MALFORMED_PAYLOAD", `policy cannot encode key ${key}`);
            }
            return `${JSON.stringify(key)}:${encode(item)}`;
          }).join(",")}}`;
        } finally {
          seen.delete(current);
        }
      }
      throw fail("MALFORMED_PAYLOAD", `policy cannot encode ${typeof current}`);
    }

    return encode(value);
  }

  function safeInteger(value, minimum, maximum, fallback) {
    const parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, parsed));
  }

  function normalizedBoolean(value, fallback) {
    if (value === true || value === 1 || value === "1" || value === "true") return true;
    if (value === false || value === 0 || value === "0" || value === "false") return false;
    return fallback;
  }

  function canonicalInstallId(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
      throw fail("INVALID_CONTEXT", "installId is invalid");
    }
    return value;
  }

  function canonicalUserName(value) {
    if (typeof value !== "string"
      || value.length < 1
      || value.length > 128
      || value.trim().length < 1
      || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
      || value === "__proto__"
      || value === "prototype"
      || value === "constructor") {
      throw fail("INVALID_CONTEXT", "userName is invalid");
    }
    return value;
  }

  function canonicalNonce(value, code = "INVALID_NONCE") {
    if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{8,256}$/.test(value)) {
      throw fail(code, "request nonce is invalid");
    }
    return value;
  }

  function bytesToBase64(bytes) {
    if (typeof btoa === "function") {
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    }
    if (typeof Buffer === "function") return Buffer.from(bytes).toString("base64");
    throw fail("CRYPTO_UNAVAILABLE", "base64 decoder is unavailable");
  }

  function base64ToBytes(value, urlSafe, code) {
    if (typeof value !== "string" || !value || value.length > MAX_TOKEN_LENGTH) throw fail(code, "base64 value is invalid");
    const expression = urlSafe ? /^[A-Za-z0-9_-]+$/ : /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    if (!expression.test(value) || (urlSafe && value.length % 4 === 1)) throw fail(code, "base64 value is invalid");
    const standard = urlSafe ? value.replace(/-/g, "+").replace(/_/g, "/") : value;
    const padded = standard + "=".repeat((4 - standard.length % 4) % 4);
    let bytes;
    try {
      if (typeof atob === "function") {
        const binary = atob(padded);
        bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      } else if (typeof Buffer === "function") {
        bytes = Uint8Array.from(Buffer.from(padded, "base64"));
      } else {
        throw new Error("decoder unavailable");
      }
    } catch {
      throw fail(code, "base64 value is invalid");
    }
    const canonical = bytesToBase64(bytes).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const expected = urlSafe ? value : value.replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    if (canonical !== expected) throw fail(code, "base64 value is not canonical");
    return bytes;
  }

  function utf8Bytes(value) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(value);
    if (typeof Buffer === "function") return Uint8Array.from(Buffer.from(value, "utf8"));
    throw fail("CRYPTO_UNAVAILABLE", "UTF-8 encoder is unavailable");
  }

  function utf8Text(value) {
    if (typeof TextDecoder === "function") {
      try {
        return new TextDecoder("utf-8", {fatal: true}).decode(value);
      } catch {
        throw fail("MALFORMED_PAYLOAD", "policy payload is not valid UTF-8");
      }
    }
    if (typeof Buffer === "function") return Buffer.from(value).toString("utf8");
    throw fail("CRYPTO_UNAVAILABLE", "UTF-8 decoder is unavailable");
  }

  function webCrypto() {
    const candidate = typeof globalThis === "object" ? globalThis.crypto : null;
    if (!candidate || !candidate.subtle) throw fail("CRYPTO_UNAVAILABLE", "WebCrypto is unavailable");
    return candidate;
  }

  function validSettingNumber(value, schema) {
    return schema.type === "number" ? Number.isFinite(value) : Number.isSafeInteger(value);
  }

  function normalizeBound(rawValue, schema) {
    if (!sameFieldSet(rawValue, ["min", "max"])
      || !validSettingNumber(rawValue.min, schema)
      || !validSettingNumber(rawValue.max, schema)
      || rawValue.min < (schema.type === "number" ? Number.MIN_VALUE : schema.min)
      || rawValue.max > schema.max
      || rawValue.max < schema.min
      || rawValue.min > rawValue.max) {
      throw fail("INVALID_BOUNDS", "policy bounds exceed client safety limits");
    }
    // The server may advertise every positive interval. Intersect that range
    // with our supported floor without rejecting an otherwise valid policy.
    return {min: Math.max(schema.min, rawValue.min), max: rawValue.max};
  }

  function normalizeSettingsPolicy(rawDefaults, rawBounds) {
    if (!sameFieldSet(rawDefaults, [...NUMERIC_FIELDS, ...BOOLEAN_FIELDS])) {
      throw fail("INVALID_DEFAULTS", "policy defaults field set is invalid");
    }
    if (!sameFieldSet(rawBounds, NUMERIC_FIELDS)) {
      throw fail("INVALID_BOUNDS", "policy bounds field set is invalid");
    }
    const defaults = {};
    const bounds = {};

    for (const name of BOOLEAN_FIELDS) {
      if (typeof rawDefaults[name] !== "boolean") throw fail("INVALID_DEFAULTS", `policy default ${name} is invalid`);
      defaults[name] = rawDefaults[name];
    }
    for (const name of NUMERIC_FIELDS) {
      const schema = HARD_SETTING_SCHEMA[name];
      const normalizedBound = normalizeBound(rawBounds[name], schema);
      const value = rawDefaults[name];
      if (!validSettingNumber(value, schema) || value < normalizedBound.min || value > normalizedBound.max) {
        throw fail("INVALID_DEFAULTS", `policy default ${name} is outside signed bounds`);
      }
      bounds[name] = normalizedBound;
      defaults[name] = value;
    }
    return {defaults, bounds};
  }

  function validModuleUrl(value) {
    if (typeof value !== "string" || value.length > 320) return false;
    if (!/^\/api\/v3c\/module\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
    const suffix = value.slice("/api/v3c/module/".length);
    return suffix.length > 0
      && !suffix.includes("//")
      && suffix.split("/").every((part) => part && part !== "." && part !== "..");
  }

  function validModuleHash(value) {
    if (typeof value !== "string" || !/^sha256-[A-Za-z0-9+/_-]{43}=?$/.test(value)) return false;
    try {
      const encoded = value.slice(7).replace(/=+$/g, "").replace(/-/g, "+").replace(/_/g, "/");
      const padded = encoded + "=".repeat((4 - encoded.length % 4) % 4);
      return base64ToBytes(padded, false, "INVALID_MODULE_HASH").byteLength === 32;
    } catch {
      return false;
    }
  }

  function parseAndNormalizePayload(payloadBytes, payloadSegment, expected, now) {
    let source;
    try {
      source = JSON.parse(utf8Text(payloadBytes));
    } catch (error) {
      if (error && error.code) throw error;
      throw fail("MALFORMED_PAYLOAD", "policy payload is not valid JSON");
    }
    if (!isRecord(source)) throw fail("MALFORMED_PAYLOAD", "policy payload must be an object");
    if (!sameFieldSet(source, PAYLOAD_FIELDS)) throw fail("MALFORMED_PAYLOAD", "policy payload field set is invalid");
    const canonicalSegment = bytesToBase64(utf8Bytes(canonicalJson(source)))
      .replace(/=+$/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    if (canonicalSegment !== payloadSegment) throw fail("MALFORMED_PAYLOAD", "policy payload is not canonical JSON");
    if (source.policyVersion !== POLICY_VERSION) {
      throw fail("UNSUPPORTED_VERSION", "policy version is unsupported");
    }

    const expectedInstallId = canonicalInstallId(expected && expected.installId);
    const expectedUserName = canonicalUserName(expected && expected.userName);
    const expectedNonce = canonicalNonce(expected && (expected.nonce || expected.requestNonce));
    const installId = canonicalInstallId(source.installId);
    const userName = canonicalUserName(source.userName);
    const nonce = canonicalNonce(source.nonce);
    if (installId !== expectedInstallId) throw fail("INSTALL_MISMATCH", "policy belongs to a different installation");
    if (userName !== expectedUserName) throw fail("USER_MISMATCH", "policy belongs to a different user");
    if (nonce !== expectedNonce) throw fail("NONCE_MISMATCH", "policy nonce does not match this request");

    const revision = source.revision;
    if (!Number.isSafeInteger(revision) || revision <= 0) throw fail("INVALID_REVISION", "policy revision is invalid");
    if (currentPolicy && revision <= currentPolicy.revision) throw fail("STALE_REVISION", "policy revision is not newer");

    const issuedAt = source.issuedAt;
    const expiresAt = source.expiresAt;
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
      || expiresAt <= issuedAt
      || expiresAt - issuedAt < MIN_POLICY_LIFETIME_MS
      || expiresAt - issuedAt > MAX_POLICY_LIFETIME_MS
      || issuedAt > now + CLOCK_SKEW_MS) {
      throw fail("INVALID_TIME", "policy time window is invalid");
    }
    if (expiresAt <= now) throw fail("EXPIRED_POLICY", "policy has expired");

    if (source.routeMode !== "server" && source.routeMode !== "local") {
      throw fail("INVALID_ROUTE", "policy routeMode is invalid");
    }
    if (typeof source.delegated !== "boolean") throw fail("INVALID_DELEGATION", "policy delegated flag is invalid");
    if ((source.delegated && source.routeMode !== "local") || (!source.delegated && source.routeMode !== "server")) {
      throw fail("INVALID_DELEGATION", "routeMode and delegated flag disagree");
    }

    const moduleUrl = source.moduleUrl == null ? "" : String(source.moduleUrl);
    const moduleHash = source.moduleHash == null ? "" : String(source.moduleHash);
    if (!source.delegated && (moduleUrl || moduleHash)) {
      throw fail("UNEXPECTED_MODULE", "non-delegated policy cannot contain a local module");
    }
    if (source.delegated && (!validModuleUrl(moduleUrl) || !validModuleHash(moduleHash))) {
      throw fail("INVALID_MODULE", "delegated policy module is invalid");
    }

    const settings = normalizeSettingsPolicy(source.defaults, source.bounds);
    return {
      policyVersion: POLICY_VERSION,
      installId,
      userName,
      nonce,
      revision,
      issuedAt,
      expiresAt,
      routeMode: source.routeMode,
      delegated: source.delegated,
      moduleUrl: source.delegated ? moduleUrl : "",
      moduleHash: source.delegated ? moduleHash : "",
      defaults: settings.defaults,
      bounds: settings.bounds,
    };
  }

  async function importPolicyPublicKey(spkiBase64) {
    const bytes = base64ToBytes(String(spkiBase64 || "").trim(), false, "INVALID_PUBLIC_KEY");
    let imported;
    try {
      imported = await webCrypto().subtle.importKey(
        "spki",
        bytes,
        {name: "Ed25519"},
        false,
        ["verify"],
      );
    } catch {
      throw fail("INVALID_PUBLIC_KEY", "policy public key is not valid Ed25519 SPKI");
    }
    policyPublicKey = imported;
    currentPolicy = null;
    return true;
  }

  async function setPolicy(token, expected, now = Date.now()) {
    if (!policyPublicKey) throw fail("PUBLIC_KEY_REQUIRED", "policy public key has not been imported");
    const timestamp = safeInteger(now, 0, Number.MAX_SAFE_INTEGER, Date.now());
    if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) {
      throw fail("MALFORMED_TOKEN", "signed policy token is invalid");
    }
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw fail("MALFORMED_TOKEN", "signed policy token is invalid");
    const payloadBytes = base64ToBytes(parts[0], true, "MALFORMED_PAYLOAD");
    const signatureBytes = base64ToBytes(parts[1], true, "MALFORMED_SIGNATURE");
    if (signatureBytes.byteLength !== 64) throw fail("MALFORMED_SIGNATURE", "Ed25519 signature must be 64 bytes");

    let verified = false;
    try {
      verified = await webCrypto().subtle.verify(
        {name: "Ed25519"},
        policyPublicKey,
        signatureBytes,
        utf8Bytes(`${SIGNING_CONTEXT}${parts[0]}`),
      );
    } catch {
      verified = false;
    }
    if (!verified) throw fail("BAD_SIGNATURE", "policy signature verification failed");

    const normalized = parseAndNormalizePayload(payloadBytes, parts[0], expected, timestamp);
    currentPolicy = deepFreeze(normalized);
    return currentPolicy;
  }

  function getCurrentPolicy() {
    return currentPolicy;
  }

  function clearPolicy() {
    currentPolicy = null;
    return null;
  }

  function isUsable(now = Date.now()) {
    if (!currentPolicy) return false;
    const timestamp = safeInteger(now, 0, Number.MAX_SAFE_INTEGER, Date.now());
    return timestamp >= currentPolicy.issuedAt - CLOCK_SKEW_MS && timestamp < currentPolicy.expiresAt;
  }

  function effectiveSettings(localOverrides, now = Date.now()) {
    if (!isUsable(now)) return null;
    if (!currentPolicy.delegated) return currentPolicy.defaults;

    const source = isRecord(localOverrides) ? localOverrides : {};
    const effective = {};
    for (const [name, defaultValue] of Object.entries(currentPolicy.defaults)) {
      const schema = HARD_SETTING_SCHEMA[name];
      if (schema.type === "boolean") {
        effective[name] = normalizedBoolean(source[name], defaultValue);
        continue;
      }
      const bound = currentPolicy.bounds[name];
      if (schema.type === "number") {
        const value = Number(source[name]);
        effective[name] = Math.max(bound.min, Math.min(bound.max, Number.isFinite(value) ? value : defaultValue));
      } else {
        effective[name] = safeInteger(source[name], bound.min, bound.max, defaultValue);
      }
    }
    return deepFreeze(effective);
  }

  function nextRefreshAt(now = Date.now(), randomSource = Math.random) {
    if (!isUsable(now)) return 0;
    const timestamp = safeInteger(now, 0, Number.MAX_SAFE_INTEGER, Date.now());
    let randomValue;
    try {
      randomValue = typeof randomSource === "function" ? Number(randomSource()) : Number(randomSource);
    } catch {
      randomValue = 0;
    }
    if (!Number.isFinite(randomValue)) randomValue = 0;
    randomValue = Math.max(0, Math.min(1, randomValue));
    const target = timestamp + REFRESH_MIN_MS + Math.floor(randomValue * REFRESH_JITTER_MS);
    // Leave time for renewal, including when an older server issues a shorter lease.
    return Math.min(target, currentPolicy.expiresAt - 30 * 1000);
  }

  return {
    POLICY_VERSION,
    NUMERIC_FIELDS,
    BOOLEAN_FIELDS,
    HARD_BOUNDS,
    DEFAULTS,
    HARD_SETTING_SCHEMA,
    importPolicyPublicKey,
    setPolicy,
    verifyAndSetPolicy: setPolicy,
    getCurrentPolicy,
    clearPolicy,
    isUsable,
    effectiveSettings,
    nextRefreshAt,
  };
});
