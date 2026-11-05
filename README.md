<div align="center">

<img src="assets/icon-512.png" width="112" alt="dsh-cot-translation-reader 图标" />

# dsh-cot-translation-reader

**让 DeepSeek Harness 的阅读页显示思考过程的机器翻译。**

在 [dsh-better-display](https://github.com/aa2246740/dsh-better-display) 的「阅读」页签里，自动显示官方 COT 机器翻译的译文，并可按卡片在原文与译文之间切换。

[![npm version](https://img.shields.io/npm/v/dsh-cot-translation-reader?style=flat-square&color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-cot-translation-reader)
[![npm downloads](https://img.shields.io/npm/dm/dsh-cot-translation-reader?style=flat-square&color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-cot-translation-reader)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-6E56CF?style=flat-square)](https://github.com/LingMoe404/dsh-cot-translation-reader)
[![better-display](https://img.shields.io/badge/better--display-%E2%89%A50.3.9-FF4D8D?style=flat-square)](https://github.com/aa2246740/dsh-better-display)
[![publish](https://github.com/LingMoe404/dsh-cot-translation-reader/actions/workflows/publish.yml/badge.svg)](https://github.com/LingMoe404/dsh-cot-translation-reader/actions/workflows/publish.yml)

</div>

---

## 为什么需要它

官方 COT 翻译组合包把译文注册在 `conversation.chat.reasoning.body` 插槽上，而阅读页用自己的组件渲染思考内容——那个插槽在阅读页里永远不会渲染。于是会出现一种错觉：明明装了翻译包，阅读页却还是原文。

本插件补上这段适配：注册到阅读页的 `dsh-better-display.text-transform` 缝，把宿主翻译服务的译文交给阅读页绘制。

## 特性

| | 能力 | 说明 |
| :--: | --- | --- |
| 🌏 | **自动翻译** | 思考内容出现即请求译文，无需点击；目标语言优先跟随官方设置，`auto` 时读取界面语言，不会把 `Accept-Language: *` 当成目标语言 |
| 🔀 | **单卡片切换** | 每张思考卡片可独立切换「查看原文 / 查看译文」，只影响所点击的卡片；相同文本也按块标识区分 |
| 👁 | **只改显示** | 会话记录、折叠、复制回答拿到的仍是原文，插件不写回会话 |
| ✍️ | **流式友好** | 生成中的最后一段保持原文，只翻译已经完成的段落 |
| ♻️ | **失败降级** | 翻译失败保留原文，自动重试最多 3 次，不打断阅读 |
| 🚦 | **串行与限流** | 逐段串行请求，单次长度遵守宿主返回的 `maxTextChars`，已缓存片段不重复请求 |
| 🛡 | **缓存有界** | 最多保留 512 条卡片缓存；满额只回收闲置五分钟以上的条目，必要时保留原文而不是制造请求风暴 |
| 🧹 | **卸载干净** | 关闭或卸载时中止进行中的请求并清理重试定时器 |

## 安装

### 前置条件

| 组件 | 版本 | 作用 |
| --- | --- | --- |
| [dsh-better-display](https://github.com/aa2246740/dsh-better-display) | ≥ **0.3.9**（单卡片按钮需 ≥ **0.3.12**） | 提供 `dsh-better-display.text-transform` 缝与思考块标识 |
| [@deepseek-ai/dsh-experimental-cot-translation-bundle](https://www.npmjs.com/package/@deepseek-ai/dsh-experimental-cot-translation-bundle) | 最新 | 提供宿主翻译服务与翻译设置（服务商、目标语言） |

两者缺任意一个时，本插件**安静地不生效**：不报错，也不改界面。

### 通过插件市场

在 DSH 插件面板里搜索 `dsh-cot-translation-reader` 安装，然后完全重启 DSH。

### 通过 npm

```sh
pnpm add dsh-cot-translation-reader
```

### 从 GitHub 安装（跟踪 main，不必等发版）

```sh
pnpm add github:LingMoe404/dsh-cot-translation-reader
```

### 安装后

1. 完全退出 DSH Desktop（托盘退出），或重启一次 Web Host。
2. 确认 profile 的 `package.json` 中已登记 bundle（插件管理器会自动写入）：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-cot-translation-reader"]
    }
  }
}
```

## 使用

- **自动翻译**：打开「阅读」页签即可，思考卡片会逐步从原文切换为译文。
- **查看原文 / 查看译文**：阅读页每张思考卡片右上角有按钮，只切换当前卡片。需要 better-display **≥ 0.3.12**。
- **目标语言**：在官方翻译组合包的设置里选择；设为 `auto` 时跟随界面语言。

### 兼容矩阵

| better-display | 自动翻译 | 单卡片按钮 |
| --- | :--: | :--: |
| `0.3.9` – `0.3.11` | ✅ | ❌（缺少 `data-reader-reasoning-block-key`） |
| `≥ 0.3.12` | ✅ | ✅ |

没有块标识时插件**不会**按文本或卡片顺序猜测归属，只显示自动翻译。

## 工作原理

```text
┌──────────────────────────── DeepSeek Harness Host ────────────────────────────┐
│  translator / cotTranslation（官方 COT 组合包提供，设置也在这里）              │
└───────────────────────────────▲──────────────────────────────────────────────┘
                                │  POST /cot-translation-reader/translate
┌───────────────────────────────┴──────────────────────────────────────────────┐
│  浏览器端：注册 dsh-better-display.text-transform 的 reasoning 转换器          │
│  阅读页 read() → 译文；原文模式 → 当前源文本；通知 → 卡片重绘                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

翻译只发生在展示层，不触碰会话记录、转录与折叠输入。

## 开发与验证

```sh
npm ci
npm run typecheck        # 类型检查
npm test                 # 78 项单元/集成测试（1 项真实网络测试默认跳过）
npm run build            # 构建 + 产物加载检查 + 40–600 张卡片稳定性检查
```

| 命令 | 检查内容 |
| --- | --- |
| `npm run check:runtime` | 导入构建后的 Host 入口、在隔离 VM 执行浏览器工厂，不挂载插件 |
| `npm run check:stability` | 用合成数据跑 40 / 41 / 45 / 100 / 512 / 600 张卡片，验证不循环重译 |
| `npm test` | 语言协商、缓存、按钮隔离、构建产物等回归 |

`tools/client-build.js` 是从 DeepSeek Harness 公共构建产物复刻的客户端打包配方（见文件头注释），因此构建不需要完整 Harness 源码树。

## 发布

推送 `v*` tag 即发布。`.github/workflows/publish.yml` 使用 npm **Trusted Publishing（OIDC）** 换取短期凭据，仓库与本机都不保存 npm token，也不需要动态码；发布前会校验 tag 与版本一致，并重新构建、检查产物。

```sh
git tag -a v0.1.8 -m "v0.1.8"
git push origin v0.1.8
```

## 常见问题

**阅读页没有译文？**
确认官方 COT 翻译组合包已启用、目标语言设置正确，并且 better-display 至少为 0.3.9。宿主未提供翻译服务时，插件不会显示任何内容，也不会报错。

**有译文但没有「查看原文」按钮？**
按钮需要 better-display ≥ 0.3.12 提供的思考块标识。升级阅读页插件并完全重启 DSH。

**插件市场更新报 `duplicate exact route`？**
升级到本插件 **0.1.8** 及以上：重复激活现在是安全无操作，不再因重复路由导致启动失败。

## 相关项目

- [dsh-better-display](https://github.com/aa2246740/dsh-better-display)：提供阅读页与 `text-transform` 扩展点
- [@deepseek-ai/dsh-experimental-cot-translation-bundle](https://www.npmjs.com/package/@deepseek-ai/dsh-experimental-cot-translation-bundle)：官方思考翻译组合包

## 作者

<div align="center">

**泠萌404** · 二次元 / PC 硬件与 NAS

<a href="https://github.com/LingMoe404"><img src="https://img.shields.io/badge/GitHub-LingMoe404-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub：LingMoe404" /></a>
<a href="https://space.bilibili.com/136850"><img src="https://img.shields.io/badge/Bilibili-136850-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white" alt="B站：136850" /></a>
<a href="https://www.douyin.com/user/MS4wLjABAAAA8fYebaVF2xlczanlTvT-bVoRxLqNjp5Tr01pV8wM88Q"><img src="https://img.shields.io/badge/Douyin-LingMoe404-000000?style=for-the-badge&logo=tiktok&logoColor=white" alt="抖音：泠萌404" /></a>

</div>

## 许可

[MIT](LICENSE) © 泠萌404
