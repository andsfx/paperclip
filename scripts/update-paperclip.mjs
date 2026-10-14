#!/usr/bin/env node
/**
 * Update Paperclip lokal (D:\Andy\paperclip) dengan aman.
 *
 * Kenapa script ini ada — `paperclipai update` tidak bisa dipakai di setup ini:
 *
 *   1. Perintah itu memanggil `execFile("npm", ...)`. Di Windows `npm` adalah
 *      `npm.cmd`; execFile gagal ENOENT dan sejak CVE-2024-27980 Node menolak
 *      menjalankan .cmd tanpa shell:true. Hasilnya `spawn npm ENOENT`.
 *   2. `detectInstallMode` mengklasifikasi folder ini sebagai `global-npm`,
 *      sehingga update akan menjalankan `npm install -g paperclipai@<versi>` —
 *      menginstal ke %APPDATA%\npm, bukan ke folder ini. Versi di sini tidak
 *      berubah, tapi terlihat "berhasil".
 *   3. `npm install` menimpa node_modules dan menghapus semua patch lokal.
 *      `postinstall` memasangnya kembali, tapi kalau anchor patch berubah di
 *      upstream, patch gagal diam-diam (exit 1 tanpa menghentikan apa pun).
 *
 * Script ini menjalankan urutan yang benar dan berhenti dengan error jelas:
 *   cek versi -> npm install (lokal) -> verifikasi patch -> sync model
 *
 * Semua path diturunkan dari lokasi script ini, jadi selalu mengarah ke
 * folder instalasi ini — tidak terpengaruh cwd maupun PAPERCLIP_HOME.
 *
 * Pemakaian:
 *   node scripts/update-paperclip.mjs              # cek + update ke latest
 *   node scripts/update-paperclip.mjs --check      # cek saja, tidak mengubah
 *   node scripts/update-paperclip.mjs --yes        # tanpa konfirmasi
 *   node scripts/update-paperclip.mjs --version 2026.1013.0
 *   node scripts/update-paperclip.mjs --no-models  # lewati sync model
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverDist = path.join(root, "node_modules", "@paperclipai", "server", "dist");
const instanceEnv = path.join(root, ".paperclip", "instances", "default", ".env");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const options = {
  check: has("--check"),
  yes: has("--yes"),
  skipModels: has("--no-models"),
  version: valueOf("--version"),
  dryRun: has("--dry-run"),
};

let failed = 0;
const step = (n, total, text) => console.log(`\n[${n}/${total}] ${text}`);
const ok = (text) => console.log(`      OK   ${text}`);
const warn = (text) => console.log(`      WARN ${text}`);
const bad = (text) => {
  console.log(`      GAGAL ${text}`);
  failed++;
};

// ---------------------------------------------------------------------------
// Jalankan npm lewat binary Node yang sedang aktif.
// Windows: `npm` adalah `npm.cmd` — execFile ENOENT, dan .cmd ditolak tanpa
// shell:true (CVE-2024-27980). shell:true tidak dipakai karena menggabungkan
// argumen tanpa escape. Pola yang sama dipakai patch 2 di apply-patches.mjs.
// ---------------------------------------------------------------------------
function resolveNpmCli() {
  const candidates = [
    path.resolve(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.APPDATA
      ? path.resolve(process.env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js")
      : null,
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function runNpm(npmArgs, { cwd = root, capture = false } = {}) {
  const cli = resolveNpmCli();
  if (!cli) throw new Error("npm-cli.js tidak ditemukan di sebelah binary Node.");
  const child = spawn(process.execPath, [cli, ...npmArgs], {
    cwd,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, npm_config_registry: "https://registry.npmjs.org" },
  });
  if (!capture) {
    return new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  }
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr })));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function installedVersion() {
  return readJson(path.join(root, "node_modules", "paperclipai", "package.json"))?.version ?? null;
}

async function publishedVersion(spec) {
  const { code, stdout } = await runNpm(["view", `paperclipai@${spec}`, "version", "--json"], { capture: true });
  if (code !== 0) return null;
  try {
    const parsed = JSON.parse(stdout.trim());
    return typeof parsed === "string" ? parsed : Array.isArray(parsed) ? parsed[parsed.length - 1] : null;
  } catch {
    return stdout.trim() || null;
  }
}

const TOTAL = options.skipModels ? 3 : 4;

// ---------------------------------------------------------------------------
step(1, TOTAL, "Periksa versi");
console.log(`      folder   ${root}`);
const before = installedVersion();
if (!before) {
  bad("paperclipai tidak terpasang di node_modules. Jalankan `npm install` dulu.");
  process.exit(1);
}
ok(`terpasang: ${before}`);

const spec = options.version ?? "latest";
const target = await publishedVersion(spec);
if (!target) {
  bad(`tidak bisa membaca versi "${spec}" dari npm registry (cek koneksi).`);
  process.exit(1);
}
ok(`tersedia : ${target}`);

const same = target === before;
console.log(same ? "      -> sudah versi terbaru, tidak ada yang perlu diubah" : `      -> update ${before} -> ${target}`);

if (options.check) {
  console.log("\n--check: tidak ada perubahan yang dilakukan.");
  process.exit(same ? 0 : 10);
}
if (same && !options.version) {
  console.log("\nSelesai tanpa perubahan.");
  process.exit(0);
}

if (!options.yes && !options.dryRun) {
  const ask = `Lanjut update ${before} -> ${target}? Patch lokal akan dipasang ulang otomatis. [y/N] `;
  const answer = await new Promise((resolve) => {
    process.stdout.write(ask);
    process.stdin.once("data", (data) => resolve(data.toString().trim().toLowerCase()));
  });
  if (answer !== "y" && answer !== "yes") {
    console.log("Dibatalkan.");
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
step(2, TOTAL, "Pasang paperclipai (lokal, bukan global)");
console.log(`      npm install paperclipai@${target}`);
if (options.dryRun) {
  warn("--dry-run: langkah ini dilewati");
} else {
  const code = await runNpm(["install", `paperclipai@${target}`, "--save-exact", "--no-audit", "--no-fund"]);
  if (code !== 0) {
    bad(`npm install keluar dengan kode ${code}. Versi terpasang tetap ${installedVersion() ?? "?"}.`);
    process.exit(1);
  }
  const after = installedVersion();
  if (after !== target) bad(`versi setelah install: ${after ?? "tidak terbaca"} (diharapkan ${target})`);
  else ok(`terpasang: ${after}`);
}

// ---------------------------------------------------------------------------
step(3, TOTAL, "Verifikasi patch lokal");
if (options.dryRun) {
  warn("--dry-run: langkah ini dilewati");
} else {
  const patchCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, "apply-patches.mjs")], {
      cwd: root,
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
  if (patchCode !== 0) {
    bad(
      "ada patch yang GAGAL dipasang — anchor-nya kemungkinan berubah di versi baru. " +
        "Jalankan `node scripts/apply-patches.mjs` untuk detail, lalu sesuaikan patch sebelum memakai server."
    );
    process.exit(1);
  }
  // Setiap patch menulis penanda unik ke file target. Kalau penanda hilang
  // setelah install, patch itu gagal dipasang (anchor-nya berubah di upstream).
  const pluginDist = path.join(
    root,
    ".paperclip",
    "adapter-plugins",
    "node_modules",
    "paperclip-adapter-custom-llm-local",
    "dist",
    "index.js"
  );
  const guards = [
    ["adapter guard", "__OMP_ADAPTER_GUARD_V1__", [path.join(serverDist, "adapters", "registry.js")]],
    [
      "windows npm",
      "__OMP_NPM_EXEC_V1__",
      [path.join(serverDist, "routes", "adapters.js"), path.join(serverDist, "services", "plugin-loader.js")],
    ],
    [
      "windows git config",
      "__OMP_GIT_CONFIG_V1__",
      [path.join(serverDist, "services", "skill-source-git-snapshot.js")],
    ],
    ["adapter model count", "__OMP_ADAPTER_MODEL_COUNT_V1__", [path.join(serverDist, "routes", "adapters.js")]],
    ["custom-llm model discovery", "__OMP_CUSTOM_LLM_MODELS_V1__", [pluginDist]],
  ];
  let missing = 0;
  for (const [label, marker, files] of guards) {
    const found = files.filter((file) => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(marker));
    if (found.length === files.length) {
      ok(`${label}: penanda ada di ${found.map((f) => path.basename(f)).join(", ")}`);
    } else {
      const absent = files.filter((file) => !found.includes(file)).map((file) => path.relative(root, file));
      warn(`${label}: penanda TIDAK ditemukan di ${absent.join(", ")}`);
      missing++;
    }
  }
  if (missing > 0) bad(`${missing} patch kehilangan penandanya — periksa manual sebelum menjalankan server.`);
}

// ---------------------------------------------------------------------------
if (!options.skipModels) {
  step(4, TOTAL, "Sinkronkan daftar model");
  if (options.dryRun) {
    warn("--dry-run: langkah ini dilewati");
  } else if (!fs.existsSync(instanceEnv)) {
    warn(`.env instance tidak ada (${path.relative(root, instanceEnv)}) — dilewati`);
  } else {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(here, "sync-models.mjs")], {
        cwd: root,
        stdio: "inherit",
      });
      child.on("close", (code) => resolve(code ?? 1));
    });
    if (code !== 0) warn(`sync-models keluar dengan kode ${code} — daftar model mungkin tidak lengkap`);
  }
}

// ---------------------------------------------------------------------------
console.log("");
if (failed > 0) {
  console.log(`SELESAI DENGAN ${failed} MASALAH — perbaiki dulu sebelum menjalankan server.`);
  process.exit(1);
}
console.log("SELESAI.");
console.log("Restart server agar versi baru dipakai:");
console.log(`  cd ${root}`);
console.log("  start-paperclip.cmd");
