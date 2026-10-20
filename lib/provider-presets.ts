/**
 * BYOK provider presets — single source of truth for the engines offered in
 * the Settings popover.
 *
 * Every entry rides the SAME pi/BYOK transport (`lib/pi-coder.ts`): a preset
 * only pre-fills the endpoint, wire protocol and default model ids, so adding
 * an engine is "paste an API key, optionally rename the model". No new
 * provider class, no new transport, no change to the agent pipeline.
 *
 * Endpoint + model ids were verified against each vendor's official docs on
 * 2026-10-19:
 *   deepseek — https://api-docs.deepseek.com
 *   zhipu    — https://docs.bigmodel.cn/cn/guide/develop/openai/introduction
 *   mimo     — https://platform.xiaomimimo.com/docs/zh-CN/integration/roocode
 *   minimax  — https://platform.minimax.io/docs/guides/text-generation
 *   kimi     — https://platform.moonshot.cn/docs/api/
 *
 * Model ids move fast; treat these as defaults, not contracts. Both model
 * fields stay editable in Settings for exactly that reason.
 *
 * ⚠️ Keep in sync with `BYOK_PRESETS` in `electron/wizard/renderer.js`
 * (the wizard is a bare-JS Electron renderer and cannot import this module).
 */

/** Every BYOK endpoint the UI can preselect. */
export type ByokPresetId =
  | "ollama"
  | "openai"
  | "anthropic"
  | "gemini"
  | "custom"
  | "deepseek"
  | "zhipu"
  | "mimo"
  | "minimax"
  | "kimi";

export type ByokApiType =
  | "openai-completions"
  | "google-generative-ai"
  | "anthropic-messages";

export type ByokPreset = {
  id: ByokPresetId;
  /** Shown in the Provider dropdown. */
  label: string;
  /** Base URL handed to pi's models.json (`baseUrl`). */
  url: string;
  apiType: ByokApiType;
  modelFast: string;
  modelSmart: string;
  /** Ollama runs locally and accepts no key; everything else requires one. */
  needsKey: boolean;
  /** Placeholder text for the API-key field. */
  keyHint: string;
  /** Where the user creates a key. */
  docsUrl: string;
  /**
   * Optional pi `compat` overrides written into models.json.
   *
   * pi auto-detects compat from the baseUrl (see `detectCompat()` in
   * pi-ai/providers/openai-completions.js) but only for hosts it knows:
   * deepseek.com, open.bigmodel.cn, api.moonshot.* are covered; api.minimax.*
   * and api.xiaomimimo.com are NOT. Leaving this undefined keeps auto-detection
   * in charge, so the pre-existing engines behave exactly as before.
   */
  compat?: Record<string, unknown>;
};

