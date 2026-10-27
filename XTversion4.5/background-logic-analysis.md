# background.js 逻辑解析（3.0 验收自动领取扩展）

> 分析对象：`background.js`（约 4200 行，MV3 service worker），并参考同目录的 `config.js`、`c-policy.js`（签名策略验证器）、`c-sandbox-loader.js`（本机模组沙箱）、`content.js`（内容脚本）与 `README.txt`。
> 全文不贴源码，只描述算法与流程；所有数值以代码常量与默认值为依据。

---

## 1. 总体架构

- **角色定位**：`background.js` 是扩展的“中枢”。它负责：与晓天服务器（`config.js` 中 `https://8.135.29.12/sv-v3`，另保留 v24b 兼容档）的注册/心跳/配置下发；`content.js` 面板的状态回报；平台（SkyVendor）请求的本地转发执行；领取/释放决策；紧急停止。
- **启动时**：`importScripts("config.js", "c-policy.js")`，把冻结的 `XiaotianV24Config` 与策略验证器 `XiaotianCPolicy` 挂到全局。所有“魔法常量”集中在 `config.js`，C 策略的密码学逻辑集中在 `c-policy.js`。
- **与 content.js 的关系**：`content.js` 注入在 SkyVendor 验收页，负责面板 UI、读取页面上显示的领取时间文本、嵌入式 C 沙箱 iframe。它把用户操作（init/status/start/stop/set-settings/manual-claim/poll/page-exit/refresh-catalog/import-workload/c-module-action）通过 `chrome.runtime.sendMessage` 发给 background；background 回推 `status-update`、`catalog-update`、`platform-request-log`。
- **串行队列**：几乎所有消息处理都被 `enqueue()` 投入到单一 Promise 链 `operationQueue`，保证同一时刻只有一个运维操作在跑（浏览器登录类操作除外，它们绕过队列直接跑，避免被长时间阻塞）。后台还有一个与 content 页面“xiaotian-v24-page”端口相连的 C 策略长轮询（watch）循环。
- **C 政策 / C 沙箱子系统**：
  - `c-policy.js`：Ed25519 公钥（SPKI base64，内置在 `config.js`）验证签名 token（`payload(base64url) + "." + 64字节签名(base64url)`）。payload 必须是指定字段集合的 canonical JSON。
  - 政策内容含：policyVersion(=1)、installId、userName、revision(单调递增)、issuedAt/expiresAt(寿命 60 秒~5 分钟、时钟偏差容忍 60 秒)、nonce、routeMode("server"|"local")、delegated(bool，且必须与 routeMode 一致)、defaults、bounds、（委托时）moduleUrl/moduleHash。
  - 只有 `delegated===true && routeMode==="local"` 时才会触发本机放权路径：background 按政策里的 moduleUrl 下载本机模组 JS（≤128000 字符），用 SHA-256 校验（格式 `sha256-...`），存入内存。然后 content.js 把模组源码塞进 `c-sandbox.html`（manifest 里声明的 sandbox 页，CSP 允许 `unsafe-eval` 但禁一切连接/对象）里执行；模组只能注册 update/actionResult/stop 三个 handler，并 emit `claim`/`idle` 两种动作。
  - 沙箱与 background 的桥：content.js 生成随机 sessionNonce，模组动作以 `c-module-action` 消息发给 background，并携带 moduleToken(=policyToken)、moduleHash、policyRevision。background 三者全部比对一致且 nonce 为 32~128 位十六进制后才执行；通过后轮换 nonce。沙箱里 window/document/chrome/fetch/XHR/WebSocket/Worker/storage/navigator/location/parent/top/opener/globalThis/self 全部被遮蔽为 undefined。

政策与模组都**只存在于内存**；saveState 持久化时显式删除 cPolicy/cPolicyToken/cModuleSource/cModuleToken 字段。

## 2. 主领取循环（服务器执行的“A 服务器模式”）

### 2.1 启动流程
`start` 消息 → `startServer`：确定 tab → `ensureConnected`（无 token 或租约 ≤5 秒快到期就 `activate`；403 时重新 activate；否则 `heartbeat`）→ `refreshCPolicy(force)` → 读一次完整快照（任务目录 + 在办工作包 + 释放政策）→ 根据当前 `claimModeForWorkingPackages`：

