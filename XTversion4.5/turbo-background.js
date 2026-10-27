"use strict";

let turboRun = null;
let turboRecoveryPending = false;
const TURBO_JOURNAL_KEY = "xiaotianTurboRecoveryV1";
const TURBO_MIN_INTERVAL_MS = 0.000000001;
const TURBO_ROUTE_KEY = "xiaotianTurboRouteV1";
const TURBO_ROUTE_PERIOD_MS = 5 * 60 * 1000;

async function turboRouteState(state) {
  const route = (await chrome.storage.local.get(TURBO_ROUTE_KEY))[TURBO_ROUTE_KEY];
  const owner = String(state.userName || state.platformAccount || state.installId || "");
  return route && route.owner === owner ? route : null;
}

function turboRouteDue(route) {
  return !!route && !route.unsettled && !route.uncertain && Date.now() >= route.nextCheckAt;
}

async function turboRouteStatus(state) {
  const route = await turboRouteState(state);
  return route ? {taskId: route.taskId, nextCheckAt: route.nextCheckAt,
    canSwitch: turboRouteDue(route), uncertain: !!route.uncertain} : null;
}

function turboSingleTask(rows) {
  const ids = new Set(rows.map((row) => String(row.taskId || "")));
  if (ids.has("") || ids.size > 1) throw new Error("存在不同任务流或任务归属不明，停止极速领取，请先核对未完成任务");
  return [...ids][0] || "";
}

async function assertTurboTaskCompatibility(state, taskId, rows) {
  const route = await turboRouteState(state);
  if (!route) return;
  const heldId = turboSingleTask(rows);
  if (route.unsettled || (route.uncertain && route.taskId !== taskId) || (heldId && heldId !== taskId)) {
    throw new Error("原极速任务流尚未清空或存在未确认请求，不能领取其他任务流");
  }
}

async function selectTurboRoute(state, settings, proposedId, rows, smartRouting, tabId) {
  let route = await turboRouteState(state);
  let heldId = turboSingleTask(rows);
  if (route?.unsettled) throw new Error("上一轮极速请求尚未完成核对，不能切换任务流");
  if (route?.uncertain && heldId && heldId !== route.taskId) {
    throw new Error("旧任务流仍有结果不确定的请求，不能向其他任务流领取");
  }
  let taskId = proposedId;
  if (smartRouting) {
    taskId = heldId || (route && !turboRouteDue(route) ? route.taskId : proposedId);
  } else if ((heldId && heldId !== proposedId) || (route?.uncertain && route.taskId !== proposedId)) {
    throw new Error("请先完成原任务流并确认全部请求结果，再选择其他任务流");
  }
  // A second fresh read is required before changing an established route.
  // A timeout is not a completed response and never grants permission to switch.
  if (route && taskId !== route.taskId) {
    await relayDelay(2000);
    rows = await turboExactRows(tabId);
    heldId = turboSingleTask(rows);
    if (heldId) {
      if (!smartRouting || heldId !== route.taskId) throw new Error("切换前发现未完成任务，保持原任务流");
      taskId = heldId;
    }
  }
  if (settings.blockedTaskIds.includes(taskId)) throw new Error("当前任务流已屏蔽，未完成前不能切换到其他任务流");
  if (!route || route.taskId !== taskId) {
    route = {owner: String(state.userName || state.platformAccount || state.installId || ""),
      taskId, nextCheckAt: Date.now() + TURBO_ROUTE_PERIOD_MS, uncertain: false, unsettled: false};
  } else if (Date.now() >= route.nextCheckAt) {
    route.nextCheckAt = Date.now() + TURBO_ROUTE_PERIOD_MS;
  }
  return {taskId, rows, route};
}

async function settleTurboRoute(run, result, rows, error) {
  if (!run.route) return;
  const route = run.route;
  route.unsettled = !!error;
  route.uncertain = route.uncertain || result.uncertain;
  if (rows?.length && Date.now() >= route.nextCheckAt) route.nextCheckAt = Date.now() + TURBO_ROUTE_PERIOD_MS;
  await chrome.storage.local.set({[TURBO_ROUTE_KEY]: route});
}

