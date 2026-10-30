# dsh-cot-translation-reader

在 [**dsh-better-display**](https://github.com/aa2246740/dsh-better-display) 的「阅读」页签里显示 DeepSeek Harness 官方「思考过程机器翻译」的译文。

官方 COT 翻译组合包把译文注册在 `conversation.chat.reasoning.body` 插槽上，而阅读页用自己的组件渲染思考，所以那个插槽在阅读页里永远不会渲染——装了翻译包看起来却像没翻译。本插件补上这段适配：注册到 reading view 的 `dsh-better-display.text-transform` 缝，把译文交给阅读页绘制。

## 依赖

| 组件 | 作用 |
| --- | --- |
| [`dsh-better-display`](https://github.com/aa2246740/dsh-better-display) ≥ **0.3.9** | 提供 `dsh-better-display.text-transform` 缝 |
| [`@deepseek-ai/dsh-experimental-cot-translation-bundle`](https://www.npmjs.com/package/@deepseek-ai/dsh-experimental-cot-translation-bundle) | 提供 `cotTranslation` 服务与翻译设置（翻译服务、目标语言） |

两个都缺任意一个时，本插件**安静地不生效**，不报错、不改界面。

## 安装

```sh
# npm（推荐）
pnpm add dsh-cot-translation-reader

# 从 GitHub 安装（跟踪 main，不用等发布）
pnpm add github:LingMoe404/dsh-cot-translation-reader

# 本地目录
pnpm add file:../dsh-cot-translation-reader
```

装完重启 DSH（Desktop 从托盘完全退出；Web Host 重开一次），然后把 `dsh-cot-translation-reader` 加进 profile `package.json` 的 `dsh.profile.bundles`（插件管理器安装时会自动写）。

## 行为

- **自动翻译**：思考内容一出现就显示译文，不需要点击。
- 每张思考卡片右上角有 **查看原文 / 查看译文** 按钮，一键切回原文，切回时不会重新请求。
- **只改显示**：会话记录、折叠、复制回答拿到的都是原文。
- 流式生成中的最后一段保持原文，只翻译已经完成的段落。
- 翻译失败时保留原文、自动重试最多 3 次，并在控制台 `warn`，不会打断阅读。
- 逐段请求（串行，避免触发提供商限流），单次长度遵守 Host 返回的 `maxTextChars`；同一段译文不会重复请求。
- 关闭插件或卸载时中止进行中的请求。

## 发布

推一个 `v*` tag 就会发布：`.github/workflows/publish.yml` 通过 npm **Trusted Publishing（OIDC）**换取短期凭据，仓库和本机都不保存任何 npm token，也不需要动态码。

```sh
git tag -a v0.1.2 -m "v0.1.2"
git push origin v0.1.2
```

## 开发

```sh
npm ci
npm run typecheck
npm test
npm run build     # 需要 tsdown + 内置的 tools/client-build.js
```

`tools/client-build.js` 是从 DeepSeek Harness 公共构建产物里复刻的客户端打包配方（见文件头注释），因此构建不需要完整的 Harness 源码树。

## 相关

- [dsh-better-display](https://github.com/aa2246740/dsh-better-display)：提供 `dsh-better-display.text-transform` 缝的阅读页插件
- [@deepseek-ai/dsh-experimental-cot-translation-bundle](https://www.npmjs.com/package/@deepseek-ai/dsh-experimental-cot-translation-bundle)：官方思考翻译组合包，翻译服务与目标语言在它的插件面板里设置

## 许可

MIT
