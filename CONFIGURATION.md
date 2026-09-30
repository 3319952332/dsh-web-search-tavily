# 配置指南：把网页搜索切到 Tavily

目标：**让 `web_search` 走 Tavily（本插件）。** 两步：给 key、选 provider。缺一不可。

---

## 第一步：凭据

Tavily 的 key 在 <https://app.tavily.com> 申请（免费额度每月 1000 credits，格式 `tvly-...`）。

写进 `~/.dsh/.credentials.yaml`：

```yaml
refs:
  TAVILY_API_KEY: tvly-xxxxxxxxxxxxxxxx
```

也可以在「设置 → 模型」页里加同名凭据。**不要**把 key 明文写进 patch 的 config——那是个明文文件；
config 里的 `apiKey` 字段只为临时排错存在。

---

## 第二步：选定 provider（改 patch）

编辑 `cordis.patch.yml`（桌面版：`~/.dsh/profiles/desktop/cordis.patch.yml`），把下面两段放在文件靠前位置、
**所有 `- insert:` 块之前**：

```yaml
# ── 网页搜索：切到 Tavily，停用 DeepSeek ──
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: tavily
- id: web-search-deepseek
  name: '@deepseek-ai/dsh-web-search-deepseek'
  disabled: true
```

保存后重启桌面版（`cordis.patch.yml` 的改动要在下次启动时全量重新加载）。

### ⚠️ 三个必守的坑

1. **位置**：这两条必须在所有 `- insert:` 块**之前**。市场的行级解析只按 `- insert:` 切块，放后面会被
   吞进上一个 insert 块，导致市场「配置/卸载」误读误删。

2. **不要写 `- disable: web-search-deepseek`**：loader 会**静默忽略**这种写法（patch 算法只认 `id` 定位的
   覆盖项），DeepSeek 根本没关。正确写法是 `- id: web-search-deepseek` + `disabled: true`。

3. **`- id: web` 的 `config` 是整体替换**。桌面版的 `web` 行默认值随 rc.2 演进过，不再只含
   `searchProvider`；若下面三个字段不重述，会被本行整体替换清空。请补全：
   ```yaml
   - id: web
     name: '@deepseek-ai/dsh-web'
     config:
       searchProvider: tavily
       fetchProvider: web-fetch-http
   ```

### 为什么还要停掉另一个

接缝的选择规则：未显式配置 provider 时，**恰好一个**可用提供方才会被自动选中；同时有两个可用的就抛
`WEB_PROVIDER_AMBIGUOUS`。而且如果你机器上还装着 `dsh-web-search-minimax`，它注册了**两个** id
（`minimax-coding-plan` + `qwen-token-plan`），所以那台机器的 `searchProvider` 必须明确指向 `tavily`，
不能靠自动挑选。

### 想保留回退能力

不必卸掉别的搜索插件：只要 `searchProvider: tavily` 指过来就行。想切回去，把那行的值改成
`qwen-token-plan` / `minimax-coding-plan` 或 `deepseek-official` 并重启会话即可。

---

## 第三步（可选）：调参

「设置 → 插件市场 → dsh-web-search-tavily → 配置」写单行 JSON，例如：

```json
{ "maxResults": 8, "searchDepth": "basic", "includeAnswer": "basic" }
```

全字段含义见 [README.md](./README.md#配置字段)。留空也能用（全部走默认值）。

---

## 怎么确认生效

- 发一条需要实时信息的提问，`web_search` 返回带 URL 的来源列表即成功。
- 报 `configured web provider "tavily" is not registered`：插件没挂载（检查是否安装、包名是否拼对）。
- 报 `configured web provider "tavily" is registered but unavailable`：key 没取到，回到第一步。
- 报 `Tavily search has no API key configured for "TAVILY_API_KEY"`：同上。
- 报 `Unauthorized: missing or invalid API key.`（HTTP 401）：key 打错了，或者不是 Tavily 的 key。
- 报 `This request exceeds your plan's set usage limit`（HTTP 432）：本月 credit 用完了，去 dashboard 看用量；
  插件不会重试这类错误。
- 报 `Your request has been blocked due to excessive requests`（HTTP 429）：撞速率限制了。插件已经会自动退避；
  还是频繁出现就把 `maxConcurrentRequests` 调到 1、`minRequestGapMs` 调高。

## 计费提醒

`searchDepth: advanced` 每次算 **2 credits**，其余档位 1 credit。默认的 `basic` 对绝大多数查询够用；
只有明显查不动的长尾问题再手动升档。
