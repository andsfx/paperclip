#!/usr/bin/env node
/**
 * Sinkronkan daftar model dari endpoint [OI]-compatible ke konfigurasi Paperclip.
 *
 * Paperclip 2026.1012.0 tidak punya cara mengambil daftar model dari baseUrl +
 * apiKey milik agent: `GET /api/companies/:id/adapters/:type/models` hanya
 * memanggil `adapter.listModels()` yang tidak menerima config sama sekali, dan
 * adapter pihak ketiga `paperclip-adapter-custom-llm-local` memang tidak
 * mengimplementasikannya (mengekspor `models = []`). Akibatnya picker model
 * kosong walau baseUrl dan apiKey sudah diisi.
 *
 * Skrip ini menutup celah itu: ambil `GET {baseUrl}/models`, lalu tulis hasilnya
 * ke dua tempat yang dibaca Paperclip —
 *
 *   1. PAPERCLIP_OPENCODE_PROVIDERS[provider].models  -> picker agent opencode_local
 *      (sekaligus membawa `modalities`, sehingga gambar tidak dibuang opencode
 *      untuk model yang memang bisa vision)
 *   2. PAPERCLIP_ADAPTER_MODELS[custom_llm_local]     -> picker agent custom_llm_local
 *
 * Jalankan setiap kali endpoint menambah model baru:
 *   npm run sync-models
 *   npm run sync-models -- --provider tiprouter-my-id --dry-run
 *
 * Sumber konfigurasi: .paperclip/instances/default/.env (baseURL + apiKey provider).
 * Restart Paperclip setelahnya agar process.env server memuat daftar baru.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const ENV_PATH = path.join(root, ".paperclip", "instances", "default", ".env");

// Endpoint di balik Cloudflare membalas 403 "error code: 1010" untuk klien tanpa
// User-Agent browser, jadi UA dikirim eksplisit.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const MIN_MODELS = 5;

function parseArgs(argv) {
  const opts = { provider: null, dryRun: false, timeoutMs: 30_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--provider") opts.provider = argv[++i] ?? null;
    else if (arg.startsWith("--provider=")) opts.provider = arg.slice("--provider=".length);
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(argv[++i]) || opts.timeoutMs;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else throw new Error(`Argumen tidak dikenal: ${arg}`);
  }
  return opts;
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Tidak menemukan ${file}. Jalankan skrip dari root repo Paperclip.`);
  }
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const values = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    values[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  // Paperclip menulis .env dengan EOL platform; pertahankan gaya yang ada supaya
  // tidak menghasilkan diff seluruh file (CRLF -> LF) di repo Windows.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return { lines, values, eol };
}

/** JSON di .env disimpan tanpa spasi; pertahankan bentuk itu agar diff tetap kecil. */
function compact(value) {
  return JSON.stringify(value, null, 0);
}

