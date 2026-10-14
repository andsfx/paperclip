#!/usr/bin/env node
/**
 * Kumpulan patch lokal untuk Paperclip (Windows).
 *
 * Dijalankan otomatis lewat `postinstall` di package.json dan lewat
 * start-paperclip.cmd, jadi patch tetap terpasang setelah `npm install` ulang.
 * Semua patch idempotent dan aman dipanggil berulang kali.
 *
 * Patch 1 — adapter-guard (registry.js)
 *   Fallback senyap `getServerAdapter(type) ?? processAdapter` mengubah adapter
 *   eksternal yang hilang dari registry menjadi error menyesatkan
 *   "Process adapter missing command". Patch: muat ulang adapter dari plugin
 *   store secara sinkron; kalau gagal, lempar error yang menjelaskan.
 *
// Patch 2 — windows-npm (routes/adapters.js, services/plugin-loader.js)
 *   Server memanggil `execFile("npm", ...)`. Di Windows `npm` adalah `npm.cmd`:
 *   execFile gagal ENOENT, dan sejak CVE-2024-27980 Node menolak menjalankan
 *   `.cmd` tanpa `shell: true` (EINVAL). Memakai `shell: true` berbahaya karena
 *   argumen (nama paket dari request) digabung tanpa escape. Patch: jalankan
 *   npm-cli.js memakai binary Node yang sedang aktif — tanpa shell sama sekali.
 *
 * Patch 3 — windows-git-config (services/skill-source-git-snapshot.js)
 *   Import skill dari GitHub memanggil git dengan `GIT_CONFIG_SYSTEM=os.devNull`
 *   dan `GIT_CONFIG_GLOBAL=os.devNull`. Di Windows `os.devNull` adalah `"nul"`;
 *   Git for Windows menerjemahkannya menjadi path perangkat `\\.\nul` dan gagal
 *   membukanya: `fatal: unable to access '\\.\nul': Invalid argument`. Akibatnya
 *   `git init` (langkah pertama, sebelum menyentuh jaringan) selalu exit 128 dan
 *   UI menampilkan "Could not download the GitHub repository". Patch: arahkan
 *   kedua variabel itu ke file kosong yang benar-benar ada, sehingga niat aslinya
 *   (abaikan config sistem/global host) tetap terjaga.
 *
 * Patch 4 — adapter-model-count (adapters/registry.js, routes/adapters.js)
 *   Kartu adapter menampilkan `modelsCount: (adapter.models ?? []).length`, yaitu
 *   daftar statis milik paket adapter. Adapter passthrough seperti
 *   custom_llm_local memang mengekspor `models = []` (model dikirim verbatim ke
 *   endpoint), sehingga kartunya menulis "0 models" walaupun operator sudah
 *   mendeklarasikan model lewat PAPERCLIP_ADAPTER_MODELS dan picker model
 *   menampilkan daftar lengkap. Patch: hitung dari sumber yang sama
 *   (declaredModelsForAdapter), jadi kartu dan picker konsisten.
 *
 * Patch 5 — custom-llm-local model discovery
 *   Adapter eksternal paperclip-adapter-custom-llm-local@0.2.0 hanya mengekspor
 *   `models = []` dan tidak punya listModels/refreshModels, jadi tidak ada cara
 *   mengambil daftar model dari baseUrl + apiKey. Paperclip memanggil hook model
 *   tanpa argumen config, sehingga patch ini membaca endpoint (base URL + kunci)
 *   dari environment server, persis pola PAPERCLIP_OPENCODE_PROVIDERS pada
 *   opencode_local. Hasil penemuan juga mengisi `models` yang dibaca kartu
 *   adapter. Nilai untuk eksekusi tetap dari adapterConfig agent.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverDist = path.join(root, "node_modules", "@paperclipai", "server", "dist");

let applied = 0;
let skipped = 0;
let failed = 0;

// ---------------------------------------------------------------------------
// Patch 1 — adapter guard
// ---------------------------------------------------------------------------
const GUARD_MARK = "__OMP_ADAPTER_GUARD_V1__";

function patchAdapterGuard() {
  const target = path.join(serverDist, "adapters", "registry.js");
  if (!fs.existsSync(target)) {
    console.log("[patch:guard] registry.js belum ada - dilewati");
    skipped++;
    return;
  }
  let src = fs.readFileSync(target, "utf8");
  if (src.includes(GUARD_MARK)) {
    console.log("[patch:guard] sudah terpasang");
    skipped++;
    return;
  }

  const IMPORT_OLD =
    'import { getDisabledAdapterTypes } from "../services/adapter-plugin-store.js";';
  const IMPORT_NEW =
    'import { getAdapterPluginByType, getAdapterPluginsDir, getDisabledAdapterTypes } from "../services/adapter-plugin-store.js";\n' +
    'import { createRequire as __ompCreateRequire } from "node:module";';

  const FN_OLD = [
    "export function getServerAdapter(type) {",
    "    return findActiveServerAdapter(type) ?? processAdapter;",
    "}",
  ].join("\n");

  const FN_NEW = [
    "const __ompRequire = __ompCreateRequire(import.meta.url);",
    "// " + GUARD_MARK,
    "// Muat ulang adapter eksternal secara sinkron dari plugin store.",
    "function __ompReviveExternalAdapter(type, record) {",
    "    try {",
    '        const path = __ompRequire("node:path");',
    '        const fs = __ompRequire("node:fs");',
    "        const packageDir = record.localPath",
    "            ? path.resolve(record.localPath)",
    '            : path.resolve(getAdapterPluginsDir(), "node_modules", record.packageName);',
    '        const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf-8"));',
    '        const exp = pkg.exports && typeof pkg.exports === "object" ? pkg.exports["."] : undefined;',
    '        const entryPoint = typeof exp === "string"',
    "            ? exp",
    '            : exp && typeof exp === "object"',
    '                ? (exp.import ?? exp.default ?? "index.js")',
    '                : (pkg.main ?? "index.js");',
    "        const mod = __ompRequire(path.resolve(packageDir, entryPoint));",
    '        if (!mod || typeof mod.createServerAdapter !== "function")',
    "            return null;",
    "        const adapterModule = mod.createServerAdapter();",
    "        if (!adapterModule || !adapterModule.type || adapterModule.type !== type)",
    "            return null;",
    "        registerServerAdapter(resolveExternalAdapterRegistration(adapterModule));",
    "        return adaptersByType.get(type) ?? null;",
    "    }",
    "    catch {",
    "        return null;",
    "    }",
    "}",
    "export function getServerAdapter(type) {",
    "    const active = findActiveServerAdapter(type);",
    "    if (active)",
    "        return active;",
    '    // Jangan pernah jatuh diam-diam ke adapter "process" untuk adapter eksternal',
    "    // yang masih terpasang: itu mengubah kegagalan muat menjadi error yang",
    '    // menyesatkan ("Process adapter missing command").',
    "    const record = getAdapterPluginByType(type);",
    "    if (record) {",
    "        const revived = __ompReviveExternalAdapter(type, record);",
    "        if (revived)",
    "            return revived;",
    "        throw new Error('External adapter \"' + type + \"\\\" is installed but not loaded in this server process (\" +",
    "            (record.localPath ?? record.packageName) +",
    '            "). Restart Paperclip to load it again: run start-paperclip.cmd. " +',
    '            "Avoid the Reload/Delete buttons for this adapter on Windows.");',
    "    }",
    "    return processAdapter;",
    "}",
  ].join("\n");

  if (!src.includes(IMPORT_OLD) || !src.includes(FN_OLD)) {
    console.error("[patch:guard] GAGAL: bentuk file tidak sesuai (versi Paperclip berbeda?)");
    failed++;
    return;
  }
  src = src.replace(IMPORT_OLD, IMPORT_NEW).replace(FN_OLD, FN_NEW);
  fs.writeFileSync(target, src);
  console.log("[patch:guard] terpasang");
  applied++;
}

// ---------------------------------------------------------------------------
// Patch 2 — windows npm
// ---------------------------------------------------------------------------
const NPM_MARK = "__OMP_NPM_EXEC_V1__";
const NPM_OLD = 'execFileAsync("npm", ';
const NPM_NEW = "__ompNpmExec(";

// `existsSync` sengaja disuntik per-file mengikuti gaya import masing-masing file.
const NPM_HELPER = [
  "// " + NPM_MARK,
  "// Jalankan CLI npm lewat binary Node yang sedang aktif, bukan lewat shim shell.",
  "// Windows: `npm` adalah `npm.cmd` - execFile gagal ENOENT, dan sejak",
  "// CVE-2024-27980 Node menolak .cmd tanpa shell:true (EINVAL). shell:true tidak",
  "// dipakai karena argumennya digabung tanpa escape (nama paket datang dari request).",
  "let __ompNpmCliResolved = false;",
  "let __ompNpmCliPath = null;",
  "function __ompNpmCli() {",
  "    if (__ompNpmCliResolved)",
  "        return __ompNpmCliPath;",
  "    __ompNpmCliResolved = true;",
  "    const candidates = [",
  '        path.resolve(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),',
  '        path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),',
  "    ];",
  "    __ompNpmCliPath = candidates.find((candidate) => %%EXISTS%%(candidate)) ?? null;",
  "    return __ompNpmCliPath;",
  "}",
  "function __ompNpmExec(args, options) {",
  "    const cli = __ompNpmCli();",
  "    return cli",
  "        ? execFileAsync(process.execPath, [cli, ...args], options)",
  '        : execFileAsync("npm", args, options);',
  "}",
].join("\n");

const NPM_TARGETS = [
  { rel: ["routes", "adapters.js"], exists: "fs.existsSync", expected: 3 },
  { rel: ["services", "plugin-loader.js"], exists: "existsSync", expected: 2 },
];

function patchWindowsNpm() {
  for (const { rel, exists, expected } of NPM_TARGETS) {
    const target = path.join(serverDist, ...rel);
    const label = `patch:npm ${rel.join("/")}`;
    if (!fs.existsSync(target)) {
      console.log(`[${label}] file tidak ada - dilewati`);
      skipped++;
      continue;
    }
    let src = fs.readFileSync(target, "utf8");
    if (src.includes(NPM_MARK)) {
      console.log(`[${label}] sudah terpasang`);
      skipped++;
      continue;
    }
    const found = src.split(NPM_OLD).length - 1;
    if (found !== expected) {
      console.error(`[${label}] GAGAL: ditemukan ${found} pemanggilan, diharapkan ${expected}`);
      failed++;
      continue;
    }
    src = src.split(NPM_OLD).join(NPM_NEW);
    src = src.replace(/\s*$/, "") + "\n\n" + NPM_HELPER.replace("%%EXISTS%%", exists) + "\n";
    fs.writeFileSync(target, src);
    console.log(`[${label}] terpasang (${found} pemanggilan)`);
    applied++;
  }
}

// ---------------------------------------------------------------------------
// Patch 3 — windows git config
// ---------------------------------------------------------------------------
const GITCFG_MARK = "__OMP_GIT_CONFIG_V1__";

const GITCFG_IMPORT_OLD =
  "import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises';";
const GITCFG_IMPORT_NEW =
  GITCFG_IMPORT_OLD +
  "\n" +
  'import { mkdtempSync as __ompMkdtempSync, writeFileSync as __ompWriteFileSync } from "node:fs";';

const GITCFG_FN_OLD = "function gitEnvironment(token) {";

const GITCFG_ENV_OLD =
  "GIT_CONFIG_SYSTEM: os.devNull,\n        GIT_CONFIG_GLOBAL: os.devNull,";
const GITCFG_ENV_NEW =
  "GIT_CONFIG_SYSTEM: __ompEmptyGitConfig(),\n        GIT_CONFIG_GLOBAL: __ompEmptyGitConfig(),";

const GITCFG_HELPER = [
  "// " + GITCFG_MARK,
  "// Windows: os.devNull adalah \"nul\", dan Git for Windows gagal membukanya",
  "// (EINVAL) ketika dipakai sebagai GIT_CONFIG_SYSTEM/GIT_CONFIG_GLOBAL - semua",
  "// import skill dari GitHub mati di langkah `git init`, sebelum menyentuh",
  "// jaringan. Git butuh file config yang benar-benar ada: satu file kosong 0 byte",
  "// per proses, di folder temp OS. Niat aslinya tetap: config sistem/global host",
  "// tidak pernah dibaca.",
  "let __ompEmptyGitConfigPath = null;",
  "function __ompEmptyGitConfig() {",
  "    if (__ompEmptyGitConfigPath)",
  "        return __ompEmptyGitConfigPath;",
  "    const dir = __ompMkdtempSync(path.join(os.tmpdir(), \"paperclip-empty-gitconfig-\"));",
  "    __ompEmptyGitConfigPath = path.join(dir, \"empty.gitconfig\");",
  "    __ompWriteFileSync(__ompEmptyGitConfigPath, \"\");",
  "    return __ompEmptyGitConfigPath;",
  "}",
].join("\n");

function patchWindowsGitConfig() {
  const target = path.join(serverDist, "services", "skill-source-git-snapshot.js");
  const label = "patch:git-config";
  if (!fs.existsSync(target)) {
    console.log(`[${label}] file tidak ada - dilewati`);
    skipped++;
    return;
  }
  let src = fs.readFileSync(target, "utf8");
  if (src.includes(GITCFG_MARK)) {
    console.log(`[${label}] sudah terpasang`);
    skipped++;
    return;
  }
  const envCount = src.split(GITCFG_ENV_OLD).length - 1;
  const fnCount = src.split(GITCFG_FN_OLD).length - 1;
  if (!src.includes(GITCFG_IMPORT_OLD) || envCount !== 1 || fnCount !== 1) {
    console.error(
      `[${label}] GAGAL: bentuk file tidak sesuai (import=${src.includes(GITCFG_IMPORT_OLD)}, env=${envCount}, fn=${fnCount})`
    );
    failed++;
    return;
  }
  src = src
    .replace(GITCFG_IMPORT_OLD, GITCFG_IMPORT_NEW)
    .replace(GITCFG_FN_OLD, GITCFG_HELPER + "\n" + GITCFG_FN_OLD)
    .replace(GITCFG_ENV_OLD, GITCFG_ENV_NEW);
  fs.writeFileSync(target, src);
  console.log(`[${label}] terpasang`);
  applied++;
}

// ---------------------------------------------------------------------------
// Patch 4 — adapter model count
// ---------------------------------------------------------------------------
const MODELCOUNT_MARK = "__OMP_ADAPTER_MODEL_COUNT_V1__";

const MODELCOUNT_REGISTRY_OLD = "function declaredModelsForAdapter(type) {";
const MODELCOUNT_REGISTRY_NEW = "export function declaredModelsForAdapter(type) {";

const MODELCOUNT_ROUTE_IMPORT_OLD =
  "import { listServerAdapters, findServerAdapter, findActiveServerAdapter, registerServerAdapter, resolveExternalAdapterRegistration, unregisterServerAdapter, isOverridePaused, setOverridePaused, } from \"../adapters/registry.js\";";
const MODELCOUNT_ROUTE_IMPORT_NEW =
  "import { listServerAdapters, findServerAdapter, findActiveServerAdapter, registerServerAdapter, resolveExternalAdapterRegistration, unregisterServerAdapter, isOverridePaused, setOverridePaused, declaredModelsForAdapter, } from \"../adapters/registry.js\";";

const MODELCOUNT_ROUTE_OLD = "modelsCount: (adapter.models ?? []).length,";
const MODELCOUNT_ROUTE_NEW =
  "// " + MODELCOUNT_MARK + "\n" +
  "        // Adapter passthrough (mis. custom_llm_local) tidak punya daftar model\n" +
  "        // statis: modelnya dideklarasikan operator lewat PAPERCLIP_ADAPTER_MODELS.\n" +
  "        // Tanpa ini kartu adapter menulis \"0 models\" padahal picker model berisi\n" +
  "        // daftar lengkap. Sumber yang sama dipakai, jadi keduanya konsisten.\n" +
  "        modelsCount: (declaredModelsForAdapter(adapter.type)?.length ?? (adapter.models ?? []).length),";

function patchAdapterModelCount() {
  const registryTarget = path.join(serverDist, "adapters", "registry.js");
  const routeTarget = path.join(serverDist, "routes", "adapters.js");
  const label = "patch:model-count";
  if (!fs.existsSync(registryTarget) || !fs.existsSync(routeTarget)) {
    console.log(`[${label}] file tidak ada - dilewati`);
    skipped++;
    return;
  }
  let registry = fs.readFileSync(registryTarget, "utf8");
  let route = fs.readFileSync(routeTarget, "utf8");
  if (route.includes(MODELCOUNT_MARK)) {
    console.log(`[${label}] sudah terpasang`);
    skipped++;
    return;
  }
  const registryCount = registry.split(MODELCOUNT_REGISTRY_OLD).length - 1;
  const importCount = route.split(MODELCOUNT_ROUTE_IMPORT_OLD).length - 1;
  const fieldCount = route.split(MODELCOUNT_ROUTE_OLD).length - 1;
  if (registryCount !== 1 || importCount !== 1 || fieldCount !== 1) {
    console.error(
      `[${label}] GAGAL: bentuk file tidak sesuai (registry=${registryCount}, import=${importCount}, field=${fieldCount})`
    );
    failed++;
    return;
  }
  registry = registry.replace(MODELCOUNT_REGISTRY_OLD, MODELCOUNT_REGISTRY_NEW);
  route = route
    .replace(MODELCOUNT_ROUTE_IMPORT_OLD, MODELCOUNT_ROUTE_IMPORT_NEW)
    .replace(MODELCOUNT_ROUTE_OLD, MODELCOUNT_ROUTE_NEW);
  fs.writeFileSync(registryTarget, registry);
  fs.writeFileSync(routeTarget, route);
  console.log(`[${label}] terpasang`);
  applied++;
}

// ---------------------------------------------------------------------------
// Patch 5 — custom-llm-local model discovery
// ---------------------------------------------------------------------------
const CUSTOMLM_MARK = "__OMP_CUSTOM_LLM_MODELS_V1__";

const CUSTOMLM_PKG = ["paperclip-adapter-custom-llm-local", "dist", "index.js"];

const CUSTOMLM_ANCHOR_OLD = "export function createServerAdapter() {";
const CUSTOMLM_HOOKS_OLD = "        models,\n        getConfigSchema,";
const CUSTOMLM_HOOKS_NEW = "        models,\n        listModels,\n        refreshModels,\n        getConfigSchema,";

const CUSTOMLM_HELPER = [
  "// " + CUSTOMLM_MARK,
  "// Paperclip memanggil hook penemuan model tanpa argumen config",
  "// (listModels?: () => Promise<AdapterModel[]>), jadi endpoint untuk enumerasi",
  "// model dibaca dari environment server - pola yang sama seperti",
  "// PAPERCLIP_OPENCODE_PROVIDERS pada adapter opencode_local. Nilai yang dipakai",
  "// saat eksekusi tetap dari adapterConfig agent (baseUrl + apiKeyEnv).",
  "//",
  "//   PAPERCLIP_CUSTOM_LLM_BASE_URL      wajib, mis. https://host/v1",
  "//   PAPERCLIP_CUSTOM_LLM_API_KEY_ENV   nama env var yang memegang kunci",
  "//   PAPERCLIP_CUSTOM_LLM_API_KEY       kunci langsung (fallback)",
  "//   PAPERCLIP_CUSTOM_LLM_TRANSPORT     openai_chat_completions (default) |",
  "//                                      anthropic_messages",
  "//   PAPERCLIP_CUSTOM_LLM_MODELS_PATH   default /models",
  "const __ompModelsCacheTtlMs = 60_000;",
  "const __ompModelsCache = { at: 0, value: null };",
  "function __ompEnvValue(name) {",
  "    const raw = process.env[name];",
  "    return typeof raw === \"string\" && raw.trim().length > 0 ? raw.trim() : null;",
  "}",
  "function __ompModelEndpoint() {",
  "    const baseUrl = __ompEnvValue(\"PAPERCLIP_CUSTOM_LLM_BASE_URL\");",
  "    if (!baseUrl)",
  "        return null;",
  "    const keyEnvName = __ompEnvValue(\"PAPERCLIP_CUSTOM_LLM_API_KEY_ENV\");",
  "    const apiKey = keyEnvName ? __ompEnvValue(keyEnvName) : __ompEnvValue(\"PAPERCLIP_CUSTOM_LLM_API_KEY\");",
  "    const transport = (__ompEnvValue(\"PAPERCLIP_CUSTOM_LLM_TRANSPORT\") ?? \"openai_chat_completions\").toLowerCase();",
  "    const path = __ompEnvValue(\"PAPERCLIP_CUSTOM_LLM_MODELS_PATH\") ?? \"/models\";",
  "    return { url: `${baseUrl.replace(/\\/+$/, \"\")}${path.startsWith(\"/\") ? path : `/${path}`}`, apiKey, transport };",
  "}",
  "function __ompNormalizeModels(payload) {",
  "    const raw = Array.isArray(payload?.data)",
  "        ? payload.data",
  "        : Array.isArray(payload?.models)",
  "            ? payload.models",
  "            : Array.isArray(payload)",
  "                ? payload",
  "                : [];",
  "    const seen = new Set();",
  "    const out = [];",
  "    for (const entry of raw) {",
  "        const id = typeof entry === \"string\" ? entry.trim()",
  "            : typeof entry?.id === \"string\" ? entry.id.trim()",
  "                : typeof entry?.name === \"string\" ? entry.name.trim()",
  "                    : \"\";",
  "        if (!id || seen.has(id))",
  "            continue;",
  "        seen.add(id);",
  "        const label = typeof entry?.display_name === \"string\" && entry.display_name.trim()",
  "            ? entry.display_name.trim()",
  "            : typeof entry?.name === \"string\" && entry.name.trim() && entry.name.trim() !== id",
  "                ? entry.name.trim()",
  "                : id;",
  "        out.push({ id, label });",
  "    }",
  "    return out;",
  "}",
  "async function __ompFetchModels() {",
  "    const endpoint = __ompModelEndpoint();",
  "    if (!endpoint)",
  "        throw new Error(\"PAPERCLIP_CUSTOM_LLM_BASE_URL is not set\");",
  "    const headers = { accept: \"application/json\", \"user-agent\": \"paperclip-adapter-custom-llm-local\" };",
  "    if (endpoint.apiKey) {",
  "        if (endpoint.transport === \"anthropic_messages\") {",
  "            headers[\"x-api-key\"] = endpoint.apiKey;",
  "            headers[\"anthropic-version\"] = __ompEnvValue(\"PAPERCLIP_CUSTOM_LLM_ANTHROPIC_VERSION\") ?? \"2023-06-01\";",
  "        }",
  "        else {",
  "            headers.authorization = `Bearer ${endpoint.apiKey}`;",
  "        }",
  "    }",
  "    const response = await fetch(endpoint.url, {",
  "        headers,",
  "        redirect: \"error\",",
  "        signal: AbortSignal.timeout(15_000),",
  "    });",
  "    if (!response.ok) {",
  "        await response.body?.cancel?.().catch(() => undefined);",
  "        throw new Error(`${endpoint.url} responded HTTP ${response.status} ${response.statusText}`.trim());",
  "    }",
  "    return __ompNormalizeModels(await response.json());",
  "}",
  "async function __ompDiscoverModels(force) {",
  "    if (!force && __ompModelsCache.value && Date.now() - __ompModelsCache.at < __ompModelsCacheTtlMs)",
  "        return __ompModelsCache.value;",
  "    try {",
  "        const value = await __ompFetchModels();",
  "        if (value.length > 0) {",
  "            __ompModelsCache.value = value;",
  "            __ompModelsCache.at = Date.now();",
  "            models.length = 0;",
  "            models.push(...value);",
  "        }",
  "        return value;",
  "    }",
  "    catch (error) {",
  "        console.warn(`[custom-llm-local] Model discovery failed (${error instanceof Error ? error.message : String(error)}); using the declared/static list.`);",
  "        return [];",
  "    }",
  "}",
  "async function listModels() {",
  "    return __ompDiscoverModels(false);",
  "}",
  "async function refreshModels() {",
  "    __ompModelsCache.value = null;",
  "    return __ompDiscoverModels(true);",
  "}",
].join("\n");

function patchCustomLlmModelDiscovery() {
  const target = path.join(root, ".paperclip", "adapter-plugins", "node_modules", ...CUSTOMLM_PKG);
  const label = "patch:custom-llm-models";
  if (!fs.existsSync(target)) {
    console.log(`[${label}] paket adapter tidak ada - dilewati`);
    skipped++;
    return;
  }
  let src = fs.readFileSync(target, "utf8");
  if (src.includes(CUSTOMLM_MARK)) {
    console.log(`[${label}] sudah terpasang`);
    skipped++;
    return;
  }
  const anchorCount = src.split(CUSTOMLM_ANCHOR_OLD).length - 1;
  const hooksCount = src.split(CUSTOMLM_HOOKS_OLD).length - 1;
  if (anchorCount !== 1 || hooksCount !== 1 || !src.includes("export const models = [];")) {
    console.error(
      `[${label}] GAGAL: bentuk file tidak sesuai (anchor=${anchorCount}, hooks=${hooksCount})`
    );
    failed++;
    return;
  }
  src = src
    .replace(CUSTOMLM_ANCHOR_OLD, `${CUSTOMLM_HELPER}\n\n${CUSTOMLM_ANCHOR_OLD}`)
    .replace(CUSTOMLM_HOOKS_OLD, CUSTOMLM_HOOKS_NEW);
  fs.writeFileSync(target, src);
  console.log(`[${label}] terpasang`);
  applied++;
}

// ---------------------------------------------------------------------------
if (!fs.existsSync(serverDist)) {
  console.log("[patch] @paperclipai/server belum terpasang - dilewati");
  process.exit(0);
}

patchAdapterGuard();
patchWindowsNpm();
patchWindowsGitConfig();
patchAdapterModelCount();
patchCustomLlmModelDiscovery();

console.log(`[patch] selesai: ${applied} dipasang, ${skipped} dilewati, ${failed} gagal`);
process.exit(failed > 0 ? 1 : 0);
