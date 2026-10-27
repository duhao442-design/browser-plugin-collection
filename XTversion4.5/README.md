# 晓天HTML脚本 4.5

在 SkyVendor 的「验收任务」页面上运行的辅助脚本：自动领取 / 释放任务包、按比例抽样、提示音提醒，并把登录、任务指令交给配套服务器执行。

> 状态：运行中（v4.5）。本 README 是整理版说明，**以代码为准**；原作者说明见 [`README.txt`](README.txt)。

## 基本信息

| 项 | 值 |
| --- | --- |
| 扩展名称 | 晓天HTML脚本4.5 |
| 版本 | 4.5.0（`version_name`: 4.5） |
| Manifest | V3 |
| 后台 | `background.js`（service worker，主逻辑，约 220 KB） |
| 内容脚本 | 注入 `https://www.skyvendorise.com/skyvendor/dashboard/annotation/acceptance*`，按序加载 `config.js` → `custom-sound.js` → `content.js` |
| 沙箱页 | `c-sandbox.html`（允许 `unsafe-eval`，无网络） |
| 主机权限 | `https://8.135.29.12/*`、`https://www.skyvendorise.com/*` |
| 权限 | `storage`、`alarms`、`scripting`、`tabs` |
| 资源 | `qiangdao_tile.mp3`、`c-sandbox.html`、`c-sandbox-loader.js` |

## 功能

- **任务领取**：按设定的包数上限、每次领取数量，自动领取验收任务；支持手动单次领取（不经过服务器）。
- **抽样控制**：固定 30% 抽样，自动模式由服务器锁定、手动模式由本地请求代码锁定。
- **包数管理**：达到上限暂停领取、降到阈值恢复；超时未完成的工作包定时释放（约 30 分钟）。
- **登录**：优先复用服务器已保存的 SkyVendor SSO；失效时弹出手机号 + 短信验证码登录。
- **面板**：可拖动、可缩放、可折叠为紧凑条，位置与尺寸保存在本机。
- **提示音**：领到包后播放 `qiangdao_tile.mp3`。
- **刷新策略**：领包后只切换验收任务筛选刷新表格，不整页 F5。

## 模块说明

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | 扩展声明与权限 |
| `background.js` | 主逻辑：任务调度、服务器指令、包数控制、定时释放 |
| `content.js` | 页面内面板、任务读取、DOM 操作 |
| `content.css` | 面板与页面元素样式 |
| `config.js` | 服务器地址与接口路径集中配置（`SERVER_PROFILES`、`API_ROUTES`） |
| `custom-sound.js` | 提示音播放 |
| `c-policy.js` | 页面侧策略/校验（待补充具体职责） |
| `c-sandbox.html` / `c-sandbox-loader.js` | 沙箱页与加载器，隔离不安全的动态执行 |
| `claim-audit-client.js` | 领取审计客户端（待补充） |
| `turbo-background.js` / `turbo-runner.js` | 加速模块：预提交与高频轮询（待补充触发条件） |
| `background-logic-analysis.md` | 后台逻辑分析笔记（开发文档，非运行文件） |

## 工作流程（概览）

```
打开验收页
   ↓
content.js 注入 → 渲染面板
   ↓
读取登录态（SSO 恢复 / 手机号登录）
   ↓
设置 包数上限 / 每次领取数量 / 扫描页数
   ↓
┌── 手动领取：当前页面直接发一次领取
└── 自动模式：本地扫描发现任务 → 通知服务器 → 服务器下发领取指令
   ↓
领到包 → 提示音 + 刷新表格
   ↓
包数达上限 → 暂停；每分钟巡检 → 超时包释放
```

## 安装与加载

1. `chrome://extensions` → 开启「开发者模式」。
2. 「加载已解压的扩展程序」→ 选择 `XTversion4.5/`。
3. 打开（或刷新）SkyVendor 验收任务页面。
4. 首次使用按面板提示完成登录。

## 使用说明

1. 面板出现后确认登录状态（已登录会自动隐藏登录区）。
2. 设置三个参数：包数上限、每次领取数量、扫描页数。
3. 需要挑任务时点「选择领取任务」勾选；不勾选表示全部。
4. 点「启动安全单任务」或「启动自动领取」开始。
5. 关闭验收页会停止自动流程；重新打开需再启动一次。

## 配置说明

所有服务端地址与接口路径集中在 `config.js`：

| 配置 | 说明 |
| --- | --- |
| `SERVER_PROFILES` | 服务器配置集合（地址、环境） |
| `API_ROUTES` | 接口路径表：`v24BrowserStatus`、`v24BrowserNameAck`、`v24BrowserLoginPhone`、`v24BrowserLoginCode`、`v24BrowserLogout` |
| `PLATFORM_TRANSPORT_MODE` | 固定为 `server-browser`，不提供本地 Cookie/Token 上传或 direct 模式 |

换服务器或改路径时只改配置表，不动业务逻辑。

## 权限与主机说明

| 项 | 用途 |
| --- | --- |
| `storage` | 面板位置尺寸、参数、本地完成次数 |
| `alarms` | 定时巡检（释放超时包、刷新状态） |
| `scripting` | 向页面注入面板与逻辑 |
| `tabs` | 定位/刷新验收页标签 |
| 主机 `8.135.29.12` | 配套服务器 |
| 主机 `skyvendorise.com` | 目标平台 |

## 数据与隐私

- 本地 SkyVendor Cookie / Token **不上传**服务器，也不用于服务器登录。
- 手机号只在当次获取验证码请求中发送，扩展不保存；验证码发送后立即清空。
- 人工验证网址只暂存于后台内存，不写入 `chrome.storage`。
- 扩展不自动识别或绕过 CAPTCHA，需要人工时只提供跳转按钮。

## 已知限制

- 自动流程依赖配套服务器；服务器离线时自动模式不可用（手动领取仍可用）。
- 全局有速率上限（文档记录：单人默认 10 次/秒、全局 1000 次/秒）；触发后行为见代码。
- 包数上限 1–3 可调，单次领取上限 5 包，超出会优先释放最新的超量包。
- 每个使用者独立领取，不进共享公平队列；同名安装共享通道，由最新启动的设备接管。

## 开发与调试

- **后台日志**：`chrome://extensions` → 本扩展 →「service worker」链接。
- **页面日志**：目标页 F12，`content.js` 的日志与页面同源。
- **配置改动**：改 `config.js` 后需在扩展页刷新，再刷新目标页。
- `background-logic-analysis.md` 记录了后台逻辑的分析过程，可作排查入口。

## TODO

- [ ] 补全「工作流程」中的判定细节与状态机
- [ ] 补全 `c-policy.js`、`claim-audit-client.js`、`turbo-*` 的职责说明
- [ ] 整理一份版本变更记录（3.0 → 4.5）
- [ ] 把 `README.txt` 与本文的差异合并

## 更新记录

| 日期 | 版本 | 说明 |
| --- | --- | --- |
| 2026-10-21 | 4.5 | 当前版本；相对 3.0 提升抢题效率（待补充具体条目） |
