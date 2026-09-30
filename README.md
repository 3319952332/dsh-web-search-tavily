# dsh-web-search-tavily — Tavily 网页搜索 Provider

给 DSH 的 `ctx.web` 接缝换一个后端：**Tavily**（<https://tavily.com>，文档 <https://docs.tavily.com/>）。
装好并配置 API key 后，内置的 `web_search` 工具就直接走 Tavily 的 `/search` 接口。

## 它做什么

注册两个 provider id（内容完全相同，只是名字）：

| id | 说明 |
|---|---|
| `tavily` | 主 id，推荐写在 patch 里 |
| `dsh-web-search-tavily` | 别名，想用插件名当 id 时用 |

每次搜索是一次 `POST {baseURL}/search`，带 `Authorization: Bearer <key>`。**不经过模型**，所以比百炼
那套 Responses 内置工具快得多（实测同一查询 ~1s 返回），也不消耗任何 token 配额。

响应映射到接缝的规范结构：

| Tavily 字段 | 接缝字段 |
|---|---|
| `results[].url` | `sources[].url`（空/重复 URL 会被丢掉） |
| `results[].title` | `sources[].title` |
| `results[].content` | `sources[].snippet` |
| `results[].published_date` | `sources[].publishedAt` |
| `answer` | `content`（provider 生成的简短答案） |
| `score` / `raw_content` | **丢弃** —— 接缝没有相关性分数的位置，整页正文会挤爆上下文 |

HTTP 200 但一条来源都没有时抛 `WEB_PROVIDER_ERROR`，而不是静默返回空列表——那样会让模型以为"网上查无此事"。

## 安装

「设置 → 插件市场」→ `dsh-web-search-tavily` → 安装。之后按 [CONFIGURATION.md](./CONFIGURATION.md)
配 key 并把 `web.searchProvider` 切过来。

## 配置字段

全部字段都有默认值，**装完不配也能挂载**（只是没 key 时不可用）。商店「配置」按钮写的是单行 JSON。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `apiKey` | string(secret) | — | 直接写明文 key。**只在本机临时测试用**，patch 是明文文件；正式用法走 `apiKeyEnv` |
| `apiKeyEnv` | string(credential-ref) | `TAVILY_API_KEY` | 从哪个凭据/环境变量取 key |
| `baseURL` | string | `https://api.tavily.com` | 接口根地址，`/search` 由代码拼接 |
| `topic` | `general`\|`news`\|`finance` | `general` | 检索类目 |
| `searchDepth` | `basic`\|`advanced`\|`fast`\|`ultra-fast` | `basic` | 延迟 vs 相关性。`advanced` **算 2 个 credit**，其余 1 个 |
| `includeAnswer` | bool\|`basic`\|`advanced` | `basic` | 是否让 Tavily 生成一句答案（进 `content`） |
| `maxResults` | int ≥1 | `10` | 请求层的结果上限，实际发给 Tavily 时截到 20 |
| `timeRange` | string | `""` | `day`/`week`/`month`/`year`；其它值（含拼错）当作不设处理 |
| `country` | string | `""` | 指定国家以加权该地区结果，仅 `topic=general` 有效 |
| `includeDomains` | string | `""` | 逗号分隔白名单域名，最多 300 个 |
| `excludeDomains` | string | `""` | 逗号分隔黑名单域名，最多 150 个 |
| `maxConcurrentRequests` | int ≥1 | `2` | 在途请求上限，超出的排队 |
| `minRequestGapMs` | int ≥0 | `150` | 两次请求的最小间隔，防瞬时爆发 |
| `cooldownMs` | int ≥1000 | `5000` | 收到 429 后整个桶停多久（服务端给了更大的 `Retry-After` 就听服务端的） |
| `maxRetries` | int ≥0 | `2` | 可重试失败（429/5xx）的额外次数 |

常用示例：

```json
{ "searchDepth": "basic", "maxResults": 8, "includeAnswer": "basic" }
```

只想省钱、要最快：`{ "searchDepth": "ultra-fast", "includeAnswer": false }`
（`ultra-fast` 每个 URL 只回一段 NLP 摘要，且不支持 `safe_search`。）

## 限流设计

DSH 的 `web_search` 工具会把多 query 调用**并发**展开（最多 4 个 query）。防护层：

| 机制 | 作用 |
|---|---|
| 在途查询合并 | 同 depth+topic+query 的并发请求共享一次真实 HTTP 调用（两个 alias id 共用同一个桶） |
| 并发闸 + 最小间隔 | 排队而非齐发 |
| 429 冷却熔断 | 优先读服务端的 `Retry-After`（秒或 HTTP-date），否则用 `cooldownMs` |
| 有界重试 | 只重放 429/5xx；401/403/432/433 快速失败——key 错了、被拦了、额度用完了，重试都不会自愈 |

432（套餐额度耗尽）/ 433（PayGo 上限）都会带着 Tavily 原文报错，去 <https://app.tavily.com> 看用量。

## 安全约束

- `redirect: "error"`：任何 3xx 都直接失败，不会把 Bearer key 转发到别的源。
- 日志与错误信息里不打印 key。
- 真 key 不放 patch 文件，放 `~/.dsh/.credentials.yaml` 或环境变量。

## 桌面版集成

如果 `1.1.0` 之前的版本在桌面版里报 `failed to import`，看 [DESKTOP-INTEGRATION.md](./DESKTOP-INTEGRATION.md)——三个根因（bundle 名解析、peer 路径、schema `.volatile()`）和验证方法都写在那里。

## 离线测试

离线回归（mock HTTP server，不花 credit）：

```bash
node test/mock.mjs   # 24 项
```