function turboServerInterval() {
  const policy = cPolicyCurrent();
  const value = policy?.defaults?.preSubmitIntervalMs;
  return cPolicyUsable() && policy.delegated === true && policy.routeMode === "local"
    && Number.isFinite(value) && value >= TURBO_MIN_INTERVAL_MS ? value : 0;
}

function requireTurboInterval() {
  const value = turboServerInterval();
  if (!value || value > 10) throw new Error("极速模式不可启动：服务器下发间隔必须为 0.000000001-10ms");
  return value;
}

async function turboJournal() {
  const journal = (await chrome.storage.local.get(TURBO_JOURNAL_KEY))[TURBO_JOURNAL_KEY] || null;
  turboRecoveryPending = !!journal;
  return journal;
}

function turboRecoverAt(journal) {
  if (!journal || journal.uncertain === false) return 0;
  return Number(journal.finishedAt || journal.startedAt || 0) + 2000;
}

async function reconcileTurboRun(tabId, journal) {
  // The scheduler has drained all local requests. Allow a short platform
  // visibility window, then reconcile current rows, never historical totals.
  const readyAt = Number(journal.finishedAt || 0) + 2000;
  if (journal.finishedAt && (journal.uncertain || journal.successes > 0)) {
    const remaining = Math.max(0, readyAt - Date.now());
    if (remaining) await relayDelay(remaining);
  }
  return turboCleanup(tabId, journal);
}

function stopTurboRun(reason, tabId = 0) {
  if (turboRun && (!tabId || turboRun.tabId === tabId)) {
    turboRun.cancelled = true;
    turboRun.engine?.stop(reason);
  }
}

async function turboExactRows(tabId) {
  const rows = await readLocalWorkingRows(tabId, true);
  const exact = [];
  for (const row of rows) {
    const data = await executeLocalRead(tabId, platformRoute("summary", {subTaskId: row.id}), {}, "极速核对包数");
    if (!Number.isSafeInteger(data && data.total) || data.total < 0) throw new Error("summary 未返回有效总数，禁止按估算包数释放");
    const summary = {total: data.total, packageCount: packageCountFromSummaryTotal(data.total), fetchedAt: Date.now()};
    subTaskSummaryCache.set(String(row.id), summary);
    exact.push({...row, summaryTotal: summary.total, summaryPackageCount: summary.packageCount});
  }
  return exact;
}

async function turboCleanup(tabId, journal) {
  let rows = await turboExactRows(tabId);
  await XiaotianClaimAudit.capture(await loadState(), rows.filter(row => !journal.baselineIds.includes(String(row.id)) && String(row.taskId) === journal.taskId), "turbo", cModuleHash)
    .catch(error => console.warn("极速领取记录待补报", error.message));
  const targets = XiaotianTurbo.excess(rows, new Set(journal.baselineIds), journal.taskId, journal.limit,
    rowPackageCount, (row) => releaseClaimedAt(row) || 0);
  for (const row of targets) {
    const result = await releaseLocalPackage(tabId, row);
    if (result.deferred) throw new Error("超额释放处于重试冷却，保留锁定，稍后重新核对");
    journal.releasedIds = [...new Set([...(journal.releasedIds || []), String(row.id)])];
    await chrome.storage.local.set({[TURBO_JOURNAL_KEY]: journal});
  }
  if (targets.length) {
    rows = await turboExactRows(tabId);
    if (workingPackageCount(rows) > journal.limit || targets.some((target) => rows.some((row) => String(row.id) === String(target.id)))) {
      throw new Error("超额释放尚未被平台列表确认，保持停止");
    }
  }
  return rows;
}