- 若当前为 C 本机放权（delegated+local）：直接保存 session running=true，启动本地目录扫描 loop，phase=c-local-module，服务器核心不启动（由沙箱模组驱动）。
- 若当前包数 ≥ targetPackages：本地挂起（autoPausedAtTarget=true），但控制 loop 仍启动，等回落恢复。
- 否则：`v24Start` 告知服务器启动核心，payload 含 transportMode、taskSelection、settings、selectedTasks、workingPackages；并启动本地控制 loop；之后 `v24Stop`/`v24Settings` 维持状态同步。

### 2.2 三种模式与阈值（逐轮重算）
`claimModeForWorkingPackages(workingPackages, runtimePolicy)`：

- `working >= stopPackages` → **paused**（达到总停止线）。
- `ordinaryClaimEnabled===true && working >= ordinaryStartPackages` → **normal**（进入普通领取）。
- `working < preSubmitStopPackages` → **pre-submit**（预提交）。
- 其余情况 → **paused**（比如预提交已关、还没到普通开始线）。

控制的“回差”：`resumeThreshold = stopPackages - 1`。挂起后必须降到 stop-1 及以下才重新判断恢复（README 举例：3 包停、2 包仍暂停、1 包恢复普通、0 包恢复预提交）。

服务器侧的默认（fallback 值，见 c-policy.js HARD_SETTING_SCHEMA）：stopPackages=3、ordinaryStartPackages=1、preSubmitStopPackages=1、claimConcurrency=1、claimAmount=1、preSubmitAmount=1、preSubmitIntervalMs=50、taskPages=1、releaseAfterMinutes=30、releasePackageLimit=5。bounds 由服务器签发，客户端 user 覆盖值会被 clamp 到 bounds。预提交起始间隔从初始 50ms（每秒约 10 次）起，按未领取时长逐档加速；档位百分比默认 `[100,90,80,70,60,50,40,30,20,10]`，每档默认 60 秒（`accelerationTierMs` 默认 60000，最小 1000ms）。

### 2.3 本地控制 loop（`localControlLoop`）
一个在 tab 上并行的 while 循环（generation+tabId 校验防重复），每轮：

1. 读在办工作包（分页 pageSize=5，最多 200 页封顶）并处理子任务汇总缓存（subtask summary，30 秒 TTL）。
2. 执行释放政策（见第 6 节），同步工作包计数与 workload。
3. 比较当前/上一轮 working ids、mode 是否变化；必要时刷新/维护 live catalog；推导 serverTaskSignature（模式+所选任务）。
4. 若达到目标（≥targetPackages）：`pauseAutonomousCore`（v24Stop 停止服务器核心, 停止失败入 serverStopPending 标记），保持每轮延迟 activeWorkingCheckMs（默认 100ms、最少 100ms）继续监控；回到 resumeThreshold 以下才重新 startAutonomousCore。
5. 若未达目标且非挂起：当 signature 改变（或 zeroConfirmationDue：预提交后 preSubmitConfirmAfter 到点）→ `v24Settings` 同步服务器。
6. 若模式 normal 且服务器允许普通领取：调 `dispatchNormalClaimFromLocal` 发一次单发领取。

### 2.4 普通领取（一次指令）
- 候选任务：`selectedServerTasks`（selectedTaskIds 非空用所选，否则全部目录；过滤 blockedTaskIds；normal 模式额外只取 left>0）。
- 本轮按 `localTaskCursor` 轮询选一个候选，amount = min(claimAmount, targetPackages - workingPackages)。
- `v24Claim` 发出；若 response.accepted/busy/服务端 claimInFlight，则 `waitForServerClaim`（轮询 `v24Poll`，直到服务端 claimInFlight=false；超时窗口 = platformRequestTimeoutMs+5000，最小 5000ms）。
- 服务端返回而未确认的 claimReceipt → `prepareClaimConfirmation` 记录 pending → `settleClaimConfirmation` → `confirmLocalClaim` 在 successAppearGraceMs（默认 3000ms、最小 300ms）窗口内反复更新本地包数 → `v24Confirm` 回报 actualAmount = min(requestedAmount, 增加量)。
- 只执行一次，不循环；预提交模式才交给服务器持续抢占。

### 2.5 预提交（服务器跑）
- 预提交由服务器侧循环执行；本地只是监控。preSubmitAmount=1、并发=1，从默认 50ms（10/s）起按 tier 加速到最高 20/s；服务器服务端另有限制（README：全服 300/s 时回落到每人 10/s，全局 1000/s 硬上限）。
- 预提交成功后服务器等待本地确认第一包；本地上一轮对比发现 added 即确认（zeroConfirmationDue 路径）。

