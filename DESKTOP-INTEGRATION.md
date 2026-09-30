# Desktop Integration Notes (v1.1.0)

Integration record for `dsh-web-search-tavily@1.1.0` against the
DSH `0.2.0-rc.2` desktop binary. Intended for the next maintainer who
ports the plugin or debugs the same "failed to import" symptom.

This document is desensitized: no API keys, no per-host paths, no hostnames,
no user identifiers. Anything deployment-specific appears as `<placeholder>`
and must not be substituted with a real value before publishing.

---

## TL;DR

Three things had to align for the plugin to load under the desktop binary.
Miss any one and the symptom is identical: the plugin shows as installed in
the Plugins page but stays "未运行", with a top-of-page warning
`failed to import` and a `1 entry did not activate` line.

1. `name:` in the bundle patch must resolve under `<profile>/node_modules/`
   (or be a relative path the include rewrites to a file URL). A
   `@scope/name` that does not exist on disk fails before `apply()` runs.
2. The plugin's `peerDependencies` must be reachable from inside the
   plugin's loaded file URL, not just from the profile. A `link:` install
   walks `realpath` and bypasses the profile's `node_modules`; the plugin
   needs its own peer-resolution path.
3. Every `Config` schema field must be `.volatile()` under `rc.2`. The
   host hands each field as a reactive accessor (`{ get(): T }`); without
   `.volatile()`, the include tree treats the value as plain JSON and the
   host re-parses it against the schema, which then refuses it.

---

## Symptom chain (observed on a freshly-installed profile)

1. Plugin was added to `dsh.profile.bundles` either via
   `dsh plugin --profile <name> add` or via the desktop "+ 添加插件" dialog.
2. Plugin appears in the Plugins page, with a warning at the top:
   ```
   dsh: warning: 1 entry did not activate
       web-search-tavily (<wrong-name>): failed to import
   ```
3. The toggle stays at "未运行".
5. `tool-web` still reports `searchProvider: deepseek-official`; the
   provider under `ctx.web` is the DeepSeek one, not Tavily.

The bundle resolution itself succeeded — the entry reached the loader's
import stage. So the failure is "module not found at the import boundary",
not a config issue.

---

## Root cause

`@deepseek-ai/cordis-plugin-loader` resolves loader entries via Node's
internal loader (`internal.import(name, baseUrl, {})`, see
`vendor/loader/src/config/tree.ts`). The first import walks
`<baseUrl>/node_modules/<name>`. Subsequent imports inside the loaded
module walk from the module's real path (`realpath` on the `link:` target).

### Issue 1 — bundle patch declares a non-existent name

```yaml
# bundle.yml (broken)
- insert:
    - id: web-search-tavily
      name: "@deepseek-ai/dsh-web-search-tavily"
```

The package on disk is `dsh-web-search-tavily` (no scope). Node walks
`<profile>/node_modules/@deepseek-ai/dsh-web-search-tavily/`, which does
not exist, and returns `ERR_MODULE_NOT_FOUND` before the plugin's
`apply()` runs. The loader catches the error and reports `failed to
import`, leaving the entry's fiber `undefined`.

### Issue 2 — peer deps invisible from inside the plugin

Even with a resolvable first name, the plugin's own `import('@deepseek-ai/...')`
statements walk from `<plugin>/lib/`, then up to `<plugin>/`. With a `link:`
install, `<plugin>/` resolves to the source directory, whose parent chain
has no `node_modules`. The profile's `node_modules/@deepseek-ai/<peer>` are
invisible from the plugin's loaded file URL. The peer imports fail with
the same `ERR_MODULE_NOT_FOUND`, reported by Node as
`Cannot find package '@deepseek-ai/<peer>' imported from <plugin>/lib/index.js`.

### Issue 3 — `Config` schema fields are reactive under `rc.2`

Without `.volatile()`, the include tree treats every parsed value as plain
JSON. The host's `SettingsForms` then re-parses the entry config against
the schema on every `await ctx.inject(...)`, and rejects it because the
plain-object form does not match the reactive accessor shape. The plugin
mounts and fails validation on the first injection.

---

## Fix

### 1. `bundle.yml` — use a resolvable name

