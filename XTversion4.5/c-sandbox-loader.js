(() => {
  "use strict";

  const CHANNEL = "xiaotian-c-sandbox-v1";
  const EMIT_TYPES = new Set(["claim", "idle"]);
  let parentSource = null;
  let sessionNonce = "";
  let moduleHash = "";
  let handlers = null;
  let loaded = false;
  let stopped = false;
  let messagePort = null;

  function serializable(value, maximum = 128000) {
    try {
      const json = JSON.stringify(value == null ? null : value);
      if (json.length > maximum) return null;
      return JSON.parse(json);
    } catch (error) {
      return null;
    }
  }

  function post(type, payload = {}) {
    if (!sessionNonce || (!messagePort && !parentSource)) return;
    const message = {
      channel: CHANNEL,
      direction: "sandbox-to-content",
      type,
      sessionNonce,
      ...payload,
    };
    if (messagePort) messagePort.postMessage(message);
    else parentSource.postMessage(message, "*");
  }

  function reportError(stage, error) {
    post("module-error", {
      stage: String(stage || "runtime").slice(0, 40),
      error: String(error && error.message || error || "本机模组执行失败").slice(0, 300),
    });
  }

  const api = Object.freeze({
    register(candidate) {
      if (loaded || handlers) throw new Error("本机模组只能注册一次 handlers");
      if (!candidate || typeof candidate !== "object") throw new Error("handlers 必须是对象");
      for (const name of ["update", "actionResult", "stop"]) {
        if (typeof candidate[name] !== "function") throw new Error(`handlers.${name} 必须是函数`);
      }
      handlers = Object.freeze({
        update: candidate.update,
        actionResult: candidate.actionResult,
        stop: candidate.stop,
      });
    },
    emit(type, payload) {
      if (!loaded || stopped || !EMIT_TYPES.has(type)) return false;
      const safePayload = serializable(payload);
      if (safePayload == null) return false;
      post("action", {action: type, payload: safePayload});
      return true;
    },
  });

  function executeModule(source) {
    const runner = Function(
      "api",
      "window",
      "document",
      "chrome",
      "browser",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "fetch",
      "XMLHttpRequest",
      "WebSocket",
      "EventSource",
      "Worker",
      "SharedWorker",
      "navigator",
      "location",
      "parent",
      "top",
      "opener",
      "globalThis",
      "self",
      `"use strict";\n${source}\n//# sourceURL=xiaotian-c-local-module.js`,
    );
    runner(
      api,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  }

  function handleMessage(rawMessage, source) {
    const message = rawMessage && typeof rawMessage === "object" ? rawMessage : {};
    if (message.channel !== CHANNEL || message.direction !== "content-to-sandbox") return;
    if (message.type === "load-module") {
      const nonce = String(message.sessionNonce || "");
      let moduleSource = String(message.moduleSource || "");
      const expectedHash = String(message.moduleHash || "").slice(0, 256);
      if (!/^[a-f0-9]{48}$/i.test(nonce) || !moduleSource || moduleSource.length > 2_000_000 || !expectedHash) return;
      if (loaded && nonce === sessionNonce && expectedHash === moduleHash) {
        post("module-loaded", {moduleHash});
        return;
      }
      if (loaded || (parentSource && source && parentSource !== source)) return;
      if (!parentSource) parentSource = source;
      sessionNonce = nonce;
      moduleHash = expectedHash;
      try {
        executeModule(moduleSource);
        moduleSource = "";
        if (!handlers) throw new Error("本机模组没有调用 api.register(handlers)");
        loaded = true;
        post("module-loaded", {moduleHash});
      } catch (error) {
        moduleSource = "";
        reportError("load", error);
      }
      return;
    }
    if (!loaded || stopped || (!messagePort && source !== parentSource) || message.sessionNonce !== sessionNonce) return;
    if (message.type === "status-update") {
      const next = serializable(message.status);
      if (next == null) return;
      try { handlers.update(next); } catch (error) { reportError("update", error); }
      return;
    }
    if (message.type === "action-result") {
      const result = serializable(message.result);
      if (result == null) return;
      try { handlers.actionResult(result); } catch (error) { reportError("actionResult", error); }
      return;
    }
    if (message.type === "stop") {
      stopped = true;
      try { handlers.stop(); } catch (error) { reportError("stop", error); }
      handlers = null;
      sessionNonce = "";
      moduleHash = "";
      const port = messagePort;
      messagePort = null;
      parentSource = null;
      try { port && port.close(); } catch (error) {}
    }
  }

  window.addEventListener("message", (event) => {
    const message = event.data && typeof event.data === "object" ? event.data : {};
    if (message.channel !== CHANNEL || message.direction !== "content-to-sandbox") return;
    if (message.type === "connect") {
      const nonce = String(message.sessionNonce || "");
      const port = event.ports && event.ports[0];
      if (!/^[a-f0-9]{48}$/i.test(nonce) || !port || messagePort) return;
      parentSource = event.source;
      sessionNonce = nonce;
      messagePort = port;
      messagePort.onmessage = (portEvent) => handleMessage(portEvent.data, parentSource);
      messagePort.start();
      post("sandbox-ready");
      return;
    }
    handleMessage(message, event.source);
  });

  window.parent.postMessage({
    channel: CHANNEL,
    direction: "sandbox-to-content",
    type: "sandbox-ready",
  }, "*");
})();