### 2.6 Relay 模式（遗留路径）
仅当 `platformTransportMode()==="browser-relay"` 时才启用（当前 config 是 c-hybrid → server-browser，所以不会启用）。RELAY_WORKERS=3、RELAY_BATCH_SIZE=3、RELAY_RETRY_MS=150ms。服务器下发 claim 指令 → 本地执行 → 返回结果。所有指令都要过 `normalizeRelayClaimCommand` 白名单校验（见第 10 节）。

## 3. 两种 routeMode：server vs local

- **server（A 服务器模式）**：默认。服务器端执行预提交；本地只在 normal 模式下发一次性 claim 指令；或服务器接收 selectedTaskIds/blockedTaskIds/settings，再由 `v24Start`/`v24Settings` 驱动。预提交/加速阈值的判定在服务器侧完成。
- **local（C 本机放权）**：`cPolicyDelegated() === policy.delegated && routeMode==="local" && cPolicyUsable()`。此时：
  - `applyCPolicyRuntime` 把政策 defaults/bounds 映射进 runtimePolicy（与服务器 clientConfig 的 runtimePolicy 平行），数字字段跟 normalizeSettings 一致。
  - 模组下载/校验（见第 1 节），随后由 content.js 的 c-sandbox.html 执行，模组每次算好一轮只 emit 一个 `claim` 或 `idle` 动作；background 的 `handleCModuleAction` 才实际调用平台。
  - C 策略 refresh：后台算 nextRefreshAt ≈ now + 4 分钟 + 随机 30ms 抖动（封顶至 expiresAt-1）；chrome.alarms 创建 refresh/expiry 两个告警（expiry 告警时间为 expiresAt+25ms）。另外还有 watch 长轮询（25 秒长等、1 秒重试），只在页面端口存在时跑；策略 controlRevision 上升即 `applyImmediateCPolicyUpdate`。
  - 到期或失效：`stopServer("C策略已过期...", {forceServerRequest:true})`；serverAccessRevoked（403+authorized:false 或文案关键字）→ 清政策、停止、phase=access-revoked。
  - 转变处理：识别 `STALE_REVISION/REVISION_MISMATCH/C_ROUTE_CHANGED/C_POLICY_REQUIRED/C_MODULE_CHANGED` 等错误码或中文提示 → 触发 refreshAfterCPolicyTransition（重连+重拉政策），update-settings/start 用 `retryAfterCPolicyTransition` 包装一次。放权打开/收回时会自动接管或停止正在跑的 session。

## 4. 注册 / 心跳 / 租约

- **installId**：首次 defaultState 用 crypto.randomUUID()；serverIdentityVersion=1，旧版本数据迁移时清空 userName/token。
- **activate**：payload 含 installId、extensionVersion（manifest version_name，fallback "3.0C.3"）、platformAccount、identityMode（server-browser 或 client-name；只有 client-name 路径才要求 userName）。服务器返回 installToken + userName + leaseExpiresAt。`ensureConnected` 5 秒内到期即重激活；403 兜底再 activate。
- **heartbeat**（每 1 分钟 chrome.alarms，onInstalled/onStartup/立即三处创建）：payload 含遥测（localRequestTotal、localClaimedPackagesTotal、intervalSumMs/Samples、reportSequence 递增）、runtimePolicy、runtimeState（worker phase/label/task/rounds/failedClaims）、C 控制报告（策略可用时 cRouteMode/cClientSettings/cPolicyRevision）、cSkyVendorTaskSummary（在办 subtask 行、首次观察时间、时区名与 utcOffsetMinutes）、clientInfo（页面路径、locale、时区）。响应里携带 clientConfig → 重算 runtimePolicy；可选 nameAckRequired → v24BrowserNameAck。
- 租约的“释放”体现在：stopServer/v24Stop 通知服务器、服务器浏览器登出、管理员停用。sign-in 租位（登录通道）由 v3/v24 的 browser 路由维护，被 FIFO 队列约束。
- **serverAccessRevoked**：心跳/策略刷新/watch 任一处遇到，统一走 `applyServerAccessRevocation`：停 loop、停 session、清政策、phase=access-revoked。恢复授权后 clearServerAccessRevocationState 清错。

## 5. 服务器浏览器登录（SSO 恢复优先）

