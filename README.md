# 浏览器插件合集

> 存放几个自用/整理的 Chrome / Edge 扩展（Manifest V3）源码。本目录只做归档与说明，不含构建产物，也没有统一的构建流程——每个插件都是「加载已解压的扩展程序」直接用。

## 插件一览

| 目录                                                            | 扩展名称               | 版本    | 作用                                                   | 形态                         |
| ------------------------------------------------------------- | ------------------ | ----- | ---------------------------------------------------- | -------------------------- |
| [`check-list-extension/`](check-list-extension/README.md)     | Check List Checker | 1.0.0 | 数据标注平台，根据输入列表数据，逐条检查通过/不通过，自动生成检查结果                  | popup + content script     |
| [`info-capture-extension/`](info-capture-extension/README.md) | 关键信息捕获             | 1.0.0 | 抓取题目 ID、队列名称、题目链接、alloc 镜像 image 四类信息，制表符分隔输出，方便快速填表 | popup + content script     |
| [`XTversion4.5/`](XTversion4.5/README.md)                     | 晓天HTML脚本 4.5       | 4.5.0 | 在 SkyVendor 验收页自动领取/释放任务，含登录、抽样、提示音、后台调度             | background + content + 沙箱页 |

## 加载方式（Chrome / Edge）

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）。
2. 右上角打开「开发者模式」。
3. 点「加载已解压的扩展程序」，选择本目录下的**子目录**（不是合集根目录）。
4. 改动源码后回到扩展页点该扩展的「刷新」按钮；content script 需要刷新目标页面才生效。

## 目录约定

```
browser-plugin-collection/
├── README.md                  # 本文件：合集总览
├── check-list-extension/      # 一个插件一个目录
│   ├── manifest.json          # 必需
│   ├── README.md              # 必需：插件说明
│   └── ...                    # 源码 / 资源
├── info-capture-extension/
└── XTversion4.5/
```

新增插件时：

1. 新建目录（小写 kebab-case；带版本迭代的可以用 `名字+版本号`，如 `XTversion4.5`）。
2. 放入 `manifest.json` 与源码。
3. 按下面的模板写该插件的 `README.md`。
4. 回到本文件，在「插件一览」表格补一行。

## 插件 README 模板

```markdown
# 插件名称

一句话说明这个插件解决什么问题。

## 基本信息      # 名称、版本、Manifest 版本、入口文件、权限
## 功能          # 能力清单，按使用场景分条
## 目录结构      # 目录树 + 每个文件的职责
## 安装与加载    # 怎么把它加载进浏览器
## 使用说明      # 用户操作步骤
## 配置说明      # 可调参数 / 存储键（没有就写「无」）
## 权限说明      # 每个 permission 为什么需要
## 开发与调试    # 日志在哪看、怎么改
## 已知问题/TODO # 待办与坑
## 更新记录      # 日期 / 版本 / 变更
```

## 待办

- [ ] 补全每个插件的具体功能描述（当前为框架 + 占位）
- [ ] 统一各插件的版本号与 `manifest.json` 中的 `version`
- [ ] 视需要给 `XTversion4.5` 补一份变更记录

## 备注

- `XTversion4.5/README.txt` 是原作者留下的说明，`README.md` 是整理后的版本，两者内容可能不一致，以代码为准。
- 本目录只用于个人开发与测试环境；涉及第三方平台的功能，请自行确认使用范围与平台规则。