export const BYOK_PRESETS: Record<ByokPresetId, ByokPreset> = {
  // ── Pre-existing presets (unchanged behaviour) ──────────────────────────
  ollama: {
    id: "ollama",
    label: "Ollama (Local)",
    url: "http://localhost:11434/v1",
    apiType: "openai-completions",
    modelFast: "qwen2.5-coder:7b",
    modelSmart: "qwen2.5-coder:7b",
    needsKey: false,
    keyHint: "Optional (ignored by Ollama)",
    docsUrl: "https://ollama.com",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini (AI Studio)",
    url: "https://generativelanguage.googleapis.com/v1beta",
    apiType: "google-generative-ai",
    modelFast: "gemini-2.5-flash",
    modelSmart: "gemini-2.5-pro",
    needsKey: true,
    keyHint: "Enter Gemini API Key",
    docsUrl: "https://aistudio.google.com/apikey",
  },
  openai: {
    id: "openai",
    label: "OpenAI (ChatGPT/Codex)",
    url: "https://api.openai.com/v1",
    apiType: "openai-completions",
    modelFast: "gpt-4o-mini",
    modelSmart: "gpt-4o",
    needsKey: true,
    keyHint: "Enter OpenAI API Key",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    url: "https://api.anthropic.com",
    apiType: "anthropic-messages",
    modelFast: "claude-3-5-haiku",
    modelSmart: "claude-3-5-sonnet",
    needsKey: true,
    keyHint: "Enter Anthropic API Key",
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  custom: {
    id: "custom",
    label: "Custom Endpoint",
    // Empty on purpose: the UI keeps whatever the user already typed.
    url: "",
    apiType: "openai-completions",
    modelFast: "",
    modelSmart: "",
    needsKey: true,
    keyHint: "Enter API Key",
    docsUrl: "",
  },

  // ── Added engines (all OpenAI-compatible /chat/completions) ─────────────
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    // Docs list https://api.deepseek.com as the [OI]-format base; the /v1
    // suffix is also accepted and keeps the URL shaped like every other preset.
    url: "https://api.deepseek.com/v1",
    apiType: "openai-completions",
    // V4-Flash was retired; `deepseek-flash` now serves V4.1-Flash.
    modelFast: "deepseek-flash",
    modelSmart: "deepseek-v4-pro",
    needsKey: true,
    keyHint: "Enter DeepSeek API Key (sk-…)",
    docsUrl: "https://platform.deepseek.com/api_keys",
  },
  zhipu: {
    id: "zhipu",
    label: "Zhipu GLM (智谱)",
    // The /v4 path segment is mandatory — a bare host returns 404.
    url: "https://open.bigmodel.cn/api/paas/v4",
    apiType: "openai-completions",
    modelFast: "glm-5.3-flash",
    modelSmart: "glm-5.3",
    needsKey: true,
    keyHint: "Enter Zhipu API Key",
    docsUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  mimo: {
    id: "mimo",
    label: "Xiaomi MiMo (小米)",
    // Pay-as-you-go host. Token Plan subscribers use
    // https://token-plan-cn.xiaomimimo.com/v1 with a tp-/ttp- key instead.
    url: "https://api.xiaomimimo.com/v1",
    apiType: "openai-completions",
    modelFast: "mimo-v2.6-flash",
    modelSmart: "mimo-v2.6-pro",
    needsKey: true,
    keyHint: "Enter MiMo API Key (sk-…)",
    docsUrl: "https://platform.xiaomimimo.com",
  },
  minimax: {
    id: "minimax",
    label: "MiniMax",
    // Global host. Mainland-China keys belong on https://api.minimaxi.com/v1 —
    // users on that region must overwrite the Base URL field.
    url: "https://api.minimax.io/v1",
    apiType: "openai-completions",
    modelFast: "MiniMax-M2.7-highspeed",
    modelSmart: "MiniMax-M3",
    needsKey: true,
    keyHint: "Enter MiniMax API Key",
    docsUrl: "https://platform.minimax.io",
    // MiniMax only accepts the roles system/user/assistant/tool — pi would
    // otherwise send `developer` for the system prompt and get a 400.
    compat: { supportsDeveloperRole: false },
  },
  kimi: {
    id: "kimi",
    label: "Moonshot Kimi",
    url: "https://api.moonshot.cn/v1",
    apiType: "openai-completions",
    // kimi-k2.5 was retired on 2026-08-31; K2.6 is the current general model.
    modelFast: "kimi-k2.6",
    modelSmart: "kimi-k3",
    needsKey: true,
    keyHint: "Enter Moonshot API Key (sk-…)",
    docsUrl: "https://platform.moonshot.cn/console/api-keys",
  },
};

/** Dropdown order. New engines sit after the built-ins, before Custom. */
export const BYOK_PRESET_ORDER: ByokPresetId[] = [
  "ollama",
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "zhipu",
  "mimo",
  "minimax",
  "kimi",
  "custom",
];

/** Engines added by this patch — used to label the BYOK panel. */
export const ADDED_ENGINE_IDS: ByokPresetId[] = [
  "deepseek",
  "zhipu",
  "mimo",
  "minimax",
  "kimi",
];

export function isByokPresetId(v: unknown): v is ByokPresetId {
  return typeof v === "string" && v in BYOK_PRESETS;
}

/** Safe lookup with a Custom fallback for unknown/legacy values. */
export function resolvePreset(id: string | undefined): ByokPreset {
  return (id && BYOK_PRESETS[id as ByokPresetId]) || BYOK_PRESETS.custom;
}

/**
 * Best-effort reverse lookup: which preset owns this base URL?
 *
 * Needed because settings written before this patch (or by the `PI_URL` env
 * var) carry a URL but no `piProvider`. Without this every such config would
 * be labelled "Custom" in the UI even though it points at a known engine.
 */
export function detectPresetFromUrl(url: string | undefined): ByokPresetId | undefined {
  if (!url) return undefined;
  const normalised = url.replace(/\/+$/, "");
  return BYOK_PRESET_ORDER.find((id) => {
    const own = BYOK_PRESETS[id].url;
    // `custom` deliberately has no URL of its own.
    return !!own && normalised.startsWith(own.replace(/\/+$/, ""));
  });
}