- `browserAuth` 状态：reported/authState/loginRequired/challengeRequired/manualLoginAvailable/message(电话号码与 4-8 位数字做掩码)/phoneMasked/updatedAt。
- 已认证状态集合 `AUTHENTICATED_BROWSER_STATES`：authenticated、authorized、logged-in、logged_in、loggedin、signed-in、signed_in、ready、active、login-success、login_success。
- 流程：
  1. `browser-status`（v24BrowserStatus；500ms 轮询直接续租不再冲 refreshCPolicy）→ 返回 authState。若认证态 → 完成（服务器侧已做 SSO 恢复）。
  2. 未认证 + loginRequired → `browser-login-phone`（手机号只保留数字、≤20、≥6 位，国家码 `+\d{1,4}`）→ 服务器触发 SSO 恢复或短信；inventory 有几秒钟窗口。之后 `browser-login-code`（4~8 位数字）。LOGIN_REQUEST_TIMEOUT_MS=90000。
  3. `challengeRequired` → 显示“打开人工验证”：url 必须 HTTPS、无用户名密码、≤2048 字符；只有用户点击才 `chrome.tabs.create` 打开，且 manualLoginUrl 只存内存，不落 chrome.storage。
  4. 登出 `browser-logout` → 服务器清通道并清 phone。
- 防重入：`browserAuthGeneration` 每次登录/登出递增，过期 response 丢弃。nameAckRequired=true 且用户名合法 → 先 saveState 再 `v24BrowserNameAck`（失败被吞，服务器短超时兜底）。README：手机号步骤 30 秒；验证码发出后 1 分钟；服务器读姓名后等待本地保存回报再释放登录位，本地不回报 15 秒释放，避免队列卡死。FIFO 公平队列由服务器侧实现。
- 登录期间如果触发 C 策略 transition 错误 → 先强制 refreshCPolicy 重拿策略再重试（console 注释提示）。

## 6. 释放（自动放包）逻辑

- **独立 watchdog**：`runIndependentReleaseWatchdog` 挂在 1 分钟心跳告警里，无论是否在领取都跑；在 session tab 或者任意 SkyVendor 验收 tab 上执行。除非（这里代码为直接访问 / 遇 FRAME_TRANSITION 安静返回）。释放后刷新表格、推送 status。README：最迟约在第 31 分钟被处理。
- **判定**：`applyLocalReleasePolicy`：
  - `releaseClaimedAt(row)`：
    - `parsePlatformTime`：空白替换为 `T`，无时区后缀就追加 `Z`（即按 UTC 解析）。
    - `parseLocalDisplayedTime`：new Date 本地分量解析。
    - 两者都有效且差 ≤2 分钟 → 取较晚（显示/精度 rounding 兜底）。
    - 两者不一致（差 >2 分钟）→ 时区契约不清，用 `localObservedAt`（首次本地看到该包的时间）。
    - 平台时间若无时区 → 直接用 localObservedAt；否则只有平台时间可用 → 用平台时间。
  - 若 `releaseAfterMinutes>0` 且 `now - claimedAt >= releaseAfterMs` → 原因“超时X分钟”。
  - 之后，若剩余包数 > `releasePackageLimit` → 把剩余按领取时间最新优先补打原因“超过X包上限”，直到溢出消除（即超最新优先释放；硬容差 5 包）。
- `releaseLocalPackage`：同一 subTaskId 并发去重（in-flight Map）；先 `reserveReleaseRequest`（guards 存 storage.session，pending TTL 2 分钟、成功后 success TTL 10 分钟；过期一并清理）；POST release route（10s 超时）→ 成功 `markReleaseRequestSuccess`。失败原因上报（`releaseFailureMessage`, “有N个超时或超量工作包释放失败”）。
- 启动时 `enforceSnapshotReleasePolicy` 会在手动/自动/手动模组领之前先执行一次释放判定，确保占位包不被重复领。

## 7. 工作量与任务选择

