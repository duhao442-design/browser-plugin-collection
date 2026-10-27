# Check List Checker

一个用来「批量核对清单」的浏览器扩展：把待检查的列表粘进来，逐条标记通过 / 不通过，最后自动汇总成检查结果。

> 状态：可用（v1.0.0）。下面标了「待补充」的地方由维护者按实际实现补齐。

## 基本信息

| 项 | 值 |
| --- | --- |
| 扩展名称 | Check List Checker |
| 版本 | 1.0.0 |
| Manifest | V3 |
| 弹窗入口 | `popup.html` + `popup.js` |
| 后台 | `background.js`（service worker） |
| 内容脚本 | `content.js` + `content.css`，匹配 `<all_urls>` |
| 权限 | `activeTab`、`scripting`、`storage` |

## 功能

- 在弹窗里录入 / 粘贴待检查的列表数据（待补充：支持的格式，按行、按 JSON、还是表格）。
- 通过注入的内容脚本在当前页面逐条高亮并标记「通过 / 不通过」。
- 自动统计通过数、不通过数、未检查数。
- 一键生成检查结果文本，可复制到工单或表格。
- 检查进度保存在 `chrome.storage`，关闭弹窗不丢失。

## 目录结构

```
check-list-extension/
├── manifest.json     # 扩展声明：权限、popup、content script
├── popup.html        # 弹窗界面
├── popup.js          # 弹窗交互：录入、开始检查、汇总展示
├── background.js     # service worker：消息转发 / 状态维护
├── content.js        # 页面内逻辑：定位条目、打标记、回传结果
├── content.css       # 页面内标记样式
└── README.md
```

## 安装与加载

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 「加载已解压的扩展程序」→ 选择本目录 `check-list-extension/`。
3. 改动代码后点扩展卡片上的刷新按钮；已打开的页面需要刷新一次。

## 使用说明

1. 点击工具栏图标打开弹窗。
2. 把待检查列表粘贴进输入框（每行一条）。
3. 点「开始检查」，扩展在当前标签页逐条定位并高亮。
4. 对每条选择「通过」或「不通过」，可用快捷键（待补充）。
5. 全部处理完后点「生成结果」，复制汇总文本。

## 配置说明

| 键 | 位置 | 说明 |
| --- | --- | --- |
| `checkList` | `chrome.storage.local` | 当前这批待检查条目（待补充结构） |
| `checkResults` | `chrome.storage.local` | 已标记的结果（待补充结构） |

无设置页；如需新增选项，在 `popup.html` 加控件并在 `popup.js` 读取。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 只在用户点击图标后访问当前标签页 |
| `scripting` | 向页面注入检查逻辑 |
| `storage` | 保存列表与检查进度 |

> 当前 `content_scripts.matches` 为 `<all_urls>`，会注入所有页面；如果只需要在特定站点使用，建议收窄匹配范围。

## 开发与调试

- **弹窗**：右键扩展图标 →「检查弹出内容」，或在 `chrome://extensions` 点「service worker」查看后台日志。
- **内容脚本**：在目标页面按 F12，日志与页面同源。
- 修改 `content.css` 后刷新页面即可看到样式变化。

## 已知问题 / TODO

- [ ] 补全导入格式说明（CSV / 制表符 / JSON）
- [ ] 结果导出为 `.xlsx` 或 `.csv`
- [ ] 收窄 `matches`，避免注入无关页面
- [ ] 增加「全部通过 / 全部不通过」批量操作

## 更新记录

| 日期 | 版本 | 说明 |
| --- | --- | --- |
| 2026-10-21 | 1.0.0 | 当前版本（待补充变更内容） |