async function startTurboRun(message, tabId) {
  const intervalMs = requireTurboInterval();
  const state = await loadState();
  if (typeof applyLiveCatalog === "function") applyLiveCatalog(state, tabId);
  applyCPolicyRuntime(state);
  const settings = normalizeSettings(state.settings, state.runtimePolicy);
  const smartRouting = message.payload.turboSmartRouting === true;
  const proposedId = String(message.payload.taskId || "");
  if ((!smartRouting && (settings.selectedTaskIds.length !== 1 || settings.selectedTaskIds[0] !== proposedId))
    || !/^[A-Za-z0-9_-]{1,80}$/.test(proposedId) || settings.blockedTaskIds.includes(proposedId)) {
    throw new Error("极速单任务队列模式必须且只能选择一个未屏蔽任务 ID");
  }
  const candidates = selectedServerTasks(smartRouting
    ? {...state, settings: {...settings, selectedTaskIds: [], taskSelectionRequired: false}} : state, "pre-submit");
  const previousRoute = await turboRouteState(state);
  if (!candidates.some((task) => task.taskId === proposedId) && !(smartRouting && previousRoute?.taskId === proposedId)) {
    throw new Error("任务不在当前任务屏蔽／预提交队列范围内");
  }
  const selected = await selectTurboRoute(state, settings, proposedId, await turboExactRows(tabId), smartRouting, tabId);
  const {taskId, route} = selected;
  if (typeof taskMissingFromDirectory === "function" && taskMissingFromDirectory(taskId, state.localDirectoryProof)) {
    throw new Error("当前任务已从完整目录消失，保持任务流绑定，等待核对后重新选择");
  }
  const baseline = selected.rows;
  const working = workingPackageCount(baseline);
  const limit = Math.min(settings.targetPackages, settings.preSubmitStopPackages);
  if (working >= limit) {
    throw new Error("已达到本机放权停止包数或不属于加速阶段");
  }
  const amount = Math.min(settings.preSubmitAmount, limit - working);
  const session = await loadSession();
  if (!session.running || session.tabId !== tabId) throw new Error("本机放权已停止");
  const policy = requireCPolicy({local: true});
  const revision = policy.revision;
  const journal = {taskId, limit, baselineIds: baseline.map((row) => String(row.id)), startedAt: Date.now(), uncertain: true};
  route.unsettled = true;
  await chrome.storage.local.set({[TURBO_JOURNAL_KEY]: journal, [TURBO_ROUTE_KEY]: route});
  const run = {tabId, journal, route, smartRouting, intervalMs, cancelled: false, engine: null, phase: "固定间隔发送", pending: 0, sent: 0};
  run.soundNotifiedIds = new Set();
  // The turbo scheduler owns local claiming exclusively. A previously
  // started control loop must not switch the task back to ordinary dispatch.
  stopControlLoop();
  stopLocalCatalogLoop(tabId);
  turboRecoveryPending = true;
  turboRun = run;
  run.engine = XiaotianTurbo.run({
    intervalMs,
    guard() {
      if (run.cancelled || turboRun !== run) throw new Error("极速模式已停止");
      const live = typeof liveCatalogForTab === "function" ? liveCatalogForTab(tabId) : null;
      if (typeof taskMissingFromDirectory === "function" && taskMissingFromDirectory(taskId, live?.directoryProof)) {
        throw new Error("任务已从完整目录消失，停止发送并等待全部响应");
      }
      const current = requireCPolicy({local: true});
      if (requireTurboInterval() !== intervalMs) throw new Error("服务器间隔已变化，停止本轮发送并重新核对");
      if (serverAccessRevoked || current.revision !== revision) throw new Error("权限或参数已变化，停止本轮发送");
      if (smartRouting && Date.now() >= route.nextCheckAt) throw new Error("智能路由五分钟核对，暂停发送并等待全部响应");
    },
    async request() {
      recordLocalPlatformRequest();
      const command = {...localManualClaimCommand(taskId, amount), logAction: "极速领取", timeoutMs: 10000, noTransportReplay: true};
      // A POST transport failure is uncertain: never replay it through the page fallback.
      return executePlatformCommand(tabId, command);
    },
    async inspect() {
      const rows = await turboExactRows(tabId);
      if (rows.some((row) => String(row.taskId || "") !== taskId)) {
        run.engine.stop("发现其他任务流，停止发送并核对");
        return true;
      }
      const newRows = rows.filter((row) => !journal.baselineIds.includes(String(row.id))
        && String(row.taskId) === journal.taskId);
      const unseen = newRows.filter((row) => !run.soundNotifiedIds.has(String(row.id)));
      if (unseen.length) {
        await XiaotianClaimAudit.capture(await loadState(), unseen, "turbo", cModuleHash)
          .catch(error => console.warn("极速领取记录待补报", error.message));
        unseen.forEach((row) => run.soundNotifiedIds.add(String(row.id)));
        await chrome.tabs.sendMessage(tabId, {
          scope: "xiaotian-v24",
          type: "turbo-package-confirmed",
          taskId: journal.taskId,
          actualAmount: workingPackageCount(unseen),
        }).catch(() => {});
      }
      return workingPackageCount(rows) >= limit;
    },
    onProgress(progress) {
      run.pending = progress.pending;
      run.sent = progress.sent;
      if (progress.stopped) run.phase = "等待在途请求并核对";
    },
  });
  run.engine.done.then((result) => finishTurboRun(run, result)).catch(async (error) => {
    await enqueue(async () => {
      await stopServer("极速核对失败，请人工核对任务");
      const latest = await loadState();
      latest.lastError = String(error.message || error);
      await saveState(latest);
    });
  }).finally(() => { if (turboRun === run) turboRun = null; });
  return {ok: true, turboPending: true, taskId};
}