- **catalog 扫描**：`readLocalTaskCatalog` 以 pageSize=5 拉 `tasks` 路由（block 限制 taskPages 页，默认 1 页，最大配置 500），去重并校验 taskId 格式 `^[A-Za-z0-9_-]{1,80}$`（最多 200 个）；进度调用 `process` 路由 5 个 id 一批。任务目录 refresh loop 节奏 `LOCAL_TASK_REFRESH_MS` 默认 100ms 但不小于耗时时长；full catalog 60s、full progress 30s、cold（left 0 的）15s；`liveLocalCatalog` 是基于 tab 的最新快照，跨刷新时从 STATE.localTaskCatalog 恢复。
- 候选选择：selectedTaskIds 非空 → 只查所选（不必要的任务标签用 id 占位）；否则全目录。blockedTaskIds 永远排在 selected 之后过滤。normal 模式额外要求 left>0。
- **workload**：对象 `{totals, active, pending}`：
  - claim 一出 → `recordWorkloadClaim` 把任务放入 pending。
  - 快照确认零增量 → `discardPendingWorkloadClaim` 撤销。
  - 释放 → `markWorkloadReleased` 从 active.subTaskIds 减，最终删空时连 pending 一起清。
  - `syncWorkload`：当前在办里已经消失的任务 → completed+1 转入 totals；新出现的自建 active 行。
  - `publicWorkload` 报告 totalCompleted、taskCount、activeCount、按更新排序的 totals。
  - 旧的 `import-workload` 消息支持 version=2/unit=claim 累计历史合并。
- 领取计数：成功确认后 `recordConfirmedLocalPackages` 把新 subTaskId 入 `localClaimedSubTaskIds`（最多保留 2000 个），localClaimedPackagesTotal 累计，通过心跳上报。

## 8. 持久化与时区

- **STATE_KEY**（`xiaotianV3CState`，chrome.storage.local）：settings.pattern、runtimePolicy.placeholder 不写入（runtimePolicy 每次 save 时置空 `{}`，防止把瞬态服务器值固化）；cPolicy/cPolicyToken/cModuleSource/cModuleToken 显式 delete；settings 持久化只留 blockedTaskIds/selectedTaskIds，其他设置跟随政策或服务器 runtime。
- **SESSION_KEY**（`xiaotianV3CSession`，chrome.storage.session）：running/tabId/refreshing/refreshStartedAt。2 分钟窗口用于 page refresh 续跑（isContinuingRefresh）。
- 其他派生存储：释放 guards（session 域）、PACKAGE_OBSERVED_KEY（local，24h 滚动）、两者键都由 STATE_KEY 拼接而来。
- **alarm**：心跳（period=HEARTBEAT_MINUTES=1 分钟）、C Policy refresh/expiry（C_POLICY_REFRESH_ALARM/C_POLICY_EXPIRY_ALARM，每次政策刷新后重排；refresh 时间为 nextRefreshAt，expiry=expiresAt+25ms）。
- **C 策略 watch/端口**：content 页面用 `chrome.runtime.onConnect` 建“xiaotian-v24-page”端口，watch 循环长轮询 `cPolicyWatch`（waitMs=25s + 10s 超时），controlRevision 更高就触发强制 refresh；端口断开时 watch 自动停。
- **时区**：页面显示时间与 API 时间各取一套；两者接近时取较晚；时区含混时回退到本地首次见包时间（`localObservedAt`），保证只延迟、不提前释放（README：夏令时/跨时区最坏只是延后）。心跳里同时上报 Intl 时区名与 -getTimezoneOffset 分钟。

## 9. 手动领取（manual-claim）与模组领取（c-module-action）

### 手动
- 要求 session 未运行（自动领取开着就不给手动）；`requireCPolicy({local:true})` 强制要求本机放权；先跑一轮快照+释放判定；校验 taskId 格式；amount=min(claimAmount, targetPackages-workingPackages)；`localManualClaimCommand` 构造固定参数（POST /{taskId}/review/fetch，batchSize=整数≥1， dim=data， sampleRate=30， userIdList=[]，timeoutMs=10s）并执行；`confirmLocalManualClaim` 在 successAppearGraceMs（默认 3000，最小 300）内反复对比前一个/当前行集合，actualAmount=min(requestedAmount, delta)；失败撤销 workload 并抛出；成功保存统计/刷新表格。确认结果里 TIMEOUT 提示“领取结果不确定”，但实际为零时才报错。
- EXECUTION_MODE：若被改成 `legacy-manual`，启动自主核心会报错“请使用手动领取”。

### 模组（沙箱）
- 从沙箱 emit 的 action 只能为 "claim"（其他返回 actualAmount:0）。background 重算模式（pre-submit/normal/waiting）与模块发报的 payload.mode 必须一致，否则“当前包数不符合本机模组领取阶段”；任务必须在当前候选范围；normal 模式还要 left≥1；normal 下 acceptPartial=false 且 left<requested 会拒绝；最终 amount=min(requested, remaining, left>0?left:requested)。预提交则固定 preSubmitAmount。执行流程同手动。worker 阶段标记为 c-local-pre-submit / c-local-claim / c-local-waiting / c-local-claimed。

