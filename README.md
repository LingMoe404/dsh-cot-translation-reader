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

- **自动翻译**：自动请求译文，不需要点击。官方手动指定的目标语言优先；设为 `auto` 时读取当前界面语言，再回退到文档或浏览器语言，不会把请求头里的 `*` 当作目标语言。
- 支持稳定块标识的阅读页会在每张思考卡片右上角显示 **查看原文 / 查看译文** 按钮；只切换所点击的卡片，不影响其他卡片。相同文本也按独立标识区分，缓存仍在时不会重新请求。
- **单卡片开关兼容性**：需要 better-display 在思考文本节点提供 `data-reader-reasoning-block-key`，配套补丁见 [better-display PR #82](https://github.com/aa2246740/dsh-better-display/pull/82)。该补丁尚未合并发布，npm 上的 better-display 0.3.9 不包含此标识：仍可自动翻译，但不会显示单卡片按钮，不通过文本或顺序猜测对应卡片。
- **只改显示**：会话记录、折叠、复制回答拿到的都是原文。
- 流式生成中的最后一段保持原文，只翻译已经完成的段落。
- 翻译失败时保留原文、自动重试最多 3 次，并在控制台 `warn`，不会打断阅读。
- 逐段请求（串行，避免触发提供商限流），单次长度遵守 Host 返回的 `maxTextChars`；保留在缓存中的片段不会重复请求。
- **缓存安全上限**：最多保留 512 条卡片缓存。满额时只回收至少五分钟未读取的条目，不因全局重绘挤掉最近使用的译文；没有可回收条目时，新卡片继续显示原文，不发送额外翻译请求。闲置缓存被回收后，再次阅读可能重新请求。
- 按钮只在启动时扫描一次文档，之后按相关 DOM 变化增量维护，不在每次流式更新时重扫整页。
- 关闭插件或卸载时中止进行中的请求并清理重试定时器。

## 发布

推一个 `v*` tag 就会发布：`.github/workflows/publish.yml` 通过 npm **Trusted Publishing（OIDC）**换取短期凭据，仓库和本机都不保存任何 npm token，也不需要动态码。

```sh
git tag -a v0.1.7 -m "v0.1.7"
git push origin v0.1.7
```

## 开发

```sh
npm ci
npm run typecheck
npm test
npm run build     # 构建后自动检查 Host 导入、浏览器工厂及 40–600 张卡片的离线稳定性
npm run check:runtime   # 单独检查当前构建产物是否可加载，不挂载插件
npm run check:stability # 单独检查当前浏览器产物，无真实 DOM/网络/桌面访问
```

`tools/client-build.js` 是从 DeepSeek Harness 公共构建产物里复刻的客户端打包配方（见文件头注释），因此构建不需要完整的 Harness 源码树。

## 相关

- [dsh-better-display](https://github.com/aa2246740/dsh-better-display)：提供 `dsh-better-display.text-transform` 缝的阅读页插件
- [@deepseek-ai/dsh-experimental-cot-translation-bundle](https://www.npmjs.com/package/@deepseek-ai/dsh-experimental-cot-translation-bundle)：官方思考翻译组合包，翻译服务与目标语言在它的插件面板里设置

## 许可

MIT
