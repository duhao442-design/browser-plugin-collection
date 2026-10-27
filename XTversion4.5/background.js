"use strict";
importScripts("config.js", "c-policy.js", "turbo-runner.js", "turbo-background.js", "claim-audit-client.js");

const CONFIG = globalThis.XiaotianV24Config;
const C_POLICY = globalThis.XiaotianCPolicy;
const PRE_SUBMIT_TARGET_PACKAGES = 1;
const PRE_SUBMIT_AMOUNT = 1;
const PRE_SUBMIT_TASK_PAGES = 1;
const DEFAULT_RELEASE_AFTER_MINUTES = 30;
const DEFAULT_RELEASE_PACKAGE_LIMIT = 5;
const ACCEPTANCE_ITEMS_PER_PACKAGE = 3;
const LOCAL_COMPLETION_CHECK_MS = 250;
const SUBTASK_SUMMARY_CACHE_MS = 30 * 1000;
const RELEASE_GUARD_PENDING_MS = 2 * 60 * 1000;
const RELEASE_GUARD_SUCCESS_MS = 10 * 60 * 1000;
const RELEASE_GUARD_KEY = `${CONFIG.STATE_KEY}ReleaseGuards`;
const PACKAGE_OBSERVED_KEY = `${CONFIG.STATE_KEY}PackageObservedAt`;
const SERVER_IDENTITY_VERSION = 1;
let operationQueue = Promise.resolve();
let relayGeneration = 0;
let relayTabId = 0;
let relayLoopCount = 0;
let controlGeneration = 0;
let controlTabId = 0;
let localTaskCursor = 0;
let localCatalogGeneration = 0;
let localCatalogTabId = 0;
let localCatalogRefreshPromise = null;
let liveLocalCatalog = {
  tabId: 0,
  taskCatalog: [],
  updatedAt: 0,
  fullCatalogAt: 0,
  fullProgressAt: 0,
  progressMeta: new Map(),
  rounds: 0,
};
let controlWakeResolver = null;
let localReadRequestsPending = 0;
let localReadIntervalSumPending = 0;
let localReadIntervalSamplesPending = 0;
let lastLocalReadAt = 0;
let lastPlatformDirectReadAt = 0;
let localWorkingReadSequence = 0;
let browserManualLoginUrl = "";
let browserAuthGeneration = 0;
let emergencyStopSequence = 0;
let cPolicyKeyReady = null;
let cPolicyToken = "";
let cPolicyNextRefreshAt = 0;
let cPolicyLastError = "";
let cPolicyControlRevision = 0;
let cModuleSource = "";
let cModuleHash = "";
let cModuleSessionNonce = "";
let cVolatileOverrides = Object.create(null);
let runtimePlatformRoutes = null;
let runtimeConfigFetchedAt = 0;
const C_POLICY_REFRESH_ALARM = "xiaotian-v3c-policy-refresh";
const C_POLICY_EXPIRY_ALARM = "xiaotian-v3c-policy-expiry";
const C_POLICY_WATCH_WAIT_MS = 25000;
const C_POLICY_WATCH_RETRY_MS = 1000;
const cPolicyPagePorts = new Set();
let cPolicyWatchGeneration = 0;
let cPolicyWatchPromise = null;
let serverAccessRevoked = false;
let cPolicyRefreshPromise = null;
let cPolicyRefreshForcePending = false;
let cPolicyRefreshState = null;
const releaseRequestsInFlight = new Map();
const platformTokenByTab = new Map();
const subTaskSummaryCache = new Map();
const subTaskSummaryRefreshes = new Map();

function enqueue(operation) {
  const next = operationQueue.then(operation, operation);
  operationQueue = next.catch(() => {});
  return next;
}

function number(value) {
  const result = Math.trunc(Number(value));
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

function requestIntervalMs(value, fallback = 50) {
  const parsed = Number(value);
  return Math.max(CONFIG.MIN_REQUEST_INTERVAL_MS, Number.isFinite(parsed) && parsed > 0 ? parsed : fallback);
}

function extensionDisplayVersion() {
  const manifest = chrome.runtime.getManifest();
  return String(manifest.version_name || manifest.version || "3.0C.3").slice(0, 64);
}

function normalizeRuntimePlatformRoutes(value) {
  const source = value && typeof value === "object" ? value : {};
  const base = String(source.base || "").trim().replace(/\/+$/, "");
  const cleanPath = (item) => {
    const path = String(item || "").trim();
    return path.startsWith("/") && !path.includes("//") && !path.includes("..") ? path : "";
  };
  return {
    base,
    tasks: cleanPath(source.tasks),
    process: cleanPath(source.process),
    subTasks: cleanPath(source.subTasks),
    summary: cleanPath(source.summary),
    claim: cleanPath(source.claim),
    release: cleanPath(source.release),
  };
}

function runtimePlatformRoutesReady(required = ["tasks", "process", "subTasks", "summary", "claim", "release"]) {
  const routes = runtimePlatformRoutes && typeof runtimePlatformRoutes === "object" ? runtimePlatformRoutes : {};
  return Boolean(routes.base && required.every((name) => String(routes[name] || "").startsWith("/")));
}

function clearResolvedPlatformRouteError(state) {
  if (!state || !runtimePlatformRoutesReady()) return state;
  if (/服务器平台路由(?:尚未下发|参数无效)/.test(String(state.lastError || ""))) state.lastError = "";
  return state;
}

function platformRoute(name, values = {}) {
  const routes = runtimePlatformRoutes || {};
  let path = String(routes[name] || "");
  if (!path) throw new Error("服务器平台路由尚未下发");
  path = path.replace(/\{(taskId|subTaskId)\}/g, (_, key) => encodeURIComponent(String(values[key] || "")));
  if (!path || path.includes("{")) throw new Error("服务器平台路由参数无效");
  return path;
}

function randomCNonce() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function cPolicyCurrent() {
  return C_POLICY && typeof C_POLICY.getCurrentPolicy === "function"
    ? C_POLICY.getCurrentPolicy()
    : null;
}

function cPolicyUsable(now = Date.now()) {
  return !!(C_POLICY && typeof C_POLICY.isUsable === "function" && C_POLICY.isUsable(now));
}

function cPolicyDelegated(now = Date.now()) {
  const policy = cPolicyCurrent();
  return cPolicyUsable(now) && !!policy && policy.delegated === true && policy.routeMode === "local";
}

function clearCModuleMemory() {
  cModuleSource = "";
  cModuleHash = "";
  cModuleSessionNonce = "";
}

function clearCPolicyMemory(reason = "") {
  if (C_POLICY && typeof C_POLICY.clearPolicy === "function") C_POLICY.clearPolicy();
  cPolicyToken = "";
  cPolicyNextRefreshAt = 0;
  cPolicyControlRevision = 0;
  cPolicyLastError = String(reason || "").slice(0, 300);
  cVolatileOverrides = Object.create(null);
  clearCModuleMemory();
}

function cPolicyReason(now = Date.now()) {
  const policy = cPolicyCurrent();
  if (!policy) return cPolicyLastError || "等待服务器下发C策略";
  if (number(policy.expiresAt) <= now) return cPolicyLastError || "C策略已过期，领取已停止";
  return cPolicyLastError || "";
}

function cPolicyPublic(now = Date.now()) {
  const policy = cPolicyCurrent();
  const usable = cPolicyUsable(now);
  return {
    usable,
    delegated: usable && policy && policy.delegated === true,
    routeMode: usable && policy && policy.routeMode === "local" ? "local" : "server",
    revision: number(policy && policy.revision),
    issuedAt: number(policy && policy.issuedAt),
    expiresAt: number(policy && policy.expiresAt),
    defaults: policy && policy.defaults || {},
    bounds: policy && policy.bounds || {},
    moduleLoaded: usable && policy && policy.delegated === true && !!cModuleSource && cModuleHash === policy.moduleHash,
    reason: usable ? "" : cPolicyReason(now),
  };
}

function requireCPolicy(options = {}) {
  const policy = cPolicyCurrent();
  if (!policy || !cPolicyUsable()) throw new Error(cPolicyReason() || "C策略不可用");
  if (options.local === true && (policy.delegated !== true || policy.routeMode !== "local" || !cModuleSource || cModuleHash !== policy.moduleHash)) {
    throw new Error(cPolicyLastError || "C本机放权模组尚未就绪");
  }
  return policy;
}

function cPolicyCoreSettings() {
  if (!cPolicyUsable()) return null;
  // The interval is server-owned; unrelated UI saves must not pin an old value.
  const effective = C_POLICY.effectiveSettings({...cVolatileOverrides,
    preSubmitIntervalMs: cPolicyCurrent()?.defaults?.preSubmitIntervalMs});
  if (!effective) return null;
  const ordinaryOnly = cPolicyDelegated() && (turboServerInterval() > 10 || effective.preSubmitEnabled === false);
  if (cPolicyDelegated() && turboServerInterval() > 10) {
    cVolatileOverrides.preSubmitEnabled = false;
    stopTurboRun("服务器间隔高于10ms，已关闭极速模式");
  }
  return {
    targetPackages: Math.max(1, number(effective.stopPackages) || 1),
    stopPackages: Math.max(1, number(effective.stopPackages) || 1),
    ordinaryClaimEnabled: ordinaryOnly || effective.ordinaryClaimEnabled === true,
    ordinaryStartPackages: ordinaryOnly ? 0 : Math.max(1, number(effective.ordinaryStartPackages) || 1),
    preSubmitEnabled: !ordinaryOnly && effective.preSubmitEnabled !== false,
    preSubmitStopPackages: Math.max(1, number(effective.preSubmitStopPackages) || 1),
    claimConcurrency: Math.max(1, number(effective.claimConcurrency) || 1),
    claimAmount: Math.max(1, number(effective.claimAmount) || 1),
    preSubmitAmount: Math.max(1, number(effective.preSubmitAmount) || 1),
    preSubmitIntervalMs: requestIntervalMs(effective.preSubmitIntervalMs),
    taskPages: Math.max(1, number(effective.taskPages) || 1),
    releaseAfterMinutes: number(effective.releaseAfterMinutes),
    releasePackageLimit: number(effective.releasePackageLimit),
    // Partial packages are always accepted; this is no longer a user option.
    acceptPartial: true,
  };
}

async function ensureCPolicyPublicKey() {
  if (!cPolicyKeyReady) {
    cPolicyKeyReady = Promise.resolve().then(() => C_POLICY.importPolicyPublicKey(CONFIG.C_POLICY_PUBLIC_KEY_SPKI_BASE64));
  }
  return cPolicyKeyReady;
}

async function scheduleCPolicyAlarms() {
  const policy = cPolicyCurrent();
  await chrome.alarms.clear(C_POLICY_REFRESH_ALARM);
  await chrome.alarms.clear(C_POLICY_EXPIRY_ALARM);
  if (!policy || !cPolicyUsable()) return;
  const refreshAt = Math.max(Date.now() + 1000, number(cPolicyNextRefreshAt));
  const expiresAt = number(policy.expiresAt);
  if (refreshAt && refreshAt < expiresAt) await chrome.alarms.create(C_POLICY_REFRESH_ALARM, {when: refreshAt});
  if (expiresAt) await chrome.alarms.create(C_POLICY_EXPIRY_ALARM, {when: expiresAt + 25});
}

function serverOrdinaryClaimEnabled(runtimePolicy = {}) {
  return runtimePolicy && runtimePolicy.ordinaryClaimEnabled === true;
}

function serverStopPackages(runtimePolicy = {}) {
  const value = number(runtimePolicy && runtimePolicy.stopPackages);
  return Math.max(1, value || PRE_SUBMIT_TARGET_PACKAGES);
}

function serverOrdinaryStartPackages(runtimePolicy = {}) {
  const value = number(runtimePolicy && (runtimePolicy.ordinaryStartPackages ?? runtimePolicy.normalStartPackages));
  return Math.max(1, value || 1);
}

function serverPreSubmitStopPackages(runtimePolicy = {}) {
  const value = number(runtimePolicy && runtimePolicy.preSubmitStopPackages);
  return Math.max(1, value || PRE_SUBMIT_TARGET_PACKAGES);
}

function serverClaimAmount(runtimePolicy = {}) {
  const value = number(runtimePolicy && runtimePolicy.claimAmount);
  return Math.max(1, value || PRE_SUBMIT_AMOUNT);
}

function serverPreSubmitAmount(runtimePolicy = {}) {
  const value = number(runtimePolicy && runtimePolicy.preSubmitAmount);
  return Math.max(1, value || PRE_SUBMIT_AMOUNT);
}

function serverTaskPages(runtimePolicy = {}) {
  const value = number(runtimePolicy && runtimePolicy.taskPages);
  return Math.max(1, value || PRE_SUBMIT_TASK_PAGES);
}

function serverReleaseAfterMinutes(runtimePolicy = {}) {
  if (!runtimePolicy || !Object.prototype.hasOwnProperty.call(runtimePolicy, "releaseAfterMinutes")) {
    return DEFAULT_RELEASE_AFTER_MINUTES;
  }
  const value = Math.trunc(Number(runtimePolicy.releaseAfterMinutes));
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_RELEASE_AFTER_MINUTES;
}

function serverReleasePackageLimit(runtimePolicy = {}) {
  if (!runtimePolicy || !Object.prototype.hasOwnProperty.call(runtimePolicy, "releasePackageLimit")) {
    return DEFAULT_RELEASE_PACKAGE_LIMIT;
  }
  const value = Math.trunc(Number(runtimePolicy.releasePackageLimit));
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_RELEASE_PACKAGE_LIMIT;
}

async function storageObject(area, key) {
  try {
    const stored = await area.get(key);
    const value = stored && stored[key];
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    return {};
  }
}

async function attachPackageObservationTimes(rows) {
  const activeRows = Array.from(rows || []);
  const now = Date.now();
  const observed = await storageObject(chrome.storage.local, PACKAGE_OBSERVED_KEY);
  let changed = false;
  for (const row of activeRows) {
    const subTaskId = String(row && row.id || "").trim().slice(0, 120);
    if (!subTaskId || number(observed[subTaskId])) continue;
    observed[subTaskId] = now;
    changed = true;
  }
  for (const [subTaskId, timestamp] of Object.entries(observed)) {
    if (now - number(timestamp) <= 24 * 60 * 60 * 1000) continue;
    delete observed[subTaskId];
    changed = true;
  }
  if (changed) await chrome.storage.local.set({[PACKAGE_OBSERVED_KEY]: observed});
  return activeRows.map((row) => {
    const subTaskId = String(row && row.id || "").trim().slice(0, 120);
    const localObservedAt = number(observed[subTaskId]);
    return localObservedAt ? {...row, localObservedAt} : row;
  });
}

async function reserveReleaseRequest(subTaskId) {
  const now = Date.now();
  const guards = await storageObject(chrome.storage.session, RELEASE_GUARD_KEY);
  const previous = guards[subTaskId] && typeof guards[subTaskId] === "object" ? guards[subTaskId] : {};
  const previousAt = number(previous.at);
  const ttl = previous.status === "success" ? RELEASE_GUARD_SUCCESS_MS : RELEASE_GUARD_PENDING_MS;
  if (previousAt && now - previousAt < ttl) return false;
  guards[subTaskId] = {status: "pending", at: now};
  for (const [id, item] of Object.entries(guards)) {
    if (now - number(item && item.at) > RELEASE_GUARD_SUCCESS_MS) delete guards[id];
  }
  await chrome.storage.session.set({[RELEASE_GUARD_KEY]: guards});
  return true;
}

async function markReleaseRequestSuccess(subTaskId) {
  const guards = await storageObject(chrome.storage.session, RELEASE_GUARD_KEY);
  guards[subTaskId] = {status: "success", at: Date.now()};
  await chrome.storage.session.set({[RELEASE_GUARD_KEY]: guards});
}

function validPlatformAccount(value) {
  const account = String(value || "").replace(/\s+/g, " ").trim().slice(0, 128);
  if (!account || /^(?:[-—_·.]+|未登记|未登記|未知|null|undefined)$/i.test(account)) return "";
  return account;
}

const AUTHENTICATED_BROWSER_STATES = new Set([
  "authenticated", "authorized", "logged-in", "logged_in", "loggedin",
  "signed-in", "signed_in", "ready", "active", "login-success", "login_success",
]);

function normalizedAuthState(value) {
  return String(value || "unknown").trim().slice(0, 48).toLowerCase() || "unknown";
}

function isAuthenticatedBrowserState(value) {
  return AUTHENTICATED_BROWSER_STATES.has(normalizedAuthState(value));
}

function sanitizedAuthMessage(value) {
  return String(value || "")
    .replace(/\+?\d[\d\s()-]{7,}\d/g, "••••")
    .replace(/\b\d{4,8}\b/g, "••••")
    .trim()
    .slice(0, 300);
}

function sanitizedMaskedPhone(value) {
  const text = String(value || "").trim().slice(0, 80);
  const digits = text.replace(/\D/g, "");
  if (digits.length > 6 && !/[＊*•]/.test(text)) return `••••${digits.slice(-4)}`;
  return text;
}

function sanitizedManualLoginUrl(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 2048) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.href;
  } catch (error) {
    return "";
  }
}

function defaultBrowserAuth() {
  return {
    reported: false,
    authState: "unknown",
    loginRequired: false,
    challengeRequired: false,
    manualLoginAvailable: false,
    message: "",
    phoneMasked: "",
    updatedAt: 0,
  };
}

function normalizeBrowserAuth(value) {
  const source = value && typeof value === "object" ? value : {};
  const authState = normalizedAuthState(source.authState);
  const reported = source.reported === true;
  const authenticated = isAuthenticatedBrowserState(authState);
  const challengeRequired = reported && !authenticated
    && (source.challengeRequired === true || authState === "challenge-required" || authState === "challenge_required");
  return {
    reported,
    authState,
    loginRequired: reported && !authenticated && (source.loginRequired === true || challengeRequired || authState !== "unknown"),
    challengeRequired,
    manualLoginAvailable: challengeRequired && source.manualLoginAvailable === true,
    message: sanitizedAuthMessage(source.message),
    phoneMasked: sanitizedMaskedPhone(source.phoneMasked),
    updatedAt: number(source.updatedAt),
  };
}

function applyBrowserAuthResponse(state, response, options = {}) {
  const source = response && typeof response === "object" ? response : {};
  const serverUserName = validPlatformAccount(source.userName).slice(0, 80);
  if (serverUserName) state.userName = serverUserName;
  const previous = normalizeBrowserAuth(state && state.browserAuth);
  const hasAuthState = Object.prototype.hasOwnProperty.call(source, "authState");
  const hasLoginRequired = Object.prototype.hasOwnProperty.call(source, "loginRequired");
  const hasChallengeRequired = Object.prototype.hasOwnProperty.call(source, "challengeRequired");
  const hasManualLoginUrl = Object.prototype.hasOwnProperty.call(source, "manualLoginUrl");
  if (hasManualLoginUrl) browserManualLoginUrl = sanitizedManualLoginUrl(source.manualLoginUrl);
  state.browserAuth = normalizeBrowserAuth({
    reported: hasAuthState || hasLoginRequired || hasChallengeRequired || previous.reported,
    authState: hasAuthState ? source.authState : previous.authState,
    loginRequired: hasLoginRequired ? source.loginRequired : previous.loginRequired,
    challengeRequired: hasChallengeRequired ? source.challengeRequired : previous.challengeRequired,
    manualLoginAvailable: !!browserManualLoginUrl,
    message: Object.prototype.hasOwnProperty.call(source, "message") ? source.message : previous.message,
    phoneMasked: options.clearPhone === true
      ? ""
      : Object.prototype.hasOwnProperty.call(source, "phoneMasked") ? source.phoneMasked : previous.phoneMasked,
    updatedAt: Date.now(),
  });
  if (!state.browserAuth.challengeRequired) {
    browserManualLoginUrl = "";
    state.browserAuth.manualLoginAvailable = false;
  }
  if (isAuthenticatedBrowserState(state.browserAuth.authState)
    && /\bUNAUTHORIZED\b|登录信息|登录凭证|请重新登录|login required/i.test(String(state.lastError || ""))) {
    state.lastError = "";
  }
  clearResolvedPlatformRouteError(state);
  return state;
}

async function applyAndAcknowledgeBrowserAuthResponse(state, response, options = {}) {
  applyBrowserAuthResponse(state, response, options);
  const source = response && typeof response === "object" ? response : {};
  const serverUserName = validPlatformAccount(source.userName).slice(0, 80);
  if (source.nameAckRequired === true && serverUserName && state.installToken) {
    await saveState(state);
    try {
      const acknowledged = await postJson(
        "v24BrowserNameAck",
        {userName: serverUserName},
        state.installToken,
        CONFIG.REQUEST_TIMEOUT_MS,
      );
      applyBrowserAuthResponse(state, acknowledged);
    } catch {
      // The server has a short fallback timeout, so a lost acknowledgement cannot block the login queue.
    }
  }
  if (options.refreshPolicy !== false && state.userName && state.installToken) {
    try { await refreshCPolicy(state, true); } catch (error) {}
  }
  return state;
}

function defaultSettings() {
  return {
    targetPackages: PRE_SUBMIT_TARGET_PACKAGES,
    claimAmount: PRE_SUBMIT_AMOUNT,
    taskPages: PRE_SUBMIT_TASK_PAGES,
    blockedTaskIds: [],
    selectedTaskIds: [],
  };
}

function normalizeSettings(value, runtimePolicy = {}) {
  const source = value && typeof value === "object" ? value : {};
  const normalizeTaskIds = (values) => {
    const taskIds = [];
    const seenTaskIds = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const taskId = String(value || "").trim().slice(0, 80);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId) || seenTaskIds.has(taskId)) continue;
      seenTaskIds.add(taskId);
      taskIds.push(taskId);
      if (taskIds.length >= 200) break;
    }
    return taskIds;
  };
  const selectedTaskIds = normalizeTaskIds(Array.isArray(source.selectedTaskIds)
    ? source.selectedTaskIds
    : source.selectedTaskId ? [source.selectedTaskId] : []);
  const blockedTaskIds = normalizeTaskIds(source.blockedTaskIds);
  const cSettings = cPolicyCoreSettings();
  const targetPackages = cSettings ? cSettings.targetPackages : serverStopPackages(runtimePolicy);
  const claimAmount = cSettings ? cSettings.claimAmount : serverClaimAmount(runtimePolicy);
  const taskPages = cSettings ? cSettings.taskPages : serverTaskPages(runtimePolicy);
  const intervalTierPercentages = Array.isArray(runtimePolicy && runtimePolicy.intervalTierPercentages)
    ? runtimePolicy.intervalTierPercentages
      .map((item) => Math.max(1, Math.min(100, number(item))))
      .filter(Boolean)
      .slice(0, 32)
    : [];
  return {
    targetPackages,
    stopPackages: targetPackages,
    ordinaryClaimEnabled: cSettings ? cSettings.ordinaryClaimEnabled : serverOrdinaryClaimEnabled(runtimePolicy),
    ordinaryStartPackages: cSettings ? cSettings.ordinaryStartPackages : serverOrdinaryStartPackages(runtimePolicy),
    preSubmitEnabled: cSettings ? cSettings.preSubmitEnabled : true,
    preSubmitStopPackages: cSettings ? cSettings.preSubmitStopPackages : serverPreSubmitStopPackages(runtimePolicy),
    claimConcurrency: cSettings ? cSettings.claimConcurrency : Math.max(1, number(runtimePolicy && runtimePolicy.claimConcurrency) || 1),
    claimAmount,
    preSubmitAmount: cSettings ? cSettings.preSubmitAmount : serverPreSubmitAmount(runtimePolicy),
    preSubmitIntervalMs: cSettings ? cSettings.preSubmitIntervalMs : requestIntervalMs(runtimePolicy && runtimePolicy.initialIntervalMs),
    taskPages,
    releaseAfterMinutes: cSettings ? cSettings.releaseAfterMinutes : serverReleaseAfterMinutes(runtimePolicy),
    releasePackageLimit: cSettings ? cSettings.releasePackageLimit : serverReleasePackageLimit(runtimePolicy),
    acceptPartial: true,
    intervalTierPercentages: intervalTierPercentages.length
      ? intervalTierPercentages
      : [100, 90, 80, 70, 60, 50, 40, 30, 20, 10],
    accelerationTierMs: Math.max(1000, number(runtimePolicy && runtimePolicy.accelerationTierMs) || 60 * 1000),
    rateLimitRetryMs: Math.max(10, number(runtimePolicy && runtimePolicy.rateLimitRetryMs) || 5000),
    errorRetryMs: Math.max(10, number(runtimePolicy && runtimePolicy.errorRetryMs) || 2000),
    blockedTaskIds,
    selectedTaskIds,
    taskSelectionRequired: source.taskSelectionRequired === true && selectedTaskIds.length === 0,
  };
}

function updateCVolatileOverrides(value) {
  if (!cPolicyDelegated()) return cPolicyCoreSettings();
  const source = value && typeof value === "object" ? value : {};
  const next = Object.create(null);
  const numeric = [
    "ordinaryStartPackages", "preSubmitStopPackages", "claimConcurrency", "claimAmount",
    "preSubmitAmount", "taskPages", "releaseAfterMinutes", "releasePackageLimit",
  ];
  next.stopPackages = Object.prototype.hasOwnProperty.call(source, "stopPackages")
    ? source.stopPackages
    : source.targetPackages;
  for (const field of numeric) {
    if (Object.prototype.hasOwnProperty.call(source, field)) next[field] = source[field];
  }
  for (const field of ["ordinaryClaimEnabled", "preSubmitEnabled"]) {
    if (Object.prototype.hasOwnProperty.call(source, field)) next[field] = source[field];
  }
  cVolatileOverrides = next;
  return cPolicyCoreSettings();
}

function catalogClaimFields(row) {
  if (row?.total == null || row?.left == null || row.total === "" || row.left === "") return {};
  const total = Number(row.total), left = Number(row.left);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(left) || total < 0 || left < 0 || left > total) return {};
  return {total, claimed: total - left};
}

function normalizeCandidateTasks(value) {
  const rows = Array.isArray(value) ? value : [];
  const output = [];
  const seen = new Set();
  for (const row of rows) {
    const taskId = String(row && row.taskId || "").trim().slice(0, 80);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId) || seen.has(taskId)) continue;
    seen.add(taskId);
    output.push({
      taskId,
      name: String(row.name || row.taskName || taskId).trim().slice(0, 160),
      left: number(row.left),
      ...catalogClaimFields(row),
    });
    if (output.length >= 200) break;
  }
  return output;
}

const CATALOG_CLAIM_STATS_KEY = `${CONFIG.STATE_KEY}CatalogClaimStatsV1`;
let catalogClaimStatsQueue = Promise.resolve();

function advanceCatalogClaimStats(previous, catalog, owner, reset = false) {
  const current = !reset && previous?.owner === owner ? previous : {owner, total: 0, points: []};
  const points = new Map((current.points || []).map(point=>[point.taskId, {...point}]));
  let total = number(current.total);
  for (const row of normalizeCandidateTasks(catalog)) {
    if (!Number.isSafeInteger(row.claimed)) continue;
    const point = points.get(row.taskId);
    if (!point) points.set(row.taskId, {taskId:row.taskId, high:row.claimed});
    else if (row.claimed > point.high) {
      total += row.claimed - point.high;
      point.high = row.claimed;
    }
    // Repeated/stale reads and a release-related decrease cannot create another
    // increment when the same count reappears. Missing tasks retain their mark.
  }
  return {owner, total, points:[...points.values()]};
}

