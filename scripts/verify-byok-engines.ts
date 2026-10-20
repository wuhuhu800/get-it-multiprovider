/**
 * Pre-flight check for the BYOK engines added by the multi-engine patch.
 *
 * Run this BEFORE wiring an engine into the app: it proves three things at
 * once — the API key is valid, the base URL is right, and the model id
 * exists on that account. If this script passes and the app still fails, the
 * problem is in the app's transport, not in your credentials.
 *
 * Usage (keys come from the environment, never from argv — they leak into
 * shell history and `ps`):
 *
 *   export DEEPSEEK_API_KEY=sk-...
 *   npx tsx scripts/verify-byok-engines.ts deepseek
 *
 *   # every engine you have a key for
 *   npx tsx scripts/verify-byok-engines.ts all
 *
 * Exit code is 0 only when every engine under test answered.
 */

import {
  ADDED_ENGINE_IDS,
  BYOK_PRESETS,
  BYOK_PRESET_ORDER,
  detectPresetFromUrl,
  type ByokPresetId,
} from "../lib/provider-presets";

/** env var holding each engine's key */
const KEY_ENV: Record<string, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  zhipu: "ZHIPU_API_KEY",
  mimo: "MIMO_API_KEY",
  minimax: "MINIMAX_API_KEY",
  kimi: "MOONSHOT_API_KEY",
};

type ProbeResult = {
  engine: string;
  ok: boolean;
  status: number | null;
  detail: string;
};

async function probe(id: ByokPresetId, apiKey: string, model: string): Promise<ProbeResult> {
  const preset = BYOK_PRESETS[id];
  const url = `${preset.url.replace(/\/+$/, "")}/chat/completions`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(45_000),
    });

    const text = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) {
      return { engine: id, ok: false, status: res.status, detail: truncate(text) };
    }
    // Pull the content out without trusting the vendor's exact shape.
    let content = "";
    try {
      const j = JSON.parse(text) as {
        choices?: { message?: { content?: string } }[];
      };
      content = j.choices?.[0]?.message?.content ?? "";
    } catch {
      content = text;
    }
    return {
      engine: id,
      ok: true,
      status: res.status,
      detail: `${ms}ms · model=${model} · reply=${truncate(content, 40)}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { engine: id, ok: false, status: null, detail: truncate(msg) };
  }
}

function truncate(s: string, n = 200): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/**
 * No-network sanity check on the preset table itself. Catches the class of
 * mistake that a live probe cannot: two presets sharing an endpoint, a model
 * id left empty, a dropdown entry with no matching preset, or a URL that
 * `detectPresetFromUrl` cannot round-trip.
 */
function selfTest(): number {
  const problems: string[] = [];
  const seenUrls = new Map<string, ByokPresetId>();

  for (const id of BYOK_PRESET_ORDER) {
    const p = BYOK_PRESETS[id];
    if (!p) {
      problems.push(`${id}: listed in BYOK_PRESET_ORDER but missing from BYOK_PRESETS`);
      continue;
    }
    if (p.id !== id) problems.push(`${id}: preset.id is "${p.id}"`);
    if (!p.label) problems.push(`${id}: empty label`);
    // "custom" is intentionally blank: it means "keep whatever the user typed".
    if (id !== "custom") {
      if (!p.url) problems.push(`${id}: empty url`);
      if (!p.modelFast) problems.push(`${id}: empty modelFast`);
      if (!p.modelSmart) problems.push(`${id}: empty modelSmart`);
    }
    if (p.needsKey && !p.keyHint) problems.push(`${id}: needsKey but no keyHint`);

    if (p.url) {
      const key = p.url.replace(/\/+$/, "");
      const owner = seenUrls.get(key);
      if (owner) problems.push(`${id}: url duplicates ${owner}`);
      seenUrls.set(key, id);

      // Round-trip: the URL we ship must resolve back to the engine we ship it for.
      const detected = detectPresetFromUrl(p.url);
      if (detected !== id) {
        problems.push(`${id}: detectPresetFromUrl returned "${detected}"`);
      }
    }
  }

  for (const id of Object.keys(BYOK_PRESETS) as ByokPresetId[]) {
    if (!BYOK_PRESET_ORDER.includes(id)) {
      problems.push(`${id}: in BYOK_PRESETS but missing from BYOK_PRESET_ORDER`);
    }
  }

  const expectedAdded: ByokPresetId[] = ["deepseek", "zhipu", "mimo", "minimax", "kimi"];
  for (const id of expectedAdded) {
    if (!ADDED_ENGINE_IDS.includes(id)) problems.push(`${id}: missing from ADDED_ENGINE_IDS`);
    if (!BYOK_PRESETS[id]) problems.push(`${id}: not registered`);
  }

  if (problems.length) {
    console.log("self-test FAILED");
    for (const p of problems) console.log(`  ✗ ${p}`);
    return 1;
  }
  console.log(
    `self-test OK — ${BYOK_PRESET_ORDER.length} presets, ` +
      `${ADDED_ENGINE_IDS.length} added by this patch, no duplicate endpoints`,
  );
  for (const id of ADDED_ENGINE_IDS) {
    const p = BYOK_PRESETS[id];
    console.log(`  ${id.padEnd(9)} ${p.modelFast.padEnd(22)} ${p.modelSmart.padEnd(22)} ${p.url}`);
  }
  return 0;
}

async function main() {
  const arg = process.argv[2];

  // `--self-test` needs no keys and no network — run it in CI, and first when
  // a live probe fails, to rule out a typo in the table before blaming the API.
  if (arg === "--self-test") {
    process.exit(selfTest());
  }

  const targets: ByokPresetId[] =
    !arg || arg === "all"
      ? (Object.keys(KEY_ENV) as ByokPresetId[])
      : (arg.split(",") as ByokPresetId[]);

  const unknown = targets.filter((t) => !KEY_ENV[t]);
  if (unknown.length) {
    console.error(
      `Unknown engine(s): ${unknown.join(", ")}\nAvailable: ${Object.keys(KEY_ENV).join(", ")}`,
    );
    process.exit(2);
  }

  const results: ProbeResult[] = [];
  for (const id of targets) {
    const envName = KEY_ENV[id];
    const key = process.env[envName];
    if (!key) {
      results.push({
        engine: id,
        ok: false,
        status: null,
        detail: `skipped — ${envName} is not set`,
      });
      continue;
    }
    const preset = BYOK_PRESETS[id];
    // Smart-tier model: the one the app uses for chat / knowledge graph.
    process.stdout.write(`probing ${id} (${preset.modelSmart}) … `);
    const r = await probe(id, key, preset.modelSmart);
    console.log(r.ok ? "ok" : "FAILED");
    results.push(r);
  }

  console.log("\n── results ─────────────────────────────────────────────");
  for (const r of results) {
    const mark = r.ok ? "PASS" : "FAIL";
    console.log(`${mark}  ${r.engine.padEnd(9)} ${String(r.status ?? "-").padEnd(5)} ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