async function finishTurboRun(run, result) {
  const journal = run.journal;
  journal.uncertain = result.uncertain;
  journal.successes = result.successes;
  journal.finishedAt = Date.now();
  await chrome.storage.local.set({[TURBO_JOURNAL_KEY]: journal});
  let rows;
  let error = "";
  try {
    rows = await reconcileTurboRun(run.tabId, journal);
    turboSingleTask(rows);
    if (rows.some((row) => String(row.taskId) !== journal.taskId)) throw new Error("发现其他任务流，已停止极速领取，请核对未完成任务");
  } catch (failure) { error = String(failure.message || failure); }
  await settleTurboRoute(run, result, rows, error);
  await enqueue(async () => {
    if (error) await stopServer("极速模式核对未完成，领取已停止");
    const latest = await loadState();
    let actualAmount = 0;
    if (rows) {
      latest.localWorkingRows = rows;
      latest.localWorkingPackages = workingPackageCount(rows);
      for (const id of journal.releasedIds || []) markWorkloadReleased(latest, id);
      syncWorkload(latest, rows);
      const newRows = rows.filter((row) => !journal.baselineIds.includes(String(row.id)) && String(row.taskId) === journal.taskId);
      actualAmount = workingPackageCount(newRows);
      const known = new Set(latest.localClaimedSubTaskIds || []);
      const uncounted = newRows.filter((row) => !known.has(String(row.id)));
      recordConfirmedLocalPackages(latest, uncounted.map((row) => String(row.id)), workingPackageCount(uncounted));
    }
    // The platform's reconciled rows are authoritative. A transport-uncertain
    // round with no newly created package is a clean no-claim result, not a
    // recovery lock. Keep the lock only when reconciliation itself failed.
    const reconciledNoClaim = !error && result.uncertain && actualAmount === 0;
    const reconciledClaim = !error && result.uncertain && actualAmount > 0;
    latest.lastError = error;
    latest.lastWorker = {...latest.lastWorker, currentTaskId: journal.taskId,
      phaseLabel: error || (reconciledNoClaim ? "本轮未领取到任务，已自动解除锁定" :
        (reconciledClaim ? "极速领取完成，结果已核对" :
          (result.successes ? "极速领取完成，超额任务已核对" : result.reason))), lastUpdatedAt: Date.now()};
    flushLocalReadStats(latest);
    await saveState(latest);
    if (!error) {
      await chrome.storage.local.remove(TURBO_JOURNAL_KEY);
      turboRecoveryPending = false;
    }
    if (turboRun === run) turboRun = null;
    const routeMessage = run.smartRouting && !error && !actualAmount
      ? "智能路由已核对，暂无待验收数据" : "";
    const response = {...await publicStatus(latest), ok: !error && (result.successes > 0 || actualAmount > 0),
      actualAmount,
      taskId: journal.taskId, error: error || routeMessage || (reconciledNoClaim ? "尚未发现新增工作包，已自动解除锁定" :
        (result.successes || actualAmount > 0 ? "" : result.reason))};
    await chrome.tabs.sendMessage(run.tabId, {scope: "xiaotian-v24", type: "turbo-result", response}).catch(() => {});
  });
  if (result.successes) await refreshAcceptanceTable(run.tabId).catch(() => {});
}