async function fetchModels(baseUrl, apiKey, timeoutMs) {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const response = await fetch(url, {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "User-Agent": BROWSER_UA,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${url} membalas HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const payload = await response.json();
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return { url, raw };
}

function normalize(raw) {
  const seen = new Set();
  const models = [];
  for (const item of raw) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const inputs = Array.isArray(item?.capabilities?.input)
      ? item.capabilities.input.filter((entry) => typeof entry === "string")
      : [];
    models.push({
      id,
      label: typeof item?.name === "string" && item.name.trim() ? item.name.trim() : id,
      input: inputs.length > 0 ? inputs : ["text"],
      reasoning: item?.reasoning === true,
      toolCall: item?.tool_call !== false,
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
  return models;
}

function providerModelEntry(model) {
  return {
    name: model.label,
    modalities: { input: model.input, output: ["text"] },
    ...(model.reasoning ? { reasoning: true } : {}),
    ...(model.toolCall ? {} : { tool_call: false }),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Pakai: npm run sync-models [-- --provider <key>] [--dry-run] [--timeout-ms <ms>]");
    return 0;
  }

  const { lines, values, eol } = readEnvFile(ENV_PATH);
  let providers;
  try {
    providers = JSON.parse(values.PAPERCLIP_OPENCODE_PROVIDERS ?? "{}");
  } catch (error) {
    throw new Error(`PAPERCLIP_OPENCODE_PROVIDERS bukan JSON yang sah: ${error.message}`);
  }

  const providerKeys = opts.provider ? [opts.provider] : Object.keys(providers);
  if (providerKeys.length === 0) {
    throw new Error("PAPERCLIP_OPENCODE_PROVIDERS tidak memuat provider apa pun.");
  }
  for (const key of providerKeys) {
    if (!providers[key]) throw new Error(`Provider "${key}" tidak ada di PAPERCLIP_OPENCODE_PROVIDERS.`);
  }

  return (async () => {
    const results = [];
    for (const key of providerKeys) {
      const entry = providers[key];
      const baseUrl = entry?.options?.baseURL;
      const apiKey = entry?.options?.apiKey;
      if (typeof baseUrl !== "string" || !baseUrl.trim()) {
        throw new Error(`Provider "${key}" tidak punya options.baseURL.`);
      }
      const { url, raw } = await fetchModels(baseUrl, typeof apiKey === "string" ? apiKey : "", opts.timeoutMs);
      const models = normalize(raw);
      if (models.length < MIN_MODELS) {
        throw new Error(
          `${url} hanya mengembalikan ${models.length} model yang bisa dipakai (minimal ${MIN_MODELS}); ` +
            "penulisan dibatalkan agar konfigurasi yang ada tidak terhapus."
        );
      }
      results.push({ key, url, models, entry });
    }

    const next = JSON.parse(JSON.stringify(providers));
    for (const result of results) {
      next[result.key] = {
        ...result.entry,
        models: Object.fromEntries(result.models.map((model) => [model.id, providerModelEntry(model)])),
      };
    }

    const declared = results
      .flatMap((result) => result.models)
      .map((model) => ({ id: model.id, label: model.label }));
    const declaredById = new Map(declared.map((model) => [model.id, model]));
    const declaredList = [...declaredById.values()].sort((a, b) =>
      a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" })
    );

    const output = [];
    let replacedProviders = false;
    let replacedAdapterModels = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("PAPERCLIP_OPENCODE_PROVIDERS=")) {
        output.push(`PAPERCLIP_OPENCODE_PROVIDERS=${compact(next)}`);
        replacedProviders = true;
      } else if (trimmed.startsWith("PAPERCLIP_ADAPTER_MODELS=")) {
        output.push(`PAPERCLIP_ADAPTER_MODELS=${compact({ custom_llm_local: declaredList })}`);
        replacedAdapterModels = true;
      } else {
        output.push(line);
      }
    }
    if (!replacedAdapterModels) {
      output.push(`PAPERCLIP_ADAPTER_MODELS=${compact({ custom_llm_local: declaredList })}`);
    }

    for (const result of results) {
      const vision = result.models.filter((model) => model.input.includes("image"));
      console.log(`[sync-models] ${result.key} <- ${result.url}`);
      console.log(`[sync-models]   ${result.models.length} model, ${vision.length} bisa vision`);
      for (const model of result.models) {
        const kinds = model.input.join("+");
        console.log(`[sync-models]   - ${model.id.padEnd(28)} ${kinds.padEnd(11)} ${model.label}`);
      }
    }

    if (opts.dryRun) {
      console.log("[sync-models] --dry-run: file .env tidak diubah");
      return 0;
    }

    fs.writeFileSync(ENV_PATH, `${output.join(eol).replace(/\s+$/, "")}${eol}`, "utf8");
    console.log(
      `[sync-models] .env diperbarui (providers=${replacedProviders ? "ya" : "tidak"}, ` +
        `adapter-models=${replacedAdapterModels ? "ya" : "ditambahkan"}). ` +
        "Restart Paperclip agar process.env server memuat daftar baru."
    );
    return 0;
  })();
}

// process.exitCode (bukan process.exit) supaya handle fetch/keep-alive ditutup
// wajar; process.exit saat ada handle aktif memicu assertion libuv di Windows.
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`[sync-models] GAGAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
