"use strict";

// Fixed cadence, without catch-up bursts or an in-flight concurrency limit.
globalThis.XiaotianTurbo = {
  run({intervalMs, guard, request, inspect, onProgress = () => {}}) {
    let timer = null;
    let stopped = false;
    let pending = 0;
    let sent = 0;
    let successes = 0;
    let uncertain = false;
    let reason = "";
    let inspection = null;
    let inspectionTimer = null;
    let resolve;
    const done = new Promise((finish) => { resolve = finish; });
    function publish() {
      onProgress({pending, sent, successes, stopped, reason});
      if (stopped && pending === 0 && !inspection) resolve({sent, successes, uncertain, reason});
    }
    function stop(message = "") {
      if (!stopped) reason = message;
      stopped = true;
      clearTimeout(timer);
      clearTimeout(inspectionTimer);
      publish();
    }
    function check() {
      if (stopped || inspection || !inspect) return;
      clearTimeout(inspectionTimer);
      inspection = Promise.resolve().then(inspect).then((reached) => {
        if (reached) stop("真实包数达到停止线，等待在途请求并核对");
      }, () => {
        // A read failure is not evidence that the stop threshold was reached.
      }).finally(() => {
        inspection = null;
        if (!stopped) inspectionTimer = setTimeout(check, 1000);
        publish();
      });
    }
    function tick() {
      if (stopped) return;
      try { guard(); } catch (error) { stop(String(error.message || error)); return; }
      pending += 1;
      sent += 1;
      publish();
      timer = setTimeout(tick, intervalMs);
      Promise.resolve().then(request).then((result) => {
        if (result?.notSent === true) {
          stop(result.error || "请求未发出，请检查平台连接");
        } else if (result && result.ok) {
          successes += 1;
          check();
        } else if (!result || result.transportError || !result.status || result.status >= 500) {
          uncertain = true;
          check();
        } else if (result.status === 429 || /429|频繁|限流/.test(String(result.error || ""))) {
          stop("平台限流，停止本轮发送");
        }
      }, (error) => {
        uncertain = true;
        check();
      }).finally(() => { pending -= 1; publish(); });
    }
    timer = setTimeout(tick, 0);
    inspectionTimer = setTimeout(check, 1000);
    return {done, stop};
  },

  excess(rows, baselineIds, taskId, limit, count, time) {
    let overflow = rows.reduce((sum, row) => sum + count(row), 0) - limit;
    const newest = rows.filter((row) => !baselineIds.has(String(row.id)) && String(row.taskId) === taskId)
      .sort((a, b) => time(b) - time(a) || String(b.id).localeCompare(String(a.id), undefined, {numeric: true}));
    const targets = [];
    for (const row of newest) {
      if (overflow <= 0) break;
      targets.push(row);
      overflow -= count(row);
    }
    if (overflow > 0) throw new Error("超额任务包含本轮之外的工作，已停止，请人工核对");
    return targets;
  },
};