function catalogClaimIncrease(state, session, catalog, reset = false) {
  const job = catalogClaimStatsQueue.catch(()=>{}).then(async () => {
    const owner = JSON.stringify([state.installId, state.userName]);
    const previous = (await chrome.storage.session.get(CATALOG_CLAIM_STATS_KEY))[CATALOG_CLAIM_STATS_KEY];
    if (!session.running && !reset) return previous?.owner === owner ? number(previous.total) : 0;
    const next = advanceCatalogClaimStats(previous, catalog, owner, reset);
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      await chrome.storage.session.set({[CATALOG_CLAIM_STATS_KEY]:next});
    }
    return next.total;
  });
  catalogClaimStatsQueue = job;
  return job;
}

function claimModeForWorkingPackages(value, runtimePolicy = {}) {
  const workingPackages = number(value);
  if (workingPackages >= serverStopPackages(runtimePolicy)) return "paused";
  if (cPolicyDelegated() && cPolicyCoreSettings()?.preSubmitEnabled === false) return "normal";
  if (serverOrdinaryClaimEnabled(runtimePolicy)
    && workingPackages >= serverOrdinaryStartPackages(runtimePolicy)) return "normal";
  if (workingPackages < serverPreSubmitStopPackages(runtimePolicy)) return "pre-submit";
  return "paused";
}

function claimModeStatusLabel(value, runtimePolicy = {}) {
  const workingPackages = number(value);
  const mode = claimModeForWorkingPackages(workingPackages, runtimePolicy);
  if (mode === "pre-submit") {
    return `本地${workingPackages}包，低于预提交停止线${serverPreSubmitStopPackages(runtimePolicy)}包，服务器执行预提交`;
  }
  if (mode === "normal") {
    return `本地${workingPackages}包，已达到普通领取开始线${serverOrdinaryStartPackages(runtimePolicy)}包，等待本地任务线索`;
  }
  if (workingPackages >= serverStopPackages(runtimePolicy)) {
    return `本地${workingPackages}包，已达到服务器总停止线${serverStopPackages(runtimePolicy)}包`;
  }
  if (!serverOrdinaryClaimEnabled(runtimePolicy)) {
    return `本地${workingPackages}包，已达到预提交停止线${serverPreSubmitStopPackages(runtimePolicy)}包；普通领取关闭，服务器保持等待`;
  }
  return `本地${workingPackages}包，已达到预提交停止线${serverPreSubmitStopPackages(runtimePolicy)}包，但未达到普通领取开始线${serverOrdinaryStartPackages(runtimePolicy)}包，服务器保持等待`;
}

function resumeThresholdForSettings(value, runtimePolicy = {}) {
  return Math.max(0, serverStopPackages(runtimePolicy) - 1);
}

function selectedServerTasks(state, mode = claimModeForWorkingPackages(state && state.localWorkingPackages, state && state.runtimePolicy)) {
  if (mode !== "normal" && state?.settings?.taskSelectionRequired && !state.settings.selectedTaskIds?.length) return [];
  const catalog = normalizeCandidateTasks(state && state.localTaskCatalog);
  const byId = new Map(catalog.map((task) => [task.taskId, task]));
  const selectedTaskIds = state && state.settings && Array.isArray(state.settings.selectedTaskIds)
    ? state.settings.selectedTaskIds
    : [];
  const blockedTaskIds = new Set(state && state.settings && Array.isArray(state.settings.blockedTaskIds)
    ? state.settings.blockedTaskIds
    : []);
  const chosen = mode !== "normal" && selectedTaskIds.length
    ? selectedTaskIds.filter((taskId) => !taskMissingFromDirectory(taskId, state.localDirectoryProof))
      .map((taskId) => byId.get(taskId) || {taskId, name: taskId, left: 0})
    : catalog;
  const unblocked = chosen.filter((task) => !blockedTaskIds.has(task.taskId));
  const candidates = mode === "normal"
    ? unblocked.filter((task) => number(task.left) > 0)
    : unblocked;
  // 普通领取有在途工作包时必须沿用同一任务流；只有工作包归零后才解除锁定。
  if (mode === "normal" && number(state && state.localWorkingPackages) > 0) {
    const rows = Array.isArray(state && state.localWorkingRows) ? state.localWorkingRows : [];
    const rowIds = Array.from(new Set(rows.map((row) => String(row && row.taskId || "").trim()).filter(Boolean)));
    if (rowIds.length !== 1 || rows.some(row => !String(row?.taskId || "").trim())) return [];
    const lockedId = rowIds[0];
    if (lockedId) return candidates.filter((task) => task.taskId === lockedId).map((task) => ({
      taskId: task.taskId, name: task.name || task.taskId, left: number(task.left),
    }));
  }
  return candidates.map((task) => ({
    taskId: task.taskId,
    name: task.name || task.taskId,
    left: number(task.left),
  }));
}

function ordinaryPacingIntervalMs(state) {
  const base = Number(cPolicyCurrent()?.defaults?.preSubmitIntervalMs
    ?? state?.runtimePolicy?.initialIntervalMs ?? state?.settings?.preSubmitIntervalMs);
  if (!Number.isFinite(base) || base <= 0) throw new Error("等待服务器下发有效请求间隔");
  const factor = 100 + Math.random() * 100;
  return Math.max(1, base * factor);
}

// The same deadlines cover manual and ordinary mode, across all tabs.
const ordinaryPacing = {refreshMs: 0, refreshNextAt: 0, refreshSampleUntil: 0,
  claimMs: 0, claimNextAt: 0, claimSampleUntil: 0, base: 0};
let pacedCatalogPromise = null;
let pacedCatalog = null;
function prepareOrdinaryPacing(state) {
  const base = Number(cPolicyCurrent()?.defaults?.preSubmitIntervalMs ?? state?.settings?.preSubmitIntervalMs);
  if (base !== ordinaryPacing.base) {
    ordinaryPacing.base = base;
    ordinaryPacing.refreshMs = ordinaryPacingIntervalMs(state);
    ordinaryPacing.claimMs = ordinaryPacingIntervalMs(state);
    ordinaryPacing.refreshNextAt = Date.now() + ordinaryPacing.refreshMs;
    ordinaryPacing.claimNextAt = Date.now() + ordinaryPacing.claimMs;
    ordinaryPacing.refreshSampleUntil = ordinaryPacing.refreshNextAt;
    ordinaryPacing.claimSampleUntil = ordinaryPacing.claimNextAt;
    pacedCatalog = null;
  }
  // Keep the next usable interval fresh even while idle. Sampling is separate
  // from request eligibility: status polls must never postpone an expired gate.
  const now = Date.now();
  for (const kind of ["refresh", "claim"]) {
    if (now >= ordinaryPacing[`${kind}NextAt`] && now >= ordinaryPacing[`${kind}SampleUntil`]) {
      ordinaryPacing[`${kind}Ms`] = ordinaryPacingIntervalMs(state);
      ordinaryPacing[`${kind}SampleUntil`] = now + ordinaryPacing[`${kind}Ms`];
    }
  }
  return ordinaryPacing;
}

async function readPacedTaskCatalog(tabId, settings) {
  const state = {settings};
  const timing = prepareOrdinaryPacing(state);
  const cacheKey = `${tabId}:${settings?.taskPages}`;
  if (pacedCatalogPromise) return pacedCatalogPromise;
  if (pacedCatalog?.key === cacheKey && Date.now() < timing.refreshNextAt) return pacedCatalog.rows;
  pacedCatalogPromise = (async () => {
    await relayDelay(Math.max(0, timing.refreshNextAt - Date.now()));
    const rows = await readLocalTaskCatalog(tabId, settings);
    pacedCatalog = {key: cacheKey, rows};
    return rows;
  })().finally(() => {
    timing.refreshMs = ordinaryPacingIntervalMs(state);
    timing.refreshNextAt = Date.now() + timing.refreshMs;
    timing.refreshSampleUntil = timing.refreshNextAt;
    pacedCatalogPromise = null;
  });
  return pacedCatalogPromise;
}

function serverTaskSignature(state) {
  return JSON.stringify({
    mode: claimModeForWorkingPackages(state && state.localWorkingPackages, state && state.runtimePolicy),
    tasks: selectedServerTasks(state).map((task) => [task.taskId, task.name]),
  });
}

function serverPackageSettings(state) {
  const settings = normalizeSettings(state && state.settings, state && state.runtimePolicy);
  return {
    targetPackages: settings.targetPackages,
    claimAmount: settings.claimAmount,
    preSubmitAmount: serverPreSubmitAmount(state && state.runtimePolicy),
    claimConcurrency: Math.max(1, number(state && state.runtimePolicy && state.runtimePolicy.claimConcurrency) || 1),
    ordinaryClaimEnabled: serverOrdinaryClaimEnabled(state && state.runtimePolicy),
    ordinaryStartPackages: serverOrdinaryStartPackages(state && state.runtimePolicy),
    preSubmitStopPackages: serverPreSubmitStopPackages(state && state.runtimePolicy),
  };
}

function serverTaskSelection(state) {
  const settings = normalizeSettings(state && state.settings, state && state.runtimePolicy);
  return {
    claimStrategy: String(CONFIG.CLAIM_STRATEGY || "availability-watch"),
    normalDispatchMode: normalDispatchMode(),
    ordinaryClaimEnabled: serverOrdinaryClaimEnabled(state && state.runtimePolicy),
    ordinaryStartPackages: serverOrdinaryStartPackages(state && state.runtimePolicy),
    preSubmitStopPackages: serverPreSubmitStopPackages(state && state.runtimePolicy),
    taskSelectionMode: settings.selectedTaskIds.length ? "selected" : "all",
    selectedTaskIds: settings.selectedTaskIds,
    taskPages: settings.taskPages,
  };
}

function normalizeWorkload(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    totals: source.totals && typeof source.totals === "object" ? source.totals : {},
    active: source.active && typeof source.active === "object" ? source.active : {},
    pending: source.pending && typeof source.pending === "object" ? source.pending : {},
  };
}

function recordWorkloadClaim(state, taskId, taskName) {
  const id = String(taskId || "").trim().slice(0, 80);
  if (!id) return;
  state.workload = normalizeWorkload(state.workload);
  state.workload.pending[id] = {taskId: id, taskName: String(taskName || "").trim().slice(0, 160), claimedAt: Date.now()};
}

function discardPendingWorkloadClaim(state, taskId) {
  const id = String(taskId || "").trim().slice(0, 80);
  if (!id) return;
  state.workload = normalizeWorkload(state.workload);
  if (!state.workload.active[id]) delete state.workload.pending[id];
}

function markWorkloadReleased(state, subTaskId) {
  const id = String(subTaskId || "").trim();
  if (!id) return;
  state.workload = normalizeWorkload(state.workload);
  for (const [taskId, active] of Object.entries(state.workload.active)) {
    const ids = Array.isArray(active && active.subTaskIds) ? [...active.subTaskIds] : [];
    const index = ids.indexOf(id);
    if (index < 0) continue;
    ids.splice(index, 1);
    if (!ids.length) {
      delete state.workload.active[taskId];
      delete state.workload.pending[taskId];
    } else {
      state.workload.active[taskId] = {...active, subTaskIds: ids, updatedAt: Date.now()};
    }
    return;
  }
}

function syncWorkload(state, rows) {
  state.workload = normalizeWorkload(state.workload);
  const groups = new Map();
  for (const row of Array.from(rows || [])) {
    const taskId = String(row && row.taskId || "").trim().slice(0, 80);
    if (!taskId) continue;
    if (!groups.has(taskId)) groups.set(taskId, []);
    groups.get(taskId).push(row);
  }
  for (const [taskId, active] of Object.entries(state.workload.active)) {
    if (groups.has(taskId)) continue;
    const previous = state.workload.totals[taskId] || {taskId, taskName: "", completed: 0, updatedAt: 0};
    state.workload.totals[taskId] = {
      taskId,
      taskName: String(active && active.taskName || previous.taskName || "").trim().slice(0, 160),
      completed: number(previous.completed) + 1,
      updatedAt: Date.now(),
    };
    delete state.workload.active[taskId];
    delete state.workload.pending[taskId];
  }
  for (const [taskId, taskRows] of groups) {
    const pending = state.workload.pending[taskId];
    const previous = state.workload.active[taskId];
    state.workload.active[taskId] = {
      taskId,
      taskName: String(taskRows.find((row) => row && row.taskName)?.taskName || pending?.taskName || previous?.taskName || "").trim().slice(0, 160),
      subTaskIds: taskRows.map((row) => String(row && row.id || "").trim()).filter(Boolean),
      updatedAt: Date.now(),
    };
    delete state.workload.pending[taskId];
  }
}

function publicWorkload(state) {
  const workload = normalizeWorkload(state && state.workload);
  const totals = Object.values(workload.totals).map((item) => ({
    taskId: String(item && item.taskId || "").trim().slice(0, 80),
    taskName: String(item && item.taskName || "").trim().slice(0, 160),
    completed: number(item && item.completed),
    updatedAt: number(item && item.updatedAt),
  })).filter((item) => item.taskId).sort((left, right) => right.updatedAt - left.updatedAt || left.taskId.localeCompare(right.taskId));
  return {
    totalCompleted: totals.reduce((sum, item) => sum + item.completed, 0),
    taskCount: totals.length,
    activeCount: Object.keys(workload.active).length,
    totals,
  };
}

function defaultState() {
  return {
    installId: crypto.randomUUID(),
    installToken: "",
    userName: "",
    serverIdentityVersion: SERVER_IDENTITY_VERSION,
    platformAccount: "",
    leaseExpiresAt: 0,
    runtimePolicy: {},
    settings: defaultSettings(),
    reportSequence: 0,
    verificationStatus: "not-required",
    lastHeartbeatAt: 0,
    lastError: "",
    lastWorker: null,
    browserAuth: defaultBrowserAuth(),
    localTaskCatalog: [],
    localTaskCatalogUpdatedAt: 0,
    localWorkingRows: [],
    localWorkingPackages: 0,
    autoPausedAtTarget: false,
    serverStopPending: false,
    lastServerTaskSignature: "",
    localScanRounds: 0,
    localRequestTotal: 0,
    localIntervalSumMs: 0,
    localIntervalSamples: 0,
    localClaimedPackagesTotal: 0,
    localClaimedSubTaskIds: [],
    pendingClaimConfirmation: null,
    workload: normalizeWorkload(null),
  };
}

async function loadState() {
  const saved = await chrome.storage.local.get(CONFIG.STATE_KEY);
  const value = saved && saved[CONFIG.STATE_KEY];
  const state = value && typeof value === "object" ? {...defaultState(), ...value} : defaultState();
  const migrateToServerIdentity = !!value && number(value.serverIdentityVersion) !== SERVER_IDENTITY_VERSION;
  if (migrateToServerIdentity) {
    state.userName = "";
    state.installToken = "";
    state.leaseExpiresAt = 0;
    state.browserAuth = defaultBrowserAuth();
    state.serverIdentityVersion = SERVER_IDENTITY_VERSION;
  }
  state.platformAccount = validPlatformAccount(state.platformAccount);
  state.userName = validPlatformAccount(state.userName).slice(0, 80);
  const persistedRoutes = normalizeRuntimePlatformRoutes(state.runtimePolicy && state.runtimePolicy.platformRoutes);
  runtimePlatformRoutes = persistedRoutes.base ? persistedRoutes : runtimePlatformRoutes;
  state.settings = normalizeSettings(state.settings, state.runtimePolicy);
  state.localTaskCatalog = normalizeCandidateTasks(state.localTaskCatalog);
  state.localTaskCatalogUpdatedAt = number(state.localTaskCatalogUpdatedAt);
  state.localWorkingRows = Array.isArray(state.localWorkingRows) ? state.localWorkingRows.slice(0, 100) : [];
  state.autoPausedAtTarget = state.autoPausedAtTarget === true;
  state.serverStopPending = state.serverStopPending === true;
  state.lastServerTaskSignature = String(state.lastServerTaskSignature || "").slice(0, 20000);
  state.localScanRounds = number(state.localScanRounds);
  state.localRequestTotal = number(state.localRequestTotal);
  state.localIntervalSumMs = number(state.localIntervalSumMs);
  state.localIntervalSamples = number(state.localIntervalSamples);
  state.localClaimedPackagesTotal = number(state.localClaimedPackagesTotal);
  state.localClaimedSubTaskIds = Array.isArray(state.localClaimedSubTaskIds)
    ? [...new Set(state.localClaimedSubTaskIds.map((value) => String(value || "").trim().slice(0, 120)).filter(Boolean))].slice(-2000)
    : [];
  state.pendingClaimConfirmation = state.pendingClaimConfirmation && typeof state.pendingClaimConfirmation === "object"
    ? state.pendingClaimConfirmation
    : null;
  state.workload = normalizeWorkload(state.workload);
  state.browserAuth = normalizeBrowserAuth(state.browserAuth);
  if (migrateToServerIdentity) await chrome.storage.local.set({[CONFIG.STATE_KEY]: state});
  return state;
}

function flushLocalReadStats(state) {
  state.localRequestTotal = number(state.localRequestTotal) + localReadRequestsPending;
  state.localIntervalSumMs = number(state.localIntervalSumMs) + localReadIntervalSumPending;
  state.localIntervalSamples = number(state.localIntervalSamples) + localReadIntervalSamplesPending;
  localReadRequestsPending = 0;
  localReadIntervalSumPending = 0;
  localReadIntervalSamplesPending = 0;
  return state;
}

function recordLocalPlatformRequest() {
  const now = Date.now();
  localReadRequestsPending += 1;
  if (lastLocalReadAt) {
    localReadIntervalSumPending += Math.max(0, now - lastLocalReadAt);
    localReadIntervalSamplesPending += 1;
  }
  lastLocalReadAt = now;
}

async function saveState(state) {
  state.settings = normalizeSettings(state.settings, state.runtimePolicy);
  const persisted = {
    ...state,
    runtimePolicy: {},
    settings: {
      blockedTaskIds: Array.isArray(state.settings.blockedTaskIds) ? state.settings.blockedTaskIds : [],
      selectedTaskIds: Array.isArray(state.settings.selectedTaskIds) ? state.settings.selectedTaskIds : [],
    },
  };
  delete persisted.cPolicy;
  delete persisted.cPolicyToken;
  delete persisted.cModuleSource;
  delete persisted.cModuleToken;
  await chrome.storage.local.set({[CONFIG.STATE_KEY]: persisted});
  return state;
}

async function loadSession() {
  const saved = await chrome.storage.session.get(CONFIG.SESSION_KEY);
  const value = saved && saved[CONFIG.SESSION_KEY];
  return value && typeof value === "object"
    ? {
      running: value.running === true,
      tabId: number(value.tabId),
      refreshing: value.refreshing === true,
      refreshStartedAt: number(value.refreshStartedAt),
    }
    : {running: false, tabId: 0, refreshing: false, refreshStartedAt: 0};
}

async function saveSession(session) {
  const value = {
    running: session && session.running === true,
    tabId: number(session && session.tabId),
    refreshing: session && session.refreshing === true,
    refreshStartedAt: number(session && session.refreshStartedAt),
  };
  await chrome.storage.session.set({[CONFIG.SESSION_KEY]: value});
  return value;
}

function isContinuingRefresh(session, tabId) {
  return !!(session && session.running === true && session.refreshing === true
    && session.tabId === number(tabId)
    && Date.now() - number(session.refreshStartedAt) < 2 * 60 * 1000);
}

function isRunningSessionTab(session, tabId) {
  return !!(session && session.running === true && session.tabId === number(tabId));
}

function apiRoute(nameOrPath) {
  const value = String(nameOrPath || "").trim();
  if (value.startsWith("/")) return value;
  const configured = CONFIG.API_ROUTES && CONFIG.API_ROUTES[value];
  const path = String(configured || "").trim();
  if (!/^\/api\/[A-Za-z0-9_./-]+$/.test(path)) throw new Error(`服务器接口未配置：${value}`);
  return path;
}

function executionMode() {
  return String(CONFIG.EXECUTION_MODE || "autonomous") === "legacy-manual" ? "legacy-manual" : "autonomous";
}

function normalDispatchMode() {
  return String(CONFIG.NORMAL_DISPATCH_MODE || "local-command") === "server-loop" ? "server-loop" : "local-command";
}

function platformTransportMode() {
  if (cPolicyDelegated()) return "direct-local";
  return "server-browser";
}

async function serverTransportPayload() {
  return {transportMode: platformTransportMode()};
}

