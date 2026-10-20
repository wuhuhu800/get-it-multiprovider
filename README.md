<div align="center">

# Get It. — Multi-Provider Edition

### Read it. See it. Get it.

**A downstream build of [Get It.](https://github.com/beltromatti/get-it) that adds five Chinese model providers to the BYOK channel, and fixes the three upstream bugs that made that channel unusable in packaged builds.**

[![Upstream](https://img.shields.io/badge/upstream-beltromatti%2Fget--it-1a1a2e?style=for-the-badge&logo=github)](https://github.com/beltromatti/get-it)
[![Baseline](https://img.shields.io/badge/baseline-v1.4.0-5b66f1?style=for-the-badge)](https://github.com/beltromatti/get-it/releases/tag/v1.4.0)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue?style=for-the-badge)](LICENSE)

[![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![Electron](https://img.shields.io/badge/Electron-33-2C2C2C?logo=electron&logoColor=9FEAF9)](https://www.electronjs.org/)
[![React 19](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

**New engines:** DeepSeek · Zhipu GLM · Xiaomi MiMo · MiniMax · Moonshot Kimi

**中文版：[README.zh-CN.md](README.zh-CN.md)**

<br />

</div>

---

## Why this fork exists

Get It. ships one BYOK channel: a single `chat/completions`-style transport (`lib/pi-coder.ts` → `pi-agent/models.json`) that the whole agent pipeline rides on. Any vendor that speaks that protocol can be added by **describing it**, not by writing a new provider class.

The original app offers five presets in that channel — Ollama, OpenAI, Anthropic, Gemini, Custom. This fork adds five more, and along the way found that the BYOK path had never actually worked in a packaged build:

| # | Problem | Symptom | Root cause |
|---|---|---|---|
| 1 | Missing engine presets | Only 5 providers in the dropdown | Not implemented upstream |
| 2 | `ERR_MODULE_NOT_FOUND: undici` | Setup wizard fails at "Verify" on **any** BYOK engine | `pi-cli` is staged without its own `node_modules`; npm had hoisted its dependencies to a tree electron-builder never copies |
| 3 | `webidl.util.markAsUncloneable is not a function` | Every request throws once (2) is fixed | undici 8.x needs Node 22.10's `worker_threads.markAsUncloneable`; Electron 33 embeds Node 20 |
| 4 | `stdout maxBuffer length exceeded` | Chat works, but knowledge graph / tags / quizzes fail | `--mode json` re-serialises two full copies of the cumulative message on every stream delta → stdout grows **O(N²)** |

All four are fixed here. Nothing else about the app changed: same UI, same interactions, same document pipeline, same storage layout.

## What changed

### 1. A preset table instead of a switch statement

`lib/provider-presets.ts` (new, 246 lines) is the single source of truth: id, label, base URL, wire protocol, two default model ids, whether a key is needed, the key placeholder, the docs link, and optional `compat` overrides.

Everything else now reads from it:

| File | Change |
|---|---|
| `lib/provider-presets.ts` | **new** — `BYOK_PRESETS`, `BYOK_PRESET_ORDER`, `resolvePreset()`, `detectPresetFromUrl()` |
| `lib/pi-coder.ts` | merges `preset.compat` into the generated `models.json` |
| `lib/settings-store.ts` | `piProvider` widened to `ByokPresetId`; reverse URL lookup so pre-existing configs are labelled correctly |
| `components/SettingsButton.tsx` | 40-line `switch` → table lookup; `<option>` list built from `BYOK_PRESET_ORDER` |
| `app/api/settings/route.ts`, `app/api/provider/status/route.ts` | accept the new ids |
| `electron/wizard/index.html`, `electron/wizard/renderer.js` | wizard's preset table kept in sync (bare-JS renderer, cannot import the TS module) |
| `scripts/electron-prepare.mjs` | **new build-time repairs** — see §3 |

Adding a sixth engine is now one row. The type system forces the wizard table to stay in sync.

### 2. The five new engines

| Engine | Base URL | Fast model | Smart model | Notes |
|---|---|---|---|---|
| **DeepSeek** | `https://api.deepseek.com/v1` | `deepseek-flash` | `deepseek-v4-pro` | `deepseek-flash` now serves V4.1-Flash; the older `deepseek-v4-flash` id was retired |
| **Zhipu GLM** | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.3-flash` | `glm-5.3` | the `/v4` path segment is mandatory — a bare host 404s |
| **Xiaomi MiMo** | `https://api.xiaomimimo.com/v1` | `mimo-v2.6-flash` | `mimo-v2.6-pro` | Token-Plan subscribers use `https://token-plan-cn.xiaomimimo.com/v1` with a `tp-`/`ttp-` key — overwrite the URL field |
| **MiniMax** | `https://api.minimax.io/v1` | `MiniMax-M2.7-highspeed` | `MiniMax-M3` | mainland-China keys belong on `https://api.minimaxi.com/v1`; needs `compat: { supportsDeveloperRole: false }` or pi sends `developer` and gets a 400 |
| **Moonshot Kimi** | `https://api.moonshot.cn/v1` | `kimi-k2.6` | `kimi-k3` | `kimi-k2.5` was retired on 2026-08-31 |

Endpoint and model ids were checked against each vendor's docs on 2026-10-19. Model ids move fast — both fields stay editable in Settings for exactly that reason.

### 3. Build-time fixes for the packaged app

`scripts/electron-prepare.mjs` now repairs the staged CLI after copying it:

- **installs `pi-cli`'s own dependency tree** (`npm install --omit=dev`, pinned by its bundled `npm-shrinkwrap.json`) directly into `pi-cli/node_modules`, so ESM resolution stops there instead of escaping into a tree that isn't in the bundle;
- **patches undici's `markAsUncloneable`** with a `typeof` guard and a no-op fallback, since the `--require` shim in `electron/setup.js` can only reach the module's exports object, not the value undici destructures at load time;
- **drops streaming snapshot events** from `print-mode.js`, which cuts a 1.5k-character answer's stdout from **84.8 MB to 38.6 KB** (2245×) and keeps every knowledge-graph run under the 10 MB `maxBuffer`.

Each step warns loudly instead of failing silently if an upstream layout change makes it inapplicable.

### 4. Verification and local signing

- `scripts/verify-byok-engines.ts` (`npm run verify:byok`) — `--self-test` validates all ten presets offline (unique ids, protocol/URL agreement, key/placeholder consistency, `compat` present where required); without the flag it probes each engine live with `GET /models`.
- `scripts/sign-adhoc.py` — signs an unsigned local build from the inside out (35 Mach-O files → nested frameworks → Helpers → main app) with the four entitlements Electron needs. `codesign --deep` alone produces a 32 MB RSS process that never opens a window.

## Install

There are no prebuilt installers in this repo's Releases yet — build one locally:

```bash
git clone https://github.com/wuhuhu800/get-it-multiprovider.git
cd get-it-multiprovider
npm install
npm run build
npm run electron:prepare
node scripts/build-electron.mjs --target=mac-x64    # or mac-arm64 / win-x64 / linux-x64 / --all
```

Artefacts land in `dist-electron/`. The build is unsigned unless you wire up a Developer ID; see **Gatekeeper** below for the local-signing path.

For browser-side hot reload (no Electron, no packaging):

```bash
npm run browser:dev    # http://localhost:3000
```

> The Electron-internal HMR loop has a known Next 16.2.6 + Turbopack + Chromium 130 hydration glitch upstream, so browser dev or rebuild-and-test remains the cleaner inner loop.

## Configure an engine

1. Launch the app and finish the wizard, choosing **Bring Your Own Key (BYOK)**. (The "Sign in with ChatGPT" step belongs to the Codex engine and is skipped.)
2. Open **Settings** (gear, top right) → the **Model Engine** row → **`⇄ Switch`** → **Bring your own key (BYOK)**.
3. Pick an engine from the **Provider** dropdown. Base URL and both model fields pre-fill; paste your API key.
4. Run something — import a PDF and generate tags, or open a document and build the knowledge graph.

The dropdown lists ten entries in this order: Ollama, OpenAI, Anthropic, Gemini, **DeepSeek, Zhipu, MiMo, MiniMax, Kimi**, Custom.

Background agents (tags, knowledge graph, quizzes) use the **Fast Model**, not the Smart Model. If concept extraction feels weak, change **Fast** — editing Smart alone won't affect them.

Settings and keys live in a single directory:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/get-it/` |
| Windows | `%APPDATA%\get-it\` |
| Linux | `~/.local/share/get-it/` |

`settings.json` holds the provider selection; `pi-agent/models.json` holds the generated provider block, **including the API key in plaintext** — the same behaviour as upstream. Treat that file as a secret.

## Gatekeeper (macOS)

Upstream releases are signed with a paid Apple Developer ID and notarized, so they open with no prompt. A locally built copy is not, and will hit one of three states:

| `spctl -a -vvv --type execute "<app>"` | Meaning | Fix |
|---|---|---|
| `accepted` | fine | — |
| `rejected` | signature incomplete — usually a bare Mach-O left unsigned inside the bundle | re-run `python3 scripts/sign-adhoc.py "<app>"` |
| `CSSMERR_TP_CERT_REVOKED` | ad-hoc signature rejected outright | sign with a real certificate, or use the browser build |

One trap worth knowing: **Gatekeeper caches its verdict on the `.app` directory's inode**, not on the path or the signature. If you re-sign in place and the dialog still appears, the cached rejection is what's killing the process — `spctl` will happily report `accepted` while the launch still fails. `objid` in `log show --predicate 'process == "syspolicyd"'` equals `stat -f "%i" "<app>"`. Copy the bundle to a new inode and it re-evaluates:

```bash
ditto "/Applications/Get It.app" "/Applications/Get It Fresh.app"
```

The browser build is the no-signature fallback — the Next.js standalone server runs on plain Node and the frontend never touches `electronAPI`:

```bash
cd "/Applications/Get It.app/Contents/Resources/app/.next/standalone"
PORT=3210 node server.js
```

## Verify the patch

```bash
npm run verify:byok -- --self-test     # offline: ten presets, all invariants
npm run verify:byok                    # online: GET /models against each engine
npx tsc --noEmit                       # types
```

`--self-test` needs no network and no keys. The online pass needs a key per engine you want to check; engines without a key are reported as skipped, not failed.

## Architecture (unchanged from upstream)

```
upload  ─► quality gate (model-free) ─► pdfjs-dist extracts text + glyph bboxes per page
         │
         ├──► visualizer pipeline
         │     ├─ batched concept-detection agent  →  DetectedConcept[] with anchor strings
         │     └─ per-tag visualization-spec agent →  3d / 2d-anim / formula / graph / 2d-text spec
         │
         └──► knowledge-graph pipeline
               ├─ kg-build agent (one-shot)        →  6–25 concept nodes + typed edges + note
               └─ kg-evaluate agent (incremental)  →  per-node {memory, comprehension,
                                                      structure, application} 0–100
```

Every prompt and schema runs behind one provider router, which is why adding an engine is a table row and not a code path. The upstream design rationale — four-axis rubric, evaluator queue, LLM-code sandbox, desktop packaging — is in [`technical-writeup.md`](technical-writeup.md).

## Upstream, credit and licence

This is an independent downstream build. **Get It. was built in 24 hours at GDG AI Hack 2026, Milan**, for the Braynr challenge, by:

- **Mattia Beltrami**, Politecnico di Milano
- **Matteo Impieri**, Politecnico di Milano
- **Filippo Difronzo**, Politecnico di Milano
- **Luca Feggi**, Università di Padova

Baseline: upstream tag [`v1.4.0`](https://github.com/beltromatti/get-it/releases/tag/v1.4.0) (commit `ae0fa99`). All credit for the product, the design and the agent pipeline belongs to them. This fork contributes the five engine presets, the build-time repairs described above, and the verification scripts — nothing else. The unmodified upstream README is kept at [`README.upstream.md`](README.upstream.md) for reference.

Licensed under the **Apache License 2.0**, same as upstream. See [`LICENSE`](LICENSE).

**Trademarks.** Get It. is not affiliated with, endorsed by, or sponsored by OpenAI, Anthropic, Google, DeepSeek, Zhipu AI, Xiaomi, MiniMax or Moonshot AI. Each engine is reached only through that vendor's own documented HTTP endpoint, authenticated with the end user's own API key. All product names are trademarks of their respective owners and are used only to describe what this build interoperates with.

**Your data.** Documents, journals, graphs and keys stay on your disk. The only outbound traffic is what you point the app at, plus the anonymous launch ping described in the upstream README — set `GETIT_DISABLE_ANALYTICS=1` to turn that off.
