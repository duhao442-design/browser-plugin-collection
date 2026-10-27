"use strict";
// Reporting has its own durable queue. Network retries never enter the claim queue.
globalThis.XiaotianClaimAudit = (() => {
  const cfg = globalThis.XiaotianV24Config;
  const key = `${cfg.STATE_KEY}ClaimAuditV1`;
  const alarm = "xiaotian-claim-audit-flush";
  let buildPromise = null, mutation = Promise.resolve(), flushing = false, timer = null;
  const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
  const digest = async data => hex(await crypto.subtle.digest("SHA-256", data));
  async function build() {
    if (!buildPromise) buildPromise = (async () => {
      const manifest = chrome.runtime.getManifest();
      const names = new Set(["manifest.json", "config.js", "c-policy.js", "turbo-runner.js", "turbo-background.js", "claim-audit-client.js"]);
      if (manifest.background?.service_worker) names.add(manifest.background.service_worker);
      for (const script of manifest.content_scripts || []) for (const name of [...(script.js || []), ...(script.css || [])]) names.add(name);
      for (const entry of manifest.web_accessible_resources || []) for (const name of entry.resources || []) names.add(name);
      const lines = await Promise.all([...names].sort().map(async name => {
        const response = await fetch(chrome.runtime.getURL(name));
        if (!response.ok) throw new Error(`无法读取插件文件 ${name}`);
        return `${name}:${await digest(await response.arrayBuffer())}\n`;
      }));
      return {scriptHash: await digest(new TextEncoder().encode(lines.join(""))), hashAlgorithm: "sha256-files-v1",
        extensionVersion: manifest.version_name || manifest.version};
    })().catch(error => {buildPromise = null; throw error;});
    return buildPromise;
  }
  async function read() {
    const value = (await chrome.storage.local.get(key))[key] || {};
    return {pending: Array.isArray(value.pending) ? value.pending : [], seen: Array.isArray(value.seen) ? value.seen : []};
  }
  function mutate(fn) {
    const job = mutation.then(async () => {
      const data = await read();
      const result = await fn(data);
      await chrome.storage.local.set({[key]: data});
      return result;
    });
    mutation = job.catch(() => {});
    return job;
  }
  function schedule(ms = 1000) {
    if (!timer) timer = setTimeout(() => {timer = null; void flush();}, ms);
    void chrome.alarms.create(alarm, {periodInMinutes: 1});
  }
  async function capture(state, rows, mode, moduleHash = "", originalBuild = null) {
    if (!state?.installId || !state?.userName || !Array.isArray(rows) || !rows.length) return;
    const info = originalBuild && /^[a-f0-9]{64}$/.test(originalBuild.scriptHash || "")
      ? originalBuild : await build();
    const now = Date.now();
    const entries = rows.filter(row => row?.id && row?.taskId).map(row => {
      const platformAt = typeof releaseClaimedAt === "function" ? releaseClaimedAt(row) : 0;
      return {eventId: `subtask:${String(row.id)}`, subTaskId: String(row.id), taskId: String(row.taskId),
        taskName: String(row.taskName || row.name || state.lastWorker?.currentTaskName || ""),
        claimedAt: Number.isSafeInteger(platformAt) && platformAt > 0 && platformAt <= now + 86400000 ? platformAt : now,
        timeSource: platformAt > 0 ? "platform" : "confirmed", mode, moduleHash, ...info};
    });
    await mutate(data => {
      const seen = new Set(data.seen);
      for (const event of entries) {
        const id = JSON.stringify([state.installId, state.userName, event.eventId]);
        if (seen.has(id)) continue;
        data.pending.push({id, installId: state.installId, userName: state.userName, event});
        seen.add(id);
      }
      data.seen = [...seen].slice(-20000);
    });
    schedule();
  }
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      await mutation;
      const data = await read();
      if (!data.pending.length) { await chrome.alarms.clear(alarm); return; }
      const state = (await chrome.storage.local.get(cfg.STATE_KEY))[cfg.STATE_KEY];
      if (!state?.installToken || !state.installId || !state.userName) {schedule(30000); return;}
      const batch = data.pending.filter(r => r.installId === state.installId && r.userName === state.userName).slice(0, 50);
      if (!batch.length) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let response, body;
      try {
        response = await fetch(`${cfg.API_BASE}/api/v3/claim-events`, {method: "POST", signal: controller.signal,
          headers: {"Content-Type": "application/json", Authorization: `Bearer ${state.installToken}`},
          body: JSON.stringify({events: batch.map(r=>r.event), scriptBuild: await build()})});
        body = await response.json();
      } finally {clearTimeout(timeout);}
      if (!response.ok || !body.ok || !Array.isArray(body.accepted)) throw new Error(`HTTP ${response.status}`);
      const accepted = new Set(body.accepted);
      const acknowledged = new Set(batch.filter(r=>accepted.has(r.event.eventId)).map(r=>r.id));
      const remaining = await mutate(current => {
        current.pending = current.pending.filter(r=>!acknowledged.has(r.id));
        return current.pending.length;
      });
      if (remaining) schedule(30000);
    } catch (error) {
      console.warn("领取记录待重试", String(error.message || error));
      schedule(30000);
    } finally {flushing = false;}
  }
  chrome.alarms.onAlarm.addListener(event => {if (event.name === alarm) void flush();});
  void build().catch(error => console.warn("插件哈希待重试", error.message));
  void read().then(data => {if(data.pending.length) schedule();});
  return {build, capture, flush};
})();
