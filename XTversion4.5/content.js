(() => {
  "use strict";
  if (!/^\/skyvendor\/dashboard\/annotation\/acceptance\/?$/.test(location.pathname)) return;
  if (globalThis.__xiaotianV24Loaded) return;
  globalThis.__xiaotianV24Loaded = true;

  const CONFIG = globalThis.XiaotianV24Config;
  const PANEL_LAYOUT_KEY = "xiaotianV30CPanelLayoutV1";
  const SOUND_ENABLED_KEY = "xiaotianV30CSoundEnabled";
  const TURBO_MODE_KEY = "xiaotianTurboSingleQueueV1";
  const TURBO_SMART_ROUTE_KEY = "xiaotianTurboSmartRouteV1";
  const RUNTIME_LOG_KEY = "xiaotianV30CRuntimeLogV1";
  const LOCAL_SCAN_MS = Math.max(100, Number(CONFIG.LOCAL_TASK_REFRESH_MS) || 100);
  const MIN_REQUEST_INTERVAL_MS = CONFIG.MIN_REQUEST_INTERVAL_MS || 0.000000001;
  const C_SANDBOX_CHANNEL = "xiaotian-c-sandbox-v1";
  const C_SANDBOX_ACTIONS = new Set(["claim", "idle"]);
  const EMPTY_C_POLICY = Object.freeze({
    usable: false,
    delegated: false,
    routeMode: "server",
    revision: 0,
    expiresAt: 0,
    moduleLoaded: false,
    reason: "正在读取服务器策略",
    defaults: Object.freeze({}),
    bounds: Object.freeze({}),
  });
  let status = null;
  let cPolicy = EMPTY_C_POLICY;
  let panel = null;
  let launcher = null;
  let clampPanelIntoViewport = () => {};
  let pagePort = null;
  let busy = false;
  let turboRecovering = false;
  let loginBusy = false;
  let loginCodeRequested = false;
  let loginNotice = "";
  let catalogBusy = false;
  let blockPageOpen = false;
  let taskPageOpen = false;
  let workloadPageOpen = false;
  let soundPageOpen = false;
  let activeMode = "auto";
  let workloadQuery = "";
  let previousClaimedPackages = null;
  let previousServerSuccessClaimAt = null;
  let soundEnabled = true;
  let turboMode = false;
  let slowModeTickBusy = false;
  let slowModeTimer = null;
  let turboSmartRouting = false;
  let audioContext = null;
  let successAudio = null;
  let customSound = null;
  let lastSuccessSoundAt = 0;
  let statusRefreshTimer = null;
  let statusRefreshBusy = false;
  let statusRefreshEpoch = 0;
  let loginStatusTimer = null;
  let loginStatusBusy = false;
  let loginProgressTimer = null;
  let loginProgressStartedAt = 0;
  let platformAccountWatchTimer = null;
  let lastReportedPlatformAccount = "";
  let cPolicyExpiryTimer = null;
  let cPolicyEpoch = 0;
  let cPolicyStateKey = "";
  let cSandboxGeneration = 0;
  let cSandbox = null;
  let cSandboxState = "未载入";
  let cSandboxError = "";
  let lastPolicyStopKey = "";
  let runtimeActivity = null;
  let runtimeLogs = [];
  let runtimeLogFlushTimer = null;
  let lastCatalogLogSignature = "";
  let runtimeSeenTaskCount = 0;

  function routineClaimResult(value) {
    return /(?:暂无待验收数据|系统繁忙|请稍后重试|请求过于频繁|操作频繁|访问频繁|限流|剩余可领取包数不足|任务可领取数量不足|没有可领取包|没有可领取容量|当前任务没有可领取包|任务不在当前.*队列|当前包数不符合.*领取阶段|已达到.*停止包数|任务已被领取|任务不存在|领取结果不确定|尚未发现新增工作包|平台已响应.*尚未发现)/.test(String(value || ""));
  }

  function recoverableCPolicyError(value) {
    const message = String(value || "").trim();
    return /(?:policy revision is stale|policy revision is newer than expected|当前已切换为C本机放权|当前已切换为A服务器|请先取得C短效策略|本机模块已经更新|C策略(?:无效|不可用|已失效|已过期)(?:，领取已停止)?)/i.test(message);
  }

  function loadRuntimeLogs() {
    try {
      const value = JSON.parse(localStorage.getItem(RUNTIME_LOG_KEY) || "[]");
      runtimeLogs = Array.isArray(value) ? value.slice(-200) : [];
    } catch (error) {
      runtimeLogs = [];
    }
  }

  function saveRuntimeLogs() {
    try { localStorage.setItem(RUNTIME_LOG_KEY, JSON.stringify(runtimeLogs.slice(-200))); } catch (error) {}
  }

  function flushRuntimeLogs() {
    if (runtimeLogFlushTimer !== null) clearTimeout(runtimeLogFlushTimer);
    runtimeLogFlushTimer = null;
    saveRuntimeLogs();
    renderRuntimeLogs();
  }

  function addRuntimeLog(level, action, details = {}) {
    const entry = {
      at: Date.now(),
      level: ["ok", "warn", "error"].includes(level) ? level : "info",
      action: String(action || "运行状态").slice(0, 40),
      taskId: String(details.taskId || "").slice(0, 80),
      taskName: String(details.taskName || "").slice(0, 120),
      amount: Math.max(0, Math.trunc(Number(details.amount) || 0)),
      durationMs: Math.max(0, Math.trunc(Number(details.durationMs) || 0)),
      durationLabel: String(details.durationLabel || "").slice(0, 20),
      message: String(details.message || "").slice(0, 200),
    };
    runtimeLogs.push(entry);
    runtimeLogs = runtimeLogs.slice(-200);
    if (runtimeLogFlushTimer === null) runtimeLogFlushTimer = setTimeout(flushRuntimeLogs, 250);
  }

  function setRuntimeActivity(phase, text, details = {}) {
    const previous = runtimeActivity && typeof runtimeActivity === "object" ? runtimeActivity : {};
    const suppliedMode = details.mode === "pre-submit" || details.mode === "normal" ? details.mode : "";
    const mode = suppliedMode || String(previous.mode || "");
    const suppliedInterval = requestIntervalValue(details.effectiveIntervalMs);
    const previousInterval = mode && mode === previous.mode && previous.policyRevision === cPolicy.revision
      ? requestIntervalValue(previous.effectiveIntervalMs)
      : 0;
    runtimeActivity = {
      phase: String(phase || "扫描中").slice(0, 40),
      text: String(text || "继续扫描").slice(0, 240),
      taskId: String(details.taskId || "").slice(0, 80),
      taskName: String(details.taskName || "").slice(0, 160),
      mode,
      effectiveIntervalMs: suppliedInterval || previousInterval,
      policyRevision: Number(details.policyRevision) || cPolicy.revision,
      accelerationTier: Object.prototype.hasOwnProperty.call(details, "accelerationTier")
        ? Math.max(0, Math.trunc(Number(details.accelerationTier) || 0))
        : Math.max(0, Math.trunc(Number(previous.accelerationTier) || 0)),
      at: Date.now(),
    };
    render();
  }

  function escapeRuntimeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    })[character]);
  }

  function runtimeLogText(entry) {
    const task = entry.taskName || entry.taskId;
    const parts = [entry.action];
    if (task) parts.push(`${task}${entry.taskId && entry.taskName ? `（${entry.taskId}）` : ""}`);
    if (entry.amount) parts.push(`${entry.amount}包`);
    if (entry.durationMs) parts.push(`${entry.durationLabel || "处理耗时"}=${entry.durationMs}ms`);
    if (entry.message) parts.push(entry.message);
    return uiText(parts.join("｜"));
  }

  function renderRuntimeLogs() {
    if (!panel) return;
    const node = panel.querySelector("#sv-runtime-log");
    if (!node) return;
    node.innerHTML = runtimeLogs.length
      ? runtimeLogs.slice(-200).reverse().map((entry) => {
        const time = new Date(Number(entry.at) || Date.now()).toLocaleTimeString("zh-CN", {hour12: false});
        return `<div class="sv-log-entry ${escapeRuntimeHtml(entry.level)}">${escapeRuntimeHtml(time)}｜${escapeRuntimeHtml(runtimeLogText(entry))}</div>`;
      }).join("")
      : '<div class="sv-log-empty">暂无运行日志</div>';
  }

  async function copyRuntimeLogs() {
    const text = runtimeLogs.map((entry) => {
      const time = new Date(Number(entry.at) || Date.now()).toLocaleString("zh-CN", {hour12: false});
      return `${time}｜${runtimeLogText(entry)}`;
    }).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      const footer = panel && panel.querySelector("#sv-status");
      if (footer) {
        footer.textContent = "运行日志已复制";
        footer.className = "sv-status ok";
      }
    } catch (error) {
      const footer = panel && panel.querySelector("#sv-status");
      if (footer) {
        footer.textContent = "复制失败，请检查剪贴板权限";
        footer.className = "sv-status error";
      }
    }
  }

  function validPlatformAccount(value) {
    const account = String(value || "").replace(/\s+/g, " ").trim().slice(0, 128);
    if (!account || /^(?:[-—_·.]+|未登记|未登記|未知|null|undefined)$/i.test(account)) return "";
    return account;
  }

  function platformAccount() {
    for (const direct of document.querySelectorAll('[class*="_userName_"]')) {
      const account = validPlatformAccount(direct && direct.textContent);
      if (account) return account;
    }
    const menu = document.querySelector('button[aria-label="用户与组织菜单"]');
    return validPlatformAccount(menu && menu.parentElement && menu.parentElement.textContent);
  }

  function stopPlatformAccountWatch() {
    if (platformAccountWatchTimer) clearInterval(platformAccountWatchTimer);
    platformAccountWatchTimer = null;
  }

  function reportPlatformAccount() {
    const account = platformAccount();
    if (!account || account === lastReportedPlatformAccount) return false;
    lastReportedPlatformAccount = account;
    send({type: "platform-account", platformAccount: account}, 8000).then((response) => {
      if (response && response.ok !== false) applyStatus(response);
    });
    return true;
  }

  function watchPlatformAccount() {
    stopPlatformAccountWatch();
    if (reportPlatformAccount()) return;
    const deadline = Date.now() + 30000;
    platformAccountWatchTimer = setInterval(() => {
      if (reportPlatformAccount() || Date.now() >= deadline) stopPlatformAccountWatch();
    }, 500);
  }

  function send(message, timeoutMs = 12000) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value || {ok: false, error: "扩展后台无回应"});
      };
      const timeout = setTimeout(() => finish({ok: false, error: "扩展后台响应超时"}), timeoutMs);
      try {
        if (!chrome.runtime || !chrome.runtime.id) throw new Error("Extension context invalidated");
        chrome.runtime.sendMessage({scope: "xiaotian-v24", ...message}, (response) => {
          const runtimeError = chrome.runtime && chrome.runtime.lastError;
          if (runtimeError) {
            const text = String(runtimeError.message || runtimeError);
            finish({ok: false, error: /context invalidated/i.test(text) ? "扩展已更新，请刷新当前网页" : text});
            return;
          }
          finish(response);
        });
      } catch (error) {
        const text = String(error && error.message || error);
        finish({ok: false, error: /context invalidated/i.test(text) ? "扩展已更新，请刷新当前网页" : text});
      }
    });
  }

  function loginMessageTimeoutMs() {
    return Math.max(35000, Math.min(185000, (Number(CONFIG.LOGIN_REQUEST_TIMEOUT_MS) || 90000) + 5000));
  }

  function requestIntervalValue(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.max(MIN_REQUEST_INTERVAL_MS, parsed) : 0;
  }

  function formatInterval(milliseconds = LOCAL_SCAN_MS) {
    const value = requestIntervalValue(milliseconds) || LOCAL_SCAN_MS;
    const display = value < 1 ? value : value / 1000;
    return `${display.toLocaleString("en-US", {useGrouping: false, maximumSignificantDigits: 15})}${value < 1 ? "ms" : "秒"}`;
  }

  function formatOrdinaryInterval(milliseconds) {
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value <= 0) return "等待调度";
    return value < 1 ? `${value.toFixed(2)}ms` : `${(value / 1000).toFixed(2)}秒`;
  }

  function displayedRequestInterval(settings, worker) {
    const turbo = status && status.turbo || {};
    if (turbo.active || turboMode && cLocalDelegated()) {
      const active = turbo.active ? requestIntervalValue(turbo.activeIntervalMs) : 0;
      return active || requestIntervalValue(cPolicy.defaults?.preSubmitIntervalMs)
        || requestIntervalValue(turbo.serverIntervalMs);
    }
    if (status?.running) {
      if (!cLocalDelegated()) return requestIntervalValue(worker.effectiveIntervalMs) || settings.preSubmitIntervalMs;
      if (runtimeActivity?.policyRevision === cPolicy.revision) {
        return requestIntervalValue(runtimeActivity.effectiveIntervalMs) || settings.preSubmitIntervalMs;
      }
    }
    return settings.preSubmitIntervalMs;
  }

  function loadUiPreferences() {
    try {
      soundEnabled = localStorage.getItem(SOUND_ENABLED_KEY) !== "false";
      turboMode = localStorage.getItem(TURBO_MODE_KEY) === "true";
      turboSmartRouting = localStorage.getItem(TURBO_SMART_ROUTE_KEY) === "true";
    } catch (error) {
      soundEnabled = true;
    }
    loadRuntimeLogs();
  }

  function saveSoundPreference() {
    try { localStorage.setItem(SOUND_ENABLED_KEY, soundEnabled ? "true" : "false"); } catch (error) {}
  }

  function connectPage() {
    try {
      pagePort = chrome.runtime.connect({name: "xiaotian-v24-page"});
      pagePort.onDisconnect.addListener(() => { pagePort = null; });
    } catch (error) {
      pagePort = null;
    }
  }

  function policyTimestamp(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return Math.trunc(numeric);
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function frozenPolicyValue(value, depth = 0) {
    if (depth > 5) return null;
    if (Array.isArray(value)) return Object.freeze(value.slice(0, 500).map((item) => frozenPolicyValue(item, depth + 1)));
    if (value && typeof value === "object") {
      const output = {};
      for (const [key, item] of Object.entries(value).slice(0, 200)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        output[key] = frozenPolicyValue(item, depth + 1);
      }
      return Object.freeze(output);
    }
    if (["string", "number", "boolean"].includes(typeof value) || value == null) return value;
    return null;
  }

  function normalizeCPolicy(value) {
    const source = value && typeof value === "object" ? value : {};
    const delegated = source.delegated === true;
    const requestedRoute = String(source.routeMode || "server").trim().toLowerCase();
    return Object.freeze({
      usable: source.usable === true,
      delegated,
      routeMode: delegated && ["local", "direct"].includes(requestedRoute) ? "local" : "server",
      revision: Math.max(0, Math.trunc(Number(source.revision) || 0)),
      expiresAt: policyTimestamp(source.expiresAt),
      moduleLoaded: source.moduleLoaded === true,
      reason: String(source.reason || "").slice(0, 300),
      defaults: frozenPolicyValue(source.defaults && typeof source.defaults === "object" ? source.defaults : {}),
      bounds: frozenPolicyValue(source.bounds && typeof source.bounds === "object" ? source.bounds : {}),
    });
  }

  function cPolicyUsable(policy = cPolicy) {
    return policy.usable === true && policy.revision > 0 && policy.expiresAt > Date.now();
  }

  function cPolicyKey(policy) {
    const value = policy && typeof policy === "object" ? policy : EMPTY_C_POLICY;
    return [
      value.usable === true ? 1 : 0,
      value.delegated === true ? 1 : 0,
      value.routeMode,
      Number(value.revision) || 0,
      Number(value.expiresAt) || 0,
      value.moduleLoaded === true ? 1 : 0,
    ].join(":");
  }

  function cLocalDelegated(policy = cPolicy) {
    return !authorizationError() && cPolicyUsable(policy) && policy.delegated === true && policy.routeMode === "local";
  }

  function cLocalSettingsEditable(policy = cPolicy) {
    return cLocalDelegated(policy) && policy.moduleLoaded === true;
  }

  function cLocalExecutionReady(policy = cPolicy) {
    return cLocalSettingsEditable(policy) && !!(cSandbox && cSandbox.ready === true);
  }

  function settingAliases(name) {
    return ({
      targetPackages: ["targetPackages", "stopPackages"],
      claimAmount: ["claimAmount", "ordinaryClaimAmount"],
      taskPages: ["taskPages", "scanPages"],
      preSubmitAmount: ["preSubmitAmount"],
      preSubmitEnabled: ["preSubmitEnabled"],
      blockedTaskIds: ["blockedTaskIds"],
      selectedTaskIds: ["selectedTaskIds", "preSubmitTaskIds"],
      ordinaryClaimEnabled: ["ordinaryClaimEnabled"],
      ordinaryStartPackages: ["ordinaryStartPackages"],
      preSubmitStopPackages: ["preSubmitStopPackages"],
      preSubmitIntervalMs: ["preSubmitIntervalMs"],
      scanIntervalMs: ["scanIntervalMs", "minScanIntervalMs"],
      intervalTierPercentages: ["intervalTierPercentages"],
      accelerationTierMs: ["accelerationTierMs"],
      rateLimitRetryMs: ["rateLimitRetryMs"],
      errorRetryMs: ["errorRetryMs"],
    })[name] || [name];
  }

  function settingFrom(source, name, fallback) {
    const value = source && typeof source === "object" ? source : {};
    for (const alias of settingAliases(name)) {
      if (Object.prototype.hasOwnProperty.call(value, alias)) return value[alias];
    }
    return fallback;
  }

  function settingBound(name, edge, fallback) {
    const bounds = cPolicy.bounds && typeof cPolicy.bounds === "object" ? cPolicy.bounds : {};
    const candidates = [];
    for (const alias of settingAliases(name)) {
      const direct = bounds[alias] && typeof bounds[alias] === "object" ? bounds[alias] : {};
      const capitalized = alias.charAt(0).toUpperCase() + alias.slice(1);
      candidates.push(edge === "min" ? direct.min : direct.max);
      candidates.push(edge === "min" ? direct.minimum : direct.maximum);
      candidates.push(bounds[`${edge}${capitalized}`]);
    }
    for (const value of candidates) {
      const numeric = name === "preSubmitIntervalMs" ? Number(value) : Math.trunc(Number(value));
      if ((name === "preSubmitIntervalMs" ? Number.isFinite(numeric) : Number.isSafeInteger(numeric)) && numeric >= 0) return numeric;
    }
    return fallback;
  }

  function boundedSetting(name, value, fallback, minimum = 1) {
    const min = Math.max(minimum, settingBound(name, "min", minimum));
    const max = Math.max(min, settingBound(name, "max", Number.MAX_SAFE_INTEGER));
    const fractional = name === "preSubmitIntervalMs";
    const numeric = fractional ? Number(value) : Math.trunc(Number(value));
    return Math.max(min, Math.min(max, (fractional ? Number.isFinite(numeric) : Number.isSafeInteger(numeric)) ? numeric : fallback));
  }

  function effectiveSettings() {
    const reported = status && status.settings && typeof status.settings === "object" ? status.settings : {};
    const defaults = cPolicy.defaults && typeof cPolicy.defaults === "object" ? cPolicy.defaults : {};
    const source = cLocalSettingsEditable() ? {...defaults, ...reported} : (Object.keys(defaults).length ? defaults : reported);
    const ordinaryOnly = cLocalDelegated() && (!accelerationAvailable()
      || (!turboMode && settingFrom(source, "preSubmitEnabled", true) === false));
    const selectedTaskIds = normalizedTaskIds(settingFrom(source, "selectedTaskIds", []));
    const blockedTaskIds = normalizedTaskIds(settingFrom(source, "blockedTaskIds", []));
    const targetFallback = Math.max(1, Math.trunc(Number(settingFrom(defaults, "targetPackages", 3)) || 3));
    const claimFallback = Math.max(1, Math.trunc(Number(settingFrom(defaults, "claimAmount", 1)) || 1));
    const pageFallback = Math.max(1, Math.trunc(Number(settingFrom(defaults, "taskPages", 1)) || 1));
    const preSubmitFallback = Math.max(1, Math.trunc(Number(settingFrom(defaults, "preSubmitAmount", 1)) || 1));
    const rawIntervalTiers = settingFrom(source, "intervalTierPercentages", []);
    const intervalTierPercentages = Array.isArray(rawIntervalTiers)
      ? rawIntervalTiers
        .map((item) => Math.max(1, Math.min(100, Math.trunc(Number(item) || 0))))
        .filter(Boolean)
        .slice(0, 32)
      : [];
    return {
      targetPackages: boundedSetting("targetPackages", settingFrom(source, "targetPackages", targetFallback), targetFallback),
      claimAmount: boundedSetting("claimAmount", settingFrom(source, "claimAmount", claimFallback), claimFallback),
      taskPages: boundedSetting("taskPages", settingFrom(source, "taskPages", pageFallback), pageFallback),
      acceptPartial: true,
      preSubmitEnabled: ordinaryOnly ? false : turboMode && cLocalDelegated() ? true : settingFrom(source, "preSubmitEnabled", true) !== false,
      preSubmitAmount: boundedSetting("preSubmitAmount", settingFrom(source, "preSubmitAmount", preSubmitFallback), preSubmitFallback),
      ordinaryClaimEnabled: ordinaryOnly || (!turboMode && settingFrom(source, "ordinaryClaimEnabled", false) === true),
      ordinaryStartPackages: boundedSetting("ordinaryStartPackages", settingFrom(source, "ordinaryStartPackages", 1), 1),
      preSubmitStopPackages: boundedSetting("preSubmitStopPackages", settingFrom(source, "preSubmitStopPackages", 1), 1),
      preSubmitIntervalMs: boundedSetting("preSubmitIntervalMs",
        settingFrom(defaults, "preSubmitIntervalMs", settingFrom(source, "preSubmitIntervalMs", 50)), 50, MIN_REQUEST_INTERVAL_MS),
      scanIntervalMs: boundedSetting("scanIntervalMs", settingFrom(source, "scanIntervalMs", LOCAL_SCAN_MS), LOCAL_SCAN_MS, LOCAL_SCAN_MS),
      intervalTierPercentages: intervalTierPercentages.length
        ? intervalTierPercentages
        : [100, 90, 80, 70, 60, 50, 40, 30, 20, 10],
      accelerationTierMs: Math.max(1000, Math.trunc(Number(settingFrom(source, "accelerationTierMs", 60 * 1000)) || 60 * 1000)),
      rateLimitRetryMs: Math.max(10, Math.trunc(Number(settingFrom(source, "rateLimitRetryMs", 5000)) || 5000)),
      errorRetryMs: Math.max(10, Math.trunc(Number(settingFrom(source, "errorRetryMs", 2000)) || 2000)),
      blockedTaskIds,
      selectedTaskIds,
      taskSelectionRequired: source.taskSelectionRequired === true && selectedTaskIds.length === 0,
      preSubmitTaskIds: selectedTaskIds,
    };
  }

  function currentSettings() {
    const base = effectiveSettings();
    if (!panel || !cLocalSettingsEditable()) return base;
    const read = (name, fallback) => {
      const input = panel.querySelector(`[name="${name}"]`);
      return boundedSetting(name, input && input.value, fallback);
    };
    const checkedTaskIds = (selector) => normalizedTaskIds(Array.from(panel
      ? panel.querySelectorAll(`${selector} input[data-task-id]:checked`)
      : []).map((input) => input.dataset.taskId));
    const selectedTaskIds = checkedTaskIds(".sv24-task-page .sv24-task-list");
    return {
      ...base,
      targetPackages: read("targetPackages", base.targetPackages),
      claimAmount: read("claimAmount", base.claimAmount),
      taskPages: read("taskPages", base.taskPages),
      acceptPartial: true,
      preSubmitEnabled: accelerationAvailable() && (turboMode || panel.querySelector('[name="preSubmitEnabled"]')?.checked === true),
      preSubmitAmount: read("preSubmitAmount", base.preSubmitAmount),
      blockedTaskIds: checkedTaskIds(".sv24-block-list"),
      selectedTaskIds,
      preSubmitTaskIds: selectedTaskIds,
    };
  }

  function randomSessionNonce() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  function cModuleEnvelope(source) {
    const root = source && typeof source === "object" ? source : {};
    const policySource = root.cPolicy && typeof root.cPolicy === "object" ? root.cPolicy : {};
    const nested = root.cModule && typeof root.cModule === "object"
      ? root.cModule
      : policySource.module && typeof policySource.module === "object" ? policySource.module : {};
    const moduleSource = String(nested.moduleSource || nested.source || root.moduleSource || policySource.moduleSource || "");
    const moduleHash = String(nested.moduleHash || nested.hash || root.moduleHash || policySource.moduleHash || "").trim();
    const moduleToken = String(nested.moduleToken || nested.token || root.moduleToken || policySource.moduleToken || "").trim();
    return {
      moduleSource: moduleSource.length <= 2_000_000 ? moduleSource : "",
      moduleHash: moduleHash.slice(0, 256),
      moduleToken: moduleToken.slice(0, 8192),
    };
  }

  function statusWithoutModule(source) {
    const root = source && typeof source === "object" ? source : {ok: false, error: "无法读取扩展状态"};
    const output = {...root};
    delete output.moduleSource;
    delete output.moduleHash;
    delete output.moduleToken;
    delete output.cModule;
    if (root.cPolicy && typeof root.cPolicy === "object") {
      output.cPolicy = {...root.cPolicy};
      delete output.cPolicy.moduleSource;
      delete output.cPolicy.moduleHash;
      delete output.cPolicy.moduleToken;
      delete output.cPolicy.module;
    }
    return output;
  }

  function base64FromBytes(bytes) {
    let binary = "";
    for (const value of bytes) binary += String.fromCharCode(value);
    return btoa(binary);
  }

  async function matchingModuleHash(moduleSource, expectedHash) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(moduleSource)));
    const hex = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
    const base64 = base64FromBytes(digest);
    const base64Url = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const expected = String(expectedHash || "").trim();
    return expected.toLowerCase() === hex
      || expected === base64
      || expected === base64Url
      || expected === `sha256-${base64}`
      || expected === `sha256-${base64Url}`;
  }

  function serializableMessage(value, maximum = 128000) {
    try {
      const json = JSON.stringify(value == null ? null : value);
      if (json.length > maximum) return null;
      return JSON.parse(json);
    } catch (error) {
      return null;
    }
  }

  function sandboxStatusSnapshot() {
    const worker = status && status.worker && typeof status.worker === "object" ? status.worker : {};
    const tasks = taskCatalog(worker).slice(0, 200);
    const settings = effectiveSettings();
    if (settings.taskSelectionRequired && !(turboMode && turboSmartRouting && cLocalDelegated())) {
      settings.preSubmitEnabled = false;
      settings.ordinaryClaimEnabled = false;
    }
    if (turboMode && turboSmartRouting && cLocalDelegated()) {
      const route = status?.turbo?.route;
      const pinned = route && (!route.canSwitch || Number(worker.workingPackages) > 0);
      settings.selectedTaskIds = pinned ? [route.taskId] : [];
      settings.preSubmitTaskIds = settings.selectedTaskIds;
      // A pinned route is an ownership constraint, never a synthetic catalog entry.
    }
    const platformRead = platformReadSnapshot(worker);
    return {
      // The local host owns ordinary-only pacing; the downloaded acceleration
      // module stays idle so its old ordinary start line cannot block zero bags.
      running: status && status.running === true && settings.preSubmitEnabled !== false,
      userName: String(status && status.userName || "").slice(0, 128),
      settings,
      cPolicy: {
        usable: cPolicyUsable(),
        delegated: cPolicy.delegated,
        routeMode: cPolicy.routeMode,
        revision: cPolicy.revision,
        expiresAt: cPolicy.expiresAt,
        moduleLoaded: cPolicy.moduleLoaded,
        fractionalCInterval: cLocalDelegated() && (Number(cPolicy.bounds?.preSubmitIntervalMs?.min) < 10
          || Number.isFinite(cPolicy.defaults?.preSubmitIntervalMs) && !Number.isInteger(cPolicy.defaults.preSubmitIntervalMs)),
      },
      worker: {
        workingPackages: Math.max(0, Number(worker.workingPackages) || 0),
        currentTaskId: String(worker.currentTaskId || "").slice(0, 80),
        taskCatalog: tasks,
        platformRead,
        availableTasks: Math.max(0, Number(worker.availableTasks) || 0),
        claimedPackages: Math.max(0, Number(worker.claimedPackages) || 0),
        localScanRounds: Math.max(0, Number(worker.localScanRounds || worker.rounds) || 0),
      },
      observedAt: Date.now(),
    };
  }

  function postToCSandbox(type, payload = {}) {
    const bridge = cSandbox;
    if (!bridge || !bridge.iframe || !bridge.iframe.contentWindow) return false;
    const message = {
      channel: C_SANDBOX_CHANNEL,
      direction: "content-to-sandbox",
      type,
      sessionNonce: bridge.sessionNonce,
      ...payload,
    };
    if (bridge.channelConnected && bridge.messagePort) bridge.messagePort.postMessage(message);
    else bridge.iframe.contentWindow.postMessage(message, "*");
    return true;
  }

  function sendCSandboxModule(bridge = cSandbox) {
    if (!bridge || !bridge.iframe || !bridge.iframe.contentWindow || !bridge.moduleSource) return false;
    const message = {
      channel: C_SANDBOX_CHANNEL,
      direction: "content-to-sandbox",
      type: "load-module",
      sessionNonce: bridge.sessionNonce,
      moduleSource: bridge.moduleSource,
      moduleHash: bridge.moduleHash,
    };
    if (bridge.channelConnected && bridge.messagePort) bridge.messagePort.postMessage(message);
    else bridge.iframe.contentWindow.postMessage(message, "*");
    return true;
  }

  function connectCSandboxMessagePort(bridge = cSandbox) {
    if (!bridge || !bridge.iframe || !bridge.iframe.contentWindow || !bridge.transferPort) return false;
    const transferPort = bridge.transferPort;
    try {
      bridge.iframe.contentWindow.postMessage({
        channel: C_SANDBOX_CHANNEL,
        direction: "content-to-sandbox",
        type: "connect",
        sessionNonce: bridge.sessionNonce,
      }, "*", [transferPort]);
      bridge.transferPort = null;
      bridge.channelOffered = true;
      return true;
    } catch (error) {
      try { bridge.messagePort && bridge.messagePort.close(); } catch (closeError) {}
      try { transferPort.close(); } catch (closeError) {}
      bridge.messagePort = null;
      bridge.transferPort = null;
      bridge.channelOffered = false;
      bridge.channelConnected = false;
      cSandboxState = "兼容通道连接中";
      render();
      return false;
    }
  }

  function sendStatusToCSandbox() {
    if (!cSandbox || cSandbox.ready !== true) return;
    postToCSandbox("status-update", {status: sandboxStatusSnapshot()});
  }

  function bestEffortBackgroundStop(bridge, reason) {
    if (!bridge) return;
    try {
      chrome.runtime.sendMessage({
        scope: "xiaotian-v24",
        type: "stop",
        reason: String(reason || "C本机模块已停止").slice(0, 200),
        cSessionNonce: bridge.sessionNonce,
        moduleToken: bridge.moduleToken,
        policyRevision: bridge.revision,
      }, () => void (chrome.runtime && chrome.runtime.lastError));
    } catch (error) {}
  }

  function bestEffortPolicyStop(reason) {
    if (!(status && status.running)) return;
    const stopKey = `${cPolicy.revision}:${cPolicy.expiresAt}:${String(reason || "")}`;
    if (lastPolicyStopKey === stopKey) return;
    lastPolicyStopKey = stopKey;
    try {
      chrome.runtime.sendMessage({
        scope: "xiaotian-v24",
        type: "stop",
        reason: String(reason || "C策略不可用").slice(0, 200),
        policyRevision: cPolicy.revision,
      }, () => void (chrome.runtime && chrome.runtime.lastError));
    } catch (error) {}
  }

  function teardownCSandbox(reason = "本机模块已停止", notifyBackground = true) {
    const bridge = cSandbox;
    if (!bridge) return;
    cSandboxGeneration += 1;
    if (bridge.loadTimer) clearTimeout(bridge.loadTimer);
    if (bridge.retryTimer) clearInterval(bridge.retryTimer);
    try { postToCSandbox("stop", {reason: String(reason).slice(0, 200)}); } catch (error) {}
    if (notifyBackground) bestEffortBackgroundStop(bridge, reason);
    try { bridge.messagePort && bridge.messagePort.close(); } catch (error) {}
    try { bridge.transferPort && bridge.transferPort.close(); } catch (error) {}
    try { bridge.iframe.remove(); } catch (error) {}
    try { bridge.clearModuleSource && bridge.clearModuleSource(); } catch (error) {}
    bridge.moduleToken = "";
    bridge.sessionNonce = "";
    cSandbox = null;
    cSandboxState = "未载入";
  }

  function scheduleCPolicyExpiry() {
    if (cPolicyExpiryTimer) clearTimeout(cPolicyExpiryTimer);
    cPolicyExpiryTimer = null;
    if (!cPolicy.expiresAt) return;
    const scheduledEpoch = cPolicyEpoch;
    const scheduledRevision = cPolicy.revision;
    const scheduledExpiresAt = cPolicy.expiresAt;
    const delay = Math.max(0, Math.min(2_147_000_000, scheduledExpiresAt - Date.now() + 20));
    cPolicyExpiryTimer = setTimeout(() => {
      cPolicyExpiryTimer = null;
      if (scheduledEpoch !== cPolicyEpoch
        || cPolicy.revision !== scheduledRevision
        || cPolicy.expiresAt !== scheduledExpiresAt) return;
      // Only local delegated execution is governed by the C policy expiry.
      // Server-routed sessions continue under the install lease.
      if (cPolicy.delegated !== true || cPolicy.routeMode !== "local") return;
      if (!cPolicyUsable()) {
        if (cSandbox) teardownCSandbox("C策略已过期", true);
        else bestEffortPolicyStop("C策略已过期");
        cSandboxError = cPolicy.reason || "服务器策略已过期";
        render();
      }
    }, delay);
  }

  async function ensureCSandbox(envelope, policyEpoch = cPolicyEpoch) {
    if (policyEpoch !== cPolicyEpoch) return;
    if (!cLocalSettingsEditable()) {
      if (cSandbox) teardownCSandbox(cPolicyUsable() ? "服务器已收回本机放权" : "C策略无效或已过期", true);
      return;
    }
    const moduleHash = String(envelope && envelope.moduleHash || "");
    const moduleToken = String(envelope && envelope.moduleToken || "");
    let moduleSource = String(envelope && envelope.moduleSource || "");
    if (envelope && typeof envelope === "object") {
      envelope.moduleSource = "";
      envelope.moduleToken = "";
    }
    if (cSandbox && (!moduleHash || cSandbox.moduleHash === moduleHash)) {
      cSandbox.policyEpoch = policyEpoch;
      if (moduleToken) cSandbox.moduleToken = moduleToken;
      cSandbox.revision = cPolicy.revision;
      moduleSource = "";
      sendStatusToCSandbox();
      return;
    }
    if (!moduleSource || !moduleHash || !moduleToken) {
      if (cSandbox) teardownCSandbox("本机模块资料不完整", true);
      cSandboxState = "等待模组";
      if (policyEpoch !== cPolicyEpoch) return;
      cSandboxError = "服务器尚未提供完整的 moduleSource、moduleHash、moduleToken";
      render();
      return;
    }
    if (cSandbox) teardownCSandbox("本机模块策略已更新", false);
    const generation = ++cSandboxGeneration;
    cSandboxState = "校验中";
    if (policyEpoch !== cPolicyEpoch) return;
    cSandboxError = "";
    render();
    let hashMatches = false;
    try {
      hashMatches = await matchingModuleHash(moduleSource, moduleHash);
    } catch (error) {
      if (policyEpoch !== cPolicyEpoch) return;
      cSandboxError = `模组SHA-256校验失败：${String(error && error.message || error)}`;
    }
    if (policyEpoch !== cPolicyEpoch || generation !== cSandboxGeneration || !cLocalSettingsEditable()) {
      moduleSource = "";
      return;
    }
    if (!hashMatches) {
      moduleSource = "";
      cSandboxState = "校验失败";
      cSandboxError ||= "moduleSource 与服务器 moduleHash 不一致";
      render();
      return;
    }
    const iframe = document.createElement("iframe");
    const sessionNonce = randomSessionNonce();
    const messageChannel = new MessageChannel();
    iframe.hidden = true;
    iframe.setAttribute("aria-hidden", "true");
    iframe.referrerPolicy = "no-referrer";
    iframe.src = chrome.runtime.getURL("c-sandbox.html");
    cSandbox = {
      iframe,
      sessionNonce,
      moduleHash,
      moduleToken,
      moduleSource,
      revision: cPolicy.revision,
      ready: false,
      claimInFlight: false,
      loadTimer: 0,
      retryTimer: 0,
      messagePort: messageChannel.port1,
      transferPort: messageChannel.port2,
      channelOffered: false,
      channelConnected: false,
      policyEpoch,
      clearModuleSource: () => { moduleSource = ""; },
    };
    const bridge = cSandbox;
    bridge.messagePort.onmessage = (event) => {
      if (cSandbox !== bridge) return;
      onCSandboxMessage(event, true);
    };
    bridge.messagePort.onmessageerror = () => {
      if (policyEpoch !== cPolicyEpoch || cSandbox !== bridge || bridge.ready || !bridge.channelOffered) return;
      cSandboxError = "sandbox 消息通道无法解析回报";
      teardownCSandbox(cSandboxError, true);
      cSandboxState = "载入失败";
      render();
    };
    bridge.messagePort.start();
    iframe.addEventListener("load", () => {
      if (policyEpoch !== cPolicyEpoch
        || !cSandbox
        || cSandbox.iframe !== iframe
        || generation !== cSandboxGeneration) return;
      cSandboxState = "消息通道连接中";
      render();
      connectCSandboxMessagePort(cSandbox);
      sendCSandboxModule(cSandbox);
    }, {once: true});
    iframe.addEventListener("error", () => {
      if (policyEpoch !== cPolicyEpoch || !cSandbox || cSandbox.iframe !== iframe) return;
      cSandboxState = "载入失败";
      cSandboxError = "无法载入 c-sandbox.html";
      teardownCSandbox(cSandboxError, true);
      render();
    }, {once: true});
    document.documentElement.appendChild(iframe);
    cSandbox.retryTimer = setInterval(() => {
      if (policyEpoch !== cPolicyEpoch || !cSandbox || cSandbox.iframe !== iframe || cSandbox.ready) return;
      sendCSandboxModule(cSandbox);
    }, 500);
    cSandbox.loadTimer = setTimeout(() => {
      if (policyEpoch !== cPolicyEpoch || !cSandbox || cSandbox.iframe !== iframe || cSandbox.ready) return;
      cSandboxError = `sandbox 模组载入超时（${cSandboxState}）`;
      teardownCSandbox(cSandboxError, true);
      cSandboxState = "载入失败";
      render();
    }, 15000);
  }

  function normalizeModuleClaim(payload) {
    const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    const taskId = String(source.taskId || "").trim().slice(0, 80);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId)) return null;
    const mode = turboMode && cLocalDelegated() ? "pre-submit" : source.mode === "pre-submit" ? "pre-submit" : "normal";
    const settings = effectiveSettings();
    if (Math.trunc(Number(source.policyRevision) || 0) !== cPolicy.revision) return null;
    if (mode === "normal" && settings.ordinaryClaimEnabled !== true) return null;
    if (mode === "pre-submit" && settings.preSubmitEnabled !== true) return null;
    if (settings.blockedTaskIds.includes(taskId)) return null;
    if (mode !== "normal" && !(turboMode && turboSmartRouting && cLocalDelegated())
      && settings.selectedTaskIds.length && !settings.selectedTaskIds.includes(taskId)) return null;
    const maximum = mode === "pre-submit" ? settings.preSubmitAmount : settings.claimAmount;
    const amount = Math.max(1, Math.min(maximum, Math.trunc(Number(source.amount) || 1)));
    return {
      mode,
      taskId,
      taskName: String(source.taskName || taskId).trim().slice(0, 160),
      amount,
      acceptPartial: true,
      effectiveIntervalMs: requestIntervalValue(source.effectiveIntervalMs) || settings.preSubmitIntervalMs,
      accelerationTier: Math.max(0, Math.trunc(Number(source.accelerationTier) || 0)),
      policyRevision: cPolicy.revision,
      turboMode: turboMode && mode === "pre-submit",
      turboSmartRouting: turboMode && turboSmartRouting && cLocalDelegated(),
    };
  }

  function moduleActionResult(response) {
    const source = response && typeof response === "object" ? response : {};
    return {
      ok: source.ok === true,
      error: String(source.error || "").slice(0, 300),
      actualAmount: Math.max(0, Math.trunc(Number(source.actualAmount) || 0)),
      taskId: String(source.taskId || "").slice(0, 80),
    };
  }

  async function handleCSandboxClaim(bridge, payload) {
    if (!cSandbox || cSandbox !== bridge || !cLocalExecutionReady() || bridge.claimInFlight) {
      postToCSandbox("action-result", {result: {ok: false, error: "本机模块当前不可领取", actualAmount: 0}});
      return;
    }
    const claim = normalizeModuleClaim(payload);
    if (!claim) {
      postToCSandbox("action-result", {result: {ok: false, error: "本机模块领取参数无效", actualAmount: 0}});
      return;
    }
    if (status?.turbo?.active) {
      postToCSandbox("action-result", {result: {ok: false, error: "极速模式正在发送或核对", actualAmount: 0}});
      return;
    }
    bridge.claimInFlight = true;
    bridge.turboSoundNotified = false;
    if (claim.turboMode) claim.effectiveIntervalMs = displayedRequestInterval(effectiveSettings(), status?.worker || {});
    const requestedAt = performance.now();
    bridge.turboClaim = claim.turboMode ? {claim, requestedAt} : null;
    const modeLabel = claim.mode === "pre-submit" ? "加速模式" : "领取";
    setRuntimeActivity(
      "请求中",
      `正在向${claim.taskName || `任务${claim.taskId}`}发起${modeLabel}，数量${claim.amount}包`,
      claim,
    );
    addRuntimeLog("info", `发起${modeLabel}`, claim);
    const response = await send({
      type: "c-module-action",
      sessionNonce: bridge.sessionNonce,
      action: "claim",
      payload: claim,
      moduleHash: bridge.moduleHash,
      moduleToken: bridge.moduleToken,
      policyRevision: bridge.revision,
    }, 40000);
    if (response && response.turboPending) {
      if (response.taskId) {
        claim.taskId = String(response.taskId);
        claim.taskName = taskCatalog(status?.worker).find((task) => task.taskId === claim.taskId)?.name || claim.taskId;
      }
      return;
    }
    finishCSandboxClaim(bridge, claim, response, requestedAt);
  }

  function finishCSandboxClaim(bridge, claim, response, requestedAt) {
    bridge.turboClaim = null;
    if (claim.turboMode && response?.taskId) {
      claim.taskId = String(response.taskId);
      claim.taskName = taskCatalog(status?.worker).find((task) => task.taskId === claim.taskId)?.name || claim.taskId;
    }
    const result = moduleActionResult(response);
    if (response?.claimDeferred) {
      applyStatus(response);
      bridge.claimInFlight = false;
      postToCSandbox("action-result", {result});
      return;
    }
    const durationMs = Math.max(0, Math.round(performance.now() - requestedAt));
    if (result.ok && result.actualAmount > 0) {
      if (!claim.turboMode || bridge.turboSoundNotified !== true) playClaimSuccessSound();
      setRuntimeActivity("领取成功", `${claim.taskName || `任务${claim.taskId}`}确认新增${result.actualAmount}包`, claim);
      addRuntimeLog("ok", "领取成功", {...claim, amount: result.actualAmount, durationMs, durationLabel: "本轮耗时"});
    } else {
      const message = result.error || "本轮未领取到任务";
      const routine = routineClaimResult(message);
      setRuntimeActivity(
        routine ? "继续扫描" : "请求失败",
        `${claim.taskName || `任务${claim.taskId}`}未领取成功：${message}${routine ? "；继续尝试其他任务" : ""}`,
        claim,
      );
      addRuntimeLog(routine ? "warn" : "error", routine ? "未领到，继续扫描" : "领取失败", {
        ...claim,
        durationMs,
        durationLabel: "本轮耗时",
        message,
      });
    }
    // Publish the reconciled route before the module schedules another choice.
    if (response && typeof response === "object") applyStatus(response);
    if (cSandbox === bridge) {
      sendStatusToCSandbox();
      bridge.claimInFlight = false;
      postToCSandbox("action-result", {result});
    }
  }

  function onCSandboxMessage(event, viaMessagePort = false) {
    const bridge = cSandbox;
    if (!bridge || bridge.policyEpoch !== cPolicyEpoch) return;
    const message = event.data && typeof event.data === "object" ? event.data : {};
    if (message.channel !== C_SANDBOX_CHANNEL || message.direction !== "sandbox-to-content") return;
    if (message.type === "sandbox-ready") {
      if (viaMessagePort) bridge.channelConnected = true;
      // WindowProxy object identity can differ across Chrome isolated worlds.
      // The module is still posted only to this bridge's iframe; subsequent
      // messages are authenticated with the per-load 192-bit session nonce.
      cSandboxState = "沙盒握手中";
      render();
      sendCSandboxModule(bridge);
      return;
    }
    if (message.sessionNonce !== bridge.sessionNonce) return;
    if (message.type === "module-loaded") {
      if (bridge.ready) return;
      if (String(message.moduleHash || "") !== bridge.moduleHash) {
        cSandboxError = "sandbox 回报的模组Hash不一致";
        teardownCSandbox(cSandboxError, true);
        render();
        return;
      }
      if (bridge.loadTimer) clearTimeout(bridge.loadTimer);
      if (bridge.retryTimer) clearInterval(bridge.retryTimer);
      bridge.loadTimer = 0;
      bridge.retryTimer = 0;
      bridge.moduleSource = "";
      bridge.ready = true;
      cSandboxState = "本机放权";
      cSandboxError = "";
      setRuntimeActivity("扫描中", "本机模组已就绪，正在扫描可领取任务");
      addRuntimeLog("ok", "本机模组已就绪");
      sendStatusToCSandbox();
      render();
      void initializeAccelerationQueue();
      return;
    }
    if (message.type === "module-error") {
      cSandboxError = String(message.error || "sandbox 模组执行失败").slice(0, 300);
      teardownCSandbox(cSandboxError, true);
      cSandboxState = "模组异常";
      render();
      return;
    }
    if (message.type !== "action" || !C_SANDBOX_ACTIONS.has(message.action)) return;
    const payload = serializableMessage(message.payload);
    if (payload == null) return;
    if (message.action === "idle") {
      const mode = String(payload.mode || "等待").slice(0, 40);
      cSandboxState = mode === "stopped" ? "已达停止线" : mode === "waiting" ? "等待条件" : "本机待命";
      const reason = String(payload.reason || "");
      const detail = mode === "stopped"
        ? "已达到停止包数，等待工作任务完成"
        : mode === "waiting"
          ? "当前包数不在领取阶段，持续检查工作状态"
          : reason === "no-task" ? "本轮没有可领取候选，继续扫描" : "正在等待下一轮扫描";
      setRuntimeActivity(mode === "stopped" ? "等待完成" : "扫描中", detail, payload);
      render();
      return;
    }
    void handleCSandboxClaim(bridge, payload);
  }

  window.addEventListener("message", onCSandboxMessage, false);

  function setText(selector, value) {
    const element = panel && panel.querySelector(selector);
    if (element) element.textContent = String(value == null || value === "" ? "—" : value);
  }

  function browserAuthState(value) {
    return String(value || "unknown").trim().toLowerCase() || "unknown";
  }

  function browserAuthIsLoggedIn(value) {
    return [
      "authenticated", "authorized", "logged-in", "logged_in", "loggedin",
      "signed-in", "signed_in", "ready", "active", "login-success", "login_success",
    ].includes(browserAuthState(value));
  }

  function browserLoginRequired(browserAuth) {
    const auth = browserAuth && typeof browserAuth === "object" ? browserAuth : {};
    if (auth.reported !== true) return false;
    const authState = browserAuthState(auth.authState);
    if (browserAuthIsLoggedIn(authState)) return false;
    return auth.loginRequired === true || (authState !== "unknown" && !browserAuthIsLoggedIn(authState));
  }

  function browserChallengeRequired(browserAuth) {
    const auth = browserAuth && typeof browserAuth === "object" ? browserAuth : {};
    const authState = browserAuthState(auth.authState);
    return !browserAuthIsLoggedIn(authState)
      && (auth.challengeRequired === true || authState === "challenge-required" || authState === "challenge_required");
  }

  function browserAuthLabel(value, challengeRequired = false) {
    const authState = browserAuthState(value);
    if (browserAuthIsLoggedIn(authState)) return "已登录";
    if (challengeRequired || authState === "challenge-required" || authState === "challenge_required") return "需要人工验证";
    if (/queue/.test(authState)) return "排队中";
    if (/code|sms|verify/.test(authState)) return "等待验证码";
    if (/start|open|loading|initial|restore|restoring/.test(authState)) return "正在准备";
    return "未登录";
  }

  function safeLoginNotice(value) {
    return String(value || "")
      .replace(/\+?\d[\d\s()-]{7,}\d/g, "••••")
      .replace(/\b\d{4,8}\b/g, "••••")
      .slice(0, 300);
  }

  function uiText(value) {
    return String(value == null ? "" : value)
      .replace(/C策略[^\n｜；]{0,16}(?:已失效|已过期)(?:，领取已停止)?/gi, "正在同步运行配置")
      .replace(/服务器策略[^\n｜；]{0,12}已过期/gi, "正在同步运行配置")
      .replace(/policy has expired/gi, "正在同步运行配置")
      .replace(/预提交/g, "加速模式");
  }

  function expiredPolicyNotice(value) {
    return /(?:C策略[^\n]{0,16}(?:已失效|已过期)|服务器策略[^\n]{0,12}已过期|EXPIRED_POLICY|policy has expired)/i.test(String(value || ""));
  }

  function authorizationDenied(value) {
    return /(?:管理员已暂停全部插件使用|管理员已停用(?:该)?(?:用户|使用者)|(?:用户|使用者)(?:尚)?未获得插件使用授权|插件使用权限已被撤回|服务器已停用当前用户|用户未获授权|授权已撤销|禁止使用插件|使用者已禁用|authorization denied|access denied)/i.test(String(value || ""));
  }

  function authorizationError() {
    const messages = [cPolicy.reason, status?.error, status?.worker?.lastError];
    return messages.find(authorizationDenied)
      || (status?.authorized === false || status?.worker?.phase === "access-revoked"
        ? "当前用户尚未获得插件使用授权" : "");
  }

  function accelerationAvailable() {
    // Only the current server policy grants access; UI defaults and cached
    // user settings must never grant permission when authorization is absent.
    const interval = cPolicy.defaults?.preSubmitIntervalMs;
    return !authorizationError() && cLocalDelegated()
      && typeof interval === "number" && Number.isFinite(interval) && interval > 0 && interval <= 10;
  }

  function stopLoginProgress() {
    if (loginProgressTimer) clearInterval(loginProgressTimer);
    loginProgressTimer = null;
    loginProgressStartedAt = 0;
  }

  function startLoginProgress() {
    stopLoginProgress();
    loginProgressStartedAt = Date.now();
    loginProgressTimer = setInterval(render, 800);
  }

  function loginProgressView() {
    if (!loginProgressStartedAt) return null;
    const elapsedMs = Math.max(0, Date.now() - loginProgressStartedAt);
    const percent = Math.min(94, 12 + Math.floor(82 * (1 - Math.exp(-elapsedMs / 22000))));
    const label = elapsedMs < 8000
      ? "正在校验用户身份"
      : elapsedMs < 24000
        ? "正在确认登录凭证"
        : elapsedMs < 45000
          ? "正在拉取全部权限"
          : "正在同步运行配置";
    return {percent, label};
  }

  function stopLoginStatusPolling() {
    if (loginStatusTimer) clearInterval(loginStatusTimer);
    loginStatusTimer = null;
  }

  function loginStatusPollingNeeded() {
    if (cLocalDelegated()) return false;
    const browserAuth = status && status.browserAuth && typeof status.browserAuth === "object" ? status.browserAuth : {};
    if (!browserLoginRequired(browserAuth) || browserChallengeRequired(browserAuth)) return false;
    return /queue|start|open|loading|initial|restore|restoring/.test(browserAuthState(browserAuth.authState));
  }

  async function refreshLoginStatus() {
    if (loginStatusBusy || loginBusy || !loginStatusPollingNeeded()) return;
    loginStatusBusy = true;
    try {
      applyStatus(await send({type: "browser-status"}, 8000));
    } finally {
      loginStatusBusy = false;
    }
  }

  function syncLoginStatusPolling() {
    if (!loginStatusPollingNeeded()) {
      stopLoginStatusPolling();
      return;
    }
    if (loginStatusTimer) return;
    const intervalMs = Math.max(250, Number(CONFIG.LOGIN_STATUS_REFRESH_MS) || 500);
    loginStatusTimer = setInterval(refreshLoginStatus, intervalMs);
    Promise.resolve().then(refreshLoginStatus);
  }

  function updateInputs(settings) {
    if (!panel) return;
    const values = settings && typeof settings === "object" ? settings : effectiveSettings();
    const editable = cLocalSettingsEditable() && !(status && status.running) && !busy && !catalogBusy;
    const turboInput = panel.querySelector('[name="turboMode"]');
    turboInput.checked = turboMode;
    turboInput.disabled = !editable || !!status?.turbo?.active || (!accelerationAvailable() && !turboMode);
    panel.querySelector(".sv-turbo-availability").textContent = status?.turbo?.allowed ? "" : "不可启动";
    turboInput.title = "仅服务器下发间隔为 0.000000001-10ms 时可启动，本地设置或分档加速不作为依据";
    const routeInput = panel.querySelector('[name="turboSmartRouting"]');
    routeInput.checked = turboSmartRouting;
    routeInput.disabled = !editable || !turboMode;
    routeInput.title = "从未屏蔽任务中由服务器 MAB 模组选取；每五分钟核对，全部响应结束且无未完成任务后才允许切换";
    panel.querySelector(".sv-turbo-route-option").hidden = !turboMode;
    const route = status?.turbo?.route;
    panel.querySelector(".sv-turbo-route-status").textContent = turboMode && turboSmartRouting && route
      ? `任务 ${route.taskId}${route.uncertain ? " · 结果待确认，保持原任务流" : route.canSwitch ? " · 等待空队列核对" : " · 保持当前任务流"}` : "";
    panel.querySelector(".sv-turbo-mode-option").hidden = !accelerationAvailable();
    panel.querySelector(".sv-pre-submit-toggle").hidden = !accelerationAvailable();
    panel.querySelector(".sv24-option-row").hidden = !accelerationAvailable();
    panel.querySelector(".sv24-task-open").hidden = !accelerationAvailable();
    panel.querySelector(".sv-turbo-controls").hidden = !cLocalSettingsEditable() && !status?.turbo?.recovery;
    panel.querySelector(".sv-turbo-recover").hidden = !status?.turbo?.recovery || !!status?.turbo?.active;
    const recoveryWait = Math.max(0, Math.ceil((Number(status?.turbo?.recoverAt) - Date.now()) / 1000)) || 0;
    panel.querySelector(".sv-turbo-recover").disabled = busy || recoveryWait > 0;
    panel.querySelector(".sv-turbo-recover").textContent = turboRecovering ? "正在核对…" : recoveryWait ? `等待 ${recoveryWait} 秒后核对` : "核对并解除锁定";
    panel.querySelector(".sv24-task-select-all").disabled = !editable || turboMode;
    for (const name of ["targetPackages", "claimAmount", "taskPages", "preSubmitAmount"]) {
      const input = panel.querySelector(`[name="${name}"]`);
      if (!input) continue;
      if (!editable || document.activeElement !== input) input.value = String(values[name]);
      input.min = String(settingBound(name, "min", name.includes("Interval") ? 50 : 1));
      const maximum = settingBound(name, "max", Number.MAX_SAFE_INTEGER);
      input.max = String(Math.max(Number(input.min), maximum));
      input.disabled = !editable;
      input.readOnly = !editable;
      input.title = editable ? "本机放权，可在服务器范围内调整" : "服务器控制，当前不可修改";
    }
    const accelerationAllowed = accelerationAvailable();
    for (const name of ["preSubmitEnabled"]) {
      const input = panel.querySelector(`[name="${name}"]`);
      if (!input) continue;
      input.checked = values[name] === true;
      input.disabled = !editable || turboMode || !accelerationAllowed;
      input.title = turboMode ? "极速模式固定启用，不单独切换" : !accelerationAllowed
        ? "服务器下发间隔高于10ms，加速模式不可用"
        : editable ? "本机放权，可调整" : "服务器控制，当前不可修改";
    }
    const amountLabel = panel.querySelector(".sv24-pre-submit-amount-label");
    if (amountLabel) amountLabel.textContent = String(values.preSubmitAmount || 1);
    const manualAmount = panel.querySelector('[name="manualClaimAmount"]');
    if (manualAmount) {
      const manualAllowed = cLocalExecutionReady();
      if (!manualAllowed || document.activeElement !== manualAmount) manualAmount.value = String(values.claimAmount || 1);
      manualAmount.min = String(settingBound("claimAmount", "min", 1));
      manualAmount.max = String(settingBound("claimAmount", "max", Number.MAX_SAFE_INTEGER));
      manualAmount.disabled = !manualAllowed || !!(status && status.running) || busy || catalogBusy;
      manualAmount.readOnly = !manualAllowed;
      manualAmount.title = manualAllowed ? "本机放权，可调整手动领取包数" : "仅白名单本机放权且模组就绪时可用";
    }
  }

  function normalizedTaskIds(value) {
    const output = [];
    const seen = new Set();
    for (const valueItem of Array.isArray(value) ? value : []) {
      const taskId = String(valueItem || "").trim().slice(0, 80);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId) || seen.has(taskId)) continue;
      seen.add(taskId);
      output.push(taskId);
    }
    return output;
  }

  function taskCatalog(worker) {
    const tasks = [];
    const seen = new Set();
    for (const item of Array.isArray(worker && worker.taskCatalog) ? worker.taskCatalog : []) {
      const taskId = String(item && item.taskId || "").trim().slice(0, 80);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId) || seen.has(taskId)) continue;
      seen.add(taskId);
      tasks.push({
        taskId,
        name: String(item && item.name || taskId).trim().slice(0, 160),
        left: Math.max(0, Math.trunc(Number(item && item.left) || 0)),
      });
    }
    return tasks;
  }

  function platformReadSource(worker) {
    const candidates = [
      status && status.platformRead,
      status && status.platformState,
      status && status.directRead,
      worker && worker.platformRead,
      worker && worker.platformState,
      worker && worker.directRead,
    ];
    return candidates.find((value) => value && typeof value === "object" && !Array.isArray(value)) || {};
  }

  function platformTaskStatus(value) {
    if (value === 0 || value === "0") return "处理中";
    if (value == null || value === "") return "—";
    return String(value).trim().slice(0, 80) || "—";
  }

  function platformDisplayTime(value) {
    if (value == null || value === "") return "—";
    if (typeof value === "number" && Number.isFinite(value)) {
      const milliseconds = value < 100000000000 ? value * 1000 : value;
      const date = new Date(milliseconds);
      return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", {hour12: false}) : "—";
    }
    const raw = String(value).trim().slice(0, 80);
    if (/^\d{10,13}$/.test(raw)) return platformDisplayTime(Number(raw));
    // A timezone-free platform string is deliberately shown verbatim.  Do not
    // reinterpret it in the browser's timezone and accidentally shift claim age.
    return raw || "—";
  }

  function platformReadSnapshot(worker) {
    const source = platformReadSource(worker);
    const rowCandidates = [
      source.recentWorkingPackages,
      source.workingRows,
      source.rows,
      source.packages,
      worker && worker.workingRows,
    ];
    const rawRows = rowCandidates.find(Array.isArray) || [];
    const rows = rawRows.slice(0, 20).map((row) => ({
      subTaskId: String(row && (row.subTaskId || row.packageId || row.id) || "").trim().slice(0, 120),
      taskId: String(row && row.taskId || "").trim().slice(0, 80),
      taskName: String(row && row.taskName || "").trim().slice(0, 160),
      status: platformTaskStatus(row && (row.taskStatus ?? row.status ?? row.state)),
      claimTime: platformDisplayTime(row && (row.claimTime || row.claimedAt || row.receiveTime || row.receivedAt || row.gmtCreate || row.createTime)),
    }));
    const rowsWereReported = rowCandidates.some(Array.isArray);
    const sourceReported = source.reported === true || typeof source.ok === "boolean"
      || Object.keys(source).length > 0;
    const latest = rows.find((row) => row.claimTime !== "—") || null;
    const explicitStatus = source.taskStatus ?? source.currentTaskStatus ?? source.state ?? source.status;
    const explicitClaimTime = source.claimTime || source.latestClaimTime || source.claimedAt || source.receiveTime;
    const workingCount = Math.max(0, Number(source.workingPackages ?? (worker && worker.workingPackages)) || rows.length);
    return {
      reported: sourceReported || rowsWereReported,
      ok: source.ok !== false,
      state: explicitStatus != null && explicitStatus !== ""
        ? platformTaskStatus(explicitStatus)
        : rows.length ? `${rows[0].status === "—" ? "处理中" : rows[0].status} · ${workingCount}包`
          : rowsWereReported ? "无工作包" : "等待直读",
      claimTime: platformDisplayTime(explicitClaimTime || latest && latest.claimTime),
      readAt: platformDisplayTime(source.readAt || source.observedAt || source.updatedAt || source.lastReadAt),
      error: String(source.error || source.reason || "").trim().slice(0, 200),
      rows,
    };
  }

  function renderPlatformRead(worker) {
    if (!panel) return;
    const snapshot = platformReadSnapshot(worker);
    const box = panel.querySelector(".sv24-platform-read");
    const badge = panel.querySelector(".sv24-platform-read-badge");
    const list = panel.querySelector(".sv24-platform-read-list");
    if (!box || !badge || !list) return;
    const failed = snapshot.reported && !snapshot.ok;
    box.dataset.state = failed ? "error" : snapshot.reported ? "ready" : "waiting";
    badge.textContent = failed ? "直读失败" : snapshot.reported
      ? snapshot.readAt !== "—" ? `已直读 ${snapshot.readAt}` : "background已直读"
      : "等待background直读";
    panel.querySelector(".sv24-platform-task-state").textContent = failed ? snapshot.error || "读取失败" : snapshot.state;
    panel.querySelector(".sv24-platform-claim-time").textContent = snapshot.claimTime;

    const rows = snapshot.rows.slice(0, 3);
    const signature = JSON.stringify({rows, reported: snapshot.reported, error: snapshot.error});
    if (list.dataset.signature === signature) return;
    const elements = rows.map((row) => {
      const item = document.createElement("div");
      const identity = document.createElement("strong");
      const detail = document.createElement("span");
      identity.textContent = row.subTaskId ? `包 ${row.subTaskId}` : row.taskId ? `任务 ${row.taskId}` : "工作包";
      const task = row.taskId && (!row.subTaskId || row.taskId !== row.subTaskId) ? `task ${row.taskId} · ` : "";
      detail.textContent = `${task}${row.status} · 领取 ${row.claimTime}`;
      item.append(identity, detail);
      return item;
    });
    if (!elements.length) {
      const empty = document.createElement("div");
      empty.className = "sv24-platform-read-empty";
      empty.textContent = failed ? snapshot.error || "平台直读失败" : snapshot.reported ? "暂无工作包明细" : "等待 background 回传平台任务状态与领取时间";
      elements.push(empty);
    }
    if (snapshot.rows.length > rows.length) {
      const more = document.createElement("div");
      more.className = "sv24-platform-read-more";
      more.textContent = `另有 ${snapshot.rows.length - rows.length} 个工作包`;
      elements.push(more);
    }
    list.replaceChildren(...elements);
    list.dataset.signature = signature;
  }

  function updateTaskSelection(worker, settings) {
    if (!panel) return;
    const editable = cLocalSettingsEditable() && !(status && status.running) && !busy && !catalogBusy;
    const tasks = taskCatalog(worker);
    const taskById = new Map(tasks.map((task) => [task.taskId, task]));
    const renderList = (listSelector, countSelector, values, emptyLabel) => {
      const list = panel.querySelector(listSelector);
      const count = panel.querySelector(countSelector);
      if (!list || !count) return;
      const taskIds = normalizedTaskIds(values);
      const selected = new Set(taskIds);
      const rows = [...tasks];
      for (const taskId of taskIds) {
        const proof = worker?.directoryProof;
        const missing = proof?.complete === true && Array.isArray(proof.taskIds) && !proof.taskIds.includes(taskId);
        if (!taskById.has(taskId) && !missing) rows.push({taskId, name: taskId, left: 0, retained: true});
      }
      const single = turboMode && listSelector.includes("sv24-task-page");
      const signature = JSON.stringify({taskIds, rows, editable, single});
      if (list.dataset.signature === signature) {
        count.textContent = String(taskIds.length);
        return;
      }
      const elements = [];
      for (const task of rows) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        const text = document.createElement("span");
        input.type = single ? "radio" : "checkbox";
        if (single) input.name = "sv-turbo-task";
        input.dataset.taskId = task.taskId;
        input.checked = selected.has(task.taskId) && (!single || selected.size === 1);
        input.disabled = !editable;
        text.textContent = `${task.name}（${task.taskId}）${task.retained ? " · 已保留" : ` · 剩余${task.left}`}`;
        label.append(input, text);
        elements.push(label);
      }
      if (!elements.length) {
        const empty = document.createElement("div");
        empty.className = "sv24-task-empty";
        empty.textContent = emptyLabel;
        elements.push(empty);
      }
      list.replaceChildren(...elements);
      list.dataset.signature = signature;
      count.textContent = String(taskIds.length);
    };
    renderList(".sv24-block-list", ".sv24-block-count", settings && settings.blockedTaskIds, "尚未读取到可屏蔽任务，请点“刷新任务”");
    renderList(".sv24-task-page .sv24-task-list", ".sv24-task-count", settings && (settings.selectedTaskIds || settings.preSubmitTaskIds), "尚未读取到加速任务，请点“刷新任务”");
    panel.querySelector(".sv24-task-clear").textContent = turboMode ? "清空选择" : "清空＝全部";
  }

  function updateManualTasks(worker, disabled) {
    if (!panel) return;
    const list = panel.querySelector(".sv24-manual-list");
    if (!list) return;
    const tasks = taskCatalog(worker);
    const signature = JSON.stringify({tasks, disabled});
    if (list.dataset.signature === signature) return;
    const elements = [];
    for (const task of tasks) {
      const row = document.createElement("div");
      const details = document.createElement("div");
      const name = document.createElement("strong");
      const meta = document.createElement("span");
      const button = document.createElement("button");
      row.className = "sv-card sv24-manual-row";
      name.className = "sv-name";
      meta.className = "sv-meta";
      name.textContent = task.name;
      meta.textContent = `taskId ${task.taskId} · 当前剩余${task.left}`;
      button.type = "button";
      button.className = "sv-manual-claim";
      button.dataset.taskId = task.taskId;
      button.dataset.taskName = task.name;
      const remaining = Math.max(0, Number(task.left) || 0);
      button.textContent = remaining > 0 ? "领取" : "暂无剩余";
      button.disabled = disabled || remaining <= 0;
      details.append(name, meta);
      row.append(details, button);
      elements.push(row);
    }
    if (!elements.length) {
      const empty = document.createElement("div");
      empty.className = "sv24-task-empty";
      empty.textContent = "尚未读取到本地任务，请点“刷新任务”";
      elements.push(empty);
    }
    list.replaceChildren(...elements);
    list.dataset.signature = signature;
  }

  function updateWorkload(workload) {
    if (!panel) return;
    const data = workload && typeof workload === "object" ? workload : {};
    setText("[data-workload=total]", Number(data.totalCompleted) || 0);
    setText("[data-workload=tasks]", Number(data.taskCount) || 0);
    setText("[data-workload=active]", Number(data.activeCount) || 0);
    const query = workloadQuery.trim().toLowerCase();
    const rows = (Array.isArray(data.totals) ? data.totals : []).filter((item) => !query
      || String(item && item.taskId || "").toLowerCase().includes(query)
      || String(item && item.taskName || "").toLowerCase().includes(query));
    const list = panel.querySelector(".sv24-workload-list");
    const signature = JSON.stringify({query, rows});
    if (!list || list.dataset.signature === signature) return;
    const elements = rows.map((item) => {
      const row = document.createElement("div");
      const details = document.createElement("div");
      const id = document.createElement("strong");
      const name = document.createElement("span");
      const count = document.createElement("b");
      const time = document.createElement("time");
      row.className = "sv-workload-row sv24-workload-row";
      count.className = "sv-workload-count";
      id.textContent = String(item.taskId || "");
      name.textContent = String(item.taskName || "未记录名称");
      count.textContent = `${Number(item.completed) || 0}次`;
      time.textContent = item.updatedAt ? new Date(item.updatedAt).toLocaleString("zh-CN", {hour12: false}) : "—";
      details.append(id, name);
      row.append(details, count, time);
      return row;
    });
    if (!elements.length) {
      const empty = document.createElement("div");
      empty.className = "sv24-task-empty";
      empty.textContent = query ? "没有符合条件的记录" : "暂无完成记录";
      elements.push(empty);
    }
    list.replaceChildren(...elements);
    list.dataset.signature = signature;
  }

  function getSuccessAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioContext || audioContext.state === "closed") audioContext = new AudioContextClass();
    return audioContext;
  }

  function getSuccessAudio(original = false) {
    const url = (!original && customSound?.getSource()) || chrome.runtime.getURL("qiangdao_tile.mp3");
    if (!successAudio || successAudio.src !== url) {
      if (successAudio) successAudio.pause();
      successAudio = new Audio(url);
      successAudio.preload = "auto";
    }
    return successAudio;
  }

  function playFallbackSuccessTone() {
    try {
      const context = getSuccessAudioContext();
      if (!context) return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.18, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.2);
    } catch (error) {}
  }

  function unlockSuccessSound() {
    if (!soundEnabled) return;
    try {
      const context = getSuccessAudioContext();
      if (context && context.state === "suspended") context.resume().catch(() => {});
      const audio = getSuccessAudio();
      audio.volume = 0;
      const attempt = audio.play();
      if (!attempt || typeof attempt.then !== "function") return;
      attempt.then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.volume = 1;
      }).catch(() => { audio.volume = 1; });
    } catch (error) {}
  }

  function playClaimSuccessSound() {
    if (!soundEnabled) return;
    const now = Date.now();
    if (now - lastSuccessSoundAt < 1200) return;
    lastSuccessSoundAt = now;
    try {
      customSound?.stopPreview();
      const audio = getSuccessAudio();
      audio.pause();
      audio.currentTime = 0;
      audio.volume = 1;
      const attempt = audio.play();
      if (attempt && typeof attempt.catch === "function") attempt.catch(() => {
        lastSuccessSoundAt = 0;
        recoverSuccessSound(audio);
      });
    } catch (error) {
      lastSuccessSoundAt = 0;
      playFallbackSuccessTone();
    }
  }

  function recoverSuccessSound(audio) {
    if (!soundEnabled) return;
    if (audio.src === chrome.runtime.getURL("qiangdao_tile.mp3")) {
      playFallbackSuccessTone();
      return;
    }
    customSound?.fallback();
    try {
      const original = getSuccessAudio(true);
      original.currentTime = 0;
      original.volume = 1;
      const attempt = original.play();
      if (attempt?.catch) attempt.catch(playFallbackSuccessTone);
    } catch (error) { playFallbackSuccessTone(); }
  }

  function platformTaskFilterRadios() {
    return Array.from(document.querySelectorAll('input[type="radio"]'))
      .filter((radio) => !radio.closest("#skyvendor-grab-panel"))
      .map((radio) => ({
        radio,
        label: String(radio.closest("label")?.textContent || radio.parentElement?.textContent || "").trim(),
      }))
      .filter((item) => ["全部", "未完成", "已完成"].includes(item.label));
  }

  function visibleWorkingClaimTimes() {
    const output = [];
    for (const table of document.querySelectorAll("main table")) {
      const headers = Array.from(table.querySelectorAll("thead th")).map((cell) => String(cell.textContent || "").trim());
      const subTaskIndex = headers.indexOf("子任务ID");
      const statusIndex = headers.indexOf("任务状态");
      const claimTimeIndex = headers.indexOf("领取时间");
      if (subTaskIndex < 0 || claimTimeIndex < 0) continue;
      for (const row of table.querySelectorAll("tbody tr")) {
        const cells = Array.from(row.querySelectorAll("td"));
        const subTaskId = String(cells[subTaskIndex] && cells[subTaskIndex].textContent || "").trim();
        const claimTime = String(cells[claimTimeIndex] && cells[claimTimeIndex].textContent || "").trim();
        const taskStatus = statusIndex >= 0 ? String(cells[statusIndex] && cells[statusIndex].textContent || "").trim() : "";
        if (subTaskId && claimTime && (!taskStatus || taskStatus === "处理中")) {
          output.push({subTaskId, claimTime, statusText: taskStatus, taskStatus});
        }
      }
    }
    return output;
  }

  async function refreshAcceptanceTaskTable() {
    const filters = platformTaskFilterRadios();
    const original = filters.find((item) => item.radio.checked)?.label || "";
    const byLabel = new Map(filters.map((item) => [item.label, item.radio]));
    if (!original || !byLabel.has("全部") || !byLabel.has("未完成")) {
      return {ok: false, error: "没有找到验收任务筛选控件"};
    }
    const sequence = original === "全部"
      ? ["未完成", "全部"]
      : original === "未完成" ? ["全部", "未完成"] : ["全部", "未完成", original];
    for (const label of sequence) {
      const radio = byLabel.get(label);
      if (!radio) continue;
      radio.click();
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    return {ok: true};
  }

  document.addEventListener("pointerdown", unlockSuccessSound, {capture: true, once: true});
  document.addEventListener("keydown", unlockSuccessSound, {capture: true, once: true});

  function serverSuccessClaimTimestamp(worker) {
    const candidates = [
      worker && worker.lastSuccessfulClaimAt,
      worker && worker.serverOperationSucceededAt,
      worker && worker.lastV24ClaimSuccessAt,
      worker && worker.lastClaimSuccessAt,
      worker && worker.claimSuccessAt,
    ];
    let latest = null;
    for (const value of candidates) {
      if (value == null || value === "") continue;
      let timestamp = null;
      if (typeof value === "number" && Number.isFinite(value)) {
        timestamp = value < 1e12 ? value * 1000 : value;
      } else if (typeof value === "string") {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
          timestamp = numeric < 1e12 ? numeric * 1000 : numeric;
        } else {
          const parsed = Date.parse(value);
          if (Number.isFinite(parsed)) timestamp = parsed;
        }
      }
      if (timestamp != null && timestamp > 0) latest = Math.max(latest || 0, timestamp);
    }
    return latest;
  }

  function applyStatus(next) {
    const incoming = next && typeof next === "object" ? next : {ok: false, error: "无法读取扩展状态"};
    const previousPolicy = cPolicy;
    const hasIncomingPolicy = Object.prototype.hasOwnProperty.call(incoming, "cPolicy");
    const incomingPolicy = hasIncomingPolicy ? normalizeCPolicy(incoming.cPolicy) : previousPolicy;
    // A delayed status response must not roll a newer signed policy back to
    // an older revision. Rev 0 is reserved for an explicit unavailable state
    // (for example an administrator revocation), so it remains authoritative.
    const stalePolicy = previousPolicy.revision > 0
      && incomingPolicy.revision > 0
      && incomingPolicy.revision < previousPolicy.revision;
    const nextPolicy = stalePolicy ? previousPolicy : incomingPolicy;
    const moduleEnvelope = stalePolicy ? {} : cModuleEnvelope(incoming);
    const nextPolicyKey = cPolicyKey(nextPolicy);
    const policyChanged = nextPolicyKey !== cPolicyStateKey;
    if (policyChanged) {
      cPolicyEpoch += 1;
      cPolicyStateKey = nextPolicyKey;
      cSandboxError = "";
    }
    cPolicy = nextPolicy;
    status = statusWithoutModule(incoming);
    status.cPolicy = cPolicy;
    if (cLocalDelegated() && !accelerationAvailable()) {
      turboMode = false;
      turboSmartRouting = false;
      try {
        localStorage.setItem(TURBO_MODE_KEY, "false");
        localStorage.setItem(TURBO_SMART_ROUTE_KEY, "false");
      } catch (error) {}
      status.settings = {...(status.settings || {}), preSubmitEnabled: false, ordinaryClaimEnabled: true};
      taskPageOpen = false;
    }
    const cPolicyRecovered = cPolicyUsable() || cPolicy.routeMode !== "local";
    if (cPolicyRecovered && !authorizationError()) {
      if (recoverableCPolicyError(status.error)) status.error = "";
      if (status.worker && typeof status.worker === "object"
        && recoverableCPolicyError(status.worker.lastError)) {
        status.worker = {...status.worker, lastError: ""};
      }
    }
    const localPolicyRoute = cPolicy.delegated === true || previousPolicy.delegated === true;
    if (cPolicyUsable()) {
      lastPolicyStopKey = "";
      if (policyChanged || cPolicy.routeMode !== "local" || cPolicy.moduleLoaded) cSandboxError = "";
    } else if (localPolicyRoute) {
      bestEffortPolicyStop(cPolicy.reason || "C策略不可用或已过期");
      if (cPolicy.routeMode !== "local") cSandboxError = "";
    } else {
      // A-server mode is authorized by the install lease and does not require
      // a usable C policy. Do not surface a stale C error or stop that session.
      cSandboxError = "";
    }
    const worker = status.worker && typeof status.worker === "object" ? status.worker : {};
    if (Number.isSafeInteger(worker.catalogClaimIncrease) && worker.catalogClaimIncrease >= 0) {
      runtimeSeenTaskCount = worker.catalogClaimIncrease;
    }
    const browserAuth = status.browserAuth && typeof status.browserAuth === "object" ? status.browserAuth : {};
    const authState = browserAuthState(browserAuth.authState);
    const authMessage = safeLoginNotice(browserAuth.message || "");
    if (browserAuthIsLoggedIn(authState)) {
      stopLoginProgress();
      loginCodeRequested = false;
      loginNotice = "";
      if (panel) {
        const phoneInput = panel.querySelector('[name="serverPhone"]');
        const codeInput = panel.querySelector('[name="serverCode"]');
        if (phoneInput) phoneInput.value = "";
        if (codeInput) codeInput.value = "";
      }
    } else if (browserChallengeRequired(browserAuth)) {
      stopLoginProgress();
      loginCodeRequested = false;
      if (authMessage) loginNotice = authMessage;
      if (panel) {
        const codeInput = panel.querySelector('[name="serverCode"]');
        if (codeInput) codeInput.value = "";
      }
    } else if (loginProgressStartedAt
      && /(?:验证码.*(?:错误|无效|过期)|验证失败|登录失败|手机号.*错误)/.test(authMessage)) {
      stopLoginProgress();
      loginCodeRequested = true;
      if (authMessage) loginNotice = authMessage;
    } else if (/code|sms|verify/.test(authState) || browserAuth.phoneMasked) {
      loginCodeRequested = true;
      if (authMessage) loginNotice = authMessage;
    } else if (/queue|start|open|loading|initial|restore|restoring/.test(authState)) {
      loginCodeRequested = false;
      if (authMessage) loginNotice = authMessage;
    } else if (/响应超时|回應逾時/.test(loginNotice) && authMessage) {
      loginNotice = authMessage;
    } else {
      loginCodeRequested = false;
      if (authMessage) loginNotice = authMessage;
      else if (!loginBusy && !String(status && status.error || "")) loginNotice = "";
    }
    const delegated = cLocalDelegated();
    const claimed = Number(worker.claimedPackages) || 0;
    if (delegated) {
      // Delegated mode keeps its existing local/package-count trigger.
      if (previousClaimedPackages != null && claimed > previousClaimedPackages) playClaimSuccessSound();
      previousClaimedPackages = claimed;
      previousServerSuccessClaimAt = null;
    } else {
      // Server mode reports the authoritative successful-claim timestamp.
      // Only an advancing timestamp is a new success; the first observation
      // is baseline initialization and must not play a sound.
      previousClaimedPackages = null;
      const successClaimAt = serverSuccessClaimTimestamp(worker);
      if (successClaimAt != null) {
        if (previousServerSuccessClaimAt != null && successClaimAt > previousServerSuccessClaimAt) {
          playClaimSuccessSound();
        }
        previousServerSuccessClaimAt = Math.max(previousServerSuccessClaimAt || 0, successClaimAt);
      }
    }
    scheduleCPolicyExpiry();
    const statusEpoch = cPolicyEpoch;
    void ensureCSandbox(moduleEnvelope, statusEpoch).catch((error) => {
      if (statusEpoch !== cPolicyEpoch) return;
      cSandboxError = String(error && error.message || error).slice(0, 300);
      if (cSandbox) teardownCSandbox(cSandboxError, true);
      cSandboxState = "模组异常";
      render();
    });
    sendStatusToCSandbox();
    render();
    syncLoginStatusPolling();
  }

  function render() {
    if (!panel) return;
    const worker = status && status.worker && typeof status.worker === "object" ? status.worker : {};
    const browserAuth = status && status.browserAuth && typeof status.browserAuth === "object" ? status.browserAuth : {};
    const settings = effectiveSettings();
    const hasName = !!String(status && status.userName || "").trim();
    const running = status && status.running === true;
    const delegated = cLocalDelegated();
    const policyRouteLocal = cPolicy.delegated === true && cPolicy.routeMode === "local";
    // Non-delegated A-server mode only needs the authenticated install lease;
    // a C signed policy is required exclusively for the local module path.
    const deniedReason = authorizationError();
    const policyDenied = !!deniedReason;
    const policyUsable = !policyDenied && (cPolicyUsable() || (!!(status && status.registered) && !policyRouteLocal));
    const settingsEditable = cLocalSettingsEditable();
    const localReady = cLocalExecutionReady();
    const manualAllowed = !policyDenied && delegated && localReady;
    if (activeMode === "manual" && !manualAllowed) activeMode = "auto";
    const executionReady = policyUsable && (!delegated || localReady);
    const policyError = !policyUsable
      ? String(cPolicy.reason || (cPolicy.expiresAt && cPolicy.expiresAt <= Date.now() ? "服务器策略已过期" : "服务器策略不可用"))
      : delegated && !cPolicy.moduleLoaded ? "白名单已放权，但服务器尚未下发本机模组"
        : delegated && cSandboxError ? cSandboxError : "";
    const rawError = String(deniedReason || status && status.error || worker.lastError || policyError || "");
    const routineResponse = routineClaimResult(rawError);
    const policyRefreshing = !policyDenied && !policyUsable && (
      expiredPolicyNotice(rawError)
      || expiredPolicyNotice(cPolicy.reason)
      || (Number(cPolicy.expiresAt) > 0 && Number(cPolicy.expiresAt) <= Date.now())
    );
    const routineNotice = running && routineResponse ? rawError : "";
    const error = policyDenied ? rawError : routineResponse || policyRefreshing ? "" : rawError;
    const loginRequired = !delegated && browserLoginRequired(browserAuth);
    const challengeRequired = loginRequired && browserChallengeRequired(browserAuth);
    const currentAuthState = browserAuthState(browserAuth.authState);
    const waitingInQueue = !challengeRequired && /queue/.test(currentAuthState);
    const preparingLogin = !challengeRequired && /start|open|loading|initial|restore|restoring/.test(currentAuthState);
    const loginFlowPending = waitingInQueue || preparingLogin;
    const codeReady = !challengeRequired && (loginCodeRequested || !!String(browserAuth.phoneMasked || "") || /code|sms|verify/.test(currentAuthState));
    const loginProgress = loginProgressView();
    const loginProgressActive = !!loginProgress && loginRequired && !challengeRequired;
    // Ordinary delegated claims use the current package count as their stop
    // gate. Derive the display from that same count, not a stale server phase
    // or the last claim-success message. Keep the session alive for recovery.
    const ordinaryTargetPaused = running && delegated && settings.preSubmitEnabled === false
      && !turboMode && !status?.turbo?.active
      && Number(worker.workingPackages) >= Number(settings.targetPackages);
    const targetPaused = ordinaryTargetPaused || (!delegated && worker.phase === "target-paused");
    const modulePending = delegated && cPolicy.moduleLoaded && !localReady && !cSandboxError;
    const stateClass = error ? "error" : policyRefreshing || loginRequired || targetPaused || modulePending ? "armed" : running ? "running" : "idle";
    const stateTitle = error ? "异常" : policyRefreshing ? "正在准备" : modulePending ? "载入本机模组" : challengeRequired ? "需要人工验证" : loginRequired ? "等待服务器登录" : ordinaryTargetPaused ? "已暂停领取" : targetPaused ? "已暂停" : running ? (turboMode && delegated ? "极速单任务队列模式" : "安全单任务模式") : "未启动";
    const phaseLabel = error ? "异常" : policyRefreshing ? "同步中" : modulePending ? cSandboxState : challengeRequired ? "验证" : loginRequired ? "登录" : ordinaryTargetPaused ? "等待完成" : targetPaused ? "暂停" : running ? String(runtimeActivity && runtimeActivity.phase || "扫描中") : "空闲";
    let stateDetail = uiText(error || (policyRefreshing
      ? "正在同步服务器运行配置，启动时会自动完成"
      : modulePending
      ? `白名单本机模组${cSandboxState}`
      : challengeRequired
      ? String(browserAuth.message || "请打开人工验证页面并自行完成验证")
      : loginRequired
        ? String(browserAuth.message || "请先完成服务器登录")
        : ordinaryTargetPaused
          ? `当前未完成${Number(worker.workingPackages)}包，已达到停止线${Number(settings.targetPackages)}包；继续检查任务状态，低于停止线后自动恢复领取`
        : running && runtimeActivity
          ? runtimeActivity.text
          : routineNotice
            ? `${routineNotice}；继续扫描其他任务`
            : worker.phaseLabel || (hasName ? "点击“启动安全单任务”后开始扫描" : "正在读取服务器登录姓名")));
    if (!error && status?.turbo?.active) stateDetail = `极速单任务 ${status.turbo.taskId}：${status.turbo.phase}，已发送 ${status.turbo.sent} 次，在途 ${status.turbo.pending} 次`;
    const currentDisplayTaskId = String(status?.turbo?.taskId || runtimeActivity && runtimeActivity.taskId || worker.currentTaskId || "");
    const workingRows = Array.isArray(worker.workingRows) ? worker.workingRows : [];
    const workingTaskIds = new Set(workingRows.map((row) => String(row && row.taskId || "").trim()).filter(Boolean));
    const workingPackages = Math.max(0, Number(worker.workingPackages) || 0);
    const workingTaskCount = workingTaskIds.size || (workingPackages > 0 ? 1 : 0);
    const reportedRequestInterval = displayedRequestInterval(settings, worker);
    const ordinaryOnly = delegated && settings.preSubmitEnabled === false;
    const currentInterval = ordinaryOnly
      ? formatOrdinaryInterval(status?.ordinaryPacing?.claimMs)
      : reportedRequestInterval ? formatInterval(reportedRequestInterval) : "不可启动";
    const currentIntervalLabel = ordinaryOnly ? "普通领取间隔" : "加速模式间隔";
    const controlModeLabel = settingsEditable ? "本机放权" : "服务器控制";
    const routeLabel = delegated ? "本地执行" : "服务器执行";
    const expiresIn = Math.max(0, Math.ceil((cPolicy.expiresAt - Date.now()) / 1000));
    panel.classList.toggle("sv24-running", running);
    panel.classList.toggle("sv24-error", !!error);
    panel.classList.toggle("sv24-login-required", loginRequired);
    panel.classList.toggle("sv24-delegated", delegated);
    panel.classList.toggle("sv24-server-controlled", !settingsEditable);
    panel.classList.toggle("sv-registration-required", loginRequired || !hasName);
    panel.querySelector(".sv24-user-name").textContent = hasName ? status.userName : "等待登入";
    const headerState = panel.querySelector("#sv-header-state");
    headerState.className = `sv-header-state ${stateClass}`;
    panel.querySelector("#sv-header-state-text").textContent = error ? "异常" : ordinaryTargetPaused ? "等待完成" : targetPaused ? "已暂停" : running ? "运行中" : stateTitle;
    panel.querySelector("#sv-compact-state").textContent = running ? phaseLabel : stateTitle;
    panel.querySelector("#sv-compact-interval").textContent = `${ordinaryOnly ? "普通" : "加速"} ${currentInterval}`;
    panel.querySelector("#sv-compact-task").textContent = currentDisplayTaskId ? `任务 ${currentDisplayTaskId}` : "任务 --";
    panel.querySelector(".sv24-server-login").hidden = delegated || !loginRequired;
    panel.querySelector(".sv24-login-state").textContent = loginProgressActive ? "验证中" : browserAuthLabel(browserAuth.authState, challengeRequired);
    const loginMessage = loginNotice || String(browserAuth.message || "请登录服务器浏览器后再启动领取");
    panel.querySelector(".sv24-login-message").textContent = loginProgressActive
      ? "服务器正在完成登录确认，请保持当前页面打开"
      : preparingLogin
      ? `${loginMessage}；验证码输入框会自动出现（最长约30秒）`
      : waitingInQueue ? `${loginMessage}；轮到后会自动进入准备阶段` : loginMessage;
    const loginProgressNode = panel.querySelector(".sv24-login-progress");
    loginProgressNode.hidden = !loginProgressActive;
    if (loginProgressActive) {
      loginProgressNode.querySelector(".sv24-login-progress-label").textContent = loginProgress.label;
      loginProgressNode.querySelector(".sv24-login-progress-value").textContent = `${loginProgress.percent}%`;
      const loginProgressBar = loginProgressNode.querySelector(".sv24-login-progress-bar");
      loginProgressBar.style.width = `${loginProgress.percent}%`;
      loginProgressNode.setAttribute("aria-valuenow", String(loginProgress.percent));
    }
    panel.querySelector(".sv24-login-challenge").hidden = !challengeRequired;
    panel.querySelector(".sv24-login-phone-form").hidden = challengeRequired || loginFlowPending || codeReady || loginProgressActive;
    panel.querySelector(".sv24-login-code-form").hidden = !codeReady || loginProgressActive;
    panel.querySelector(".sv24-login-reset").hidden = loginProgressActive || challengeRequired || (!codeReady && !loginFlowPending);
    for (const control of panel.querySelectorAll(".sv24-server-login input, .sv24-server-login button")) control.disabled = loginBusy;
    for (const control of panel.querySelectorAll(".sv24-login-phone-form input, .sv24-login-phone-form button")) {
      control.disabled = loginBusy || loginFlowPending;
    }
    panel.querySelector(".sv24-login-phone-submit").textContent = loginBusy ? "处理中" : preparingLogin ? "正在打开登录页" : waitingInQueue ? "等待排队" : "获取验证码";
    panel.querySelector(".sv24-login-code-submit").textContent = loginBusy ? "处理中" : "登录";
    panel.querySelector(".sv24-login-reset").textContent = loginBusy ? "处理中" : loginFlowPending ? "取消本次登录" : "重新开始登录";
    panel.querySelector(".sv24-login-challenge-open").textContent = loginBusy ? "正在打开" : "打开人工验证";
    panel.querySelector(".sv24-controls").classList.remove("sv24-disabled");
    panel.querySelector(".sv24-start").disabled = busy || catalogBusy || (!running && (!hasName || loginRequired || !executionReady));
    if (!running && (status?.turbo?.active || status?.turbo?.recovery)) panel.querySelector(".sv24-start").disabled = true;
    if (!running && turboMode && delegated && !status?.turbo?.allowed) panel.querySelector(".sv24-start").disabled = true;
    if (!running && delegated && !turboMode && settings.preSubmitEnabled === true && !accelerationAvailable()) panel.querySelector(".sv24-start").disabled = true;
    panel.querySelector(".sv24-start").textContent = busy ? "处理中" : running ? "停止安全单任务" : "启动安全单任务";
    if (!busy && turboMode && delegated) panel.querySelector(".sv24-start").textContent = running ? "停止极速单任务队列" : "启动极速单任务队列";
    panel.querySelector(".sv24-refresh-tasks").disabled = busy || catalogBusy || running || !hasName || !policyUsable;
    panel.querySelector(".sv24-refresh-tasks").textContent = catalogBusy ? "刷新中" : "刷新任务";
    panel.querySelector(".sv24-task-page-refresh").disabled = busy || catalogBusy || running || !hasName || !policyUsable;
    panel.querySelector(".sv24-task-page-refresh").textContent = catalogBusy ? "查询中" : "刷新任务";
    panel.querySelector(".sv24-block-open").disabled = busy || catalogBusy || running || !hasName || !policyUsable;
    panel.querySelector(".sv24-block-page-refresh").disabled = busy || catalogBusy || running || !hasName || !policyUsable;
    panel.querySelector(".sv24-task-open").disabled = busy || catalogBusy || running || !hasName || !policyUsable;
    const settingActionLocked = !settingsEditable || busy || catalogBusy || running || !hasName;
    for (const selector of [".sv24-block-select-all", ".sv24-block-clear", ".sv24-block-add", ".sv24-task-select-all", ".sv24-task-clear", ".sv24-task-add"]) {
      panel.querySelector(selector).disabled = settingActionLocked;
    }
    for (const field of panel.querySelectorAll(".sv24-task-custom textarea")) {
      field.disabled = settingActionLocked;
      field.readOnly = settingActionLocked;
    }
    const subpageOpen = blockPageOpen || taskPageOpen || workloadPageOpen || soundPageOpen;
    customSound?.setVisible(soundPageOpen);
    const autoPanel = panel.querySelector("#sv-auto-section");
    const manualPanel = panel.querySelector("#sv-manual-section");
    autoPanel.classList.toggle("active", activeMode === "auto");
    manualPanel.classList.toggle("active", activeMode === "manual");
    autoPanel.hidden = subpageOpen || activeMode !== "auto";
    panel.querySelector(".sv24-block-page").hidden = !blockPageOpen;
    panel.querySelector(".sv24-task-page").hidden = !taskPageOpen;
    manualPanel.hidden = subpageOpen || activeMode !== "manual";
    panel.querySelector(".sv24-workload-page").hidden = !workloadPageOpen;
    panel.querySelector(".sv24-manual-refresh").disabled = busy || catalogBusy || running || !hasName || !manualAllowed;
    const autoTab = panel.querySelector("#sv-mode-auto");
    const manualTab = panel.querySelector("#sv-mode-manual");
    autoTab.classList.toggle("active", activeMode === "auto");
    manualTab.classList.toggle("active", activeMode === "manual");
    autoTab.setAttribute("aria-selected", activeMode === "auto" ? "true" : "false");
    manualTab.setAttribute("aria-selected", activeMode === "manual" ? "true" : "false");
    manualTab.disabled = busy || catalogBusy || running || !manualAllowed;
    manualTab.title = manualAllowed ? "手动领取可用" : "当前模式不可手动领取";
    manualTab.setAttribute("aria-disabled", manualTab.disabled ? "true" : "false");
    const runState = panel.querySelector("#sv-safe-run-state");
    runState.className = `sv-run-state safe sv24-info ${stateClass}`;
    panel.querySelector(".sv24-status-title").textContent = stateTitle;
    panel.querySelector("#sv-safe-state-phase").textContent = phaseLabel;
    panel.querySelector(".sv24-status-detail").textContent = stateDetail;
    const footerStatus = panel.querySelector("#sv-status");
    footerStatus.textContent = stateDetail;
    footerStatus.className = `sv-status ${error ? "error" : running ? "ok" : ""}`.trim();
    panel.querySelector("#sv-server-claim-amount").textContent = String(Number(settings.claimAmount) || 1);
    panel.querySelector("#sv-server-scan-interval").textContent = formatInterval(LOCAL_SCAN_MS);
    panel.querySelector("#sv-server-pre-submit-interval").textContent = formatInterval(settings.preSubmitIntervalMs);
    const controlModeNode = panel.querySelector(".sv24-control-mode");
    if (controlModeNode) {
      controlModeNode.textContent = controlModeLabel;
      controlModeNode.dataset.mode = settingsEditable ? "local" : "server";
    }
    const routeModeNode = panel.querySelector(".sv24-route-mode");
    if (routeModeNode) routeModeNode.textContent = routeLabel;
    panel.querySelector(".sv24-policy-revision").textContent = String(cPolicy.revision || 0);
    panel.querySelector(".sv24-policy-expiry").textContent = policyUsable ? `${expiresIn}秒` : policyRefreshing ? "同步中" : "无效";
    panel.querySelector(".sv24-module-state").textContent = delegated ? policyRefreshing ? "等待同步" : cSandboxState : "未下发";
    panel.querySelector(".sv24-policy-detail").textContent = policyUsable
      ? `${controlModeLabel}｜${routeLabel}｜revision ${cPolicy.revision}｜任务扫描${formatInterval(LOCAL_SCAN_MS)}｜加速模式基准${formatInterval(settings.preSubmitIntervalMs)}｜${expiresIn}秒后刷新或失效`
      : policyRefreshing ? "正在同步服务器运行配置" : `策略不可用｜${cPolicy.reason || "等待服务器下发"}`;
    panel.querySelector("#sv-server-parameter-hint").textContent = settingsEditable
      ? "本地参数已同步"
      : "参数由服务器控制";
    const manualGuard = panel.querySelector("#sv-manual-guard");
    const atLimit = Number(worker.workingPackages) >= Number(settings.targetPackages || 3);
    const manualGuardClass = !manualAllowed ? "guarded" : error ? "error" : atLimit ? "guarded" : running || busy ? "busy" : "ready";
    manualGuard.className = `sv-manual-guard ${manualGuardClass}`;
    panel.querySelector("#sv-manual-guard-title").textContent = !manualAllowed ? "仅白名单本机放权可用" : error ? "当前不可领取" : running ? "自动领取运行中" : atLimit ? "已达到停止包数" : "可以手动领取";
    panel.querySelector("#sv-manual-guard-detail").textContent = !manualAllowed
      ? delegated ? "等待本机模组就绪；未就绪时不可进入或触发手动领取" : "A服务器模式不提供手动本地领取"
      : error || (running ? "请先停止安全自动模式" : atLimit ? `当前已有${Number(worker.workingPackages) || 0}包，暂不可手动领取` : `确认任务ID后领取 · 当前${routeLabel}`);
    const refreshInterval = formatOrdinaryInterval(status?.ordinaryPacing?.refreshMs);
    const claimInterval = formatOrdinaryInterval(status?.ordinaryPacing?.claimMs);
    panel.querySelector("#sv-manual-subtitle").textContent = `当前目标${Number(settings.claimAmount) || 1}包 · 本轮刷新${refreshInterval} · 领取间隔${claimInterval}`;
    updateInputs(settings);
    updateTaskSelection(worker, settings);
    updateManualTasks(worker, busy || running || atLimit || !manualAllowed);
    updateWorkload(status && status.workload);
    renderPlatformRead(worker);
    setText("#sv-safe-stat-working", workingTaskCount);
    setText("#sv-safe-stat-task", currentDisplayTaskId || "—");
    setText("#sv-safe-stat-unfinished", workingPackages);
    setText("#sv-safe-stat-claimed", worker.claimedPackages || 0);
    setText("#sv-safe-stat-seen", runtimeSeenTaskCount);
    setText("#sv-safe-stat-interval-label", currentIntervalLabel);
    setText("#sv-safe-stat-interval", currentInterval);
    setText("[data-value=availableTasks]", worker.availableTasks || 0);
    renderRuntimeLogs();
  }

  async function refreshCatalog() {
    if (busy || catalogBusy) return;
    catalogBusy = true;
    render();
    const response = await send({type: "refresh-catalog", settings: currentSettings()});
    catalogBusy = false;
    applyStatus(response);
  }

  async function tickSlowMode() {
    if (slowModeTickBusy || busy || catalogBusy || !cLocalExecutionReady() || authorizationError()) return;
    const timing = status?.ordinaryPacing;
    if (!timing) return;
    if (activeMode === "manual" && !status.running) {
      if (Date.now() < timing.refreshNextAt) return;
      slowModeTickBusy = true;
      try { await refreshCatalog(); } finally { slowModeTickBusy = false; }
      return;
    }
    const settings = effectiveSettings();
    if (!status.running || settings.preSubmitEnabled || turboMode || status?.turbo?.active
      || status?.turbo?.recovery || cSandbox.claimInFlight || Date.now() < timing.claimNextAt) return;
    const worker = status.worker || {};
    if (Number(worker.workingPackages) >= settings.targetPackages) return;
    const rows = Array.isArray(worker.workingRows) ? worker.workingRows : [];
    const heldIds = [...new Set(rows.map(row => String(row.taskId || "")))];
    if (Number(worker.workingPackages) > 0 && (heldIds.length !== 1 || !heldIds[0])) return;
    const candidate = taskCatalog(worker).find(task => Number(task.left) > 0
      && !settings.blockedTaskIds.includes(task.taskId)
      && (Number(worker.workingPackages) === 0 || task.taskId === heldIds[0]));
    if (!candidate) return;
    slowModeTickBusy = true;
    try {
      await handleCSandboxClaim(cSandbox, {mode: "normal", taskId: candidate.taskId,
        taskName: candidate.name, amount: settings.claimAmount, policyRevision: cPolicy.revision,
        effectiveIntervalMs: timing.claimMs});
    } finally { slowModeTickBusy = false; }
  }

  async function initializeAccelerationQueue() {
    if (turboMode) return;
    if (!cLocalExecutionReady() || currentSettings().selectedTaskIds.length) return;
    await refreshCatalog();
    const tasks = taskCatalog(status && status.worker);
    if (tasks.length && !currentSettings().selectedTaskIds.length) {
      await saveTaskSelection("selectedTaskIds", tasks.map((task) => task.taskId));
    }
  }

  async function submitLocalSettings(overrides = {}) {
    if (!cLocalSettingsEditable()) {
      render();
      return false;
    }
    const settings = {...currentSettings(), ...overrides};
    applyStatus(await send({
      type: "set-settings",
      settings,
      cPolicyRevision: cPolicy.revision,
      cRouteMode: "local",
    }));
    return true;
  }

  async function saveTaskSelection(settingName, taskIds) {
    if (!cLocalSettingsEditable()) {
      render();
      return;
    }
    const normalized = normalizedTaskIds(taskIds);
    if (turboMode && settingName === "selectedTaskIds" && normalized.length > 1) {
      addRuntimeLog("warn", "极速模式只能选择一个任务 ID");
      render();
      return;
    }
    const overrides = {[settingName]: normalized};
    if (settingName === "selectedTaskIds") {
      overrides.preSubmitTaskIds = normalized;
      overrides.taskSelectionRequired = false;
    }
    await submitLocalSettings(overrides);
  }

  function showSubpage(name = "") {
    blockPageOpen = name === "blocks";
    taskPageOpen = name === "tasks";
    workloadPageOpen = name === "workload";
    soundPageOpen = name === "sound";
    render();
  }

  function switchMode(mode) {
    if (mode === "manual" && !cLocalExecutionReady()) {
      activeMode = "auto";
      render();
      return false;
    }
    activeMode = mode === "manual" ? "manual" : "auto";
    soundPageOpen = false;
    taskPageOpen = false;
    workloadPageOpen = false;
    render();
    return true;
  }

  function setupPanelDragging() {
    const header = panel.querySelector(".sv-header");
    const collapseButton = panel.querySelector("#sv-collapse");
    const resizeHandle = panel.querySelector(".sv-resize-handle");
    let savedLayout = null;
    let dragging = false;
    let resizing = false;
    let dragMoved = false;
    let suppressHeaderClick = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let startWidth = 0;
    let startHeight = 0;

    try { savedLayout = JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY) || "null"); } catch (error) {}

    const saveLayout = () => {
      const rect = panel.getBoundingClientRect();
      const next = savedLayout && typeof savedLayout === "object" ? {...savedLayout} : {};
      const key = panel.classList.contains("sv-collapsed") ? "compact" : "expanded";
      next[key] = {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      savedLayout = next;
      try { localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify(next)); } catch (error) {}
    };

    const clamp = () => {
      if (!panel || panel.hidden) return;
      const rect = panel.getBoundingClientRect();
      const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
      const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
      const nextLeft = Math.min(maxLeft, Math.max(8, rect.left));
      const nextTop = Math.min(maxTop, Math.max(8, rect.top));
      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.transform = "none";
    };

    const centerExpanded = () => {
      const width = Math.min(440, Math.max(280, window.innerWidth - 16));
      const height = Math.min(720, Math.max(300, window.innerHeight - 32));
      panel.style.width = `${width}px`;
      panel.style.height = `${height}px`;
      panel.style.left = `${Math.max(8, Math.round((window.innerWidth - width) / 2))}px`;
      panel.style.top = `${Math.max(8, Math.round((window.innerHeight - height) / 2))}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.transform = "none";
    };

    const applySavedLayout = (key) => {
      const saved = savedLayout && savedLayout[key];
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        panel.style.left = `${saved.left}px`;
        panel.style.top = `${saved.top}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.transform = "none";
        if (key === "expanded") {
          if (Number.isFinite(saved.width)) panel.style.width = `${Math.max(280, saved.width)}px`;
          if (Number.isFinite(saved.height)) panel.style.height = `${Math.max(300, saved.height)}px`;
        }
        return;
      }
      if (key === "expanded") {
        centerExpanded();
        return;
      }
      const width = panel.getBoundingClientRect().width || 280;
      panel.style.left = `${Math.max(8, Math.round((window.innerWidth - width) / 2))}px`;
      panel.style.top = `${Math.max(8, Math.round(window.innerHeight / 7))}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.transform = "none";
    };

    const setCollapsed = (collapsed) => {
      if (panel.classList.contains("sv-collapsed") === collapsed) return;
      saveLayout();
      panel.classList.toggle("sv-collapsed", collapsed);
      collapseButton.textContent = collapsed ? "+" : "−";
      collapseButton.title = collapsed ? "展开详细界面" : "收起为小界面";
      collapseButton.setAttribute("aria-label", collapseButton.title);
      applySavedLayout(collapsed ? "compact" : "expanded");
      requestAnimationFrame(() => {
        clamp();
        saveLayout();
      });
    };

    clampPanelIntoViewport = clamp;
    applySavedLayout("compact");
    requestAnimationFrame(() => {
      clamp();
      saveLayout();
    });

    header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button, input, select, textarea, a, label")) return;
      const rect = panel.getBoundingClientRect();
      dragging = true;
      dragMoved = false;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      event.preventDefault();
    });

    header.addEventListener("click", (event) => {
      if (event.target.closest("button") || suppressHeaderClick || !panel.classList.contains("sv-collapsed")) return;
      setCollapsed(false);
    });

    collapseButton.addEventListener("click", () => setCollapsed(!panel.classList.contains("sv-collapsed")));

    resizeHandle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || panel.classList.contains("sv-collapsed")) return;
      const rect = panel.getBoundingClientRect();
      resizing = true;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      startWidth = rect.width;
      startHeight = rect.height;
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      event.preventDefault();
      event.stopPropagation();
    });

    const onPointerMove = (event) => {
      if (dragging) {
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        if (Math.abs(deltaX) + Math.abs(deltaY) > 4) dragMoved = true;
        const maxLeft = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
        const maxTop = Math.max(8, window.innerHeight - panel.offsetHeight - 8);
        panel.style.left = `${Math.min(maxLeft, Math.max(8, startLeft + deltaX))}px`;
        panel.style.top = `${Math.min(maxTop, Math.max(8, startTop + deltaY))}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
      }
      if (resizing) {
        const availableWidth = Math.max(240, window.innerWidth - startLeft - 8);
        const availableHeight = Math.max(240, window.innerHeight - startTop - 8);
        const minWidth = Math.min(360, availableWidth);
        const minHeight = Math.min(360, availableHeight);
        panel.style.width = `${Math.min(availableWidth, Math.max(minWidth, startWidth + event.clientX - startX))}px`;
        panel.style.height = `${Math.min(availableHeight, Math.max(minHeight, startHeight + event.clientY - startY))}px`;
      }
    };

    const onPointerUp = () => {
      if (dragging) {
        dragging = false;
        suppressHeaderClick = dragMoved;
        saveLayout();
        setTimeout(() => { suppressHeaderClick = false; }, 0);
      }
      if (resizing) {
        resizing = false;
        saveLayout();
      }
    };

    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("resize", clamp);
    launcher?.addEventListener("click", () => requestAnimationFrame(clamp));
  }

  function createPanel() {
    panel = document.createElement("aside");
    panel.id = "skyvendor-grab-panel";
    panel.className = "sv-collapsed";
    panel.innerHTML = `
      <div class="sv-header sv24-header">
        <span class="sv-brand">
          <span class="sv-title">晓天HTML脚本 <span class="sv24-version">4.5</span></span>
          <span class="sv-user-line sv24-user-line"><span class="sv-user-label">使用者</span><b id="sv-user-name" class="sv24-user-name">等待登入</b></span>
          <span class="sv-compact-meta"><span id="sv-compact-state">未启动</span><span id="sv-compact-interval">加速 —</span><span id="sv-compact-task">任务 --</span></span>
        </span>
        <span id="sv-header-state" class="sv-header-state idle"><span class="sv-state-dot"></span><span id="sv-header-state-text">未启动</span></span>
        <button id="sv-collapse" type="button" title="展开详细界面" aria-label="展开详细界面">+</button>
        <button id="sv-close" class="sv24-close" type="button" title="关闭">×</button>
      </div>
      <div class="sv-body">
        <div class="sv-toolbar">
          <div class="sv-toolbar-actions">
            <button id="sv-refresh" class="sv24-refresh-tasks" type="button">刷新任务</button>
            <button id="sv-workload-open" class="sv24-workload-open" type="button">工作量</button>
            <label class="sv-sound-toggle" title="领取成功提示音">
              <input id="sv-sound-enabled" type="checkbox" checked>
              <span class="sv-switch-track" aria-hidden="true"><span class="sv-switch-thumb"></span></span>
              <span>提示音</span>
            </label>
          </div>
          <span>只读取验收任务，安全模式需手动启动</span>
        </div>
        <div class="sv-mode-switch" role="tablist" aria-label="领取方式">
          <button id="sv-mode-auto" class="sv-mode-tab active" type="button" role="tab" aria-selected="true">安全自动</button>
          <button id="sv-mode-manual" class="sv-mode-tab" type="button" role="tab" aria-selected="false">手动领取</button>
        </div>
        <section class="sv-server-login sv24-server-login" hidden>
          <div class="sv24-login-heading"><strong>服务器登录</strong><span class="sv24-login-state">未登录</span></div>
          <p class="sv24-login-message">请登录服务器浏览器后再启动领取</p>
          <div class="sv24-login-progress" role="progressbar" aria-label="服务器登录进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" hidden>
            <div class="sv24-login-progress-head"><strong class="sv24-login-progress-label">正在校验用户身份</strong><span class="sv24-login-progress-value">12%</span></div>
            <div class="sv24-login-progress-track"><span class="sv24-login-progress-bar"></span></div>
          </div>
          <div class="sv24-login-challenge" hidden>
            <strong>需要人工验证</strong>
            <p>请在新页面中自行完成验证；扩展不会尝试识别、代填或绕过CAPTCHA。</p>
            <button class="sv24-login-challenge-open" type="button">打开人工验证</button>
          </div>
          <form class="sv24-login-phone-form" autocomplete="off">
            <label>国家／地区代码<input name="serverCountryCode" type="text" inputmode="tel" maxlength="5" value="+86" required></label>
            <label class="sv24-login-phone-field">手机号码<input name="serverPhone" type="tel" inputmode="tel" maxlength="20" autocomplete="off" placeholder="请输入手机号码" required></label>
            <button class="sv24-login-phone-submit" type="submit">获取验证码</button>
          </form>
          <form class="sv24-login-code-form" autocomplete="off" hidden>
            <label>短信验证码<input name="serverCode" type="text" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" autocomplete="one-time-code" placeholder="请输入验证码" required></label>
            <button class="sv24-login-code-submit" type="submit">登录</button>
          </form>
          <button class="sv24-login-reset" type="button" hidden>重新开始登录</button>
          <small>验证码不会保存或写入日志；扩展不会向服务器上传本地SkyVendor Cookie或Token。</small>
        </section>
        <main class="sv24-controls">
          <section id="sv-auto-section" class="sv-section sv-mode-panel safe active sv24-main-page">
            <div class="sv-safe-hero">
              <div class="sv-safe-hero-head">
                <strong class="sv-safe-hero-title">安全单任务模式<span class="sv-safe-hero-note">(如果配置拉取异常刷新一下网页即可)</span></strong>
                <span class="sv-param-chips">
                  <span class="sv-param-chip">领取包数<strong id="sv-server-claim-amount">1</strong></span>
                </span>
              </div>
              <div class="sv24-policy-strip">
                <span>revision <strong class="sv24-policy-revision">0</strong></span>
                <span>有效期 <strong class="sv24-policy-expiry">无效</strong></span>
                <span>模组 <strong class="sv24-module-state">未下发</strong></span>
                <span>任务扫描间隔 <strong id="sv-server-scan-interval">0.1秒</strong></span>
                <span>加速模式基准间隔 <strong id="sv-server-pre-submit-interval">—</strong></span>
              </div>
              <div id="sv-server-parameter-hint" class="sv-safe-page-hint">正在读取服务器策略参数…</div>
            </div>
            <div id="sv-safe-run-state" class="sv-run-state safe idle sv24-info">
              <div class="sv-run-state-main"><span class="sv-state-dot"></span><strong id="sv-safe-state-title" class="sv24-status-title">未启动</strong><span id="sv-safe-state-phase" class="sv-phase-chip">空闲</span></div>
              <div id="sv-safe-state-detail" class="sv24-status-detail">点击“启动安全单任务”后开始扫描</div>
              <div class="sv24-policy-detail">正在读取服务器策略</div>
              <div class="sv24-platform-read" data-state="waiting">
                <div class="sv24-platform-read-head"><strong>平台直读</strong><span class="sv24-platform-read-badge">等待background直读</span></div>
                <div class="sv24-platform-read-summary">
                  <span>任务状态 <strong class="sv24-platform-task-state">等待直读</strong></span>
                  <span>领取时间 <strong class="sv24-platform-claim-time">—</strong></span>
                </div>
                <div class="sv24-platform-read-list"><div class="sv24-platform-read-empty">等待 background 回传平台任务状态与领取时间</div></div>
              </div>
              <div class="sv-stat-grid">
                <div class="sv-stat"><span class="sv-stat-label">工作中任务</span><strong id="sv-safe-stat-working">0</strong></div>
                <div class="sv-stat"><span class="sv-stat-label">当前 taskId</span><strong id="sv-safe-stat-task">—</strong></div>
                <div class="sv-stat"><span class="sv-stat-label">未完成包</span><strong id="sv-safe-stat-unfinished">0</strong></div>
                <div class="sv-stat"><span class="sv-stat-label">已领取</span><strong id="sv-safe-stat-claimed">0</strong></div>
                <div class="sv-stat" title="本轮任务目录中已领取数量的新增量，包含其他使用者领取，不是本人成功领取数"><span class="sv-stat-label">看到任务次数</span><strong id="sv-safe-stat-seen">0</strong></div>
                <div class="sv-stat"><span id="sv-safe-stat-interval-label" class="sv-stat-label">加速模式间隔</span><strong id="sv-safe-stat-interval">—</strong></div>
              </div>
            </div>
            <div class="sv-controls sv24-settings">
              <label>停止包数<input name="targetPackages" type="number" min="1" value="3">包</label>
              <label>每次领取<input name="claimAmount" type="number" min="1" value="1">包</label>
              <label>扫描页数<input name="taskPages" type="number" min="1" value="1">页</label>
            </div>
            <div class="sv24-option-row">
              <label class="sv-option-toggle sv-turbo-mode-option"><input name="turboMode" type="checkbox"> 极速单任务队列模式 <span class="sv-turbo-availability"></span></label>
              <label class="sv-pre-submit-toggle"><input name="preSubmitEnabled" type="checkbox"> 启用加速模式（每次<span class="sv24-pre-submit-amount-label">1</span>包）</label>
            </div>
            <div class="sv-controls sv-mode-actions sv24-pre-submit-actions">
              <button class="sv24-block-open" type="button">任务屏蔽 <span class="sv24-block-count">0</span></button>
              <button class="sv24-task-open" type="button">加速任务 <span class="sv24-task-count">0</span></button>
              <div class="sv-turbo-controls">
                <label class="sv-turbo-route-option" hidden><input name="turboSmartRouting" type="checkbox"> 智能路由</label>
                <span class="sv-turbo-route-status" role="status"></span>
                <button class="sv-turbo-recover" type="button" hidden>核对并解除锁定</button>
              </div>
              <button id="sv-safe-toggle" class="sv24-start" type="button">启动安全单任务</button>
            </div>
          </section>
          <section id="sv-manual-section" class="sv-section sv-mode-panel manual sv24-manual-page" hidden>
            <div class="sv-manual-head"><div><strong>手动领取</strong><span id="sv-manual-subtitle">单任务ID · 当前目标1包 · 本地扫描0.1秒</span></div><span class="sv-auto-refresh" role="status" title="任务状态自动刷新" aria-label="自动刷新中"><span class="sv-auto-refresh-icon" aria-hidden="true">↻</span></span></div>
            <div id="sv-manual-guard" class="sv-manual-guard idle"><strong id="sv-manual-guard-title">正在检查工作中任务</strong><span id="sv-manual-guard-detail">确认任务ID后才可手动领取 · 本地扫描0.1秒</span></div>
            <p class="sv24-manual-help">确认任务ID后手动领取，领取完成后才能启动安全自动。</p>
            <div class="sv-controls sv24-manual-toolbar"><label>每次领取<input name="manualClaimAmount" type="number" min="1" value="1">包</label><button class="sv24-manual-refresh" type="button">刷新任务</button></div>
            <div id="sv-list" class="sv-list sv24-manual-list"></div>
          </section>
          <section id="sv-block-page" class="sv-subpage sv24-block-page" hidden>
            <div class="sv-subpage-header sv24-subpage-header"><strong>任务屏蔽</strong><button class="sv24-block-back" type="button">返回</button></div>
            <p class="sv-subpage-help">勾选后不会对该任务启用加速领取；未勾选的任务仍可进入加速任务范围。</p>
            <div class="sv24-task-page-actions"><button class="sv24-block-page-refresh" type="button">刷新任务</button><button class="sv24-block-select-all" type="button">全部屏蔽</button><button class="sv24-block-clear" type="button">清空屏蔽</button></div>
            <div class="sv24-task-list sv24-block-list"></div>
            <div class="sv24-task-custom"><label>自定义 taskId<textarea class="sv24-block-custom-input" rows="2" placeholder="可用逗号、空格或换行分隔"></textarea></label><button class="sv24-block-add" type="button">加入屏蔽</button></div>
          </section>
          <section id="sv-task-page" class="sv-subpage sv24-task-page" hidden>
            <div class="sv-subpage-header sv24-subpage-header"><strong>加速任务</strong><button class="sv24-task-back" type="button">返回</button></div>
            <p class="sv-subpage-help">勾选需要加速领取的任务；不勾选任何任务即使用全部未屏蔽任务。</p>
            <div class="sv-subpage-setting"><label>每次加速领取包数</label><input name="preSubmitAmount" type="number" min="1" value="1"><span>包</span></div>
            <div class="sv24-task-page-actions"><button class="sv24-task-page-refresh" type="button">刷新任务</button><button class="sv24-task-select-all" type="button">全选清单</button><button class="sv24-task-clear" type="button">清空＝全部</button></div>
            <div class="sv24-task-list"></div>
            <div class="sv24-task-custom"><label>自定义 taskId<textarea class="sv24-task-custom-input" rows="2" placeholder="可用逗号、空格或换行分隔"></textarea></label><button class="sv24-task-add" type="button">加入选择</button></div>
          </section>
          <section id="sv-workload-page" class="sv-subpage sv-workload-page sv24-workload-page" hidden>
            <div class="sv-subpage-header sv24-subpage-header"><strong>工作量查询</strong><button class="sv24-workload-back" type="button">返回</button></div>
            <div class="sv-workload-summary sv24-workload-summary"><div><span>累计完成次数</span><strong data-workload="total">0</strong></div><div><span>任务ID数</span><strong data-workload="tasks">0</strong></div><div><span>当前进行中</span><strong data-workload="active">0</strong></div></div>
            <label class="sv-workload-search sv24-workload-search">查询任务ID<input type="search" placeholder="输入任务ID或任务名称"></label>
            <div class="sv-workload-list sv24-workload-list"></div>
          </section>
        </main>
        <section class="sv-log-section sv24-runtime-log-section">
          <div class="sv-log-header">
            <div class="sv-section-title">运行日志</div>
            <div class="sv-log-actions"><button id="sv-copy-runtime-log" type="button">复制</button><button id="sv-clear-runtime-log" type="button">清空</button></div>
          </div>
          <div id="sv-runtime-log" class="sv-log" role="log"><div class="sv-log-empty">暂无运行日志</div></div>
        </section>
        <div id="sv-status" class="sv-status">正在读取任务…</div>
      </div>
      <div id="sv-resize-handle" class="sv-resize-handle" title="拖动调整大小" aria-label="拖动调整大小"></div>`;
    document.documentElement.appendChild(panel);

    launcher = document.createElement("button");
    launcher.id = "xiaotian-v24-launcher";
    launcher.type = "button";
    launcher.textContent = "晓天3.0C";
    launcher.hidden = true;
    document.documentElement.appendChild(launcher);
    panel.querySelector("#sv-sound-enabled").checked = soundEnabled;
    try { customSound = globalThis.XiaotianCustomSound?.mount(panel, showSubpage) || null; } catch (error) {}
    panel.querySelector("#sv-copy-runtime-log").addEventListener("click", copyRuntimeLogs);
    panel.querySelector("#sv-clear-runtime-log").addEventListener("click", () => {
      runtimeLogs = [];
      flushRuntimeLogs();
    });
    renderRuntimeLogs();
    setupPanelDragging();

    panel.querySelector(".sv24-close").addEventListener("click", () => {
      panel.hidden = true;
      launcher.hidden = false;
    });
    launcher.addEventListener("click", () => {
      launcher.hidden = true;
      panel.hidden = false;
    });
    panel.querySelector(".sv24-login-phone-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (loginBusy) return;
      const phoneInput = panel.querySelector('[name="serverPhone"]');
      const countryCodeInput = panel.querySelector('[name="serverCountryCode"]');
      const phone = String(phoneInput.value || "").replace(/\D/g, "").slice(0, 20);
      const countryCode = String(countryCodeInput.value || "+86").trim();
      loginBusy = true;
      loginNotice = "正在请求短信验证码…";
      render();
      const response = await send({type: "browser-login-phone", phone, countryCode}, loginMessageTimeoutMs());
      loginBusy = false;
      if (response.ok === true && /code|sms|verify/.test(browserAuthState(response.browserAuth && response.browserAuth.authState))) loginCodeRequested = true;
      loginNotice = safeLoginNotice(response.error || response.browserAuth && response.browserAuth.message || (response.ok === true ? "验证码已发送，请输入短信验证码" : "获取验证码失败"));
      applyStatus(response);
      if (response.ok === true) panel.querySelector('[name="serverCode"]').focus();
    });
    panel.querySelector(".sv24-login-code-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (loginBusy) return;
      const codeInput = panel.querySelector('[name="serverCode"]');
      let code = String(codeInput.value || "").trim();
      codeInput.value = "";
      loginBusy = true;
      loginNotice = "正在校验用户身份…";
      startLoginProgress();
      render();
      const request = send({type: "browser-login-code", code}, loginMessageTimeoutMs());
      code = "";
      const response = await request;
      loginBusy = false;
      if (response.ok !== true && /(?:验证码.*(?:错误|无效|过期)|验证失败|登录失败|手机号.*错误)/.test(String(response.error || ""))) {
        stopLoginProgress();
      }
      loginNotice = safeLoginNotice(response.error || response.browserAuth && response.browserAuth.message || (response.ok === true ? "登录完成" : "登录失败"));
      applyStatus(response);
    });
    panel.querySelector(".sv24-login-reset").addEventListener("click", async () => {
      if (loginBusy) return;
      loginBusy = true;
      loginNotice = "正在重置服务器登录…";
      render();
      const response = await send({type: "browser-logout"}, loginMessageTimeoutMs());
      loginBusy = false;
      loginCodeRequested = false;
      panel.querySelector('[name="serverPhone"]').value = "";
      panel.querySelector('[name="serverCode"]').value = "";
      loginNotice = safeLoginNotice(response.error || response.browserAuth && response.browserAuth.message || "请重新获取验证码");
      applyStatus(response);
    });
    panel.querySelector(".sv24-login-challenge-open").addEventListener("click", async () => {
      if (loginBusy) return;
      loginBusy = true;
      loginNotice = "正在打开人工验证页面…";
      render();
      const response = await send({type: "browser-open-manual-login"}, 30000);
      loginBusy = false;
      loginNotice = safeLoginNotice(response.error || (response.manualLoginOpened ? "人工验证页面已打开，请在新页面中自行完成验证" : "无法打开人工验证页面"));
      applyStatus(response);
    });
    for (const input of panel.querySelectorAll(".sv24-settings input, .sv24-settings select, .sv24-option-row input, .sv-subpage-setting input")) {
      if (input.name === "turboMode") continue;
      input.addEventListener("change", async () => {
        if (!cLocalSettingsEditable()) {
          render();
          return;
        }
        await submitLocalSettings();
      });
    }
    panel.querySelector(".sv24-task-open").addEventListener("click", async () => {
      showSubpage("tasks");
      await refreshCatalog();
    });
    panel.querySelector(".sv24-block-open").addEventListener("click", async () => {
      showSubpage("blocks");
      await refreshCatalog();
    });
    panel.querySelector(".sv24-block-back").addEventListener("click", () => showSubpage());
    panel.querySelector(".sv24-block-page-refresh").addEventListener("click", refreshCatalog);
    panel.querySelector(".sv24-block-list").addEventListener("change", async (event) => {
      if (!event.target.closest('input[data-task-id]')) return;
      await saveTaskSelection("blockedTaskIds", currentSettings().blockedTaskIds);
    });
    panel.querySelector(".sv24-block-select-all").addEventListener("click", async () => {
      await saveTaskSelection("blockedTaskIds", taskCatalog(status && status.worker).map((task) => task.taskId));
    });
    panel.querySelector(".sv24-block-clear").addEventListener("click", async () => {
      await saveTaskSelection("blockedTaskIds", []);
    });
    panel.querySelector(".sv24-block-add").addEventListener("click", async () => {
      const input = panel.querySelector(".sv24-block-custom-input");
      const additions = String(input.value || "").split(/[\s,，;；]+/);
      await saveTaskSelection("blockedTaskIds", [...currentSettings().blockedTaskIds, ...additions]);
      input.value = "";
    });
    panel.querySelector(".sv24-task-back").addEventListener("click", () => showSubpage());
    panel.querySelector(".sv24-refresh-tasks").addEventListener("click", refreshCatalog);
    panel.querySelector(".sv24-task-page-refresh").addEventListener("click", refreshCatalog);
    panel.querySelector(".sv24-task-page .sv24-task-list").addEventListener("change", async (event) => {
      if (!event.target.closest('input[data-task-id]')) return;
      if (turboMode && event.target.checked) {
        await saveTaskSelection("selectedTaskIds", [event.target.dataset.taskId]);
        return;
      }
      await saveTaskSelection("selectedTaskIds", currentSettings().selectedTaskIds);
    });
    panel.querySelector(".sv24-task-select-all").addEventListener("click", async () => {
      await saveTaskSelection("selectedTaskIds", taskCatalog(status && status.worker).map((task) => task.taskId));
    });
    panel.querySelector(".sv24-task-clear").addEventListener("click", async () => {
      await saveTaskSelection("selectedTaskIds", []);
    });
    panel.querySelector(".sv24-task-add").addEventListener("click", async () => {
      const input = panel.querySelector(".sv24-task-custom-input");
      const additions = String(input.value || "").split(/[\s,，;；]+/);
      await saveTaskSelection("selectedTaskIds", [...currentSettings().selectedTaskIds, ...additions]);
      input.value = "";
    });
    panel.querySelector("#sv-mode-auto").addEventListener("click", () => switchMode("auto"));
    panel.querySelector("#sv-mode-manual").addEventListener("click", async () => {
      if (!cLocalExecutionReady() || !switchMode("manual")) return;
      if (!(status && status.running) && cLocalExecutionReady()) await refreshCatalog();
    });
    panel.querySelector(".sv24-manual-refresh").addEventListener("click", async () => {
      if (!cLocalExecutionReady()) {
        render();
        return;
      }
      await refreshCatalog();
    });
    panel.querySelector('[name="manualClaimAmount"]').addEventListener("change", async (event) => {
      if (!cLocalExecutionReady()) {
        render();
        return;
      }
      const amount = boundedSetting("claimAmount", event.target.value, effectiveSettings().claimAmount);
      event.target.value = String(amount);
      const mainInput = panel.querySelector('[name="claimAmount"]');
      if (mainInput) mainInput.value = String(amount);
      await submitLocalSettings({claimAmount: amount});
    });
    panel.querySelector(".sv24-manual-list").addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-task-id]");
      if (!button || button.disabled || busy || !cLocalExecutionReady()) {
        render();
        return;
      }
      const amountInput = panel.querySelector('[name="manualClaimAmount"]');
      const amount = boundedSetting("claimAmount", amountInput.value, effectiveSettings().claimAmount);
      busy = true;
      render();
      const response = await send({
        type: "manual-claim",
        taskId: button.dataset.taskId,
        taskName: button.dataset.taskName,
        settings: {...currentSettings(), claimAmount: amount},
        platformAccount: platformAccount(),
        cPolicyRevision: cPolicy.revision,
        cRouteMode: cPolicy.routeMode,
      }, 40000);
      busy = false;
      applyStatus(response);
    });
    panel.querySelector(".sv24-workload-open").addEventListener("click", () => showSubpage("workload"));
    panel.querySelector(".sv24-workload-back").addEventListener("click", () => showSubpage());
    panel.querySelector(".sv24-workload-search input").addEventListener("input", (event) => {
      workloadQuery = String(event.target.value || "");
      updateWorkload(status && status.workload);
    });
    panel.querySelector("#sv-sound-enabled").addEventListener("change", (event) => {
      soundEnabled = event.target.checked === true;
      saveSoundPreference();
      if (soundEnabled) unlockSuccessSound();
    });
    panel.querySelector('[name="turboMode"]').addEventListener("change", (event) => {
      if (status?.running || !cLocalSettingsEditable()) { render(); return; }
      if (event.target.checked && !status?.turbo?.allowed) { render(); return; }
      turboMode = event.target.checked;
      try { localStorage.setItem(TURBO_MODE_KEY, String(turboMode)); } catch (error) {}
      if (turboMode && !turboSmartRouting && currentSettings().selectedTaskIds.length !== 1) showSubpage("tasks");
      render();
    });
    panel.querySelector('[name="turboSmartRouting"]').addEventListener("change", (event) => {
      if (status?.running || !turboMode || !cLocalSettingsEditable()) { render(); return; }
      turboSmartRouting = event.target.checked;
      try { localStorage.setItem(TURBO_SMART_ROUTE_KEY, String(turboSmartRouting)); } catch (error) {}
      if (!turboSmartRouting && currentSettings().selectedTaskIds.length !== 1) showSubpage("tasks");
      render();
      sendStatusToCSandbox();
    });
    panel.querySelector(".sv-turbo-recover").addEventListener("click", async () => {
      if (busy || !window.confirm("将按当前平台列表核对并释放本轮超额任务。超时请求仍可能迟到；确认已检查平台任务，解除后由你手动启动？")) return;
      busy = true;
      turboRecovering = true;
      statusRefreshEpoch += 1;
      render();
      try {
        const response = await send({type: "turbo-recover"}, 120000);
        if (response.ok === true && response.turboRecovered === true) {
          // A lost turbo-result can leave both bridge and module waiting for
          // an old action. Recreate them using the fresh response envelope.
          cPolicyEpoch += 1;
          teardownCSandbox("解除锁定后重新初始化", false);
          cSandboxError = "";
          runtimeActivity = null;
          addRuntimeLog("ok", "已解除锁定", {message: "核对完成，可手动启动"});
        } else if (response.ok !== true) {
          addRuntimeLog("error", "解除锁定失败", {message: response.error || "核对未完成"});
        }
        applyStatus(response);
      } finally { turboRecovering = false; busy = false; render(); }
    });
    panel.querySelector(".sv24-start").addEventListener("click", async () => {
      if (busy) return;
      if (!status?.running && authorizationError()) {
        addRuntimeLog("error", "启动失败", {message: authorizationError()});
        render();
        return;
      }
      if (!status?.running && currentSettings().preSubmitEnabled && currentSettings().taskSelectionRequired && !(turboMode && turboSmartRouting)) {
        addRuntimeLog("warn", "需要重新选择任务", {message: "原勾选任务已从完整目录消失，请重新选择"});
        showSubpage("tasks");
        return;
      }
      if (!status?.running && turboMode && cLocalDelegated()
        && ((!turboSmartRouting && currentSettings().selectedTaskIds.length !== 1) || !currentSettings().preSubmitEnabled)) {
        addRuntimeLog("warn", "启动失败", {message: "极速模式需要启用加速模式，且只选择一个任务 ID"});
        showSubpage("tasks");
        return;
      }
      if (!status?.running && cLocalDelegated() && currentSettings().preSubmitEnabled === true) {
        if (!accelerationAvailable()) {
          addRuntimeLog("warn", "启动失败", {message: "服务器下发间隔高于10ms，加速模式不可启动，请关闭加速模式后使用普通领取"});
          render();
          return;
        }
      }
      const policyRouteLocal = cPolicy.delegated === true && cPolicy.routeMode === "local";
      const serverLeaseReady = !!(status && status.registered) && !policyRouteLocal;
      if (!(status && status.running) && (!(cPolicyUsable() || serverLeaseReady) || (cLocalDelegated() && !cLocalExecutionReady()))) {
        render();
        return;
      }
      busy = true;
      const wasRunning = !!(status && status.running);
      if (!wasRunning && soundEnabled) unlockSuccessSound();
      render();
      const response = wasRunning
        ? await send({type: "stop", reason: "使用者已停止"})
        : await send({
          type: "start",
          settings: currentSettings(),
          platformAccount: platformAccount(),
          cPolicyRevision: cPolicy.revision,
          cRouteMode: cPolicy.routeMode,
        });
      busy = false;
      if (response && response.ok !== false) {
        if (wasRunning) {
          runtimeActivity = null;
          addRuntimeLog("info", "安全自动已停止", {message: "使用者已停止"});
        } else {
          runtimeSeenTaskCount = 0;
          lastCatalogLogSignature = "";
          setRuntimeActivity("扫描中", "安全自动已启动，正在读取候选任务");
          addRuntimeLog("ok", "安全自动已启动");
        }
      } else {
        addRuntimeLog("error", wasRunning ? "停止失败" : "启动失败", {message: String(response && response.error || "后台无回应")});
      }
      applyStatus(response);
    });
  }

  function stopOnExit() {
    if (slowModeTimer) clearInterval(slowModeTimer);
    slowModeTimer = null;
    if (runtimeLogFlushTimer !== null) flushRuntimeLogs();
    if (statusRefreshTimer) clearInterval(statusRefreshTimer);
    statusRefreshTimer = null;
    stopLoginStatusPolling();
    stopLoginProgress();
    stopPlatformAccountWatch();
    if (cPolicyExpiryTimer) clearTimeout(cPolicyExpiryTimer);
    cPolicyExpiryTimer = null;
    // Tab关闭、离开SkyVendor和策略失效由background处理。页面刷新时这里只
    // 释放iframe，不能把正常刷新误判成使用者停止。
    if (cSandbox) teardownCSandbox("验收页面已关闭", false);
    if (pagePort) {
      try { pagePort.disconnect(); } catch (error) {}
      pagePort = null;
    }
  }

  async function refreshStatus() {
    if (statusRefreshBusy || turboRecovering) return;
    statusRefreshBusy = true;
    const epoch = statusRefreshEpoch;
    try {
      const response = await send({type: "poll"});
      if (epoch === statusRefreshEpoch && !turboRecovering) applyStatus(response);
    } finally {
      statusRefreshBusy = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.scope !== "xiaotian-v24") return;
    if (message.type === "turbo-result") {
      const bridge = cSandbox;
      if (bridge?.turboClaim) {
        const {claim, requestedAt} = bridge.turboClaim;
        finishCSandboxClaim(bridge, claim, message.response, requestedAt);
      } else {
        if (message.response?.ok && message.response.actualAmount > 0) playClaimSuccessSound();
        applyStatus(message.response);
      }
      return;
    }
    if (message.type === "turbo-package-confirmed") {
      const bridge = cSandbox;
      if (bridge && bridge.policyEpoch === cPolicyEpoch && bridge.claimInFlight) {
        bridge.turboSoundNotified = true;
        playClaimSuccessSound();
      }
      return;
    }
    if (message.type === "read-working-claim-times") {
      sendResponse({ok: true, rows: visibleWorkingClaimTimes()});
      return;
    }
    if (message.type === "platform-request-log") {
      addRuntimeLog(message.success === true ? "info" : "warn", `接口响应·${String(message.action || "平台请求").slice(0, 40)}`, {
        durationMs: Number(message.durationMs) || 0,
        durationLabel: "响应耗时",
        message: message.success === true ? "成功" : String(message.message || "未成功"),
      });
      return;
    }
    if (message.type === "catalog-update") {
      const currentWorker = status && status.worker && typeof status.worker === "object" ? status.worker : {};
      const taskCatalog = Array.isArray(message.taskCatalog) ? message.taskCatalog : [];
      status = {
        ...(status || {}),
        worker: {
          ...currentWorker,
          taskCatalog,
          availableTasks: Number(message.availableTasks) || 0,
          localScanRounds: Number(message.localScanRounds) || 0,
          catalogClaimIncrease: Number.isSafeInteger(message.catalogClaimIncrease)
            ? message.catalogClaimIncrease : currentWorker.catalogClaimIncrease,
        },
      };
      updateTaskSelection(status.worker, effectiveSettings());
      if (authorizationError()) {
        render();
        return;
      }
      sendStatusToCSandbox();
      setText("[data-value=availableTasks]", status.worker.availableTasks);
      if (message.error) {
        panel.querySelector(".sv24-status-detail").textContent = `本地扫描失败：${String(message.error)}`;
      } else {
        const rounds = Number(status.worker.localScanRounds) || 0;
        const available = Number(status.worker.availableTasks) || 0;
        if (Number.isSafeInteger(status.worker.catalogClaimIncrease) && status.worker.catalogClaimIncrease >= 0) {
          runtimeSeenTaskCount = status.worker.catalogClaimIncrease;
        }
        setText("#sv-safe-stat-seen", runtimeSeenTaskCount);
        const claimInFlight = !!(cSandbox && cSandbox.claimInFlight);
        if (status.running === true && !claimInFlight && (!runtimeActivity || Date.now() - runtimeActivity.at > 800)) {
          runtimeActivity = {
            ...(runtimeActivity || {}),
            phase: "扫描中",
            text: `第${rounds}轮扫描：${available > 0 ? `发现${available}个可领取任务，正在选择候选` : "暂无可领取任务，继续刷新"}`,
            taskId: "",
            taskName: "",
            at: Date.now(),
          };
          render();
        } else if (status.running !== true && !String(status.error || currentWorker.lastError || "")) {
          panel.querySelector(".sv24-status-detail").textContent = `本地每${Math.max(100, Number(message.refreshMs) || LOCAL_SCAN_MS)}ms扫描可领取任务（第${rounds}轮）`;
        }
        const signature = `${Math.floor(rounds / 25)}:${available}`;
        if (status.running === true && rounds > 0 && signature !== lastCatalogLogSignature) {
          lastCatalogLogSignature = signature;
          addRuntimeLog("info", "扫描任务", {message: `第${rounds}轮，发现${available}个可领取任务`});
        }
      }
      return;
    }
    if (message.type === "status-update") {
      applyStatus(message.status);
      return;
    }
    if (message.type === "toggle-panel") {
      panel.hidden = !panel.hidden;
      launcher.hidden = !panel.hidden;
      if (!panel.hidden) requestAnimationFrame(clampPanelIntoViewport);
      return;
    }
    if (message.type === "refresh-acceptance-table") {
      refreshAcceptanceTaskTable().then(sendResponse, (error) => {
        sendResponse({ok: false, error: String(error && error.message || error)});
      });
      return true;
    }
  });

  async function boot() {
    loadUiPreferences();
    createPanel();
    connectPage();
    const detectedAccount = platformAccount();
    lastReportedPlatformAccount = detectedAccount;
    applyStatus(await send({type: "init", platformAccount: detectedAccount}));
    // On the first load, fetch the acceleration queue and select every
    // available task. Existing explicit selections remain untouched.
    void initializeAccelerationQueue();
    if (!detectedAccount) watchPlatformAccount();
    try {
      const legacyWorkload = JSON.parse(localStorage.getItem("xiaotianWorkloadV1") || "null");
      if (legacyWorkload && typeof legacyWorkload === "object") {
        applyStatus(await send({type: "import-workload", workload: legacyWorkload}));
      }
    } catch (error) {}
    statusRefreshTimer = setInterval(refreshStatus, Math.max(250, Number(CONFIG.STATUS_REFRESH_MS) || 1000));
    slowModeTimer = setInterval(() => { void tickSlowMode().catch(error => {
      addRuntimeLog("error", "普通模式检查失败", {message: String(error.message || error)});
    }); }, 100);
  }

  window.addEventListener("pagehide", stopOnExit, {capture: true});
  window.addEventListener("beforeunload", stopOnExit, {capture: true});
  boot();
})();
