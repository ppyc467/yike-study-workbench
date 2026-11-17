# 一刻 · 学习工作台

<p align="center"><img src="public/favicon.svg" width="72" alt="一刻图标"></p>

把想学的，变成正在做的。一个适配电脑与手机的个人学习工作台，把专注计时、任务、笔记、学习统计和 AI 辅导放在一起。

[![Checks](https://github.com/ppyc467/yike-study-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/ppyc467/yike-study-workbench/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## 功能

- **专注计时**：自由计时、番茄钟、暂停与继续、历史时长修正、跨日统计，同一账号同时保留一个活动计时。
- **任务与项目**：搜索、筛选、置顶、归档、计划日期和截止提醒，任务行可直接开始或继续专注。
- **学习笔记**：Markdown 编辑与预览，任务笔记与独立笔记，可引用笔记向学习助手提问。
- **学习统计**：最近 7 天 / 30 天时长、每日明细、项目占比与任务用时排行，按北京时间统计。
- **学习助手**：每个任务独立对话、流式回答、持久学习记忆；可根据材料生成自测题并安排复习。
- **同步与备份**：版本冲突处理、离线草稿补传、JSON 备份和恢复；部署后可在同一账号的多个设备间使用。
- **PWA 与桌面小窗**：支持安装到桌面，首次联网缓存后可离线使用部分功能；另附 Windows 原生计时小窗源码。
- **MCP 接口**：通过 `/mcp` 为兼容客户端提供学习工作区工具。

## 本地运行

需要 Git 和 **Node.js 22.13+**，推荐 Node.js 24。仓库提供锁定依赖文件，Windows、macOS 和 Linux 使用同一套命令。

```sh
git clone https://github.com/ppyc467/yike-study-workbench.git
cd yike-study-workbench
npm run install:ci
npm run build
npm run db:migrate:local
npm run dev
```

打开终端显示的本机地址（默认 `http://127.0.0.1:5173/`），点击“打开本机工作台”。开发服务器提供本机体验账号，无需真实 ChatGPT 登录。数据库保存在本项目 `.wrangler/state/`；学习助手未配置时，计时、任务和笔记仍可使用。

首次运行需要先构建，让工具生成数据库配置，再执行迁移。后续启动通常只需 `npm run dev`。拉取新增数据库迁移的版本后，重新构建并运行 `npm run db:migrate:local`；迁移工具会记录已执行的文件。

本机预览仅供本机开发，默认绑定回环地址。它的体验账号和数据库与自行部署的实例分别存储。

## 配置学习助手（可选）

服务端通过 OpenAI Responses API 调用模型。在项目根目录新建 `.dev.vars`：

```dotenv
OPENAI_API_KEY=replace_with_your_own_key
OPENAI_MODEL=gpt-6-luna
```

将占位内容替换为自己的 API 密钥，模型填写账号可用且支持该请求格式的模型。配置后重启开发服务器。`.dev.vars` 已被 Git 忽略；生产环境使用部署平台的服务端 secret。

聊天、生成题目和更新学习记忆会把当前选用的任务材料及对话上下文发送到模型服务，并产生 API 费用。密钥不会写入浏览器代码。

## 部署说明

当前服务端基于 **Vinext + Cloudflare Workers + D1**，沿用 OpenAI Sites 的登录和服务绑定方式。`npm run build` 输出前端资源和 Worker；它不是纯静态网站，不能只上传 GitHub Pages 来运行完整功能。

- **使用 Sites**：为自己的实例新建项目，填入平台返回的项目标识，保留 `.openai/hosting.json` 中的数据库和 MCP 配置，再按平台流程发布。
- **部署到其他平台**：配置实际数据库并执行迁移，同时适配身份认证和入口代理。服务端目前读取受信入口注入的 `oai-authenticated-user-*` 请求头；公开部署时，入口必须清除客户端伪造的同名头，再注入经过验证的身份。单独暴露当前 Worker 不提供完整登录边界。
- **预览构建结果**：`npm start` 启动本机 Worker，但不提供开发服务器的模拟登录；日常本地体验请使用 `npm run dev`。

公开仓库省略了原实例的项目标识、浏览器配置和部署状态。每个部署实例使用自己的数据库、身份系统和服务端配置。

## Windows 计时小窗

`desktop/windows/` 包含 C# / WinForms 小窗源码、编译脚本和示例启动配置。小窗在一刻主窗口最小化时显示计时状态。

参见 [编译与使用说明](desktop/windows/README.md)。网页端可以独立使用。

## 开发与检查

```sh
npm test
npm run typecheck
npm run build
```

GitHub Actions 会在推送和 Pull Request 时运行以上检查。测试覆盖计时与任务操作、统计、数据同步、离线缓存、身份隔离、对话、复习和备份等逻辑；模型请求使用测试替身，不需要真实 API 密钥。

| 目录 | 内容 |
| --- | --- |
| `app/` | 页面、交互界面、服务端 API 与 MCP 路由 |
| `lib/` | 学习业务、同步、统计、聊天与复习逻辑 |
| `db/`、`drizzle/` | 数据访问、数据库结构和迁移 |
| `public/` | 图标、PWA 清单与离线缓存脚本 |
| `tests/` | 自动化测试与本机集成检查脚本 |
| `desktop/windows/` | Windows 计时小窗 |
| `scripts/`、`worker/` | 开发、构建及 Worker 入口 |

提交反馈时请附复现步骤、系统和浏览器版本。分享日志或备份前先移除密钥、账号信息和私人学习内容。

## 许可证

项目原创代码采用 [MIT License](LICENSE)，允许使用、修改和分发，请保留许可证和版权声明。第三方代码保留各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