async function postJson(route, payload, installToken = "", timeoutMs = CONFIG.REQUEST_TIMEOUT_MS, extraHeaders = {}) {
  const path = apiRoute(route);
  const controller = new AbortController();
  const requestTimeoutMs = Math.max(1000, Math.min(180000, Number(timeoutMs) || Number(CONFIG.REQUEST_TIMEOUT_MS) || 10000));
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const headers = {"Accept": "application/json", "Content-Type": "application/json"};
    if (installToken) headers.Authorization = `Bearer ${installToken}`;
    const cHeader = String(extraHeaders && extraHeaders["X-SV-C-Policy-Token"]
      || (path.startsWith("/api/v3c/") ? cPolicyToken : "")
      || "").trim();
    if (cHeader) headers["X-SV-C-Policy-Token"] = cHeader;
    const response = await fetch(`${CONFIG.API_BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload || {}),
      cache: "no-store",
      signal: controller.signal,
    });
    let body = {};
    try { body = await response.json(); } catch (error) {}
    if (!response.ok || body.ok === false) {
      const requestError = new Error(String(body.error || body.message || `服务器HTTP ${response.status}`));
      requestError.status = response.status;
      requestError.code = String(body.code || body.errorCode || "").trim().slice(0, 80);
      if (body.authorized === true || body.authorized === false) requestError.authorized = body.authorized;
      if (body.registered === true || body.registered === false) requestError.registered = body.registered;
      throw requestError;
    }
    return body;
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error("服务器响应超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function runtimeConfigRefreshDue(now = Date.now()) {
  return !runtimeConfigFetchedAt || now - runtimeConfigFetchedAt >= CONFIG.CLIENT_CONFIG_REFRESH_MS;
}

async function refreshRuntimeConfig(state, force = false) {
  if (!state || !state.installToken) return state;
  if (!force && !runtimeConfigRefreshDue()) return state;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(CONFIG.REQUEST_TIMEOUT_MS) || 10000));
  try {
    const response = await fetch(`${CONFIG.API_BASE}${apiRoute("clientConfig")}`, {
      method: "GET",
      headers: {Accept: "application/json", Authorization: `Bearer ${state.installToken}`},
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      const requestError = new Error(String(body.error || body.message || `服务器HTTP ${response.status}`));
      requestError.status = response.status;
      requestError.code = String(body.code || body.errorCode || "").trim().slice(0, 80);
      if (body.authorized === true || body.authorized === false) requestError.authorized = body.authorized;
      if (body.registered === true || body.registered === false) requestError.registered = body.registered;
      throw requestError;
    }
    state.runtimePolicy = runtimePolicyFromClientConfig(body);
    state.settings = normalizeSettings(state.settings, state.runtimePolicy);
    clearResolvedPlatformRouteError(state);
    await saveState(state);
    return state;
  } finally {
    clearTimeout(timer);
  }
}

function applyCPolicyRuntime(state) {
  const settings = cPolicyCoreSettings();
  if (!settings) return state;
  const previous = state.runtimePolicy && typeof state.runtimePolicy === "object" ? state.runtimePolicy : {};
  state.runtimePolicy = {
    serverConfigRevision: number(cPolicyCurrent() && cPolicyCurrent().revision),
    initialIntervalMs: settings.preSubmitIntervalMs,
    ordinaryClaimEnabled: settings.ordinaryClaimEnabled,
    stopPackages: settings.targetPackages,
    ordinaryStartPackages: settings.ordinaryStartPackages,
    preSubmitStopPackages: settings.preSubmitStopPackages,
    claimAmount: settings.claimAmount,
    preSubmitAmount: settings.preSubmitAmount,
    claimConcurrency: settings.claimConcurrency,
    taskPages: settings.taskPages,
    releaseAfterMinutes: settings.releaseAfterMinutes,
    releasePackageLimit: settings.releasePackageLimit,
    intervalTierPercentages: Array.isArray(previous.intervalTierPercentages)
      ? previous.intervalTierPercentages.slice(0, 32)
      : [100, 90, 80, 70, 60, 50, 40, 30, 20, 10],
    accelerationTierMs: Math.max(1000, number(previous.accelerationTierMs) || 60 * 1000),
    rateLimitRetryMs: Math.max(10, number(previous.rateLimitRetryMs) || 5000),
    errorRetryMs: Math.max(10, number(previous.errorRetryMs) || 2000),
    successAppearGraceMs: Math.max(300, number(previous.successAppearGraceMs) || 3000),
    platformRequestTimeoutMs: Math.max(1000, number(previous.platformRequestTimeoutMs) || 20000),
    activeWorkingCheckMs: Math.max(100, number(previous.activeWorkingCheckMs) || 100),
    coldProgressCheckMs: Math.max(100, number(previous.coldProgressCheckMs) || 15 * 1000),
    fullProgressRefreshMs: Math.max(100, number(previous.fullProgressRefreshMs) || 30 * 1000),
    taskCatalogRefreshMs: Math.max(100, number(previous.taskCatalogRefreshMs) || 60 * 1000),
  };
  state.settings = normalizeSettings(state.settings, state.runtimePolicy);
  return state;
}

async function cModuleDigest(source) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)));
  let binary = "";
  for (const value of digest) binary += String.fromCharCode(value);
  return `sha256-${btoa(binary)}`;
}

async function fetchCModule(state, policy, token) {
  if (!policy || policy.delegated !== true || policy.routeMode !== "local") {
    clearCModuleMemory();
    return false;
  }
  const moduleUrl = String(policy.moduleUrl || "");
  if (!/^\/api\/v3c\/module\/[A-Za-z0-9._~/-]+$/.test(moduleUrl) || moduleUrl.includes("//") || moduleUrl.split("/").includes("..")) {
    throw new Error("服务器下发的C本机模组地址无效");
  }
  const response = await fetch(`${CONFIG.API_BASE}${moduleUrl}`, {
    method: "GET",
    headers: {
      "Accept": "text/javascript",
      "Authorization": `Bearer ${state.installToken}`,
      "X-SV-C-Policy-Token": token,
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`C本机模组下载失败（HTTP ${response.status}）`);
  const source = await response.text();
  if (!source || source.length > 128000) throw new Error("C本机模组大小无效");
  const actualHash = await cModuleDigest(source);
  if (actualHash !== String(policy.moduleHash || "")) throw new Error("C本机模组SHA-256校验失败");
  cModuleSource = source;
  cModuleHash = actualHash;
  cModuleSessionNonce = "";
  return true;
}

async function refreshCPolicyInternal(state, force = false) {
  if (!state || !state.installToken) return state;
  const now = Date.now();
  if (!force && cPolicyUsable(now) && cPolicyNextRefreshAt > now) {
    clearCPolicyTransitionState(state);
    return applyCPolicyRuntime(state);
  }
  const userName = validPlatformAccount(state.userName).slice(0, 80);
  if (!userName) {
    cPolicyLastError = "等待服务器登录后取得正式姓名";
    return state;
  }
  await ensureCPolicyPublicKey();
  const nonce = randomCNonce();
  const previous = cPolicyCurrent();
  try {
    const response = await postJson("cPolicy", {
      installId: state.installId,
      nonce,
      extensionVersion: extensionDisplayVersion(),
      fractionalCInterval: true,
      maxPolicyLifetimeMs: 10 * 60 * 1000,
    }, state.installToken);
    const token = String(response.policyToken || response.token || response.leaseToken || "").trim();
    if (!token) throw new Error("服务器没有返回C短效策略Token");
    const policy = await C_POLICY.verifyAndSetPolicy(token, {
      installId: state.installId,
      userName,
      nonce,
    }, now);
    cPolicyToken = token;
    cPolicyControlRevision = Math.max(1, number(response.controlRevision) || cPolicyControlRevision || 1);
    cPolicyLastError = "";
    cPolicyNextRefreshAt = C_POLICY.nextRefreshAt(now);
    clearServerAccessRevocationState(state);
    clearCPolicyTransitionState(state);
    if (policy.delegated === true) {
      try {
        await fetchCModule(state, policy, token);
      } catch (error) {
        clearCModuleMemory();
        cPolicyLastError = String(error && error.message || error).slice(0, 300);
      }
    } else {
      clearCModuleMemory();
      cVolatileOverrides = Object.create(null);
    }
    applyCPolicyRuntime(state);
    await scheduleCPolicyAlarms();
    if (previous && previous.delegated !== true && policy.delegated === true) {
      await handoffRunningSessionToLocalPolicy(state);
    }
    if (previous && previous.delegated === true && policy.delegated !== true) {
      const session = await loadSession();
      if (session.running) await stopServer("服务器已收回C本机放权，请重新启动A服务器模式", {forceServerRequest: true});
    }
    return state;
  } catch (error) {
    cPolicyLastError = String(error && error.message || error).slice(0, 300);
    if (isServerAccessRevoked(error)) throw error;
    if (!cPolicyUsable(now)) {
      clearCPolicyMemory(cPolicyLastError);
      await scheduleCPolicyAlarms();
      const session = await loadSession();
      if (session.running && previous && previous.delegated === true) {
        await stopServer("C策略已失效，领取已停止", {forceServerRequest: true});
      }
      throw error;
    }
    return applyCPolicyRuntime(state);
  }
}

// Policy refreshes can be triggered by heartbeats, alarms, page polling and
// authorization transitions at the same time. Coalesce duplicate requests so
// login/status polling cannot build an unbounded queue behind a slow refresh.
function refreshCPolicy(state, force = false) {
  if (state && typeof state === "object") cPolicyRefreshState = state;
  if (force) cPolicyRefreshForcePending = true;
  if (cPolicyRefreshPromise) return cPolicyRefreshPromise;
  const run = (async () => {
    let result = cPolicyRefreshState || state;
    do {
      const requestedForce = cPolicyRefreshForcePending;
      cPolicyRefreshForcePending = false;
      result = await refreshCPolicyInternal(cPolicyRefreshState || result, requestedForce);
    } while (cPolicyRefreshForcePending);
    return result;
  })();
  cPolicyRefreshPromise = run.finally(() => {
    cPolicyRefreshPromise = null;
    cPolicyRefreshState = null;
    cPolicyRefreshForcePending = false;
  });
  return cPolicyRefreshPromise;
}

function isCPolicyTransitionError(error) {
  const code = String(error && error.code || "").trim().toUpperCase();
  if (["STALE_REVISION", "REVISION_MISMATCH", "C_ROUTE_CHANGED", "C_POLICY_REQUIRED", "C_MODULE_CHANGED"].includes(code)) return true;
  return /(?:policy revision is stale|policy revision is newer than expected|当前已切换为C本机放权|当前已切换为A服务器|请先取得C短效策略|本机模块已经更新)/i.test(String(error && error.message || error || ""));
}

function isCPolicyTransitionMessage(value) {
  return isCPolicyTransitionError({message: String(value || "")});
}

function isRecoverableCPolicyError(value) {
  const message = String(value || "").trim();
  return isCPolicyTransitionMessage(message)
    || /C策略(?:无效|不可用|已失效|已过期)(?:，领取已停止)?/i.test(message);
}

function isServerAccessRevoked(error) {
  const status = number(error && error.status);
  const message = String(error && error.message || error || "");
  if (status === 403 && error && error.authorized === false) return true;
  return /(?:管理员已暂停全部插件使用|管理员已停用(?:该)?(?:用户|使用者)|当前(?:用户|使用者)尚未获得插件使用授权|插件使用权限已被撤回)/i.test(message);
}

function isServerRegistrationRejected(error) {
  return number(error && error.status) === 403 && !!error && error.registered === false;
}

function serverAccessRevokedReason(error) {
  const message = String(error && error.message || error || "").trim();
  return message && isServerAccessRevoked(error) ? message.slice(0, 200) : "服务器已停用当前用户";
}

function clearServerAccessRevocationState(state) {
  if (!state || typeof state !== "object") return state;
  serverAccessRevoked = false;
  if (isServerAccessRevoked({message: state.lastError})) state.lastError = "";
  if (state.lastWorker && typeof state.lastWorker === "object") {
    const worker = {...state.lastWorker};
    if (isServerAccessRevoked({message: worker.lastError})) worker.lastError = "";
    if (worker.phase === "access-revoked") {
      worker.phase = "stopped";
      worker.phaseLabel = "服务器授权已恢复，等待启动";
      worker.lastUpdatedAt = Date.now();
    }
    state.lastWorker = worker;
  }
  return state;
}

function clearCPolicyTransitionState(state) {
  if (!state || typeof state !== "object") return state;
  if (isRecoverableCPolicyError(state.lastError)) state.lastError = "";
  if (state.lastWorker && isRecoverableCPolicyError(state.lastWorker.lastError)) {
    state.lastWorker = {...state.lastWorker, lastError: ""};
  }
  return state;
}

async function handoffRunningSessionToLocalPolicy(state) {
  stopControlLoop();
  stopRelayLoops();
  const session = await loadSession();
  if (!session.running || !session.tabId) return state;
  const settings = normalizeSettings(state.settings, state.runtimePolicy);
  state.settings = settings;
  state.autoPausedAtTarget = number(state.localWorkingPackages) >= settings.targetPackages;
  state.serverStopPending = false;
  state.lastServerTaskSignature = "";
  state.lastError = "";
  state.lastWorker = {
    ...(state.lastWorker || {}),
    running: true,
    phase: state.autoPausedAtTarget ? "target-paused" : "c-local-module",
    phaseLabel: state.autoPausedAtTarget
      ? `本地已有${number(state.localWorkingPackages)}包，达到放权停止包数${settings.targetPackages}包`
      : "服务器已切换为本机放权，正在接管任务扫描",
    workingPackages: number(state.localWorkingPackages),
    lastError: "",
    lastUpdatedAt: Date.now(),
  };
  syncLocalCatalogLoop(session.tabId, state, session);
  return state;
}

async function refreshAfterCPolicyTransition() {
  let state = await loadState();
  state = await ensureConnected(state);
  state = await refreshCPolicy(state, true);
  clearCPolicyTransitionState(state);
  await saveState(state);
  await broadcastCPolicyStatus(state);
  return state;
}

async function retryAfterCPolicyTransition(operation) {
  try {
    return await operation();
  } catch (error) {
    if (!isCPolicyTransitionError(error)) throw error;
    await refreshAfterCPolicyTransition();
    return operation();
  }
}

function cPolicyConnectedTabIds() {
  return [...new Set(Array.from(cPolicyPagePorts)
    .map((port) => number(port && port.sender && port.sender.tab && port.sender.tab.id))
    .filter(Boolean))];
}

function cPolicyWatchDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, number(ms))));
}

async function broadcastCPolicyStatus(state = null) {
  const currentState = state || await loadState();
  const session = await loadSession();
  const status = await publicStatus(currentState, session);
  await Promise.all(cPolicyConnectedTabIds().map((tabId) => chrome.tabs.sendMessage(tabId, {
    scope: "xiaotian-v24",
    type: "status-update",
    status,
  }).catch(() => {})));
}

async function applyServerAccessRevocation(error) {
  const reason = serverAccessRevokedReason(error);
  serverAccessRevoked = true;
  clearCPolicyMemory(reason);
  await scheduleCPolicyAlarms();
  await stopServer(reason, {skipServerRequest: true});
  const state = await loadState();
  state.leaseExpiresAt = 0;
  state.lastError = reason;
  state.lastWorker = {
    ...(state.lastWorker || {}),
    running: false,
    phase: "access-revoked",
    phaseLabel: reason,
    lastError: reason,
    lastUpdatedAt: Date.now(),
  };
  await saveState(state);
  await broadcastCPolicyStatus(state);
  return state;
}

async function applyImmediateCPolicyUpdate() {
  return enqueue(async () => {
    let state = await loadState();
    if (!state.installToken || !state.userName) return state;
    state = await refreshCPolicy(state, true);
    if (/^服务器配置更新失败：/.test(String(state.lastError || ""))) state.lastError = "";
    clearCPolicyTransitionState(state);
    await saveState(state);
    await broadcastCPolicyStatus(state);
    return state;
  });
}

async function runCPolicyWatchLoop(generation) {
  while (generation === cPolicyWatchGeneration && cPolicyPagePorts.size > 0) {
    if (serverAccessRevoked) {
      await cPolicyWatchDelay(C_POLICY_WATCH_RETRY_MS);
      continue;
    }
    if (!cPolicyUsable() || !cPolicyCurrent()) {
      try { await applyImmediateCPolicyUpdate(); } catch (error) {}
      await cPolicyWatchDelay(C_POLICY_WATCH_RETRY_MS);
      continue;
    }
    const state = await loadState();
    if (!state.installToken || !state.userName) {
      await cPolicyWatchDelay(C_POLICY_WATCH_RETRY_MS);
      continue;
    }
    try {
      const current = cPolicyCurrent();
      const response = await postJson("cPolicyWatch", {
        installId: state.installId,
        afterRevision: cPolicyControlRevision,
        routeMode: current && current.delegated === true && current.routeMode === "local" ? "local" : "server",
        waitMs: C_POLICY_WATCH_WAIT_MS,
      }, state.installToken, C_POLICY_WATCH_WAIT_MS + 10000);
      if (generation !== cPolicyWatchGeneration || cPolicyPagePorts.size === 0) return;
      const receivedRevision = number(response.controlRevision);
      const changed = response.changed === true
        || (receivedRevision > 0 && receivedRevision > cPolicyControlRevision);
      if (receivedRevision > 0) cPolicyControlRevision = Math.max(cPolicyControlRevision, receivedRevision);
      if (changed) await applyImmediateCPolicyUpdate();
    } catch (error) {
      if (generation !== cPolicyWatchGeneration || cPolicyPagePorts.size === 0) return;
      if (isServerAccessRevoked(error)) {
        await enqueue(() => applyServerAccessRevocation(error)).catch(() => {});
        continue;
      }
      if (isServerRegistrationRejected(error)) {
        await enqueue(async () => {
          let retryState = await loadState();
          try {
            retryState = await ensureConnected(retryState);
            clearCPolicyTransitionState(retryState);
            await saveState(retryState);
            await broadcastCPolicyStatus(retryState);
          } catch (reconnectError) {
            if (isServerAccessRevoked(reconnectError)) return applyServerAccessRevocation(reconnectError);
            throw reconnectError;
          }
          return retryState;
        }).catch(() => {});
        continue;
      }
      await cPolicyWatchDelay(C_POLICY_WATCH_RETRY_MS);
    }
  }
}

function ensureCPolicyWatchLoop() {
  if (cPolicyWatchPromise) return cPolicyWatchPromise;
  const generation = ++cPolicyWatchGeneration;
  cPolicyWatchPromise = runCPolicyWatchLoop(generation).finally(() => {
    cPolicyWatchPromise = null;
    if (cPolicyPagePorts.size > 0) ensureCPolicyWatchLoop();
  });
  return cPolicyWatchPromise;
}

function stopCPolicyWatchLoopIfIdle() {
  return cPolicyPagePorts.size === 0;
}

function runtimePolicyFromClientConfig(clientConfig) {
  const parameters = clientConfig && clientConfig.parameters || {};
  const routes = normalizeRuntimePlatformRoutes(clientConfig && clientConfig.platform);
  runtimePlatformRoutes = routes.base ? routes : null;
  runtimeConfigFetchedAt = Date.now();
  const has = (name) => Object.prototype.hasOwnProperty.call(parameters, name);
  const preSubmitAmount = has("defaultPreSubmitAmount")
    ? parameters.defaultPreSubmitAmount
    : parameters.preSubmitAmount;
  const releaseAfterMinutes = has("releaseAfterMinutes")
    ? parameters.releaseAfterMinutes
    : parameters.releaseTimeoutMinutes;
  const ordinaryStartPackages = has("ordinaryStartPackages")
    ? parameters.ordinaryStartPackages
    : parameters.normalStartPackages;
  return {
    serverConfigRevision: number(clientConfig && clientConfig.revision),
    initialIntervalMs: requestIntervalMs(parameters.defaultInitialIntervalMs),
    intervalTierPercentages: Array.isArray(parameters.intervalTierPercentages)
      ? parameters.intervalTierPercentages
        .map((item) => Math.max(1, Math.min(100, number(item))))
        .filter(Boolean)
        .slice(0, 32)
      : [100, 90, 80, 70, 60, 50, 40, 30, 20, 10],
    accelerationTierMs: Math.max(1000, number(parameters.accelerationTierMs) || 60 * 1000),
    ordinaryClaimEnabled: parameters.ordinaryClaimEnabled === true || parameters.normalClaimEnabled === true,
    stopPackages: Math.max(1, number(parameters.stopPackages) || 1),
    ordinaryStartPackages: Math.max(1, number(ordinaryStartPackages) || 1),
    preSubmitStopPackages: Math.max(1, number(parameters.preSubmitStopPackages) || 1),
    claimAmount: Math.max(1, number(parameters.defaultClaimAmount) || 1),
    preSubmitAmount: Math.max(1, number(preSubmitAmount) || 1),
    claimConcurrency: Math.max(1, number(parameters.claimConcurrency) || 1),
    taskPages: Math.max(1, number(parameters.defaultTaskPages) || 1),
    releaseAfterMinutes: has("releaseAfterMinutes") || has("releaseTimeoutMinutes")
      ? Math.max(0, number(releaseAfterMinutes))
      : DEFAULT_RELEASE_AFTER_MINUTES,
    releasePackageLimit: has("releasePackageLimit")
      ? Math.max(0, number(parameters.releasePackageLimit))
      : DEFAULT_RELEASE_PACKAGE_LIMIT,
    successAppearGraceMs: number(parameters.successAppearGraceMs),
    rateLimitRetryMs: Math.max(10, number(parameters.rateLimitRetryMs) || 5000),
    errorRetryMs: Math.max(10, number(parameters.errorRetryMs) || 2000),
    platformRequestTimeoutMs: number(parameters.platformRequestTimeoutMs),
    activeWorkingCheckMs: Math.max(100, number(parameters.activeWorkingCheckMs) || 100),
    coldProgressCheckMs: Math.max(100, number(parameters.coldProgressCheckMs) || 15 * 1000),
    fullProgressRefreshMs: Math.max(100, number(parameters.fullProgressRefreshMs) || 30 * 1000),
    taskCatalogRefreshMs: Math.max(100, number(parameters.taskCatalogRefreshMs) || 60 * 1000),
    platformRoutes: routes,
  };
}

async function activate(state, userName) {
  // C白名单必须始终绑定服务器登录实际读取到的正式姓名。即使当前
  // 租约允许本机执行，也不能在续租时退回可伪造的client-name身份。
  const serverIdentityOnly = String(CONFIG.PLATFORM_TRANSPORT_MODE || "") === "c-hybrid"
    || platformTransportMode() === "server-browser";
  const cleanName = validPlatformAccount(userName).slice(0, 80);
  if (!serverIdentityOnly && !cleanName) throw new Error("无法读取SkyVendor登录姓名");
  if (!serverIdentityOnly) state.userName = cleanName;
  await saveState(state);
  const common = {
    userName: serverIdentityOnly ? "" : cleanName,
    identityMode: serverIdentityOnly ? "server-browser" : "client-name",
    installId: state.installId,
    extensionVersion: extensionDisplayVersion(),
    buildFingerprint: "not-required-v24",
    platformAccount: state.platformAccount,
    working: false,
  };
  const response = await postJson("activate", {...common, runtimePolicy: state.runtimePolicy});
  state.runtimePolicy = runtimePolicyFromClientConfig(response.clientConfig);
  state.installToken = String(response.installToken || "");
  state.userName = validPlatformAccount(response.userName).slice(0, 80) || state.userName;
  state.leaseExpiresAt = number(response.leaseExpiresAt);
  clearServerAccessRevocationState(state);
  serverAccessRevoked = false;
  state.verificationStatus = "not-required";
  state.lastError = "";
  await saveState(state);
  if (state.userName) {
    try { await refreshCPolicy(state, true); } catch (error) {}
  }
  return state;
}

async function heartbeat(state, session = null) {
  if (!state.installToken) return state;
  flushLocalReadStats(state);
  const activeSession = session || await loadSession();
  state.reportSequence = number(state.reportSequence) + 1;
  const worker = state.lastWorker && typeof state.lastWorker === "object" ? state.lastWorker : {};
  const effectiveCSettings = cPolicyCoreSettings();
  // MV3 may restart the service worker while the install lease is still valid.
  // The signed C policy is intentionally memory-only, so omit protected C
  // control fields until a fresh policy has been obtained. This lets the
  // ordinary heartbeat renew the install lease before refreshCPolicy runs.
  const cControlReport = cPolicyUsable() ? {
    cRouteMode: cPolicyDelegated() ? "local" : "server",
    cClientSettings: effectiveCSettings || {},
    cPolicyRevision: number(cPolicyCurrent() && cPolicyCurrent().revision),
  } : {};
  const response = await postJson("heartbeat", {
    installId: state.installId,
    scriptBuild: await XiaotianClaimAudit.build().catch(() => null),
    extensionVersion: extensionDisplayVersion(),
    platformAccount: state.platformAccount,
    working: activeSession.running === true,
    requestTotal: number(state.localRequestTotal),
    claimedPackagesTotal: number(state.localClaimedPackagesTotal),
    intervalSumMs: number(state.localIntervalSumMs),
    intervalSamples: number(state.localIntervalSamples),
    reportSequence: state.reportSequence,
    buildFingerprint: "not-required-v24",
    runtimePolicy: state.runtimePolicy,
    runtimeState: {
      running: activeSession.running === true,
      phase: String(worker.phase || (activeSession.running ? "server-core" : "idle")),
      phaseLabel: String(worker.phaseLabel || (activeSession.running ? "服务器核心工作中" : "等待启动")),
      activeTaskId: String(worker.currentTaskId || ""),
      activeTaskName: String(worker.currentTaskName || ""),
      rounds: number(worker.rounds),
      failedClaims: number(worker.failedRequests),
      effectiveIntervalMs: 0,
      v24TargetPackages: state.settings.targetPackages,
      v24ClaimAmount: state.settings.claimAmount,
      v24TaskPages: state.settings.taskPages,
      updatedAt: Date.now(),
    },
    reportedSettings: state.settings,
    ...cControlReport,
    cSkyVendorTaskSummary: {
      observedAt: number(lastPlatformDirectReadAt),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      utcOffsetMinutes: -new Date().getTimezoneOffset(),
      tasks: Array.from(state.localWorkingRows || []).slice(0, 100).map((row) => ({
        // The summary is per active subtask. Use subTaskId as the unique row key
        // and retain the parent task/name only as a display label.
        taskId: String(row && row.id || "").trim().slice(0, 80),
        taskName: String(row && (row.taskName || row.taskId) || "").trim().slice(0, 160),
        status: String(row && row.localStatusText || (Number(row && row.status) === 0 ? "处理中" : `状态码${row && row.status}`)).trim().slice(0, 80),
        claimedAt: 0,
        claimedAtText: String(row && (row.localClaimTime || row.gmtCreate || row.createTime || row.claimTime) || "").trim().slice(0, 100),
      })),
    },
    clientInfo: {
      pagePath: "/skyvendor/dashboard/annotation/acceptance",
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    apiStats: [],
    claimRateBuckets: [],
  }, state.installToken, CONFIG.REQUEST_TIMEOUT_MS, cPolicyToken ? {"X-SV-C-Policy-Token": cPolicyToken} : {});
  if (runtimeConfigRefreshDue() && response.clientConfig && typeof response.clientConfig === "object") {
    state.runtimePolicy = runtimePolicyFromClientConfig(response.clientConfig);
    state.settings = normalizeSettings(state.settings, state.runtimePolicy);
    clearResolvedPlatformRouteError(state);
  }
  state.leaseExpiresAt = number(response.leaseExpiresAt);
  state.userName = validPlatformAccount(response.userName).slice(0, 80) || state.userName;
  state.verificationStatus = "not-required";
  state.lastHeartbeatAt = Date.now();
  clearServerAccessRevocationState(state);
  if (cPolicyUsable()) applyCPolicyRuntime(state);
  await saveState(state);
  return state;
}

async function ensureConnected(state) {
  if (!state.installToken || state.leaseExpiresAt <= Date.now() + 5000) {
    state = await activate(state, state.userName);
    try { return await refreshCPolicy(state, false); } catch (error) { return state; }
  }
  try {
    state = await heartbeat(state);
    try { return await refreshCPolicy(state, false); } catch (error) { return state; }
  } catch (error) {
    if (number(error && error.status) === 403) {
      state = await activate(state, state.userName);
      try { return await refreshCPolicy(state, false); } catch (refreshError) { return state; }
    }
    throw error;
  }
}

async function refreshBrowserAuthState(state, silent = false, options = {}) {
  if (!state || !state.installToken || platformTransportMode() !== "server-browser") return state;
  try {
    const response = await postJson("v24BrowserStatus", {}, state.installToken);
    await applyAndAcknowledgeBrowserAuthResponse(state, response, options);
  } catch (error) {
    if (number(error && error.status) === 403) {
      try {
        await activate(state, state.userName);
        const response = await postJson("v24BrowserStatus", {}, state.installToken);
        await applyAndAcknowledgeBrowserAuthResponse(state, response, options);
        return state;
      } catch (retryError) {
        if (!silent) throw retryError;
        return state;
      }
    }
    if (!silent) throw error;
  }
  return state;
}

async function browserAuthConnection() {
  let state = await loadState();
  try {
    state = await ensureConnected(state);
  } catch (error) {
    // A login action may arrive during an administrator route/policy switch.
    // Refresh the signed policy once, then retry the lease heartbeat so the
    // code submission is not rejected with the previous policy revision.
    if (!isCPolicyTransitionError(error)) throw error;
    state = await refreshCPolicy(state, true);
    state = await ensureConnected(state);
  }
  return state;
}

async function getBrowserAuthStatus(requestGeneration = browserAuthGeneration) {
  let state = await loadState();
  // Status polling is frequent and the status endpoint renews the install
  // lease itself. Avoid a heartbeat/C-policy refresh on every 500ms poll.
  if (!state.installToken || state.leaseExpiresAt <= Date.now() + 5000) {
    state = await browserAuthConnection();
  }
  await refreshBrowserAuthState(state, false, {refreshPolicy: false});
  if (requestGeneration !== browserAuthGeneration) return publicStatus();
  await saveState(state);
  return publicStatus(state);
}

async function requestBrowserLoginPhone(message, requestGeneration = browserAuthGeneration) {
  let state = await browserAuthConnection();
  let phone = String(message && message.phone || "").replace(/\D/g, "").slice(0, 20);
  const countryCodeInput = String(message && message.countryCode || "+86").trim();
  const countryCode = /^\+\d{1,4}$/.test(countryCodeInput) ? countryCodeInput : "";
  if (phone.length < 6) throw new Error("请输入正确的手机号码");
  if (!countryCode) throw new Error("请输入正确的国家或地区代码");
  const payload = {phone, countryCode};
  try {
    const response = await postJson("v24BrowserLoginPhone", payload, state.installToken, CONFIG.LOGIN_REQUEST_TIMEOUT_MS);
    if (requestGeneration !== browserAuthGeneration) return publicStatus();
    await applyAndAcknowledgeBrowserAuthResponse(state, response);
    await saveState(state);
    return publicStatus(state);
  } finally {
    payload.phone = "";
    phone = "";
  }
}

async function submitBrowserLoginCode(message, requestGeneration = browserAuthGeneration) {
  let state = await browserAuthConnection();
  let code = String(message && message.code || "").trim();
  if (!/^\d{4,8}$/.test(code)) {
    code = "";
    throw new Error("请输入4至8位短信验证码");
  }
  const payload = {code};
  try {
    const response = await postJson("v24BrowserLoginCode", payload, state.installToken, CONFIG.LOGIN_REQUEST_TIMEOUT_MS);
    if (requestGeneration !== browserAuthGeneration) return publicStatus();
    await applyAndAcknowledgeBrowserAuthResponse(state, response);
    await saveState(state);
    return publicStatus(state);
  } finally {
    payload.code = "";
    code = "";
  }
}

async function logoutServerBrowser(requestGeneration = browserAuthGeneration) {
  const state = await browserAuthConnection();
  const response = await postJson("v24BrowserLogout", {}, state.installToken, CONFIG.LOGIN_REQUEST_TIMEOUT_MS);
  if (requestGeneration !== browserAuthGeneration) return publicStatus();
  browserManualLoginUrl = "";
  applyBrowserAuthResponse(state, response, {clearPhone: true});
  await saveState(state);
  return publicStatus(state);
}

async function openManualBrowserLogin() {
  const state = await browserAuthConnection();
  await refreshBrowserAuthState(state);
  const browserAuth = normalizeBrowserAuth(state.browserAuth);
  if (!browserAuth.challengeRequired) throw new Error("服务器目前没有要求人工验证");
  const url = sanitizedManualLoginUrl(browserManualLoginUrl);
  if (!url) throw new Error("服务器没有提供可用的HTTPS人工验证网址");
  await chrome.tabs.create({url, active: true});
  await saveState(state);
  return {...await publicStatus(state), manualLoginOpened: true};
}

function relayDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, number(ms))));
}

function wakeControlLoop() {
  const resolver = controlWakeResolver;
  controlWakeResolver = null;
  if (resolver) resolver();
}

function controlDelay(ms) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (controlWakeResolver === finish) controlWakeResolver = null;
      resolve();
    };
    const timer = setTimeout(finish, Math.max(1, number(ms)));
    controlWakeResolver = finish;
  });
}

function stopRelayLoops() {
  relayGeneration += 1;
  relayTabId = 0;
  relayLoopCount = 0;
}

function stopControlLoop() {
  controlGeneration += 1;
  controlTabId = 0;
  localTaskCursor = 0;
}

async function saveRelayWorker(worker) {
  if (!worker || typeof worker !== "object") return;
  let state = await loadState();
  state.lastWorker = worker;
  if (worker.lastError) state.lastError = String(worker.lastError);
  await saveState(state);
}

async function reloadClaimPage(tabId, keepRunning) {
  const normalizedTabId = number(tabId);
  if (!normalizedTabId) return false;
  if (keepRunning) {
    const session = await loadSession();
    if (!session.running || session.tabId !== normalizedTabId) return false;
    stopControlLoop();
    stopRelayLoops();
    await saveSession({
      running: true,
      tabId: normalizedTabId,
      refreshing: true,
      refreshStartedAt: Date.now(),
    });
  }
  try {
    await chrome.tabs.reload(normalizedTabId);
    return true;
  } catch (error) {
    if (keepRunning) {
      await saveSession({running: true, tabId: normalizedTabId});
      const state = await loadState();
      if (!state.autoPausedAtTarget) startRelayLoops(normalizedTabId);
      startControlLoop(normalizedTabId);
    }
    throw error;
  }
}

async function refreshAcceptanceTable(tabId) {
  const normalizedTabId = number(tabId);
  if (!normalizedTabId) return false;
  try {
    const response = await chrome.tabs.sendMessage(normalizedTabId, {
      scope: "xiaotian-v24",
      type: "refresh-acceptance-table",
    });
    if (response && response.ok === true) return true;
  } catch (error) {}
  if (CONFIG.FULL_PAGE_REFRESH_FALLBACK === true) return reloadClaimPage(normalizedTabId, false);
  return false;
}

async function pushStatusUpdate(tabId, state = null, session = null) {
  const normalizedTabId = number(tabId);
  if (!normalizedTabId) return false;
  const status = await publicStatus(state, session);
  return withPageResponseTimeout(chrome.tabs.sendMessage(normalizedTabId, {
    scope: "xiaotian-v24",
    type: "status-update",
    status,
  })).then(() => true, () => false);
}

async function withPageResponseTimeout(operation, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("网页通信超时")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRelayClaimCommand(command) {
  const id = String(command && command.id || "").trim().slice(0, 128);
  const method = String(command && command.method || "").toUpperCase();
  const pathName = String(command && command.pathName || "").trim();
  const match = /^\/([A-Za-z0-9_-]{1,80})\/review\/fetch$/.exec(pathName);
  const data = command && command.data && typeof command.data === "object" ? command.data : {};
  const taskId = match && match[1];
  const batchSize = Math.trunc(Number(data.batchSize));
  const valid = !!id && method === "POST" && !!taskId
    && String(data.taskId || "") === taskId
    && Number.isSafeInteger(batchSize) && batchSize >= 1
    && data.dim === "data"
    && Number(data.sampleRate) === 30
    && Array.isArray(data.userIdList) && data.userIdList.length === 0;
  if (!valid) return null;
  return {
    id,
    pathName,
    method: "POST",
    params: {},
    data: {batchSize, dim: "data", sampleRate: 30, taskId, userIdList: []},
    timeoutMs: Math.max(1000, number(command.timeoutMs) || 20000),
    logAction: "领取任务",
  };
}

function localManualClaimCommand(taskId, batchSize) {
  const normalizedTaskId = String(taskId || "").trim().slice(0, 80);
  const normalizedBatchSize = Math.trunc(Number(batchSize));
  const command = normalizeRelayClaimCommand({
    id: crypto.randomUUID(),
    pathName: platformRoute("claim", {taskId: normalizedTaskId}),
    method: "POST",
    data: {
      batchSize: normalizedBatchSize,
      dim: "data",
      sampleRate: 30,
      taskId: normalizedTaskId,
      userIdList: [],
    },
    timeoutMs: 10000,
  });
  if (!command) throw new Error("本地手动领取参数无效");
  return command;
}

function isTransientFrameError(value) {
  const code = String(value && value.code || "").toUpperCase();
  if (code === "FRAME_TRANSITION") return true;
  const message = String(value && value.message || value || "");
  return /Frame with ID \d+ was removed|No frame with id|No tab with id|tab with id \d+ does not exist|frame (?:was|has been) removed/i.test(message);
}

async function waitForStablePlatformFrame(tabId, timeoutMs = 3000) {
  const deadline = Date.now() + Math.max(250, number(timeoutMs));
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(number(tabId));
      const url = String(tab && tab.url || "");
      if (url && !isSkyVendorPageUrl(url)) return false;
      if (tab && tab.discarded !== true && tab.status === "complete" && isSkyVendorPageUrl(url)) return true;
    } catch (error) {
      return false;
    }
    await relayDelay(100);
  }
  return false;
}

async function executePlatformCommandRaw(tabId, command, frameRetry = 0) {
  const direct = await executeDirectPlatformCommand(tabId, command);
  if (direct && direct.transportError !== true) return direct;
  if (command.noTransportReplay && direct?.notSent !== true) return direct;
  if (command.noTransportReplay && !runtimePlatformRoutes?.base) return direct;
  try {
    const executions = await chrome.scripting.executeScript({
      target: {tabId},
      world: "MAIN",
      args: [{
        id: String(command.id || ""),
        base: runtimePlatformRoutes && runtimePlatformRoutes.base,
        pathName: String(command.pathName || ""),
        method: String(command.method || "GET"),
        params: command.params && typeof command.params === "object" ? command.params : {},
        data: command.data,
        timeoutMs: Math.max(1000, number(command.timeoutMs) || 20000),
      }],
      func: async (input) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), input.timeoutMs);
        try {
          const platformFetch = async (pathName, options = {}) => {
            const url = new URL(`${input.base}${pathName}`);
            for (const [key, value] of Object.entries(options.params || {})) {
              if (value == null || value === "") continue;
              url.searchParams.set(key, String(value));
            }
            const token = String(localStorage.getItem("token") || sessionStorage.getItem("token") || "").trim();
            const headers = {"Accept": "application/json, text/plain, */*"};
            if (token) headers.Authorization = `Bearer ${token}`;
            const init = {method: String(options.method || "GET").toUpperCase(), credentials: "include", headers, signal: controller.signal};
            if (options.data !== undefined) {
              headers["Content-Type"] = "application/json;charset=UTF-8";
              init.body = JSON.stringify(options.data);
            }
            const response = await fetch(url, init);
            let payload = {};
            try { payload = await response.json(); } catch (error) {
              return {ok: false, status: response.status, code: response.status, error: `接口返回异常（HTTP ${response.status}）`};
            }
            const ok = response.ok && Number(payload.code) === 0 && payload.success !== false;
            return {
              ok,
              status: response.status,
              code: payload.code == null ? response.status : payload.code,
              data: ok ? payload.data : undefined,
              error: ok ? "" : String(payload.message || payload.log || `HTTP ${response.status}`),
            };
          };
          const result = await platformFetch(input.pathName, input);
          return {
            id: input.id,
            ...result,
          };
        } catch (error) {
          return {id: input.id, ok: false, status: 0, code: error && error.name === "AbortError" ? "TIMEOUT" : "RELAY_ERROR", error: String(error && error.message || error)};
        } finally {
          clearTimeout(timer);
        }
      },
    });
    return executions && executions[0] && executions[0].result
      || {id: String(command.id || ""), ok: false, status: 0, code: "NO_RESULT", error: "浏览器没有返回平台请求结果"};
  } catch (error) {
    const method = String(command && command.method || "GET").toUpperCase();
    const pathName = String(command && command.pathName || "");
    if (isTransientFrameError(error)) {
      if (method === "GET" && frameRetry < 1 && await waitForStablePlatformFrame(tabId)) {
        return executePlatformCommandRaw(tabId, command, frameRetry + 1);
      }
      const uncertainClaim = method === "POST" && /\/review\/fetch$/.test(pathName);
      return {
        id: String(command.id || ""),
        ok: false,
        status: 0,
        code: uncertainClaim ? "TIMEOUT" : "FRAME_TRANSITION",
        error: uncertainClaim ? "页面切换中，领取结果待平台确认" : "页面切换中，稍后自动重试",
      };
    }
    return {id: String(command.id || ""), ok: false, status: 0, code: "RELAY_ERROR", error: String(error && error.message || error)};
  }
}

function publishPlatformRequestTiming(tabId, command, result, durationMs) {
  const normalizedTabId = number(tabId);
  if (!normalizedTabId) return;
  const action = String(command && command.logAction || (String(command && command.method || "GET").toUpperCase() === "GET" ? "数据查询" : "平台请求")).slice(0, 40);
  chrome.tabs.sendMessage(normalizedTabId, {
    scope: "xiaotian-v24",
    type: "platform-request-log",
    action,
    durationMs: Math.max(0, Math.trunc(Number(durationMs) || 0)),
    success: result && result.ok === true,
    message: result && result.ok === true ? "" : String(result && result.error || "请求未成功").slice(0, 160),
  }).catch(() => {});
}

async function executePlatformCommand(tabId, command, frameRetry = 0) {
  const startedAt = performance.now();
  let result = null;
  try {
    const operation = executePlatformCommandRaw(tabId, command, frameRetry);
    // A suspended page cannot run its own fetch timeout. Bound read-only
    // execution from the extension as well; writes retain their result checks.
    result = await (String(command.method || "GET").toUpperCase() === "GET"
      ? withPageResponseTimeout(operation, Math.max(1000, number(command.timeoutMs) || 20000) + 4000)
      : operation);
    return result;
  } catch (error) {
    result = {ok: false, error: String(error && error.message || error)};
    throw error;
  } finally {
    publishPlatformRequestTiming(tabId, command, result, performance.now() - startedAt);
  }
}

async function readPlatformToken(tabId, force = false) {
  const normalizedTabId = number(tabId);
  const cached = platformTokenByTab.get(normalizedTabId);
  if (!force && cached && Date.now() - cached.updatedAt < 5 * 60 * 1000) return cached.token;
  try {
    const executions = await chrome.scripting.executeScript({
      target: {tabId: normalizedTabId},
      world: "MAIN",
      func: () => String(localStorage.getItem("token") || sessionStorage.getItem("token") || "").trim(),
    });
    const token = String(executions && executions[0] && executions[0].result || "").trim();
    if (token) platformTokenByTab.set(normalizedTabId, {token, updatedAt: Date.now()});
    return token;
  } catch (error) {
    return "";
  }
}

async function executeDirectPlatformCommand(tabId, command) {
  const routes = runtimePlatformRoutes;
  if (!routes || !routes.base) return {ok: false, transportError: true, notSent: true, status: 0, code: "NO_PLATFORM_ROUTE", error: "服务器平台路由尚未下发，请求未发出"};
  const token = await readPlatformToken(tabId);
  if (!token) return {ok: false, transportError: true, notSent: true, status: 0, code: "NO_PLATFORM_TOKEN", error: "未读取到平台 Token，后台直连请求未发出"};
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, number(command && command.timeoutMs) || 20000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(`${routes.base}${String(command.pathName || "")}`);
    for (const [key, value] of Object.entries(command.params && typeof command.params === "object" ? command.params : {})) {
      if (value == null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    const headers = {Accept: "application/json, text/plain, */*", Authorization: `Bearer ${token}`};
    const init = {
      method: String(command.method || "GET").toUpperCase(),
      credentials: "include",
      headers,
      signal: controller.signal,
    };
    if (command.data !== undefined) {
      headers["Content-Type"] = "application/json;charset=UTF-8";
      init.body = JSON.stringify(command.data);
    }
    const response = await fetch(url, init);
    let payload = {};
    try { payload = await response.json(); } catch (error) {
      return {id: String(command.id || ""), ok: false, status: response.status, code: response.status, error: `接口返回异常（HTTP ${response.status}）`};
    }
    if (response.status === 401) platformTokenByTab.delete(number(tabId));
    const ok = response.ok && Number(payload.code) === 0 && payload.success !== false;
    return {
      id: String(command.id || ""),
      ok,
      status: response.status,
      code: payload.code == null ? response.status : payload.code,
      data: ok ? payload.data : undefined,
      error: ok ? "" : String(payload.message || payload.log || `HTTP ${response.status}`),
    };
  } catch (error) {
    return {
      id: String(command && command.id || ""),
      transportError: true,
      ok: false,
      status: 0,
      code: error && error.name === "AbortError" ? "TIMEOUT" : "DIRECT_NETWORK_ERROR",
      error: String(error && error.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function executeRelayCommand(tabId, command) {
  const normalized = normalizeRelayClaimCommand(command);
  if (!normalized) {
    return {id: String(command && command.id || ""), ok: false, status: 0, code: "RELAY_REJECTED", error: "服务器下发的领取指令不符合固定安全规则"};
  }
  return executePlatformCommand(tabId, normalized);
}

async function executeLocalRead(tabId, pathName, params, logAction = "数据查询") {
  recordLocalPlatformRequest();
  const result = await executePlatformCommand(tabId, {
    id: crypto.randomUUID(),
    pathName,
    method: "GET",
    params,
    timeoutMs: 10000,
    logAction,
  });
  if (!result.ok) {
    const error = new Error(String(result.error || "无法读取SkyVendor数据"));
    error.code = String(result.code || "");
    throw error;
  }
  return result.data;
}

function packageCountFromSummaryTotal(total) {
  const normalized = number(total);
  return Math.max(1, Math.ceil(normalized / ACCEPTANCE_ITEMS_PER_PACKAGE));
}

function rowPackageCount(row) {
  const summaryCount = number(row && row.summaryPackageCount);
  return summaryCount > 0 ? summaryCount : 1;
}

function workingPackageCount(rows) {
  return Array.from(rows || []).reduce((total, row) => total + rowPackageCount(row), 0);
}

function workingPackageDelta(currentRows, previousRows, taskId = "") {
  const previousById = new Map(Array.from(previousRows || []).map((row) => [String(row && row.id || "").trim(), row]));
  const expectedTaskId = String(taskId || "").trim();
  const hasTaskIds = Array.from(currentRows || []).some((row) => String(row && row.taskId || "").trim());
  let total = 0;
  for (const row of Array.from(currentRows || [])) {
    if (expectedTaskId && hasTaskIds && String(row && row.taskId || "").trim() !== expectedTaskId) continue;
    const id = String(row && row.id || "").trim();
    if (!id) continue;
    const previous = previousById.get(id);
    total += Math.max(0, rowPackageCount(row) - (previous ? rowPackageCount(previous) : 0));
  }
  return total;
}

async function fetchSubTaskSummary(tabId, subTaskId) {
  const data = await executeLocalRead(tabId, platformRoute("summary", {subTaskId}), {}, "核对包数");
  const total = number(data && data.total);
  return {
    total,
    packageCount: packageCountFromSummaryTotal(total),
    fetchedAt: Date.now(),
  };
}

function scheduleSubTaskSummaryRefresh(tabId, rows) {
  const normalizedTabId = number(tabId);
  if (!normalizedTabId || !runtimePlatformRoutes || !runtimePlatformRoutes.summary || !Array.isArray(rows) || !rows.length) return;
  const previous = subTaskSummaryRefreshes.get(normalizedTabId) || Promise.resolve();
  const next = previous.then(async () => {
    for (const row of rows) {
      const subTaskId = String(row && row.id || "").trim();
      if (!subTaskId) continue;
      const cached = subTaskSummaryCache.get(subTaskId);
      if (cached && Date.now() - cached.fetchedAt < SUBTASK_SUMMARY_CACHE_MS) continue;
      try {
        subTaskSummaryCache.set(subTaskId, await fetchSubTaskSummary(normalizedTabId, subTaskId));
      } catch (error) {
        // Keep the row-count fallback; a slow or unavailable summary must not
        // block the task scan or the claim loop.
      }
    }
  }).finally(() => {
    if (subTaskSummaryRefreshes.get(normalizedTabId) === next) subTaskSummaryRefreshes.delete(normalizedTabId);
  });
  subTaskSummaryRefreshes.set(normalizedTabId, next);
}

// All ordinary/manual working-list readers share this gate, including claim
// confirmation and the release watchdog. Never reuse a pre-claim snapshot for
// a post-claim check: every caller receives a fresh read after its own turn.
let workingReadQueue = Promise.resolve();
const workingReadTiming = {lastStartedAt: 0};

async function workingReadPacingBase() {
  if (!cPolicyDelegated()) return 0;
  const base = Number(cPolicyCurrent()?.defaults?.preSubmitIntervalMs);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const settings = cPolicyCoreSettings();
  const session = await loadSession();
  return base > 10 || settings?.preSubmitEnabled === false || !session.running ? Math.max(1, base * 100) : 0;
}

async function readLocalWorkingRows(tabId, strict = false) {
  if (!(await workingReadPacingBase())) return readObservedLocalWorkingRows(tabId, strict);
  const pending = workingReadQueue.catch(() => {}).then(async () => {
    while (true) {
      const intervalMs = await workingReadPacingBase();
      if (!intervalMs) break;
      const remaining = workingReadTiming.lastStartedAt
        ? workingReadTiming.lastStartedAt + intervalMs - Date.now() : 0;
      if (remaining <= 0) break;
      // Recheck server settings while waiting so a mode/interval change takes
      // effect without retaining the previous mode's deadline.
      await relayDelay(Math.min(250, remaining));
    }
    workingReadTiming.lastStartedAt = Date.now();
    return readObservedLocalWorkingRows(tabId, strict);
  });
  workingReadQueue = pending.then(() => {}, () => {});
  return pending;
}

async function readObservedLocalWorkingRows(tabId, strict) {
  const rows = await readLocalWorkingRowsNow(tabId, strict);
  await rememberLocalClaimObservation(tabId, rows);
  queueLateLocalClaimConfirmation(tabId, rows);
  return rows;
}

async function readLocalWorkingRowsNow(tabId, strict = false) {
  const pageSize = 5;
  const first = await executeLocalRead(tabId, platformRoute("subTasks"), {
    type: "review",
    page: 1,
    pageSize,
    filterByTaskUser: true,
    finished: false,
  }, "读取未完成任务");
  const validPage = (page) => page && Array.isArray(page.data)
    && page.recordCount != null && Number.isSafeInteger(Number(page.recordCount)) && Number(page.recordCount) >= 0;
  if (strict && !validPage(first)) throw new Error("未完成任务列表格式无效，不能确认空队列");
  const recordCount = number(first && first.recordCount);
  const pageCount = Math.ceil(recordCount / pageSize);
  if (pageCount > 200) throw new Error("本地工作包记录过多，无法完整确认包数");
  const later = await Promise.all(Array.from({length: Math.max(0, pageCount - 1)}, (_, index) => executeLocalRead(tabId, platformRoute("subTasks"), {
    type: "review",
    page: index + 2,
    pageSize,
    filterByTaskUser: true,
    finished: false,
  }, "读取未完成任务")));
  if (strict && later.some((page) => !validPage(page))) throw new Error("未完成任务分页格式无效，不能确认空队列");
  const rows = [];
  for (const page of [first, ...later]) rows.push(...(page && Array.isArray(page.data) ? page.data : []));
  if (rows.length < recordCount) throw new Error("本地工作包列表读取不完整");
  if (strict && (new Set(rows.map((row) => String(row?.id || ""))).size !== rows.length
    || rows.some((row) => !row?.id || !row.taskId || row.status == null))) {
    throw new Error("未完成任务存在重复或归属不明的记录，不能切换任务流");
  }
  const activeRows = await attachPackageObservationTimes(rows.filter((row) => Number(row && row.status) === 0 && row.gmtCommit == null));
  // The last package disappearing is authoritative without any DOM metadata.
  // Do not depend on a busy/hidden acceptance page to confirm an empty list.
  const localDetails = activeRows.length ? await readVisibleLocalClaimTimes(tabId) : new Map();
  const directRows = activeRows.map((row) => {
    const subTaskId = String(row && row.id || "").trim();
    const detail = localDetails.get(subTaskId) || {};
    const localClaimTime = String(detail.claimTime || "").trim();
    const localStatusText = String(detail.statusText || "").trim();
    const summary = subTaskSummaryCache.get(subTaskId);
    return {
      ...(localClaimTime || localStatusText ? {...row, localClaimTime, localStatusText} : row),
      ...(summary ? {summaryTotal: summary.total, summaryPackageCount: summary.packageCount} : {}),
    };
  });
  scheduleSubTaskSummaryRefresh(tabId, directRows);
  lastPlatformDirectReadAt = Date.now();
  localWorkingReadSequence += 1;
  return directRows;
}

function parsePlatformTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return NaN;
  const normalized = raw.replace(" ", "T");
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const parsed = Date.parse(hasTimezone ? normalized : `${normalized}Z`);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function parseLocalDisplayedTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return NaN;
  const parsed = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

function releaseClaimedAt(row) {
  const platformTime = parsePlatformTime(row && row.gmtCreate);
  const localDisplayedTime = parseLocalDisplayedTime(row && row.localClaimTime);
  const localObservedAt = number(row && row.localObservedAt);
  const rawPlatformTime = String(row && row.gmtCreate || "").trim().replace(" ", "T");
  const platformHasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawPlatformTime);
  if (Number.isFinite(platformTime) && Number.isFinite(localDisplayedTime)) {
    // When both representations resolve to the same instant, use the later one
    // for sub-second/display rounding.  A large disagreement means the API's
    // timezone contract is ambiguous, so wait 30 minutes from first local sight.
    if (Math.abs(platformTime - localDisplayedTime) <= 2 * 60 * 1000) {
      return Math.max(platformTime, localDisplayedTime);
    }
    return localObservedAt || NaN;
  }
  if (Number.isFinite(platformTime) && platformHasTimezone) return platformTime;
  return localObservedAt || NaN;
}

async function readVisibleLocalClaimTimes(tabId) {
  const output = new Map();
  try {
    const response = await withPageResponseTimeout(chrome.tabs.sendMessage(number(tabId), {
      scope: "xiaotian-v24",
      type: "read-working-claim-times",
    }), 500);
    for (const item of response && Array.isArray(response.rows) ? response.rows : []) {
      const subTaskId = String(item && item.subTaskId || "").trim().slice(0, 120);
      const claimTime = String(item && item.claimTime || "").trim().slice(0, 40);
      const statusText = String(item && (item.statusText || item.taskStatus) || "").trim().slice(0, 40);
      if (subTaskId && (claimTime || statusText)) output.set(subTaskId, {claimTime, statusText});
    }
  } catch (error) {}
  return output;
}

async function releaseLocalPackage(tabId, row) {
  const subTaskId = String(row && row.id || "").trim().slice(0, 120);
  if (!subTaskId) throw new Error("工作包缺少subTaskId，无法释放");
  if (releaseRequestsInFlight.has(subTaskId)) return releaseRequestsInFlight.get(subTaskId);
  const request = (async () => {
    if (!await reserveReleaseRequest(subTaskId)) return {subTaskId, deferred: true};
    recordLocalPlatformRequest();
    const result = await executePlatformCommand(tabId, {
      id: crypto.randomUUID(),
      pathName: platformRoute("release", {subTaskId}),
      method: "POST",
      timeoutMs: 10000,
      logAction: "释放任务",
    });
    if (!result.ok) throw new Error(String(result.error || `工作包${subTaskId}释放失败`));
    await markReleaseRequestSuccess(subTaskId);
    return {subTaskId, deferred: false};
  })();
  releaseRequestsInFlight.set(subTaskId, request);
  try {
    return await request;
  } finally {
    if (releaseRequestsInFlight.get(subTaskId) === request) releaseRequestsInFlight.delete(subTaskId);
  }
}

async function applyLocalReleasePolicy(tabId, rows, runtimePolicy = {}, options = {}) {
  // The turbo coordinator owns overflow cleanup while its requests are
  // draining. Expired packages are independent of that round, however, and
  // must still be released after the configured timeout.
  const turboActive = !!(turboRun || turboRecoveryPending);
  const allowTurboTimeout = options && options.allowTurboTimeout === true;
  if (turboActive && !allowTurboTimeout) return {rows: Array.from(rows || []), released: [], failed: [], deferred: []};
  const activeRows = Array.from(rows || []);
  const now = Date.now();
  const releaseAfterMinutes = serverReleaseAfterMinutes(runtimePolicy);
  const releaseAfterMs = releaseAfterMinutes * 60 * 1000;
  const releasePackageLimit = serverReleasePackageLimit(runtimePolicy);
  const releaseReasons = new Map();
  for (const row of activeRows) {
    const subTaskId = String(row && row.id || "").trim();
    const createdAt = releaseClaimedAt(row);
    if (releaseAfterMinutes > 0 && subTaskId && Number.isFinite(createdAt) && now - createdAt >= releaseAfterMs) {
      releaseReasons.set(subTaskId, `超时${releaseAfterMinutes}分钟`);
    }
  }
  const nonExpired = activeRows.filter((row) => !releaseReasons.has(String(row && row.id || "").trim()));
  if (!turboActive && releasePackageLimit > 0 && workingPackageCount(nonExpired) > releasePackageLimit) {
    const newestFirst = [...nonExpired].sort((left, right) => {
      const leftAt = releaseClaimedAt(left);
      const rightAt = releaseClaimedAt(right);
      return (Number.isFinite(rightAt) ? rightAt : now) - (Number.isFinite(leftAt) ? leftAt : now);
    });
    let overflow = workingPackageCount(nonExpired) - releasePackageLimit;
    for (const row of newestFirst) {
      if (overflow <= 0) break;
      const subTaskId = String(row && row.id || "").trim();
      if (subTaskId) {
        releaseReasons.set(subTaskId, `超过${releasePackageLimit}包上限`);
        overflow -= rowPackageCount(row);
      }
    }
  }
  const targets = activeRows.filter((row) => releaseReasons.has(String(row && row.id || "").trim()));
  const results = await Promise.all(targets.map(async (row) => {
    const subTaskId = String(row && row.id || "").trim();
    try {
      const released = await releaseLocalPackage(tabId, row);
      if (released && released.deferred) return {subTaskId, packageCount: rowPackageCount(row), ok: false, deferred: true, reason: releaseReasons.get(subTaskId)};
      return {subTaskId, packageCount: rowPackageCount(row), ok: true, deferred: false, reason: releaseReasons.get(subTaskId)};
    } catch (error) {
      return {subTaskId, packageCount: rowPackageCount(row), ok: false, reason: releaseReasons.get(subTaskId), error: String(error && error.message || error)};
    }
  }));
  const releasedIds = new Set(results.filter((item) => item.ok).map((item) => item.subTaskId));
  return {
    rows: activeRows.filter((row) => !releasedIds.has(String(row && row.id || "").trim())),
    released: results.filter((item) => item.ok),
    failed: results.filter((item) => !item.ok && !item.deferred),
    deferred: results.filter((item) => item.deferred),
  };
}

function taskMissingFromDirectory(taskId, proof) {
  return proof?.complete === true && Array.isArray(proof.taskIds) && !proof.taskIds.includes(String(taskId));
}

function applyDirectoryProof(state, proof) {
  if (!proof || Number(proof.updatedAt) < Number(state.localDirectoryProof?.updatedAt || 0)) return;
  state.localDirectoryProof = proof;
  if (!proof.complete || !state.settings) return;
  const previous = state.settings.selectedTaskIds || [];
  const selected = previous.filter((id) => !taskMissingFromDirectory(id, proof));
  if (selected.length !== previous.length) {
    state.settings = {...state.settings, selectedTaskIds: selected,
      taskSelectionRequired: selected.length === 0};
  }
}

async function readLocalTaskCatalog(tabId, settings) {
  const request = (pathName, params) => executeLocalRead(tabId, pathName, params, "读取任务目录");
  const pageSize = 5;
  const first = await request(platformRoute("tasks"), {subTaskType: "review", page: 1, pageSize});
  const validPage = (page) => page && Array.isArray(page.data) && page.recordCount != null
    && Number.isSafeInteger(Number(page.recordCount)) && Number(page.recordCount) >= 0;
  if (!validPage(first)) throw new Error("任务目录格式无效，保留原选择，稍后重新刷新");
  const recordCount = Math.max(0, number(first && first.recordCount));
  const configuredPages = Math.max(1, number(settings && settings.taskPages) || PRE_SUBMIT_TASK_PAGES);
  const pageCount = Math.min(Math.ceil(recordCount / pageSize), configuredPages);
  const laterPages = await Promise.all(Array.from({length: Math.max(0, pageCount - 1)}, (_, index) => request(platformRoute("tasks"), {
    subTaskType: "review",
    page: index + 2,
    pageSize,
  })));
  const definitions = [];
  if (laterPages.some((page) => !validPage(page) || Number(page.recordCount) !== recordCount)) {
    throw new Error("任务目录分页不完整或发生变化，保留原选择");
  }
  const seen = new Set();
  for (const page of [first, ...laterPages]) {
    for (const row of page && Array.isArray(page.data) ? page.data : []) {
      const taskId = String(row && row.taskId || "").trim().slice(0, 80);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId) || seen.has(taskId)) throw new Error("任务目录存在无效或重复记录，保留原选择");
      seen.add(taskId);
      definitions.push({
        taskId,
        name: String(row.name || row.taskName || taskId).trim().slice(0, 160),
        left: number(row.left),
        ...catalogClaimFields(row),
      });
    }
  }
  if (definitions.length < Math.min(recordCount, configuredPages * pageSize)) {
    throw new Error("任务目录读取不完整，保留原选择");
  }
  const result = await readLocalTaskProgress(tabId, definitions);
  result.directoryProof = {complete: definitions.length === recordCount,
    taskIds: definitions.map((task) => task.taskId), updatedAt: Date.now()};
  return result;
}

async function readLocalTaskProgress(tabId, tasks) {
  const definitions = normalizeCandidateTasks(tasks);
  if (!definitions.length) return [];
  const request = (pathName, params) => executeLocalRead(tabId, pathName, params, "读取任务余量");
  const groups = [];
  for (let index = 0; index < definitions.length; index += 5) groups.push(definitions.slice(index, index + 5));
  const progressPages = await Promise.all(groups.map((group) => request(platformRoute("process"), {
    subTaskType: "review",
    taskIds: group.map((item) => item.taskId).join(","),
  })));
  const progressById = new Map();
  for (const rows of progressPages) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const taskId = String(row && row.taskId || "").trim().slice(0, 80);
      if (taskId) progressById.set(taskId, row);
    }
  }
  return definitions.map((definition) => {
    const current = progressById.get(definition.taskId) || definition;
    return {
      taskId: definition.taskId,
      name: String(current.name || current.taskName || definition.name).trim().slice(0, 160),
      left: number(current.left == null ? definition.left : current.left),
      ...catalogClaimFields(current),
    };
  });
}

function localTaskRefreshMs() {
  return Math.max(100, number(CONFIG.LOCAL_TASK_REFRESH_MS) || 100);
}

function localCatalogTiming(state) {
  const runtime = state && state.runtimePolicy && typeof state.runtimePolicy === "object" ? state.runtimePolicy : {};
  return {
    fullCatalogMs: Math.max(100, number(runtime.taskCatalogRefreshMs) || 60 * 1000),
    fullProgressMs: Math.max(100, number(runtime.fullProgressRefreshMs) || 30 * 1000),
    coldProgressMs: Math.max(100, number(runtime.coldProgressCheckMs) || 15 * 1000),
  };
}

function cacheFullLocalCatalog(tabId, taskCatalog, checkedAt = Date.now()) {
  const normalizedTabId = number(tabId);
  const catalog = normalizeCandidateTasks(taskCatalog);
  const progressMeta = new Map(catalog.map((task) => [task.taskId, {checkedAt, intervalMs: 0}]));
  liveLocalCatalog = {
    tabId: normalizedTabId,
    taskCatalog: catalog,
    directoryProof: taskCatalog.directoryProof || null,
    updatedAt: checkedAt,
    fullCatalogAt: checkedAt,
    fullProgressAt: checkedAt,
    progressMeta,
    rounds: liveLocalCatalog.tabId === normalizedTabId ? number(liveLocalCatalog.rounds) + 1 : 1,
  };
  return liveLocalCatalog;
}

function seedLiveLocalCatalog(tabId, state) {
  const normalizedTabId = number(tabId);
  if (liveLocalCatalog.tabId === normalizedTabId && liveLocalCatalog.fullCatalogAt > 0) return liveLocalCatalog;
  const checkedAt = number(state && state.localTaskCatalogUpdatedAt);
  if (!checkedAt) return liveLocalCatalog;
  const catalog = normalizeCandidateTasks(state && state.localTaskCatalog);
  liveLocalCatalog = {
    tabId: normalizedTabId,
    taskCatalog: catalog,
    directoryProof: state.localDirectoryProof || null,
    updatedAt: checkedAt,
    fullCatalogAt: checkedAt,
    fullProgressAt: checkedAt,
    progressMeta: new Map(catalog.map((task) => [task.taskId, {checkedAt, intervalMs: 0}])),
    rounds: number(state && state.localScanRounds),
  };
  return liveLocalCatalog;
}

async function refreshLiveLocalCatalog(tabId, state, forceFull = false) {
  if (localCatalogRefreshPromise) return localCatalogRefreshPromise;
  localCatalogRefreshPromise = (async () => {
    const normalizedTabId = number(tabId);
    if (cPolicyDelegated() && cPolicyCoreSettings()?.preSubmitEnabled === false) {
      const catalog = await readPacedTaskCatalog(tabId, state.settings);
      return cacheFullLocalCatalog(tabId, catalog, Date.now());
    }
    seedLiveLocalCatalog(normalizedTabId, state);
    const current = Date.now();
    const timing = localCatalogTiming(state);
    const existing = liveLocalCatalog.tabId === normalizedTabId ? liveLocalCatalog : {
      tabId: normalizedTabId,
      taskCatalog: [],
      updatedAt: 0,
      fullCatalogAt: 0,
      fullProgressAt: 0,
      progressMeta: new Map(),
      rounds: 0,
    };
    if (forceFull || !existing.fullCatalogAt || current - existing.fullCatalogAt >= timing.fullCatalogMs) {
      const catalog = await readLocalTaskCatalog(normalizedTabId, state && state.settings);
      return cacheFullLocalCatalog(normalizedTabId, catalog, Date.now());
    }

    const catalog = normalizeCandidateTasks(existing.taskCatalog);
    const progressMeta = existing.progressMeta instanceof Map ? new Map(existing.progressMeta) : new Map();
    const fullProgress = !existing.fullProgressAt || current - existing.fullProgressAt >= timing.fullProgressMs;
    const due = catalog.filter((task) => {
      const meta = progressMeta.get(task.taskId) || {checkedAt: 0, intervalMs: 0};
      return fullProgress || !meta.checkedAt || current - meta.checkedAt >= number(meta.intervalMs);
    });
    let nextCatalog = catalog;
    if (due.length) {
      const refreshed = await readLocalTaskProgress(normalizedTabId, due);
      const refreshedById = new Map(refreshed.map((task) => [task.taskId, task]));
      nextCatalog = catalog.map((task) => refreshedById.get(task.taskId) || task);
      const checkedAt = Date.now();
      for (const task of due) {
        const next = refreshedById.get(task.taskId) || task;
        const changed = number(next.left) !== number(task.left);
        progressMeta.set(task.taskId, {
          checkedAt,
          intervalMs: changed || number(next.left) > 0 ? 0 : timing.coldProgressMs,
        });
      }
    }
    liveLocalCatalog = {
      tabId: normalizedTabId,
      taskCatalog: nextCatalog,
      directoryProof: existing.directoryProof,
      updatedAt: Date.now(),
      fullCatalogAt: existing.fullCatalogAt,
      fullProgressAt: fullProgress ? Date.now() : existing.fullProgressAt,
      progressMeta,
      rounds: number(existing.rounds) + 1,
    };
    return liveLocalCatalog;
  })();
  try {
    return await localCatalogRefreshPromise;
  } finally {
    localCatalogRefreshPromise = null;
  }
}

function taskCatalogFingerprint(value) {
  return JSON.stringify(normalizeCandidateTasks(value).map((task) => [task.taskId, task.name, number(task.left)]));
}

function liveCatalogForTab(tabId) {
  return liveLocalCatalog.tabId === number(tabId) && liveLocalCatalog.updatedAt > 0 ? liveLocalCatalog : null;
}

function applyLiveCatalog(state, tabId) {
  const live = liveCatalogForTab(tabId);
  if (!live) return false;
  const previous = taskCatalogFingerprint(state.localTaskCatalog);
  state.localTaskCatalog = normalizeCandidateTasks(live.taskCatalog);
  state.localTaskCatalogUpdatedAt = live.updatedAt;
  applyDirectoryProof(state, live.directoryProof);
  state.localScanRounds = Math.max(number(state.localScanRounds), number(live.rounds));
  return previous !== taskCatalogFingerprint(state.localTaskCatalog);
}

function stopLocalCatalogLoop(tabId = 0) {
  const normalizedTabId = number(tabId);
  if (normalizedTabId && localCatalogTabId !== normalizedTabId) return;
  localCatalogGeneration += 1;
  localCatalogTabId = 0;
  wakeControlLoop();
}

async function localCatalogLoop(generation, tabId) {
  let state = await loadState();
  let settings = state.settings;
  let settingsReadAt = Date.now();
  let rounds = Math.max(
    number(state.localScanRounds),
    liveLocalCatalog.tabId === tabId ? number(liveLocalCatalog.rounds) : 0,
  );
  let lastStatusPushAt = 0;
  while (generation === localCatalogGeneration && localCatalogTabId === tabId) {
    const startedAt = Date.now();
    const ordinaryOnly = cPolicyDelegated() && cPolicyCoreSettings()?.preSubmitEnabled === false;
    try {
      if (startedAt - settingsReadAt >= 1000) {
        state = await loadState();
        settings = state.settings;
        settingsReadAt = startedAt;
      }
      const previousFingerprint = liveLocalCatalog.tabId === tabId
        ? taskCatalogFingerprint(liveLocalCatalog.taskCatalog)
        : "";
      const refreshed = await refreshLiveLocalCatalog(tabId, {...state, settings});
      const taskCatalog = normalizeCandidateTasks(refreshed.taskCatalog);
      const nextFingerprint = taskCatalogFingerprint(taskCatalog);
      const changed = previousFingerprint !== nextFingerprint;
      rounds = Math.max(rounds, number(refreshed.rounds));
      liveLocalCatalog.rounds = rounds;
      if (changed) wakeControlLoop();
      if (changed || Date.now() - lastStatusPushAt >= 1000) {
        lastStatusPushAt = Date.now();
        chrome.tabs.sendMessage(tabId, {
          scope: "xiaotian-v24",
          type: "catalog-update",
          taskCatalog,
          availableTasks: taskCatalog.filter((task) => task.left > 0).length,
          localScanRounds: rounds,
          catalogClaimIncrease: await catalogClaimIncrease(state, await loadSession(), taskCatalog),
          refreshMs: ordinaryOnly ? ordinaryPacing.refreshMs : localTaskRefreshMs(),
        }).catch(() => {});
      }
    } catch (error) {
      if (Date.now() - lastStatusPushAt >= 1000) {
        lastStatusPushAt = Date.now();
        chrome.tabs.sendMessage(tabId, {
          scope: "xiaotian-v24",
          type: "catalog-update",
          taskCatalog: liveLocalCatalog.tabId === tabId ? liveLocalCatalog.taskCatalog : [],
          availableTasks: liveLocalCatalog.tabId === tabId
            ? liveLocalCatalog.taskCatalog.filter((task) => task.left > 0).length
            : 0,
          localScanRounds: rounds,
          refreshMs: ordinaryOnly ? ordinaryPacing.refreshMs : localTaskRefreshMs(),
          error: String(error && error.message || error).slice(0, 300),
        }).catch(() => {});
      }
    }
    await relayDelay(ordinaryOnly ? Math.min(1000, Math.max(1, ordinaryPacing.refreshNextAt - Date.now()))
      : Math.max(1, localTaskRefreshMs() - (Date.now() - startedAt)));
  }
}

function startLocalCatalogLoop(tabId) {
  const normalizedTabId = number(tabId);
  if (!normalizedTabId || localCatalogTabId === normalizedTabId) return;
  const generation = ++localCatalogGeneration;
  localCatalogTabId = normalizedTabId;
  localCatalogLoop(generation, normalizedTabId).catch(() => {
    if (generation === localCatalogGeneration && localCatalogTabId === normalizedTabId) localCatalogTabId = 0;
  });
}

function shouldRunLocalCatalogLoop(tabId, state, session) {
  const normalizedTabId = number(tabId);
  if (!normalizedTabId || !session || session.running !== true || number(session.tabId) !== normalizedTabId) return false;
  const workingPackages = number(state && state.localWorkingPackages);
  const settings = normalizeSettings(state && state.settings, state && state.runtimePolicy);
  if (!cPolicyDelegated() || workingPackages >= settings.targetPackages) return false;
  const mode = claimModeForWorkingPackages(workingPackages, state && state.runtimePolicy);
  if (mode !== "normal" && mode !== "pre-submit") return false;
  return !(state && state.autoPausedAtTarget === true
    && workingPackages > resumeThresholdForSettings(settings, state && state.runtimePolicy));
}

function syncLocalCatalogLoop(tabId, state, session) {
  if (shouldRunLocalCatalogLoop(tabId, state, session)) startLocalCatalogLoop(tabId);
  else stopLocalCatalogLoop(tabId);
}

async function readLocalSnapshot(tabId, settings, manual = false) {
  const [taskCatalog, workingRows] = await Promise.all([
    cPolicyDelegated() && (manual || cPolicyCoreSettings()?.preSubmitEnabled === false)
      ? readPacedTaskCatalog(tabId, settings) : readLocalTaskCatalog(tabId, settings),
    readLocalWorkingRows(tabId),
  ]);
  cacheFullLocalCatalog(tabId, taskCatalog);
  return {taskCatalog, workingRows, workingPackages: workingPackageCount(workingRows)};
}

async function enforceSnapshotReleasePolicy(tabId, snapshot, runtimePolicy = {}) {
  const release = await applyLocalReleasePolicy(tabId, snapshot && snapshot.workingRows, runtimePolicy);
  return {
    ...(snapshot || {}),
    workingRows: release.rows,
    workingPackages: workingPackageCount(release.rows),
    release,
  };
}

function releaseFailureMessage(snapshot) {
  const failed = snapshot && snapshot.release && Array.isArray(snapshot.release.failed) ? snapshot.release.failed : [];
  return failed.length ? `有${failed.length}个超时或超量工作包释放失败：${failed[0].error}` : "";
}

function releaseSuccessMessage(snapshot) {
  const released = snapshot && snapshot.release && Array.isArray(snapshot.release.released) ? snapshot.release.released : [];
  if (!released.length) return "";
  const packageTotal = released.reduce((sum, item) => sum + Math.max(1, number(item && item.packageCount) || 1), 0);
  const expired = released
    .filter((item) => String(item.reason || "").startsWith("超时"))
    .reduce((sum, item) => sum + Math.max(1, number(item && item.packageCount) || 1), 0);
  const overflow = packageTotal - expired;
  return `本地已释放${packageTotal}包（超时${expired}、超量${overflow}）`;
}

function syncSnapshotWorkload(state, snapshot) {
  const released = snapshot && snapshot.release && Array.isArray(snapshot.release.released) ? snapshot.release.released : [];
  for (const item of released) markWorkloadReleased(state, item.subTaskId);
  syncWorkload(state, snapshot && snapshot.workingRows);
}

async function findAcceptanceTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://www.skyvendorise.com/skyvendor/dashboard/annotation/acceptance*"],
  });
  const usable = Array.from(tabs || []).filter((tab) => number(tab && tab.id) && tab.discarded !== true);
  return usable.find((tab) => tab.active === true) || usable[0] || null;
}

async function acceptanceTabById(tabId) {
  const normalizedTabId = number(tabId);
  if (!normalizedTabId) return null;
  try {
    const tab = await chrome.tabs.get(normalizedTabId);
    const url = String(tab && tab.url || "");
    if (tab && tab.discarded !== true && isAcceptancePageUrl(url)) return tab;
  } catch (error) {}
  return null;
}

function isAcceptancePageUrl(value) {
  return /^https:\/\/www\.skyvendorise\.com\/skyvendor\/dashboard\/annotation\/acceptance(?:[/?#]|$)/.test(String(value || ""));
}

function isSkyVendorPageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.hostname === "www.skyvendorise.com";
  } catch (error) {
    return false;
  }
}

async function runIndependentReleaseWatchdog() {
  const session = await loadSession();
  const sessionTabId = session.running ? number(session.tabId) : 0;
  const tab = await acceptanceTabById(sessionTabId) || await findAcceptanceTab();
  const tabId = number(tab && tab.id);
  if (!tabId) return false;
  const state = await loadState();
  try {
    const release = await applyLocalReleasePolicy(
      tabId,
      await readLocalWorkingRows(tabId),
      state.runtimePolicy,
      {allowTurboTimeout: true},
    );
    flushLocalReadStats(state);
    state.localWorkingRows = release.rows.slice(0, 100);
    state.localWorkingPackages = workingPackageCount(release.rows);
    for (const item of release.released) markWorkloadReleased(state, item.subTaskId);
    syncWorkload(state, release.rows);
    const releasedMessage = releaseSuccessMessage({release});
    const releaseError = releaseFailureMessage({release});
    if (releaseError) state.lastError = `后台释放检查失败：${releaseError}`;
    else if (/^后台释放检查失败：/.test(String(state.lastError || ""))) state.lastError = "";
    if (releasedMessage) {
      state.lastWorker = {
        ...(state.lastWorker || {}),
        workingPackages: workingPackageCount(release.rows),
        phaseLabel: session.running ? releasedMessage : `${releasedMessage}；自动领取未启动`,
        lastUpdatedAt: Date.now(),
      };
    }
    await saveState(state);
    if (release.released.length) await refreshAcceptanceTable(tabId);
    await pushStatusUpdate(tabId, state, session);
    return release.released.length > 0;
  } catch (error) {
    if (isTransientFrameError(error)) return false;
    state.lastError = `后台释放检查失败：${String(error && error.message || error)}`;
    await saveState(state);
    await pushStatusUpdate(tabId, state, session);
    return false;
  }
}

function applyLocalSnapshot(state, snapshot, idleLabel = "") {
  flushLocalReadStats(state);
  const taskCatalog = normalizeCandidateTasks(snapshot && snapshot.taskCatalog);
  const workingPackages = number(snapshot && snapshot.workingPackages);
  const previous = state.lastWorker && typeof state.lastWorker === "object" ? state.lastWorker : {};
  state.localTaskCatalog = taskCatalog;
  state.localTaskCatalogUpdatedAt = Date.now();
  applyDirectoryProof(state, snapshot?.taskCatalog?.directoryProof);
  state.localWorkingRows = Array.from(snapshot && snapshot.workingRows || []).slice(0, 100);
  state.localWorkingPackages = workingPackages;
  state.localScanRounds = number(state.localScanRounds) + 1;
  state.lastWorker = {
    ...previous,
    taskCatalog,
    availableTasks: taskCatalog.filter((task) => task.left > 0).length,
    workingPackages,
    rounds: state.localScanRounds,
    phaseLabel: previous.running === true ? previous.phaseLabel : idleLabel || `本地已读取${taskCatalog.length}个任务`,
    lastUpdatedAt: Date.now(),
  };
  return state;
}

async function syncServerStatus(stopWhenFull = true) {
  const state = await loadState();
  flushLocalReadStats(state);
  state.reportSequence = number(state.reportSequence) + 1;
  const workingPackages = number(state.localWorkingPackages);
  const response = await postJson("v24Poll", {
    workingPackages,
    telemetry: {
      requestTotal: number(state.localRequestTotal),
      claimedPackagesTotal: 0,
      intervalSumMs: number(state.localIntervalSumMs),
      intervalSamples: number(state.localIntervalSamples),
      reportSequence: state.reportSequence,
    },
  }, state.installToken);
  state.lastWorker = response.worker || state.lastWorker;
  state.lastError = String(state.lastWorker && state.lastWorker.lastError || "");
  if (stopWhenFull && workingPackages >= state.settings.targetPackages) {
    const stopped = await postJson("v24Stop", {reason: `本地确认已有${workingPackages}包，达到上限`}, state.installToken);
    state.lastWorker = stopped.worker || state.lastWorker;
    await saveSession({running: false, tabId: 0});
    stopControlLoop();
    stopRelayLoops();
  }
  await saveState(state);
  return {state, stopped: stopWhenFull && workingPackages >= state.settings.targetPackages};
}

async function refreshLocalCatalog(message, sender) {
  const tabId = number(sender.tab && sender.tab.id);
  if (!tabId) throw new Error("无法确认当前SkyVendor页面");
  const state = await loadState();
  state.settings = normalizeSettings(message.settings || state.settings, state.runtimePolicy);
  const snapshot = await enforceSnapshotReleasePolicy(tabId, await readLocalSnapshot(tabId, state.settings, true), state.runtimePolicy);
  applyLocalSnapshot(state, snapshot, releaseSuccessMessage(snapshot) || "本地完整任务目录已刷新");
  syncSnapshotWorkload(state, snapshot);
  state.lastError = releaseFailureMessage(snapshot);
  await saveState(state);
  return {...await publicStatus(state), ok: !state.lastError};
}

async function relayLoop(generation, tabId) {
  try {
    while (generation === relayGeneration && relayTabId === tabId) {
      const session = await loadSession();
      const state = await loadState();
      if (!session.running || session.tabId !== tabId || !state.installToken) return;
      try {
        const polled = await postJson("v24RelayPoll", {
          limit: Math.max(1, number(CONFIG.RELAY_BATCH_SIZE) || 1),
        }, state.installToken);
        if (polled.worker) await saveRelayWorker(polled.worker);
        if (generation !== relayGeneration || relayTabId !== tabId) return;
        if (polled.running === false) {
          await saveSession({running: false, tabId: 0});
          return;
        }
        const commands = Array.isArray(polled.commands) && polled.commands.length
          ? polled.commands
          : polled.command ? [polled.command] : [];
        if (!commands.length) continue;
        const results = await Promise.all(commands.map((command) => executeRelayCommand(tabId, command)));
        const reported = await postJson("v24RelayResult", {results}, state.installToken);
        if (reported.worker) await saveRelayWorker(reported.worker);
      } catch (error) {
        if (generation !== relayGeneration || relayTabId !== tabId) return;
        await relayDelay(CONFIG.RELAY_RETRY_MS);
      }
    }
  } finally {
    if (generation === relayGeneration && relayTabId === tabId) {
      relayLoopCount = Math.max(0, relayLoopCount - 1);
      if (!relayLoopCount) relayTabId = 0;
    }
  }
}

function startRelayLoops(tabId) {
  if (platformTransportMode() !== "browser-relay") return;
  const normalizedTabId = number(tabId);
  if (!normalizedTabId || relayTabId === normalizedTabId && relayLoopCount > 0) return;
  const generation = ++relayGeneration;
  relayTabId = normalizedTabId;
  relayLoopCount = Math.max(1, number(CONFIG.RELAY_WORKERS) || 1);
  for (let index = 0; index < relayLoopCount; index += 1) relayLoop(generation, normalizedTabId).catch(() => {});
}

async function autonomousStartPayload(state, tabId) {
  return {
    scriptBuild: await XiaotianClaimAudit.build().catch(() => null),
    ...await serverTransportPayload(tabId),
    ...serverTaskSelection(state),
    autonomous: true,
    settings: serverPackageSettings(state),
    selectedTasks: selectedServerTasks(state),
    workingPackages: number(state && state.localWorkingPackages),
  };
}

async function startAutonomousCore(state, tabId, phaseLabel = "") {
  if (executionMode() !== "autonomous") {
    throw new Error("当前已切换为应急手动接口，请使用手动领取；自主核心不会同时启动");
  }
  const response = await postJson("v24Start", await autonomousStartPayload(state, tabId), state.installToken);
  state.lastWorker = response.worker || null;
  state.autoPausedAtTarget = false;
  state.serverStopPending = false;
  state.lastServerTaskSignature = serverTaskSignature(state);
  state.lastError = "";
  if (phaseLabel && state.lastWorker) state.lastWorker.phaseLabel = phaseLabel;
  await saveSession({running: true, tabId});
  await saveState(state);
  syncLocalCatalogLoop(tabId, state, {running: true, tabId});
  startRelayLoops(tabId);
  return state;
}

async function confirmDelegatedResume(state, tabId) {
  try {
    const response = await postJson("v24Start", await autonomousStartPayload(state, tabId), state.installToken);
    const latest = await loadState();
    latest.lastWorker = response.worker || latest.lastWorker;
    latest.lastError = "";
    latest.serverStopPending = false;
    await saveState(latest);
    await pushStatusUpdate(tabId, latest, {running: true, tabId});
  } catch (error) {
    const latest = await loadState();
    latest.lastError = String(error && error.message || error);
    await saveState(latest);
    await pushStatusUpdate(tabId, latest, {running: true, tabId});
  }
}

async function pauseAutonomousCore(state, tabId, reason) {
  stopLocalCatalogLoop(tabId);
  stopRelayLoops();
  let stopError = "";
  try {
    const stopped = await postJson("v24Stop", {reason}, state.installToken);
    state.lastWorker = stopped.worker || state.lastWorker;
  } catch (error) {
    stopError = String(error && error.message || error);
  }
  state.autoPausedAtTarget = true;
  state.serverStopPending = !!stopError;
  state.lastServerTaskSignature = "";
  cModuleSessionNonce = "";
  state.lastWorker = {
    ...(state.lastWorker || {}),
    running: false,
    phase: "target-paused",
    phaseLabel: stopError
      ? `${reason}；本地转发已关闭，停止信号将在后台重试`
      : `${reason}；本地继续监控，降到${resumeThresholdForSettings(state.settings, state.runtimePolicy)}包后按服务器边界重新判断`,
    workingPackages: number(state.localWorkingPackages),
    lastUpdatedAt: Date.now(),
  };
  state.lastError = stopError;
  await saveSession({running: true, tabId});
  await saveState(state);
  return state;
}

async function refreshControlTaskCatalog(tabId, state, force = false) {
  const previousSignature = serverTaskSignature(state);
  if (cPolicyDelegated() && cPolicyCoreSettings()?.preSubmitEnabled === false) {
    const catalog = await readPacedTaskCatalog(tabId, state.settings);
    cacheFullLocalCatalog(tabId, catalog);
    applyLiveCatalog(state, tabId);
    return previousSignature !== serverTaskSignature(state);
  }
  const mode = claimModeForWorkingPackages(state.localWorkingPackages, state.runtimePolicy);
  const ordinaryRefreshMs = mode === "normal" ? ordinaryPacingIntervalMs(state) : 0;
  const live = liveCatalogForTab(tabId);
  if (live && Date.now() - live.updatedAt <= Math.max(ordinaryRefreshMs || 250, localTaskRefreshMs() * 4)) {
    applyLiveCatalog(state, tabId);
    return previousSignature !== serverTaskSignature(state);
  }
  const activeCheckMs = Math.max(100, number(state.runtimePolicy && state.runtimePolicy.activeWorkingCheckMs) || 100);
  const catalogRefreshMs = Math.max(activeCheckMs, number(state.runtimePolicy && state.runtimePolicy.taskCatalogRefreshMs) || 60000);
  const normalCandidates = selectedServerTasks(state, "normal");
  const refreshAfterMs = mode === "normal" && (normalDispatchMode() === "local-command" || !normalCandidates.length)
    ? ordinaryPacingIntervalMs(state)
    : catalogRefreshMs;
  if (!force && Date.now() - number(state.localTaskCatalogUpdatedAt) < refreshAfterMs) return false;
  const catalog = await readLocalTaskCatalog(tabId, state.settings);
  state.localTaskCatalog = normalizeCandidateTasks(catalog);
  applyDirectoryProof(state, catalog.directoryProof);
  state.localTaskCatalogUpdatedAt = Date.now();
  state.localScanRounds = number(state.localScanRounds) + 1;
  return previousSignature !== serverTaskSignature(state);
}

function localScanInterval(state) {
  return Math.max(100, number(CONFIG.LOCAL_TASK_REFRESH_MS) || 100);
}

function localCompletionCheckInterval(state) {
  // Completion detection must not inherit a slow server tuning value. The
  // server controls claim pacing, while this short local read only watches
  // for a package leaving the work queue so automatic claiming can resume.
  return LOCAL_COMPLETION_CHECK_MS;
}

async function waitForServerClaim(tabId, state, shouldContinue = () => true) {
  const timeoutMs = Math.max(5000, number(state.runtimePolicy && state.runtimePolicy.platformRequestTimeoutMs) + 5000);
  const deadline = Date.now() + timeoutMs;
  while (shouldContinue() && Date.now() < deadline) {
    const session = await loadSession();
    if (!session.running || session.tabId !== tabId) return state;
    const response = await postJson("v24Poll", {
      settings: state.settings,
      workingPackages: number(state.localWorkingPackages),
    }, state.installToken);
    state.lastWorker = response.worker || state.lastWorker;
    if (!state.lastWorker || state.lastWorker.running !== true || state.lastWorker.claimInFlight !== true) return state;
    await relayDelay(50);
  }
  throw new Error("服务器领取响应超时");
}

function claimReceipt(worker) {
  const value = worker && worker.claimReceipt;
  if (!value || typeof value !== "object") return null;
  const id = String(value.id || "").trim().slice(0, 128);
  if (!id) return null;
  return {
    id,
    taskId: String(value.taskId || "").trim().slice(0, 80),
    taskName: String(value.taskName || "").trim().slice(0, 160),
    requestedAmount: Math.max(1, number(value.requestedAmount)),
    confirmed: value.confirmed === true,
    actualAmount: value.confirmed === true ? number(value.actualAmount) : null,
  };
}

async function prepareClaimConfirmation(state, receipt, previousWorking, taskId, taskName) {
  if (!receipt || receipt.confirmed) return state;
  const existing = state.pendingClaimConfirmation;
  if (!existing || String(existing.claimId || "") !== receipt.id) {
    state.pendingClaimConfirmation = {
      claimId: receipt.id,
      taskId: receipt.taskId || String(taskId || "").trim().slice(0, 80),
      taskName: receipt.taskName || String(taskName || "").trim().slice(0, 160),
      previousWorking: number(previousWorking),
      requestedAmount: receipt.requestedAmount,
    };
    recordWorkloadClaim(state, state.pendingClaimConfirmation.taskId, state.pendingClaimConfirmation.taskName);
    await saveState(state);
  }
  return state;
}

async function settleClaimConfirmation(tabId, state, shouldContinue = () => true) {
  const pending = state.pendingClaimConfirmation;
  if (!pending || !pending.claimId) return {state, actualAmount: 0, settled: false};
  const workingPackages = await confirmLocalClaim(tabId, state, number(pending.previousWorking), shouldContinue);
  const actualAmount = Math.min(
    Math.max(1, number(pending.requestedAmount)),
    Math.max(0, workingPackages - number(pending.previousWorking)),
  );
  const response = await postJson("v24Confirm", {
    claimId: String(pending.claimId),
    actualAmount,
  }, state.installToken);
  state.lastWorker = response.worker || state.lastWorker;
  if (!actualAmount) discardPendingWorkloadClaim(state, pending.taskId);
  state.pendingClaimConfirmation = null;
  state.lastError = actualAmount ? "" : String(state.lastWorker && state.lastWorker.lastError || "平台响应成功，但本地没有新增工作包");
  await saveState(state);
  return {state, actualAmount, settled: true};
}

async function confirmLocalClaim(tabId, state, previousWorking, shouldContinue = () => true) {
  const graceMs = Math.max(300, number(state.runtimePolicy && state.runtimePolicy.successAppearGraceMs) || 3000);
  const deadline = Date.now() + graceMs;
  let workingPackages = number(state.localWorkingPackages);
  while (shouldContinue() && Date.now() < deadline) {
    const release = await applyLocalReleasePolicy(tabId, await readLocalWorkingRows(tabId), state.runtimePolicy);
    workingPackages = workingPackageCount(release.rows);
    flushLocalReadStats(state);
    state.localWorkingRows = release.rows.slice(0, 100);
    state.localWorkingPackages = workingPackages;
    for (const item of release.released) markWorkloadReleased(state, item.subTaskId);
    syncWorkload(state, release.rows);
    if (release.released.length) state.lastWorker = {...(state.lastWorker || {}), phaseLabel: releaseSuccessMessage({release})};
    if (release.failed.length) throw new Error(releaseFailureMessage({release}));
    if (workingPackages > previousWorking || workingPackages >= state.settings.targetPackages) break;
    await relayDelay(localScanInterval(state));
  }
  return workingPackages;
}

async function confirmLocalManualClaim(tabId, state, previousRows, requestedAmount, expectedTaskId = "", auditMode = "manual") {
  const previousIds = new Set(Array.from(previousRows || [])
    .map((row) => String(row && row.id || "").trim())
    .filter(Boolean));
  const expectedAmount = Math.max(1, number(requestedAmount));
  // Ordinary/manual reads use 100 times the server interval. Keep a short
  // foreground confirmation window; durable receipts cover later observations.
  const graceMs = Math.max(auditMode === "normal" || auditMode === "manual" ? 5000 : 300,
    number(state.runtimePolicy && state.runtimePolicy.successAppearGraceMs) || 3000);
  const deadline = Date.now() + graceMs;
  const normalizedTaskId = String(expectedTaskId || "").trim();
  let newRows = [];
  let attributableRows = [];
  let actualAmount = 0;
  while (Date.now() < deadline) {
    const observedRows = await readLocalWorkingRows(tabId);
    await XiaotianClaimAudit.capture(state, observedRows.filter(row => !previousIds.has(String(row.id))
      && String(row.taskId) === normalizedTaskId), auditMode, cModuleHash)
      .catch(error => console.warn("领取记录待补报", error.message));
    const release = await applyLocalReleasePolicy(tabId, observedRows, state.runtimePolicy);
    flushLocalReadStats(state);
    state.localWorkingRows = release.rows.slice(0, 100);
    state.localWorkingPackages = workingPackageCount(release.rows);
    for (const item of release.released) markWorkloadReleased(state, item.subTaskId);
    syncWorkload(state, release.rows);
    if (release.failed.length) throw new Error(releaseFailureMessage({release}));
    newRows = release.rows.filter((row) => {
      const id = String(row && row.id || "").trim();
      return id && !previousIds.has(id);
    });
    const rowsWithTaskId = newRows.filter((row) => String(row && row.taskId || "").trim());
    attributableRows = normalizedTaskId && rowsWithTaskId.length
      ? newRows.filter((row) => String(row && row.taskId || "").trim() === normalizedTaskId)
      : newRows;
    actualAmount = Math.min(expectedAmount, workingPackageDelta(release.rows, previousRows, normalizedTaskId));
    if (actualAmount >= expectedAmount) break;
    await relayDelay(Math.max(100, localScanInterval(state)));
  }
  const newSubTaskIds = [...new Set(attributableRows
    .map((row) => String(row && row.id || "").trim())
    .filter(Boolean))];
  return {
    state,
    actualAmount,
    newSubTaskIds,
  };
}

// Observe delayed successful claims through existing working-list reads. This
// creates no extra polling and never treats an unrelated task/old row as a win.
const pendingLocalClaimReceipts = new Map();
const pendingLocalClaimObservations = new Map();
let lateLocalClaimJob = null;
const LOCAL_CLAIM_RECEIPTS_KEY = `${CONFIG.STATE_KEY}PendingClaimReceiptsV1`;
let localClaimReceiptsLoaded = null;
let localClaimReceiptWrites = Promise.resolve();

function loadLocalClaimReceipts() {
  if (!localClaimReceiptsLoaded) localClaimReceiptsLoaded = (async () => {
    const saved = (await chrome.storage.local.get(LOCAL_CLAIM_RECEIPTS_KEY))[LOCAL_CLAIM_RECEIPTS_KEY];
    for (const receipt of Array.isArray(saved) ? saved : []) {
      if (!receipt?.id || !receipt.installId || !receipt.userName || !receipt.taskId
        || (receipt.expiresAt <= Date.now() && !receipt.observedRows?.length)) continue;
      pendingLocalClaimReceipts.set(receipt.id, {...receipt, baselineIds: new Set(receipt.baselineIds || [])});
    }
  })().catch(error => {localClaimReceiptsLoaded = null; throw error;});
  return localClaimReceiptsLoaded;
}

function persistLocalClaimReceipts() {
  const job = localClaimReceiptWrites.catch(() => {}).then(() => chrome.storage.local.set({
    [LOCAL_CLAIM_RECEIPTS_KEY]: [...pendingLocalClaimReceipts.values()].map(receipt => ({
      ...receipt, baselineIds: [...receipt.baselineIds],
    })),
  }));
  localClaimReceiptWrites = job;
  return job;
}

async function beginLocalClaimReceipt(tabId, state, previousRows, expectedAmount, taskId, mode) {
  await loadLocalClaimReceipts();
  for (const [key, receipt] of pendingLocalClaimReceipts) {
    if (receipt.expiresAt <= Date.now() && !receipt.observedRows?.length) pendingLocalClaimReceipts.delete(key);
  }
  const scriptBuild = await XiaotianClaimAudit.build();
  const id = crypto.randomUUID();
  pendingLocalClaimReceipts.set(id, {
    id, installId: state.installId, userName: state.userName, tabId, taskId, mode,
    taskName: state.lastWorker?.currentTaskName || taskId,
    baselineIds: new Set(previousRows.map(row => String(row.id))), expectedAmount,
    moduleHash: cModuleHash, scriptBuild, requestedAt: Date.now(),
    observeUntil: Date.now() + Math.max(120000,
      number(state.runtimePolicy?.platformRequestTimeoutMs) + number(state.runtimePolicy?.successAppearGraceMs) + 5000),
    expiresAt: Date.now() + 30 * 60 * 1000, observedRows: [],
  });
  // Do not send a claim unless its recovery record has been saved.
  await persistLocalClaimReceipts();
  return id;
}

async function cancelLocalClaimReceipt(id) {
  pendingLocalClaimReceipts.delete(id);
  await persistLocalClaimReceipts();
}

function localClaimReceiptMatchesRow(receipt, row) {
  if (!row?.id || String(row.taskId) !== receipt.taskId || receipt.baselineIds.has(String(row.id))) return false;
  const firstSeenAt = number(row.localObservedAt);
  if (firstSeenAt && firstSeenAt < receipt.requestedAt - 2000) return false;
  const claimedAt = typeof releaseClaimedAt === "function" ? releaseClaimedAt(row) : NaN;
  const evidenceAt = Number.isFinite(claimedAt) && claimedAt > 0 ? claimedAt : firstSeenAt || Date.now();
  // A stale request cannot absorb an unrelated later batch from the same flow.
  // Two seconds allow the platform UI's whole-second timestamp rounding.
  return evidenceAt >= receipt.requestedAt - 2000
    && evidenceAt <= (receipt.observeUntil || receipt.requestedAt + 120000);
}

async function rememberLocalClaimObservation(tabId, rows) {
  await loadLocalClaimReceipts();
  if (!pendingLocalClaimReceipts.size) return;
  const state = await loadState();
  let changed = false;
  for (const receipt of pendingLocalClaimReceipts.values()) {
    if ((receipt.expiresAt <= Date.now() && !receipt.observedRows?.length)
      || receipt.installId !== state.installId || receipt.userName !== state.userName) continue;
    const observed = new Map((receipt.observedRows || []).map(row => [String(row.id), row]));
    for (const row of rows) {
      if (!localClaimReceiptMatchesRow(receipt, row)) continue;
      if (observed.has(String(row.id))) continue;
      // Persist only reporting/confirmation metadata, never question contents.
      observed.set(String(row.id), {id: String(row.id), taskId: receipt.taskId,
        taskName: row.taskName || receipt.taskName, gmtCreate: row.gmtCreate,
        localClaimTime: row.localClaimTime, localObservedAt: row.localObservedAt || Date.now(),
        summaryPackageCount: row.summaryPackageCount});
      changed = true;
    }
    if (observed.size && receipt.tabId !== tabId) {receipt.tabId = tabId; changed = true;}
    receipt.observedRows = [...observed.values()];
  }
  if (changed) await persistLocalClaimReceipts();
}

function queueLateLocalClaimConfirmation(tabId, rows) {
  for (const [key, receipt] of pendingLocalClaimReceipts) {
    if (receipt.expiresAt <= Date.now() && !receipt.observedRows?.length) pendingLocalClaimReceipts.delete(key);
  }
  if (![...pendingLocalClaimReceipts.values()].some(receipt => receipt.tabId === tabId)) return;
  const observed = new Map((pendingLocalClaimObservations.get(tabId) || []).map(row => [String(row.id), row]));
  for (const row of rows) observed.set(String(row.id), row);
  pendingLocalClaimObservations.set(tabId, [...observed.values()]);
  if (lateLocalClaimJob) return;
  // The claim operation may still be confirming. Reconcile after its state
  // write so the same task cannot increment the count twice.
  lateLocalClaimJob = enqueue(async () => {
    while (pendingLocalClaimObservations.size) {
      const observations = [...pendingLocalClaimObservations];
      pendingLocalClaimObservations.clear();
      for (const [observedTabId, observedRows] of observations) {
        const state = await loadState();
        let added = 0;
        for (const [key, receipt] of pendingLocalClaimReceipts) {
          if (receipt.tabId !== observedTabId) continue;
          if ((receipt.expiresAt <= Date.now() && !receipt.observedRows?.length)
            || receipt.installId !== state.installId || receipt.userName !== state.userName) {
            pendingLocalClaimReceipts.delete(key);
            continue;
          }
          const matchedById = new Map((receipt.observedRows || []).map(row => [String(row.id), row]));
          const matched = [...matchedById.values()];
          if (!matched.length) continue;
          // Capture even when the synchronous path already counted the row:
          // this also retries a previous local outbox/hash failure.
          let reported = true;
          await XiaotianClaimAudit.capture(state, matched, receipt.mode, receipt.moduleHash, receipt.scriptBuild)
            .catch(error => { reported = false; console.warn("延迟领取记录待补报", error.message); });
          const known = new Set(state.localClaimedSubTaskIds || []);
          const unseen = matched.filter(row => !known.has(String(row.id)));
          if (unseen.length) added += recordConfirmedLocalPackages(state, unseen.map(row => row.id), workingPackageCount(unseen));
          if (reported && workingPackageCount(matched) >= receipt.expectedAmount) pendingLocalClaimReceipts.delete(key);
        }
        if (added) {
          await saveState(state);
          await pushStatusUpdate(observedTabId, state, await loadSession());
        }
        await persistLocalClaimReceipts();
      }
    }
  }).catch(error => console.warn("延迟领取确认待重试", error.message))
    .finally(() => { lateLocalClaimJob = null; });
}

function recordConfirmedLocalPackages(state, subTaskIds, packageCount = 0) {
  const known = new Set(Array.isArray(state.localClaimedSubTaskIds) ? state.localClaimedSubTaskIds : []);
  let added = 0;
  for (const value of Array.isArray(subTaskIds) ? subTaskIds : []) {
    const subTaskId = String(value || "").trim().slice(0, 120);
    if (!subTaskId || known.has(subTaskId)) continue;
    known.add(subTaskId);
    added += 1;
  }
  state.localClaimedSubTaskIds = Array.from(known).slice(-2000);
  if (!added) return 0;
  const increment = number(packageCount) || added;
  state.localClaimedPackagesTotal = number(state.localClaimedPackagesTotal) + increment;
  return increment;
}

async function dispatchNormalClaimFromLocal(tabId, state, shouldContinue = () => true) {
  if (normalDispatchMode() !== "local-command" || claimModeForWorkingPackages(state.localWorkingPackages, state.runtimePolicy) !== "normal") {
    return {state, attempted: false, actualAmount: 0};
  }
  if (state.pendingClaimConfirmation && state.pendingClaimConfirmation.claimId) {
    const confirmation = await settleClaimConfirmation(tabId, state, shouldContinue);
    return {state: confirmation.state, attempted: true, actualAmount: confirmation.actualAmount};
  }
  if (state.lastWorker && state.lastWorker.claimInFlight === true) {
    state = await waitForServerClaim(tabId, state, shouldContinue);
    return {state, attempted: true, actualAmount: 0};
  }
  const candidates = selectedServerTasks(state, "normal");
  if (!candidates.length) return {state, attempted: false, actualAmount: 0};
  const task = candidates[localTaskCursor % candidates.length];
  localTaskCursor = (localTaskCursor + 1) % Math.max(1, candidates.length);
  const previousWorking = number(state.localWorkingPackages);
  const amount = Math.max(1, Math.min(
    state.settings.claimAmount,
    Math.max(1, state.settings.targetPackages - previousWorking),
  ));
  const receiptBefore = claimReceipt(state.lastWorker);
  const response = await postJson("v24Claim", {
    ...serverTaskSelection(state),
    taskId: task.taskId,
    taskName: task.name || task.taskId,
    amount,
    settings: serverPackageSettings(state),
    workingPackages: previousWorking,
  }, state.installToken);
  state.lastWorker = response.worker || state.lastWorker;
  state.lastError = "";
  await saveState(state);
  if (response.accepted === true || response.busy === true || state.lastWorker && state.lastWorker.claimInFlight === true) {
    state = await waitForServerClaim(tabId, state, shouldContinue);
  }
  const receiptAfter = claimReceipt(state.lastWorker);
  if (receiptAfter && !receiptAfter.confirmed && (!receiptBefore || receiptAfter.id !== receiptBefore.id)) {
    state = await prepareClaimConfirmation(state, receiptAfter, previousWorking, task.taskId, task.name);
    const confirmation = await settleClaimConfirmation(tabId, state, shouldContinue);
    state = confirmation.state;
    if (confirmation.actualAmount > 0) {
      state.lastWorker = {
        ...(state.lastWorker || {}),
        phase: "claimed",
        phaseLabel: `本地确认${task.name || task.taskId}新增${confirmation.actualAmount}包`,
        workingPackages: number(state.localWorkingPackages),
        lastUpdatedAt: Date.now(),
      };
      await saveState(state);
    }
    return {state, attempted: true, actualAmount: confirmation.actualAmount};
  }
  state.lastError = String(state.lastWorker && state.lastWorker.lastError || "服务器未返回新的领取结果");
  await saveState(state);
  return {state, attempted: true, actualAmount: 0};
}

async function localControlLoop(generation, tabId) {
  try {
    while (generation === controlGeneration && controlTabId === tabId) {
      const session = await loadSession();
      if (!session.running || session.tabId !== tabId) return;
      let state = await loadState();
      if (!state.installToken) return;
      try {
        const previousRows = Array.isArray(state.localWorkingRows) ? state.localWorkingRows : [];
        const previousWorkingPackages = number(state.localWorkingPackages);
        const previousMode = claimModeForWorkingPackages(previousWorkingPackages, state.runtimePolicy);
        const previousIds = new Set(previousRows.map((row) => String(row && row.id || "")).filter(Boolean));
        const release = await applyLocalReleasePolicy(tabId, await readLocalWorkingRows(tabId), state.runtimePolicy);
        flushLocalReadStats(state);
        state.localWorkingRows = release.rows.slice(0, 100);
        state.localWorkingPackages = workingPackageCount(release.rows);
        for (const item of release.released) markWorkloadReleased(state, item.subTaskId);
        syncWorkload(state, release.rows);
        const newRows = release.rows.filter((row) => !previousIds.has(String(row && row.id || "")));
        const currentIds = new Set(release.rows.map((row) => String(row && row.id || "")).filter(Boolean));
        const completedRows = previousRows.filter((row) => {
          const id = String(row && row.id || "").trim();
          return id && !currentIds.has(id);
        });
        const workingChanged = currentIds.size !== previousIds.size
          || [...currentIds].some((id) => !previousIds.has(id))
          || previousWorkingPackages !== state.localWorkingPackages;
        const currentMode = claimModeForWorkingPackages(state.localWorkingPackages, state.runtimePolicy);
        const modeChanged = currentMode !== previousMode;
        syncLocalCatalogLoop(tabId, state, {running: true, tabId});
        const catalogChanged = await refreshControlTaskCatalog(tabId, state, workingChanged || modeChanged);
        const taskSignature = serverTaskSignature(state);
        const zeroConfirmationDue = state.localWorkingPackages === 0
          && state.lastWorker && state.lastWorker.awaitingFirstPackage === true
          && number(state.lastWorker.preSubmitConfirmAfter) > 0
          && Date.now() >= number(state.lastWorker.preSubmitConfirmAfter);
        const releasedMessage = releaseSuccessMessage({release});
        const releaseError = releaseFailureMessage({release});
        const targetReached = state.localWorkingPackages >= state.settings.targetPackages;
        const resumeThreshold = resumeThresholdForSettings(state.settings, state.runtimePolicy);
        if (releaseError) {
          state.lastError = releaseError;
          await saveState(state);
          if (targetReached) {
            state = await pauseAutonomousCore(
              state,
              tabId,
              `本地已有${state.localWorkingPackages}包且自动释放失败，服务器领取已暂停`,
            );
          }
          await relayDelay(localCompletionCheckInterval(state));
          continue;
        }
        state.lastError = "";
        if (targetReached) {
          const reason = `本地确认已有${state.localWorkingPackages}包，达到服务器停止包数${state.settings.targetPackages}包`;
          if (!state.autoPausedAtTarget || state.serverStopPending || state.lastWorker && state.lastWorker.running === true) {
            state = await pauseAutonomousCore(state, tabId, reason);
          } else {
            state.lastWorker = {
              ...(state.lastWorker || {}),
              running: false,
              phase: "target-paused",
              phaseLabel: `${reason}；降到${resumeThreshold}包后按服务器边界重新判断`,
              workingPackages: state.localWorkingPackages,
              lastUpdatedAt: Date.now(),
            };
            await saveState(state);
          }
          if (newRows.length || completedRows.length || release.released.length) {
            await refreshAcceptanceTable(tabId);
            await pushStatusUpdate(tabId, state, {running: true, tabId});
          }
          await relayDelay(localCompletionCheckInterval(state));
          continue;
        }
        if (state.autoPausedAtTarget) {
          if (state.localWorkingPackages > resumeThreshold) {
            state.lastWorker = {
              ...(state.lastWorker || {}),
              running: false,
              phase: "target-paused",
              phaseLabel: `服务器领取保持暂停；当前${state.localWorkingPackages}包，降到${resumeThreshold}包后按服务器边界重新判断`,
              workingPackages: state.localWorkingPackages,
              lastUpdatedAt: Date.now(),
            };
            await saveState(state);
            await relayDelay(localCompletionCheckInterval(state));
            continue;
          }
          // The package count has crossed the resume threshold. Publish an
          // explicit recovering state before the server start request so the
          // UI does not remain on the stale target-paused message while that
          // request is in flight.
          state.lastWorker = {
            ...(state.lastWorker || {}),
            running: true,
            phase: "resuming",
            phaseLabel: `已完成任务，正在恢复自动领取（当前${state.localWorkingPackages}包）`,
            workingPackages: state.localWorkingPackages,
            lastUpdatedAt: Date.now(),
          };
          await saveState(state);
          await pushStatusUpdate(tabId, state, {running: true, tabId});
          if (cPolicyDelegated()) {
            // Local delegated mode resumes immediately like 2.2. The server
            // start request is only a background confirmation and must not
            // delay the next local scan.
            state.autoPausedAtTarget = false;
            state.serverStopPending = false;
            state.lastWorker = {
              ...(state.lastWorker || {}),
              running: true,
              phase: "c-local-module",
              phaseLabel: claimModeStatusLabel(state.localWorkingPackages, state.runtimePolicy),
              workingPackages: state.localWorkingPackages,
              lastUpdatedAt: Date.now(),
            };
            await saveState(state);
            syncLocalCatalogLoop(tabId, state, {running: true, tabId});
            await pushStatusUpdate(tabId, state, {running: true, tabId});
            void confirmDelegatedResume(state, tabId);
            await relayDelay(1);
            continue;
          }
          state = await startAutonomousCore(
            state,
            tabId,
            claimModeStatusLabel(state.localWorkingPackages, state.runtimePolicy),
          );
          // The sandbox may still hold the previous target-paused snapshot.
          // Push the resumed state immediately instead of waiting for the
          // content script's slow status poll.
          await pushStatusUpdate(tabId, state, {running: true, tabId});
        } else if (!state.lastWorker || state.lastWorker.running !== true) {
          state = await startAutonomousCore(
            state,
            tabId,
            claimModeStatusLabel(state.localWorkingPackages, state.runtimePolicy),
          );
        } else if (workingChanged || catalogChanged || taskSignature !== state.lastServerTaskSignature || zeroConfirmationDue) {
          const synced = await postJson("v24Settings", {
            ...serverTaskSelection(state),
            settings: serverPackageSettings(state),
            selectedTasks: selectedServerTasks(state),
            workingPackages: state.localWorkingPackages,
          }, state.installToken);
          state.lastWorker = synced.worker || state.lastWorker;
          state.lastServerTaskSignature = taskSignature;
          await saveState(state);
        }
        if (currentMode === "normal" && serverOrdinaryClaimEnabled(state.runtimePolicy)) {
          const nextNormalClaimAt = number(state.normalNextClaimAt);
          if (nextNormalClaimAt > Date.now()) {
            await relayDelay(nextNormalClaimAt - Date.now());
            continue;
          }
          const dispatched = await dispatchNormalClaimFromLocal(
            tabId,
            state,
            () => generation === controlGeneration && controlTabId === tabId,
          );
          state = dispatched.state;
          if (dispatched.attempted) {
            state.normalNextClaimAt = Date.now() + ordinaryPacingIntervalMs(state);
            await saveState(state);
            if (dispatched.actualAmount > 0) await refreshAcceptanceTable(tabId);
            await pushStatusUpdate(tabId, state, {running: true, tabId});
            await relayDelay(localCompletionCheckInterval(state));
            continue;
          }
        }
        const awaitingFirstPackage = state.lastWorker && state.lastWorker.awaitingFirstPackage === true;
        state.lastWorker = {
          ...(state.lastWorker || {}),
          running: true,
          workingPackages: state.localWorkingPackages,
          phase: awaitingFirstPackage
            ? "awaiting-first-package"
            : currentMode === "normal"
              ? "waiting-local-command"
              : currentMode === "pre-submit" ? "pre-submit" : "policy-paused",
          phaseLabel: awaitingFirstPackage
            ? "预提交已成功，服务器请求已停止，等待本地确认实际新增包数"
            : releasedMessage || claimModeStatusLabel(state.localWorkingPackages, state.runtimePolicy),
          lastUpdatedAt: Date.now(),
        };
        await saveState(state);
        if (newRows.length || completedRows.length || release.released.length) {
          await refreshAcceptanceTable(tabId);
          await pushStatusUpdate(tabId, state, {running: true, tabId});
        }
        await controlDelay(Math.max(100, number(state.runtimePolicy && state.runtimePolicy.activeWorkingCheckMs) || 100));
      } catch (error) {
        state = await loadState();
        if (isTransientFrameError(error)) {
          if (isTransientFrameError(state.lastError)) {
            state.lastError = "";
            await saveState(state);
          }
          await relayDelay(250);
          continue;
        }
        state.lastError = String(error && error.message || error);
        await saveState(state);
        await relayDelay(Math.max(100, number(state.runtimePolicy && state.runtimePolicy.activeWorkingCheckMs) || 100));
      }
    }
  } finally {
    if (generation === controlGeneration && controlTabId === tabId) controlTabId = 0;
  }
}

function startControlLoop(tabId) {
  const normalizedTabId = number(tabId);
  if (!normalizedTabId || controlTabId === normalizedTabId) return;
  const generation = ++controlGeneration;
  controlTabId = normalizedTabId;
  localTaskCursor = 0;
  localControlLoop(generation, normalizedTabId).catch(() => {});
}

async function publicStatus(state = null, session = null) {
  const recoveryJournal = await turboJournal();
  const currentSession = session || await loadSession();
  const currentState = ordinaryCompletionView(state || await loadState(), currentSession);
  const currentPolicy = cPolicyCurrent();
  const cPolicyRecovered = cPolicyUsable()
    || !currentPolicy
    || currentPolicy.delegated !== true
    || currentPolicy.routeMode !== "local";
  const live = liveCatalogForTab(currentSession.tabId || localCatalogTabId);
  const localTaskCatalog = normalizeCandidateTasks(live ? live.taskCatalog : currentState.localTaskCatalog);
  applyDirectoryProof(currentState, live?.directoryProof);
  const localScanRounds = live ? number(live.rounds) : number(currentState.localScanRounds);
  const availableTasks = localTaskCatalog.filter((task) => task.left > 0).length;
  const worker = currentState.lastWorker && typeof currentState.lastWorker === "object"
    ? {...currentState.lastWorker, taskCatalog: localTaskCatalog, availableTasks, workingPackages: number(currentState.localWorkingPackages), localScanRounds, localRequests: number(currentState.localRequestTotal)}
    : {taskCatalog: localTaskCatalog, availableTasks, workingPackages: number(currentState.localWorkingPackages), rounds: 0, localScanRounds, localRequests: number(currentState.localRequestTotal)};
  if (routineLocalClaimFailure(worker.lastError)) worker.lastError = "";
  if (cPolicyRecovered && isRecoverableCPolicyError(worker.lastError)) worker.lastError = "";
  if (cPolicyDelegated()) worker.claimedPackages = number(currentState.localClaimedPackagesTotal);
  worker.catalogClaimIncrease = await catalogClaimIncrease(currentState, currentSession, localTaskCatalog);
  worker.workingRows = Array.from(currentState.localWorkingRows || []).slice(0, 100).map((row) => ({
    id: String(row && row.id || "").trim().slice(0, 120),
    taskId: String(row && row.taskId || "").trim().slice(0, 80),
    taskName: String(row && row.taskName || "").trim().slice(0, 160),
    status: Number.isFinite(Number(row && row.status)) ? Number(row.status) : null,
    statusText: String(row && row.localStatusText || "").trim().slice(0, 40),
    claimTime: String(row && (row.localClaimTime || row.gmtCreate || row.createTime || row.claimTime) || "").trim().slice(0, 80),
    summaryTotal: number(row && row.summaryTotal),
    summaryPackageCount: rowPackageCount(row),
  }));
  worker.platformDirectReadAt = number(lastPlatformDirectReadAt);
  worker.directoryProof = currentState.localDirectoryProof || null;
  worker.platformRead = {
    reported: number(lastPlatformDirectReadAt) > 0,
    ok: true,
    observedAt: number(lastPlatformDirectReadAt),
    workingPackages: number(currentState.localWorkingPackages),
    workingRows: worker.workingRows,
  };
  return {
    ok: true,
    userName: String(currentState.userName || ""),
    turbo: {active: !!turboRun, recovery: !!recoveryJournal, recoverAt: turboRecoverAt(recoveryJournal), serverIntervalMs: turboServerInterval(),
      activeIntervalMs: turboRun?.intervalMs || 0,
      allowed: turboServerInterval() > 0 && turboServerInterval() <= 10, pending: turboRun?.pending || 0,
      sent: turboRun?.sent || 0, phase: turboRun?.phase || "", taskId: turboRun?.journal.taskId || "",
      smartRouting: turboRun?.smartRouting === true, route: await turboRouteStatus(currentState)},
    registered: !!currentState.installToken && currentState.leaseExpiresAt > Date.now(),
    ordinaryPacing: cPolicyDelegated() ? {...prepareOrdinaryPacing(currentState)} : null,
    verificationStatus: "not-required",
    settings: normalizeSettings(currentState.settings, currentState.runtimePolicy),
    running: currentSession.running === true,
    worker,
    browserAuth: normalizeBrowserAuth(currentState.browserAuth),
    workload: publicWorkload(currentState),
    cPolicy: cPolicyPublic(),
    cModule: cPolicyDelegated() && cModuleSource ? {
      moduleSource: cModuleSource,
      moduleHash: cModuleHash,
      moduleToken: cPolicyToken,
    } : {},
    error: routineLocalClaimFailure(currentState.lastError)
      || (cPolicyRecovered && isRecoverableCPolicyError(currentState.lastError))
      ? ""
      : String(currentState.lastError || ""),
  };
}

async function stopServer(reason, options = {}) {
  stopTurboRun(reason, number(options.expectedTabId));
  stopControlLoop();
  stopRelayLoops();
  const session = await loadSession();
  const expectedTabId = number(options && options.expectedTabId);
  if (expectedTabId && session.running && session.tabId && session.tabId !== expectedTabId) {
    return publicStatus(null, session);
  }
  stopLocalCatalogLoop(session.tabId || localCatalogTabId);
  const state = await loadState();
  const notifyServer = !(options && options.skipServerRequest === true)
    && !!state.installToken
    && (session.running || options && options.forceServerRequest === true);
  await saveSession({running: false, tabId: 0});
  if (notifyServer) {
    try { await postJson("v24Stop", {reason: String(reason || "本地已停止")}, state.installToken); } catch (error) {}
  }
  state.autoPausedAtTarget = false;
  state.serverStopPending = false;
  state.lastServerTaskSignature = "";
  cModuleSessionNonce = "";
  if (state.lastWorker && typeof state.lastWorker === "object") {
    state.lastWorker = {...state.lastWorker, running: false, phase: "stopped", phaseLabel: String(reason || "已停止")};
  }
  await saveState(state);
  return publicStatus(state, {running: false, tabId: 0});
}

function dispatchEmergencyStop(reason, tabId = 0) {
  stopTurboRun(reason, number(tabId));
  const normalizedTabId = number(tabId);
  const operation = (async () => {
    const session = await loadSession();
    if (normalizedTabId && !isRunningSessionTab(session, normalizedTabId)) return publicStatus(null, session);
    const sequence = ++emergencyStopSequence;
    stopControlLoop();
    stopRelayLoops();
    stopLocalCatalogLoop(normalizedTabId || localCatalogTabId);
    const immediate = await stopServer(reason, {expectedTabId: normalizedTabId});
    enqueue(async () => {
      if (sequence !== emergencyStopSequence) return null;
      return stopServer(reason, {forceServerRequest: true});
    }).catch(() => {});
    return immediate;
  })();
  operation.catch(() => {});
  return operation;
}

async function handlePageExit(message, sender) {
  const tabId = number(sender.tab && sender.tab.id);
  if (tabId) {
    stopLocalCatalogLoop(tabId);
    stopControlLoop();
    stopRelayLoops();
  }
  const session = await loadSession();
  if (!tabId || !isRunningSessionTab(session, tabId)) return publicStatus(null, session);
  const refreshingSession = await saveSession({
    running: true,
    tabId,
    refreshing: true,
    refreshStartedAt: Date.now(),
  });
  return publicStatus(null, refreshingSession);
}

async function initializePage(message, sender) {
  const tabId = number(sender.tab && sender.tab.id);
  const session = await loadSession();
  const continuingRefresh = isContinuingRefresh(session, tabId) || isRunningSessionTab(session, tabId);
  if (tabId && !continuingRefresh) stopLocalCatalogLoop(tabId);
  // A newly opened or refreshed acceptance tab must only read the current
  // status. It is not the bound working tab, so it must not stop that session.
  let state = await loadState();
  const detectedAccount = validPlatformAccount(message.platformAccount);
  state.platformAccount = detectedAccount || state.platformAccount;
  if (!state.installToken || state.leaseExpiresAt <= Date.now() + 5000) {
    await saveState(state);
    try {
      await activate(state, "");
      await refreshBrowserAuthState(state, true);
    } catch (error) {
      if (!isTransientFrameError(error)) state.lastError = String(error && error.message || error);
    }
  }
  if (state.installToken) {
    try { state = await refreshRuntimeConfig(state, true); } catch (error) {}
  }
  if (state.installToken && state.userName) {
    try { await refreshCPolicy(state, false); } catch (error) {
      if (cPolicyCurrent() && cPolicyCurrent().delegated === true) {
        state.lastError = String(error && error.message || error);
      }
    }
  }
  if (tabId && runtimePlatformRoutesReady(["subTasks", "summary", "release"])) {
    try {
      const release = await applyLocalReleasePolicy(tabId, await readLocalWorkingRows(tabId), state.runtimePolicy);
      flushLocalReadStats(state);
      state.localWorkingRows = release.rows.slice(0, 100);
      state.localWorkingPackages = workingPackageCount(release.rows);
      for (const item of release.released) markWorkloadReleased(state, item.subTaskId);
      syncWorkload(state, release.rows);
      state.lastError = releaseFailureMessage({release});
      const messageText = releaseSuccessMessage({release});
      if (messageText) state.lastWorker = {...(state.lastWorker || {}), workingPackages: workingPackageCount(release.rows), phaseLabel: messageText};
    } catch (error) {
      if (!isTransientFrameError(error)) state.lastError = String(error && error.message || error);
    }
  }
  if (cPolicyDelegated()) {
    applyCPolicyRuntime(state);
    syncLocalCatalogLoop(tabId, state, continuingRefresh ? {running: true, tabId} : session);
    try { await refreshControlTaskCatalog(tabId, state, true); } catch (error) {}
    if (continuingRefresh) {
      state.lastError = "";
      state.lastWorker = {
        ...(state.lastWorker || {}),
        running: true,
        phase: "c-local-module",
        phaseLabel: "页面刷新完成，2.3.1本机放权模组已接回",
        workingPackages: number(state.localWorkingPackages),
        lastUpdatedAt: Date.now(),
      };
      await saveSession({running: true, tabId});
    }
    await saveState(state);
    return publicStatus(state, continuingRefresh ? {running: true, tabId} : {running: false, tabId});
  }
  if (continuingRefresh) {
    const currentMode = claimModeForWorkingPackages(state.localWorkingPackages, state.runtimePolicy);
    syncLocalCatalogLoop(tabId, state, {running: true, tabId});
    try { await refreshControlTaskCatalog(tabId, state, true); } catch (error) {}
    state.lastError = "";
    await saveSession({running: true, tabId});
    await saveState(state);
    const targetReached = state.localWorkingPackages >= state.settings.targetPackages;
    const resumeThreshold = resumeThresholdForSettings(state.settings, state.runtimePolicy);
    if (targetReached) {
      if (!state.autoPausedAtTarget || state.serverStopPending || state.lastWorker && state.lastWorker.running === true) {
        await pauseAutonomousCore(
          state,
          tabId,
          `本地确认已有${state.localWorkingPackages}包，达到服务器停止包数${state.settings.targetPackages}包`,
        );
      } else {
        state.lastWorker = {
          ...(state.lastWorker || {}),
          running: false,
          phase: "target-paused",
          phaseLabel: `服务器领取保持暂停；降到${resumeThreshold}包后按服务器边界重新判断`,
          workingPackages: state.localWorkingPackages,
        };
        await saveState(state);
      }
      startControlLoop(tabId);
      return publicStatus(state, {running: true, tabId});
    }
    if (state.autoPausedAtTarget && state.localWorkingPackages > resumeThreshold) {
      state.lastWorker = {
        ...(state.lastWorker || {}),
        running: false,
        phase: "target-paused",
        phaseLabel: `服务器领取保持暂停；当前${state.localWorkingPackages}包，降到${resumeThreshold}包后按服务器边界重新判断`,
        workingPackages: state.localWorkingPackages,
      };
      await saveState(state);
      startControlLoop(tabId);
      return publicStatus(state, {running: true, tabId});
    }
    if (state.autoPausedAtTarget) {
      await startAutonomousCore(
        state,
        tabId,
        `页面刷新完成；${claimModeStatusLabel(state.localWorkingPackages, state.runtimePolicy)}`,
      );
      startControlLoop(tabId);
      return publicStatus(state, {running: true, tabId});
    }
    try {
      const synced = await postJson("v24Settings", {
        ...serverTaskSelection(state),
        settings: serverPackageSettings(state),
        selectedTasks: selectedServerTasks(state),
        workingPackages: state.localWorkingPackages,
      }, state.installToken);
      state.lastWorker = synced.worker || state.lastWorker;
      state.lastServerTaskSignature = serverTaskSignature(state);
      await saveState(state);
      startRelayLoops(tabId);
    } catch (error) {
      await startAutonomousCore(
        state,
        tabId,
        `页面刷新完成；${claimModeStatusLabel(state.localWorkingPackages, state.runtimePolicy)}`,
      );
    }
    startControlLoop(tabId);
    return publicStatus(state, {running: true, tabId});
  }
  await saveState(state);
  return publicStatus(state, {running: false, tabId});
}

async function updatePlatformAccount(message) {
  const detectedAccount = validPlatformAccount(message && message.platformAccount);
  if (!detectedAccount) return publicStatus();
  let state = await loadState();
  state.platformAccount = detectedAccount;
  if (!state.installToken || state.leaseExpiresAt <= Date.now() + 5000) {
    await saveState(state);
    try {
      state = await activate(state, "");
      await refreshBrowserAuthState(state, true);
    } catch (error) {
      state.lastError = String(error && error.message || error);
    }
  }
  if (state.installToken && state.userName) {
    try { await refreshCPolicy(state, false); } catch (error) {
      state.lastError = String(error && error.message || error);
    }
  }
  await saveState(state);
  return publicStatus(state);
}

async function updateSettings(message) {
  if (turboRun) throw new Error("极速模式仍有在途请求或正在核对，暂不可修改参数");
  let state = await loadState();
  requireCPolicy();
  const incoming = message && message.settings && typeof message.settings === "object" ? message.settings : {};
  if (cPolicyDelegated()) {
    updateCVolatileOverrides(incoming);
    applyCPolicyRuntime(state);
  }
  state.settings = normalizeSettings(incoming, state.runtimePolicy);
  const session = await loadSession();
  if (cPolicyDelegated()) {
    state.lastWorker = {
      ...(state.lastWorker || {}),
      phaseLabel: "本机放权参数已在记忆体更新",
      lastUpdatedAt: Date.now(),
    };
    await saveState(state);
    return publicStatus(state, session);
  }
  if (session.running && state.installToken) {
    const targetReached = number(state.localWorkingPackages) >= state.settings.targetPackages;
    const resumeThreshold = resumeThresholdForSettings(state.settings, state.runtimePolicy);
    if (targetReached) {
      state = await pauseAutonomousCore(
        state,
        session.tabId,
        `本地已有${state.localWorkingPackages}包，达到服务器停止包数${state.settings.targetPackages}包`,
      );
    } else if (state.autoPausedAtTarget) {
      if (number(state.localWorkingPackages) <= resumeThreshold) {
        state = await startAutonomousCore(
          state,
          session.tabId,
          `任务设置更新后；${claimModeStatusLabel(state.localWorkingPackages, state.runtimePolicy)}`,
        );
      } else {
        state.lastWorker = {
          ...(state.lastWorker || {}),
          running: false,
          phase: "target-paused",
          phaseLabel: `任务设置已保存；当前${state.localWorkingPackages}包，降到${resumeThreshold}包后按服务器边界重新判断`,
        };
      }
    } else {
      const response = await postJson("v24Settings", {
        ...serverTaskSelection(state),
        settings: serverPackageSettings(state),
        selectedTasks: selectedServerTasks(state),
        workingPackages: number(state.localWorkingPackages),
      }, state.installToken);
      state.lastWorker = response.worker || state.lastWorker;
      state.lastServerTaskSignature = serverTaskSignature(state);
    }
  }
  await saveState(state);
  return publicStatus(state, session);
}

async function importLegacyWorkload(message) {
  const state = await loadState();
  const incoming = message && message.workload && typeof message.workload === "object" ? message.workload : {};
  const totals = incoming.version === 2 && incoming.unit === "claim" && incoming.totals && typeof incoming.totals === "object"
    ? incoming.totals
    : {};
  state.workload = normalizeWorkload(state.workload);
  for (const [taskIdValue, item] of Object.entries(totals).slice(0, 2000)) {
    const taskId = String(item && item.taskId || taskIdValue || "").trim().slice(0, 80);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId)) continue;
    const previous = state.workload.totals[taskId] || {};
    state.workload.totals[taskId] = {
      taskId,
      taskName: String(item && item.taskName || previous.taskName || "").trim().slice(0, 160),
      completed: Math.max(number(previous.completed), number(item && item.completed)),
      updatedAt: Math.max(number(previous.updatedAt), number(item && item.updatedAt)),
    };
  }
  await saveState(state);
  return publicStatus(state);
}

async function startServer(message, sender) {
  const tabId = number(sender.tab && sender.tab.id);
  if (!tabId) throw new Error("无法确认当前SkyVendor页面");
  let state = await loadState();
  state.platformAccount = validPlatformAccount(message.platformAccount) || validPlatformAccount(state.platformAccount);
  if (!state.userName) throw new Error("服务器尚未读取到SkyVendor登录姓名");
  state = await ensureConnected(state);
  state = await refreshCPolicy(state, true);
  // A-server mode is authorized by the install lease.  Only a currently
  // usable delegated policy enters the local C module path.
  if (cPolicyDelegated()) {
    updateCVolatileOverrides(message.settings || {});
    applyCPolicyRuntime(state);
  }
  state.settings = normalizeSettings(message.settings || state.settings, state.runtimePolicy);
  const snapshot = await enforceSnapshotReleasePolicy(tabId, await readLocalSnapshot(tabId, state.settings), state.runtimePolicy);
  applyLocalSnapshot(state, snapshot, releaseSuccessMessage(snapshot));
  syncSnapshotWorkload(state, snapshot);
  const releaseError = releaseFailureMessage(snapshot);
  if (releaseError) {
    state.lastError = releaseError;
    await saveState(state);
    throw new Error(releaseError);
  }
  await catalogClaimIncrease(state, {running:true,tabId}, snapshot.taskCatalog, true);
  if (cPolicyDelegated()) {
    syncLocalCatalogLoop(tabId, state, {running: true, tabId});
    try { await refreshControlTaskCatalog(tabId, state, true); } catch (error) {}
    state.autoPausedAtTarget = state.localWorkingPackages >= state.settings.targetPackages;
    state.serverStopPending = false;
    state.lastServerTaskSignature = "";
    state.lastWorker = {
      ...(state.lastWorker || {}),
      running: true,
      phase: state.autoPausedAtTarget ? "target-paused" : "c-local-module",
      phaseLabel: state.autoPausedAtTarget
        ? `本地已有${state.localWorkingPackages}包，达到放权停止包数${state.settings.targetPackages}包`
        : "2.3.1本机放权模组已启动",
      workingPackages: state.localWorkingPackages,
      lastUpdatedAt: Date.now(),
    };
    state.lastError = "";
    await saveSession({running: true, tabId});
    await saveState(state);
    return publicStatus(state, {running: true, tabId});
  }
  if (state.localWorkingPackages >= state.settings.targetPackages) {
    state.autoPausedAtTarget = true;
    state.serverStopPending = false;
    state.lastServerTaskSignature = "";
    state.lastWorker = {
      ...(state.lastWorker || {}),
      running: false,
      phase: "target-paused",
      phaseLabel: `本地已有${state.localWorkingPackages}包，达到服务器停止包数；降到${resumeThresholdForSettings(state.settings, state.runtimePolicy)}包后按服务器边界重新判断`,
      workingPackages: state.localWorkingPackages,
    };
    state.lastError = "";
    await saveSession({running: true, tabId});
    await saveState(state);
    startControlLoop(tabId);
    return publicStatus(state, {running: true, tabId});
  }
  await startAutonomousCore(
    state,
    tabId,
    claimModeStatusLabel(state.localWorkingPackages, state.runtimePolicy),
  );
  startControlLoop(tabId);
  return publicStatus(state, {running: true, tabId});
}

async function manualClaimTask(message, sender) {
  const tabId = number(sender.tab && sender.tab.id);
  if (!tabId) throw new Error("无法确认当前SkyVendor页面");
  const existingSession = await loadSession();
  if (existingSession.running) throw new Error("请先停止自动领取，再使用手动领取");
  let state = await loadState();
  state.platformAccount = validPlatformAccount(message.platformAccount) || validPlatformAccount(state.platformAccount);
  state = await ensureConnected(state);
  requireCPolicy({local: true});
  updateCVolatileOverrides(message.settings || {});
  applyCPolicyRuntime(state);
  state.settings = normalizeSettings(message.settings || state.settings, state.runtimePolicy);
  const timing = prepareOrdinaryPacing(state);
  await relayDelay(Math.max(0, timing.claimNextAt - Date.now()));
  requireCPolicy({local: true});
  const snapshot = await enforceSnapshotReleasePolicy(tabId, await readLocalSnapshot(tabId, state.settings, true), state.runtimePolicy);
  applyLocalSnapshot(state, snapshot, releaseSuccessMessage(snapshot));
  syncSnapshotWorkload(state, snapshot);
  const releaseError = releaseFailureMessage(snapshot);
  if (releaseError) {
    state.lastError = releaseError;
    await saveState(state);
    throw new Error(releaseError);
  }
  if (state.localWorkingPackages >= state.settings.targetPackages) {
    state.lastError = `本地已有${state.localWorkingPackages}包，达到所选上限${state.settings.targetPackages}包`;
    await saveState(state);
    throw new Error(state.lastError);
  }
  const taskId = String(message.taskId || "").trim().slice(0, 80);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId)) throw new Error("请选择有效任务");
  await assertTurboTaskCompatibility(state, taskId, snapshot.workingRows);
  const task = normalizeCandidateTasks(state.localTaskCatalog).find((item) => item.taskId === taskId);
  const taskName = String(message.taskName || task && task.name || taskId).trim().slice(0, 160);
  const amount = Math.max(1, Math.min(state.settings.claimAmount, Math.max(1, state.settings.targetPackages - state.localWorkingPackages)));
  const previousRows = Array.from(snapshot.workingRows || []);
  const previousWorker = state.lastWorker && typeof state.lastWorker === "object" ? state.lastWorker : {};
  recordWorkloadClaim(state, taskId, taskName);
  state.lastError = "";
  state.lastWorker = {
    ...previousWorker,
    running: false,
    phase: "manual-local",
    phaseLabel: `本地正在手动领取${taskName}`,
    currentTaskId: taskId,
    currentTaskName: taskName,
    lastUpdatedAt: Date.now(),
  };
  await saveState(state);

  let confirmation = null;
  let claimResult = null;
  const receiptId = await beginLocalClaimReceipt(tabId, state, previousRows, amount, taskId, "manual");
  try {
    timing.claimNextAt = Date.now() + timing.claimMs;
    timing.claimSampleUntil = timing.claimNextAt;
    recordLocalPlatformRequest();
    claimResult = await executePlatformCommand(tabId, localManualClaimCommand(taskId, amount));
    if (!claimResult.ok && (claimResult.notSent === true || (number(claimResult.status) > 0 && Number.isFinite(Number(claimResult.code))))) {
      await cancelLocalClaimReceipt(receiptId);
    }
    flushLocalReadStats(state);
    if (!claimResult.ok && claimResult.code !== "TIMEOUT") throw new Error(String(claimResult.error || "本地手动领取请求失败"));
    confirmation = await confirmLocalManualClaim(tabId, state, previousRows, amount, taskId);
    state = confirmation.state;
    recordConfirmedLocalPackages(state, confirmation.newSubTaskIds, confirmation.actualAmount);
    await XiaotianClaimAudit.capture(state, state.localWorkingRows.filter(row => confirmation.newSubTaskIds.includes(String(row.id))), "manual", cModuleHash)
      .catch(error => console.warn("手动领取记录待补报", error.message));
    if (confirmation.actualAmount < 1) throw new Error(claimResult.code === "TIMEOUT"
      ? "领取结果不确定，本地尚未发现新增工作包"
      : "平台响应成功，但本地没有发现新增工作包");
  } catch (error) {
    flushLocalReadStats(state);
    discardPendingWorkloadClaim(state, taskId);
    state.lastError = String(error && error.message || error || "本地手动领取失败");
    state.lastWorker = {
      ...state.lastWorker,
      phase: "manual-local-error",
      phaseLabel: state.lastError,
      lastUpdatedAt: Date.now(),
    };
    await saveState(state);
    throw new Error(state.lastError);
  }

  state.lastError = "";
  state.lastWorker = {
    ...state.lastWorker,
    running: false,
    phase: "manual-local-claimed",
    phaseLabel: `本地手动领取${taskName}，确认新增${confirmation.actualAmount}包`,
    currentTaskId: taskId,
    currentTaskName: taskName,
    claimedPackages: number(state.localClaimedPackagesTotal),
    workingPackages: number(state.localWorkingPackages),
    lastUpdatedAt: Date.now(),
  };
  await saveState(state);
  await refreshAcceptanceTable(tabId);
  await pushStatusUpdate(tabId, state, {running: false, tabId: 0});
  return publicStatus(state, {running: false, tabId: 0});
}

function routineLocalClaimFailure(value) {
  return /(?:暂无待验收数据|系统繁忙|请稍后重试|请求过于频繁|操作频繁|访问频繁|限流|剩余可领取包数不足|任务可领取数量不足|没有可领取包|当前任务没有可领取包|任务已被领取|任务不存在|尚未发现新增工作包|平台已响应.*尚未发现)/.test(String(value || ""));
}

async function readCModuleActionSnapshot(tabId, state) {
  seedLiveLocalCatalog(tabId, state);
  const live = liveCatalogForTab(tabId);
  if (!live || !live.fullCatalogAt) await refreshLiveLocalCatalog(tabId, state, true);
  applyLiveCatalog(state, tabId);
  let taskCatalog = normalizeCandidateTasks(state.localTaskCatalog);
  const workingRows = await readLocalWorkingRows(tabId);
  return {taskCatalog, workingRows, workingPackages: workingPackageCount(workingRows)};
}

async function handleCModuleAction(message, sender) {
  const tabId = number(sender.tab && sender.tab.id);
  if (!tabId) throw new Error("无法确认当前SkyVendor页面");
  const session = await loadSession();
  if (!session.running || session.tabId !== tabId) throw new Error("2.3.1本机放权尚未启动");
  const policy = requireCPolicy({local: true});
  const sessionNonce = String(message && message.sessionNonce || "");
  if (!/^[A-Fa-f0-9]{32,128}$/.test(sessionNonce)) throw new Error("本机模组会话无效");
  if (String(message && message.moduleToken || "") !== cPolicyToken
    || String(message && message.moduleHash || "") !== cModuleHash
    || number(message && message.policyRevision) !== number(policy.revision)) {
    throw new Error("本机模组授权与当前C策略不一致");
  }
  // A valid renewed policy may replace the sandbox without stopping the task.
  // Rotate its local nonce only after the current token/hash/revision pass.
  cModuleSessionNonce = sessionNonce;
  if (message.action !== "claim") return {...await publicStatus(), actualAmount: 0};
  const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
  if ((payload.turboMode === true || payload.mode === "pre-submit") && !(turboServerInterval() > 0 && turboServerInterval() <= 10)) {
    return {...await publicStatus(), ok: false, claimDeferred: true, actualAmount: 0};
  }
  if (payload.turboMode === true && payload.mode === "pre-submit") return startTurboRun(message, tabId);
  if (turboRun) throw new Error("极速模式正在运行或核对，不能同时普通领取");
  const taskId = String(payload.taskId || "").trim().slice(0, 80);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId)) throw new Error("本机模组任务ID无效");

  let state = await loadState();
  applyCPolicyRuntime(state);
  state.settings = normalizeSettings(state.settings, state.runtimePolicy);
  if (payload.mode === "normal") {
    const timing = prepareOrdinaryPacing(state);
    if (Date.now() < timing.claimNextAt) return {...await publicStatus(state, session), ok: false, claimDeferred: true, actualAmount: 0};
  }
  const snapshot = await enforceSnapshotReleasePolicy(tabId, await readCModuleActionSnapshot(tabId, state), state.runtimePolicy);
  applyLocalSnapshot(state, snapshot, releaseSuccessMessage(snapshot));
  syncSnapshotWorkload(state, snapshot);
  const releaseError = releaseFailureMessage(snapshot);
  if (releaseError) throw new Error(releaseError);
  if (state.localWorkingPackages >= state.settings.targetPackages) throw new Error("已达到本机放权停止包数");

  const expectedMode = state.settings.preSubmitEnabled === false ? "normal" : state.settings.ordinaryClaimEnabled === true
    && state.localWorkingPackages >= state.settings.ordinaryStartPackages
    ? "normal"
    : state.settings.preSubmitEnabled !== false
      && state.localWorkingPackages < state.settings.preSubmitStopPackages
      ? "pre-submit"
      : "waiting";
  if (expectedMode === "waiting" || payload.mode !== expectedMode) throw new Error("当前包数不符合本机模组领取阶段");
  const candidate = selectedServerTasks(state, expectedMode).find((task) => task.taskId === taskId);
  if (!candidate) throw new Error("任务不在当前任务屏蔽／预提交队列范围内");
  if (expectedMode === "normal" && number(candidate.left) < 1) throw new Error("当前任务没有可领取包");

  const requested = expectedMode === "pre-submit" ? state.settings.preSubmitAmount : state.settings.claimAmount;
  await assertTurboTaskCompatibility(state, taskId, snapshot.workingRows);
  const remaining = Math.max(0, state.settings.targetPackages - state.localWorkingPackages);
  if (remaining < 1) throw new Error("已达到本机放权停止包数");
  const amount = Math.max(1, Math.min(requested, remaining,
    expectedMode === "normal" && number(candidate.left) > 0 ? number(candidate.left) : requested));
  const previousRows = Array.from(snapshot.workingRows || []);
  const previousWorker = state.lastWorker && typeof state.lastWorker === "object" ? state.lastWorker : {};
  recordWorkloadClaim(state, taskId, candidate.name || payload.taskName || taskId);
  state.lastWorker = {
    ...previousWorker,
    running: true,
    phase: expectedMode === "pre-submit" ? "c-local-pre-submit" : "c-local-claim",
    phaseLabel: expectedMode === "pre-submit"
      ? `2.3.1本机预提交${candidate.name || taskId}`
      : `2.3.1本机领取${candidate.name || taskId}`,
    currentTaskId: taskId,
    currentTaskName: candidate.name || taskId,
    platformRequests: number(previousWorker.platformRequests) + 1,
    rounds: number(previousWorker.rounds) + 1,
    lastUpdatedAt: Date.now(),
  };
  await saveState(state);

  if (expectedMode === "normal") {
    const timing = prepareOrdinaryPacing(state);
    timing.claimNextAt = Date.now() + timing.claimMs;
    timing.claimSampleUntil = timing.claimNextAt;
  }
  const receiptId = await beginLocalClaimReceipt(tabId, state, previousRows, amount, taskId,
    expectedMode === "normal" ? "normal" : "accelerated");
  recordLocalPlatformRequest();
  const result = await executePlatformCommand(tabId, localManualClaimCommand(taskId, amount));
  if (!result.ok && (result.notSent === true || (number(result.status) > 0 && Number.isFinite(Number(result.code))))) {
    await cancelLocalClaimReceipt(receiptId);
  }
  flushLocalReadStats(state);
  if (!result.ok && result.code !== "TIMEOUT") {
    discardPendingWorkloadClaim(state, taskId);
    const failure = String(result.error || "本机领取未成功");
    const routine = routineLocalClaimFailure(failure);
    state.lastError = routine ? "" : failure;
    state.lastWorker = {
      ...state.lastWorker,
      phase: "c-local-waiting",
      phaseLabel: routine ? `${failure}；继续扫描` : failure,
      lastError: routine ? "" : failure,
      lastUpdatedAt: Date.now(),
    };
    await saveState(state);
    return {...await publicStatus(state, session), ok: false, error: failure, actualAmount: 0, taskId};
  }
  const confirmation = await confirmLocalManualClaim(tabId, state, previousRows, amount, taskId, expectedMode === "normal" ? "normal" : "accelerated");
  state = confirmation.state;
  recordConfirmedLocalPackages(state, confirmation.newSubTaskIds, confirmation.actualAmount);
  await XiaotianClaimAudit.capture(state, state.localWorkingRows.filter(row => confirmation.newSubTaskIds.includes(String(row.id))),
    expectedMode === "normal" ? "normal" : "accelerated", cModuleHash)
    .catch(error => console.warn("自动领取记录待补报", error.message));
  const actualAmount = number(confirmation.actualAmount);
  if (actualAmount < 1) discardPendingWorkloadClaim(state, taskId);
  const noClaimMessage = result.code === "TIMEOUT"
    ? "领取结果不确定，本地尚未发现新增工作包"
    : "平台已响应，但本地尚未发现新增工作包";
  state.lastError = actualAmount > 0 || routineLocalClaimFailure(noClaimMessage) ? "" : noClaimMessage;
  state.lastWorker = {
    ...state.lastWorker,
    running: true,
    phase: actualAmount > 0 ? "c-local-claimed" : "c-local-waiting",
    phaseLabel: actualAmount > 0
      ? `2.3.1本机确认新增${actualAmount}包`
      : `${noClaimMessage}；继续扫描`,
    lastError: "",
    claimedPackages: number(state.localClaimedPackagesTotal),
    workingPackages: number(state.localWorkingPackages),
    lastUpdatedAt: Date.now(),
  };
  await saveState(state);
  if (actualAmount > 0) await refreshAcceptanceTable(tabId);
  await pushStatusUpdate(tabId, state, session);
  return {
    ...await publicStatus(state, session),
    ok: actualAmount > 0,
    error: actualAmount > 0 ? "" : noClaimMessage,
    actualAmount,
    taskId,
  };
}

async function pollServer(message, sender) {
  let state = await loadState();
  let session = await loadSession();
  const tabId = number(sender.tab && sender.tab.id);
  if (!tabId) return publicStatus(state, session);
  if (state.installToken && state.userName) {
    try { state = await refreshCPolicy(state, false); } catch (error) {
      if (isServerAccessRevoked(error)) {
        state = await applyServerAccessRevocation(error);
        return publicStatus(state, await loadSession());
      }
      state.lastError = String(error && error.message || error);
    }
  }
  if (cPolicyDelegated()) {
    applyCPolicyRuntime(state);
    if (cPolicyCoreSettings()?.preSubmitEnabled === false) {
      // Completion reads have their own job. Remote policy refresh and the
      // directory request must never be prerequisites for those reads.
      scheduleOrdinaryCompletionCheck(session);
      state = ordinaryCompletionView(state, session);
      syncLocalCatalogLoop(tabId, state, session);
      return publicStatus(state, session);
    }
    syncLocalCatalogLoop(tabId, state, session);
    const previousWorkingPackages = number(state.localWorkingPackages);
    if (session.running && session.tabId === tabId) {
      try {
        const snapshot = await enforceSnapshotReleasePolicy(tabId, await readLocalSnapshot(tabId, state.settings), state.runtimePolicy);
        applyLocalSnapshot(state, snapshot, releaseSuccessMessage(snapshot));
        syncSnapshotWorkload(state, snapshot);
        state.lastError = releaseFailureMessage(snapshot);
      } catch (error) {
        state.lastError = isTransientFrameError(error) ? "" : String(error && error.message || error);
      }
    }
    await saveState(state);
    // In delegated mode the local catalog loop is intentionally stopped at the
    // target package limit.  A completed package therefore has to wake the
    // sandbox through the status channel; otherwise the module can remain in
    // its previous "stopped" snapshot and never schedule the next claim.
    if (session.running && session.tabId === tabId
      && previousWorkingPackages !== number(state.localWorkingPackages)) {
      await pushStatusUpdate(tabId, state, session);
    }
    return publicStatus(state, session);
  }
  syncLocalCatalogLoop(tabId, state, session);
  if (session.running && session.tabId === tabId) {
    if (!state.autoPausedAtTarget) startRelayLoops(tabId);
    startControlLoop(tabId);
    try {
      const synced = await syncServerStatus(false);
      state = synced.state;
      session = await loadSession();
    } catch (error) {
      if (isCPolicyTransitionError(error)) {
        try {
          state = await refreshAfterCPolicyTransition();
          session = await loadSession();
          return publicStatus(state, session);
        } catch (refreshError) {
          if (!isCPolicyTransitionError(refreshError)) throw refreshError;
          clearCPolicyTransitionState(state);
          await saveState(state);
          return publicStatus(state, session);
        }
      }
      state.lastError = String(error && error.message || error);
      await saveState(state);
    }
  }
  syncLocalCatalogLoop(tabId, state, session);
  if (state.installToken) {
    await refreshBrowserAuthState(state, true);
    await saveState(state);
  }
  return publicStatus(state, session);
}

let ordinaryCompletionJob = null;
let ordinaryCompletionTimer = null;
let ordinaryCompletionCommit = null;
let ordinaryCompletionObservation = null;

function ordinaryCompletionEnabled(session) {
  return session?.running === true && !session.refreshing && number(session.tabId) > 0
    && cPolicyDelegated() && cPolicyUsable() && !serverAccessRevoked
    && cPolicyCoreSettings()?.preSubmitEnabled === false && !turboRun;
}

function ordinaryCompletionMatches(observation, state, session) {
  return !!observation && ordinaryCompletionEnabled(session)
    && observation.tabId === session.tabId
    && observation.installId === state.installId && observation.userName === state.userName
    && observation.stopSequence === emergencyStopSequence
    && observation.readSequence === localWorkingReadSequence;
}

function ordinaryCompletionView(state, session) {
  const observed = ordinaryCompletionObservation;
  if (!ordinaryCompletionMatches(observed, state, session)) return state;
  return {...state, localWorkingRows: observed.rows.slice(0, 100),
    localWorkingPackages: workingPackageCount(observed.rows),
    autoPausedAtTarget: workingPackageCount(observed.rows) >= state.settings.targetPackages};
}

function queueOrdinaryCompletionCommit() {
  if (ordinaryCompletionCommit) return;
  // Only the short state merge uses the mutation queue. Publish observations
  // immediately through publicStatus while a remote operation occupies it.
  ordinaryCompletionCommit = enqueue(async () => {
    const session = await loadSession();
    const state = await loadState();
    const observed = ordinaryCompletionObservation;
    if (!ordinaryCompletionMatches(observed, state, session)) return;
    flushLocalReadStats(state);
    applyLiveCatalog(state, session.tabId);
    state.localWorkingRows = observed.rows.slice(0, 100);
    state.localWorkingPackages = workingPackageCount(observed.rows);
    state.autoPausedAtTarget = state.localWorkingPackages >= state.settings.targetPackages;
    for (const item of observed.released) markWorkloadReleased(state, item.subTaskId);
    syncWorkload(state, observed.rows);
    await saveState(state);
    const savedIds = new Set(observed.released.map(item => item.subTaskId));
    if (ordinaryCompletionObservation?.installId === observed.installId
      && ordinaryCompletionObservation?.userName === observed.userName) {
      ordinaryCompletionObservation.released = ordinaryCompletionObservation.released.filter(item => !savedIds.has(item.subTaskId));
    }
  }).catch(error => console.warn("完成状态保存待重试", error.message))
    .finally(() => { ordinaryCompletionCommit = null; });
}

function scheduleOrdinaryCompletionCheck(session) {
  if (ordinaryCompletionJob || !ordinaryCompletionEnabled(session)) return;
  if (ordinaryCompletionTimer !== null) clearTimeout(ordinaryCompletionTimer);
  ordinaryCompletionTimer = null;
  const tabId = session.tabId;
  const stopSequence = emergencyStopSequence;
  ordinaryCompletionJob = (async () => {
    const owner = await loadState();
    // Share the existing 100x pacing gate; never introduce an extra fast poll.
    const rows = await readLocalWorkingRows(tabId, true);
    const readSequence = localWorkingReadSequence;
    let currentSession = await loadSession();
    let latest = await loadState();
    const observed = {tabId, installId: owner.installId, userName: owner.userName,
      stopSequence, readSequence, rows, released: []};
    if (!ordinaryCompletionMatches(observed, latest, currentSession)) return;
    applyCPolicyRuntime(latest);
    const release = await applyLocalReleasePolicy(tabId, rows, latest.runtimePolicy);
    currentSession = await loadSession();
    latest = await loadState();
    if (!ordinaryCompletionMatches(observed, latest, currentSession)) return;
    observed.rows = release.rows;
    const previous = ordinaryCompletionObservation;
    const carried = previous?.installId === observed.installId && previous?.userName === observed.userName
      && previous?.stopSequence === observed.stopSequence ? previous.released : [];
    observed.released = [...new Map([...carried, ...release.released].map(item => [item.subTaskId, item])).values()];
    ordinaryCompletionObservation = observed;
    const view = ordinaryCompletionView(latest, currentSession);
    syncLocalCatalogLoop(tabId, view, currentSession);
    queueOrdinaryCompletionCommit();
    const releaseError = releaseFailureMessage({release});
    if (releaseError) view.lastError = releaseError;
    await pushStatusUpdate(tabId, view, currentSession);
  })().catch(error => {
    if (!isTransientFrameError(error)) console.warn("未完成任务检查待重试", error.message);
  }).finally(() => {
    ordinaryCompletionJob = null;
    // Continue monitoring even if the page stops polling its UI. The next
    // iteration revalidates the live session/permission before issuing a read.
    const interval = Math.max(1, Number(cPolicyCurrent()?.defaults?.preSubmitIntervalMs) * 100 || 1000);
    const delay = Math.max(250, workingReadTiming.lastStartedAt + interval - Date.now());
    ordinaryCompletionTimer = setTimeout(() => {
      ordinaryCompletionTimer = null;
      loadSession().then(scheduleOrdinaryCompletionCheck).catch(() => {});
    }, delay);
  });
}

let statusRefreshJob = null;

async function readResponsiveStatus(message, sender) {
  const session = await loadSession();
  if (message.type === "poll") scheduleOrdinaryCompletionCheck(session);
  if (message.type === "poll" && !statusRefreshJob) {
    const tabId = number(session.running && session.tabId || sender.tab && sender.tab.id);
    if (tabId) {
      // UI reads never wait behind remote queries. Coalesce those queries so
      // repeated UI polls cannot build a backlog in the mutation queue.
      statusRefreshJob = enqueue(async () => {
        try {
          const status = await pollServer(message, {...sender, tab: {...sender.tab, id: tabId}});
          await withPageResponseTimeout(chrome.tabs.sendMessage(tabId, {scope: "xiaotian-v24", type: "status-update", status})).catch(() => {});
        } catch (error) {
          const status = {...await publicStatus(), ok: false, error: String(error && error.message || error)};
          await withPageResponseTimeout(chrome.tabs.sendMessage(tabId, {scope: "xiaotian-v24", type: "status-update", status})).catch(() => {});
        }
      }).catch(() => {}).finally(() => { statusRefreshJob = null; });
    }
  }
  return publicStatus(null, session);
}

function runDirectBrowserOperation(message) {
  if (message.type === "browser-status") return getBrowserAuthStatus(browserAuthGeneration);
  if (message.type === "browser-login-phone") {
    browserAuthGeneration += 1;
    return requestBrowserLoginPhone(message, browserAuthGeneration);
  }
  if (message.type === "browser-login-code") {
    browserAuthGeneration += 1;
    return submitBrowserLoginCode(message, browserAuthGeneration);
  }
  if (message.type === "browser-logout") {
    browserAuthGeneration += 1;
    return logoutServerBrowser(browserAuthGeneration);
  }
  if (message.type === "browser-open-manual-login") return openManualBrowserLogin();
  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.scope !== "xiaotian-v24" || sender.frameId > 0) return undefined;
  if (message.type === "stop" || message.type === "page-exit") stopTurboRun("页面停止或退出", number(sender.tab && sender.tab.id));
  const directBrowserOperation = /^browser-(?:status|login-phone|login-code|logout|open-manual-login)$/.test(String(message.type || ""));
  const directStatusRead = message.type === "poll" || message.type === "status";
  const operation = directStatusRead ? readResponsiveStatus(message, sender)
    : directBrowserOperation ? Promise.resolve().then(() => runDirectBrowserOperation(message)) : enqueue(async () => {
    if (message.type === "turbo-recover") return recoverTurboRun(number(sender.tab && sender.tab.id));
    if (["start", "manual-claim", "c-module-action"].includes(message.type)) {
      if (turboRun) throw new Error("极速模式正在发送或核对，不能重复启动领取");
      const recoveryJournal = await turboJournal();
      const recoveryState = await loadState();
      const recoveryRoute = await turboRouteState(recoveryState);
      if (recoveryJournal || recoveryRoute?.unsettled || recoveryRoute?.uncertain) {
        // Switching away from turbo must finish its persisted reconciliation
        // before ordinary/accelerated claiming is allowed. A previous stop
        // could leave the journal behind even after the sender had stopped.
        // Recover it here so the user does not need to refresh or unlock
        // manually; failures still keep the safety lock.
        const tabId = number(sender.tab && sender.tab.id);
        if (!tabId) throw new Error("极速任务流仍待核对，请在工作页面中重试");
        await recoverTurboRun(tabId);
        if (await turboJournal()) throw new Error("极速任务流仍待核对，请稍候重试");
      }
    }
    if (message.type === "init") return initializePage(message, sender);
    if (message.type === "platform-account") return updatePlatformAccount(message);
    if (message.type === "set-settings") return retryAfterCPolicyTransition(() => updateSettings(message));
    if (message.type === "import-workload") return importLegacyWorkload(message);
    if (message.type === "refresh-catalog") return refreshLocalCatalog(message, sender);
    if (message.type === "start") return retryAfterCPolicyTransition(() => startServer(message, sender));
    if (message.type === "manual-claim") return manualClaimTask(message, sender);
    if (message.type === "c-module-action") return handleCModuleAction(message, sender);
    if (message.type === "page-exit") return handlePageExit(message, sender);
    if (message.type === "stop") return stopServer(message.reason || "使用者已停止");
    throw new Error("未知操作");
  });
  operation.then(sendResponse, async (error) => {
    const errorText = String(error && error.message || error);
    if (isServerAccessRevoked(error)) {
      try {
        const revokedState = await enqueue(() => applyServerAccessRevocation(error));
        sendResponse({...await publicStatus(revokedState, await loadSession()), ok: false, error: serverAccessRevokedReason(error)});
      } catch (revokeError) {
        sendResponse({ok: false, error: serverAccessRevokedReason(error)});
      }
      return;
    }
    try {
      sendResponse({...await publicStatus(), ok: false, error: errorText});
    } catch (statusError) {
      sendResponse({ok: false, error: errorText});
    }
  });
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== "xiaotian-v24-page") return;
  cPolicyPagePorts.add(port);
  ensureCPolicyWatchLoop().catch(() => {});
  port.onDisconnect.addListener(() => {
    cPolicyPagePorts.delete(port);
    stopCPolicyWatchLoopIfIdle();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  dispatchEmergencyStop("验收页面或浏览器已关闭，服务器核心已紧急停止", tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading" && !changeInfo.url) return;
  if (changeInfo.status === "loading") stopTurboRun("工作页面正在刷新，停止新增请求", tabId);
  const currentUrl = String(changeInfo.url || tab && tab.url || "");
  if (currentUrl && !isSkyVendorPageUrl(currentUrl)) {
    dispatchEmergencyStop("本地已离开SkyVendor，服务器核心已紧急停止", tabId);
    return;
  }
  if (changeInfo.status !== "loading") return;
  enqueue(async () => {
    const session = await loadSession();
    if (!isRunningSessionTab(session, tabId)) return;
    // Only the tab bound to the running session may reset its loops.  A
    // separate acceptance tab can be opened or refreshed without interrupting
    // the original working tab.
    stopLocalCatalogLoop(tabId);
    stopControlLoop();
    stopRelayLoops();
    await saveSession({
      running: true,
      tabId,
      refreshing: true,
      refreshStartedAt: Date.now(),
    });
  }).catch(() => {});
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, {scope: "xiaotian-v24", type: "toggle-panel"}).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm) return;
  if (alarm.name === CONFIG.HEARTBEAT_ALARM) {
    enqueue(runHeartbeatAlarm).catch(() => {});
    return;
  }
  if (alarm.name === C_POLICY_REFRESH_ALARM || alarm.name === C_POLICY_EXPIRY_ALARM) {
    enqueue(() => runCPolicyAlarm(alarm.name)).catch(() => {});
  }
});

async function runCPolicyAlarm(alarmName) {
  let state = await loadState();
  const session = await loadSession();
  if (alarmName === C_POLICY_EXPIRY_ALARM && !cPolicyUsable()) {
    const wasDelegated = cPolicyCurrent() && cPolicyCurrent().delegated === true;
    clearCPolicyMemory("C策略已过期");
    if (session.running && wasDelegated) {
      await stopServer("C策略已过期，领取已停止", {forceServerRequest: true});
      state = await loadState();
    }
  } else if (state.installToken && state.userName) {
    try {
      state = await refreshCPolicy(state, true);
      await saveState(state);
    } catch (error) {
      state.lastError = String(error && error.message || error);
      await saveState(state);
    }
  }
  if (session.tabId) {
    await chrome.tabs.sendMessage(session.tabId, {
      scope: "xiaotian-v24",
      type: "status-update",
      status: await publicStatus(state, await loadSession()),
    }).catch(() => {});
  }
}

async function runHeartbeatAlarm() {
  const session = await loadSession();
  let state = await loadState();
  if (state.installToken) {
    let refreshError = "";
    let accessRevocationError = null;
    try {
      // Renew or recreate the short install lease before any protected config
      // or C-policy request.  A delayed MV3 alarm must not retry those routes
      // with an already expired token and stop an otherwise valid local run.
      state = await ensureConnected(state);
    } catch (error) {
      if (isServerAccessRevoked(error)) accessRevocationError = error;
      else refreshError = String(error && error.message || error);
    }
    if (!accessRevocationError) {
      try {
        state = await refreshRuntimeConfig(state, false);
      } catch (error) {
        if (isServerAccessRevoked(error)) accessRevocationError = error;
        else if (!refreshError) refreshError = String(error && error.message || error);
      }
    }
    if (!accessRevocationError) {
      try {
        state = await refreshCPolicy(state, false);
      } catch (error) {
        if (isServerAccessRevoked(error)) accessRevocationError = error;
        else if (!refreshError) refreshError = String(error && error.message || error);
      }
    }
    if (accessRevocationError) {
      await applyServerAccessRevocation(accessRevocationError);
      return;
    }
    if (refreshError) {
      state.lastError = `服务器配置更新失败：${refreshError}`;
      await saveState(state);
    } else if (/^服务器配置更新失败：/.test(String(state.lastError || ""))) {
      state.lastError = "";
      await saveState(state);
    }
  }
  await runIndependentReleaseWatchdog();
  if (!state.userName || !state.installToken) return;
  try {
    if (session.running && session.tabId) {
      const next = await pollServer({}, {tab: {id: session.tabId}});
      await chrome.tabs.sendMessage(session.tabId, {scope: "xiaotian-v24", type: "status-update", status: next}).catch(() => {});
    }
  } catch (error) {
    state.lastError = `服务器状态更新失败：${String(error && error.message || error)}`;
    await saveState(state);
    if (session.tabId) {
      await chrome.tabs.sendMessage(session.tabId, {scope: "xiaotian-v24", type: "status-update", status: await publicStatus(state, session)}).catch(() => {});
    }
  }
}

async function ensureHeartbeatAlarm() {
  const existing = await chrome.alarms.get(CONFIG.HEARTBEAT_ALARM);
  if (existing) return false;
  await chrome.alarms.create(CONFIG.HEARTBEAT_ALARM, {
    delayInMinutes: Math.max(1, Number(CONFIG.HEARTBEAT_MINUTES) || 1),
    periodInMinutes: Math.max(1, Number(CONFIG.HEARTBEAT_MINUTES) || 1),
  });
  return true;
}

if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(() => { ensureHeartbeatAlarm().catch(() => {}); });
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => { ensureHeartbeatAlarm().catch(() => {}); });
ensureHeartbeatAlarm().catch(() => {});