## 10. 限速、重试、30% 抽样、失败处理

- **30% 抽样锁**：`normalizeRelayClaimCommand` 是领取请求的白名单形态校验：method=POST、pathName=/…/review/fetch、data.taskId 与路径一致、batchSize 为安全整数 ≥1、dim="data"、`Number(sampleRate)===30`、userIdList 为空数组。本地手动与模组领取都用同一份构造，sampleRate 常量 30 写死，符合 README“自动模式由服务器锁定，手动领取由本地请求代码锁定”。
- **平台请求的两种方式**：`executePlatformCommandRaw` 先尝试 direct（背景直接用 token，token 从页面 localStorage/sessionStorage 读取，缓存 5 分钟，401 清缓存），失败（transportError）则用 `chrome.scripting.executeScript` 在 MAIN world 内 fetch（credentials include）。FRAME_TRANSITION 类瞬时错误：GET 最多重试 1 次；POST /review/fetch 返回 TIMEOUT 并提示“结果待平台确认”。每次执行都会往 content 推 platform-request-log（≤40 字符 action、≤160 字符错误）。
- **HTTP 层**：postJson/fetch 的 AbortController 超时最小 1000ms、最大 180s；abort → “服务器响应超时”。错误对象带 status/code/authorized/registered。
- **重试门限**：runtimePolicy 里的 rateLimitRetryMs（默认 5000）、errorRetryMs（默认 2000）只作为参数传到服务器；本地控制 loop 出错后只按 activeWorkingCheckMs（默认 100ms）等再重试。瞬时 frame 错误额外延迟 250ms。
- **routine 失败掩码**：`routineLocalClaimFailure` 匹配“暂无待验收数据 / 系统繁忙 / 请稍后重试 / 频繁 / 限流 / 剩余可领不足 / 没有可领取包 / 任务已被领取 / 尚未发现新增工作包 / 平台已响应…”等，被当成软失败，不显示到面板 lastError。
- **紧急停止**：验收 tab 被关闭、tab URL 离开 SkyVendor → dispatchEmergencyStop（先本地停，随后入队再发 forceServerRequest 确保服务器也停）；page-exit 消息进入 2 分钟 refreshing 会话窗口。`initialIntervalMs/apiStats/claimRateBuckets` 等遥测上报被清空发送，减少流量。
- **C-policy 失败**：refreshCPolicy 全局串行合并（cPolicyRefreshPromise），force 请求合并为同一 promise 复用；invalidusability 时若旧政策仍可用，保留 errorReason 并用现有政策。

---

## 附：关键常量一览（以代码 current fallback 为准）

| 含义 | 默认值 / 取值 |
|---|---|
| 停止包数 stopPackages | 3（fallback），服务端 bounds 可在 1..10000 |
| 预提交目标 preSubmitStopPackages | 1 |
| 预提交每次数量 preSubmitAmount | 1（并发 1） |
| 普通每次数量 claimAmount | min(claimAmount, 剩余空间) |
| 恢复线 resumeThreshold | stopPackages-1 |
| 释放时限 releaseAfterMinutes | 30（分钟；独立 1 分钟巡检） |
| 释放包上限 releasePackageLimit | 5（超量者优先放最新） |
| 预提交起始间隔 | 50ms（≈10/s），按 60s 一档，百分比档 `[100..10]`，最高 20/s |
| 控制 loop 检查间隔 activeWorkingCheckMs | 100ms |
| 任务目录刷新 LOCAL_TASK_REFRESH_MS | 100ms（full 60s / progress 30s / cold 15s） |
| 确认窗口 successAppearGraceMs | 3000ms（min 300ms） |
| 子任务汇总缓存 SUBTASK_SUMMARY_CACHE_MS | 30s |
| 释放 guard | pending 2min / success 10min |
| 抽样 sampleRate | 30（锁定，不可修改） |
| 心跳 HEARTBEAT_MINUTES | 1 分钟 |
| 登录请求超时 LOGIN_REQUEST_TIMEOUT_MS | 90s |
| 手机号步骤 / 验证码 | 30s / 发出后保留 1 分钟（README） |
| C 策略 refresh | ~4min + 30s 抖动，到期 expiresAt+25ms 告警；长轮询 25s |
| C 策略窗口 | 寿命 60s~5min，时钟偏差 60s |