async function recoverTurboRun(tabId) {
  if (turboRun) throw new Error("仍有在途请求或正在核对，请稍候");
  const journal = await turboJournal();
  const stateBeforeRecovery = await loadState();
  const routeBeforeRecovery = await turboRouteState(stateBeforeRecovery);
  // A completed round can lose its journal after the result is reconciled,
  // while its route record remains marked uncertain. Do not treat that stale
  // route as an active lock; verify the live rows below before clearing it.
  const routeNeedsRecovery = !!(routeBeforeRecovery && (routeBeforeRecovery.unsettled || routeBeforeRecovery.uncertain));
  if (!journal && !routeNeedsRecovery && (await loadSession()).running) return publicStatus();
  const remaining = Math.max(0, Math.ceil((turboRecoverAt(journal) - Date.now()) / 1000));
  if (remaining) throw new Error(`仍需等待 ${remaining} 秒，避免结果不确定的请求迟到`);
  let state = stateBeforeRecovery;
  // Recovery must restore the lease/module as page initialization would, but
  // must never restart claiming on behalf of the user.
  state = await ensureConnected(state);
  state = await refreshRuntimeConfig(state, false);
  state = await refreshCPolicy(state, false);
  if (cPolicyDelegated()) requireCPolicy({local: true});
  const rows = journal ? await reconcileTurboRun(tabId, journal) : await turboExactRows(tabId);
  turboSingleTask(rows);
  const route = await turboRouteState(state) || (journal ? {
    owner: String(state.userName || state.platformAccount || state.installId || ""),
    taskId: journal.taskId, nextCheckAt: Date.now() + TURBO_ROUTE_PERIOD_MS,
    unsettled: true, uncertain: journal.uncertain !== false,
  } : null);
  if (route) {
    // With no persisted journal, the exact live-row read is the final
    // evidence available. turboSingleTask() above has already rejected
    // multiple task streams, so the stale route can be safely settled.
    // The exact live-row reconciliation above is the final result for this
    // round. Once it succeeds, neither the journal nor the route may keep an
    // uncertainty flag; retaining it would permanently block the next turbo
    // or accelerated round after the journal has already been removed.
    route.uncertain = false;
    route.unsettled = false;
    await chrome.storage.local.set({[TURBO_ROUTE_KEY]: route});
  }
  await saveSession({running: false, tabId: 0});
  state.localWorkingRows = rows;
  state.localWorkingPackages = workingPackageCount(rows);
  for (const id of journal?.releasedIds || []) markWorkloadReleased(state, id);
  syncWorkload(state, rows);
  state.lastError = "";
  state.lastWorker = {...state.lastWorker, running: false, phase: "stopped", lastError: "",
    workingPackages: state.localWorkingPackages, phaseLabel: "核对完成，已解除锁定，可手动启动", lastUpdatedAt: Date.now()};
  await saveState(state);
  await chrome.storage.local.remove(TURBO_JOURNAL_KEY);
  turboRecoveryPending = false;
  return {...await publicStatus(state), turboRecovered: true};
}

turboJournal().catch(() => { turboRecoveryPending = true; });