```yaml
# bundle.yml (fixed)
# `name:` must resolve under <profile>/node_modules via the loader's
# `internal.import(name, baseUrl)` call. This package is published locally
# as the unscoped `dsh-web-search-tavily`; the @deepseek-ai/... form does
# not exist on disk and Node returns MODULE_NOT_FOUND before `apply()` runs.
# A relative path would also work (anchorInsertedPluginNames rewrites it to
# a file URL), but the unscoped name lets package.json `main` drive the entry.
- insert:
    - id: web-search-tavily
      name: "dsh-web-search-tavily"
```

`anchorInsertedPluginNames` (in `packages/boot/app-boot/src/index.ts`) only
rewrites names that start with `./`, `../`, or are absolute paths. Bare
names stay literal and are handed to Node as-is. So the choice is between
a real npm-style name (resolvable via `<profile>/node_modules`) and a
relative path that the include rewrites to a file URL.

### 2. `lib/index.js` — every schema field gets `.volatile()`

```js
const Config = z.object({
    apiKey: z.string().role("secret").volatile(),
    apiKeyEnv: z.string().role("credential-ref")
        .default(DEFAULT_API_KEY_ENV).volatile(),
    // ... every field ends in .volatile()
});
```

`apply()` reads via a `getField(config, key)` helper that accepts both the
new accessor form (`{ get(): T }`) and the old plain value, so the plugin
stays host-agnostic and can be back-ported if needed:

```js
function getField(config, key) {
    const value = config?.[key];
    return typeof value === "object"
        && value !== null
        && typeof value.get === "function"
        ? value.get()
        : value;
}
```

`test/mock.mjs` mirrors the same accommodation with an `unwrap()` helper
that peels volatile accessors off parsed values for direct assertions.

### 3. Peer dependencies visible from inside the plugin

The desktop profile installs peers at
`<profile>/node_modules/@deepseek-ai/<peer>` (hoisted by pnpm with
`nodeLinker: hoisted, autoInstallPeers: false`). The plugin itself is
brought in via `link:<plugin-source-dir>`, which makes
`<profile>/node_modules/<plugin>` a symlink to the source. Node's parent
walk follows the `realpath` of the loaded file, so the resolution chain
from `<plugin>/lib/index.js` is `<plugin>/lib/` → `<plugin>/` →
`<plugin-source-dir>/`, never reaching `<profile>/`.

Two practical approaches for local development:

- **Junction each peer into the plugin's own `node_modules`**:
  ```
  <plugin-dir>/node_modules/@deepseek-ai/<peer> → <profile>/node_modules/@deepseek-ai/<peer>
  ```
  Windows junctions (`mklink /J`) work without admin and Node 22 / 24
  follow them for `node_modules` resolution. This is what the v1.1.0
  development setup uses.

- **Change `peerDependencies` to `dependencies`** so pnpm installs them
  at the plugin's own `node_modules/` during a market publish. Local
  development still needs the junction approach unless the plugin is
  itself installed into the profile.

Both produce identical resolution chains inside `lib/index.js`.

---

## Verification

A direct Node REPL test, using the same Node binary the desktop bundles:

```sh
cd <profile-dir>
<desktop-node> --input-type=module -e \
  "import('dsh-web-search-tavily')
     .then(m => console.log('LOAD OK', Object.keys(m)))"
```

Expected output (subset):

```
LOAD OK [ 'Config', 'apply', 'TavilySearchProvider', ... ]
```

If the output shows `Cannot find package '<wrong-name>'`, the bundle patch
is not resolving the entry. If it shows
`Cannot find package '@deepseek-ai/<peer>' imported from <plugin>/lib/index.js`,
the peer deps are not visible from inside the plugin.

After both fixes are in place and the desktop has been restarted, the
Plugins page should show:
- Top warning: gone.
- Plugin toggle: enabled, "运行中".

---

## Files changed in v1.1.0

| File | Change |
|---|---|
| `bundle.yml` (new) | Bundle patch declaring the resolvable entry name |
| `lib/index.js` | `.volatile()` on every schema field; `getField()` reader |
| `test/mock.mjs` | `unwrap()` helper for reactive accessors in tests |
| `CONFIGURATION.md` | Documents desktop profile's `cordis.patch.yml` location and the required full-restatement of the `web` entry's config (`rc.2` evolves the default) |
| `package.json` | `version: 1.1.0`; `dsh.bundle.patch`; peer deps tightened to `rc.2` ranges |