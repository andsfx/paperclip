#!/usr/bin/env node
/**
 * Restart Paperclip dengan bersih: matikan SEMUA proses lama dulu, pastikan
 * benar-benar mati, baru start satu instance.
 *
 * Kenapa perlu: `cmd /c start ... start-paperclip.cmd` membuka jendela terminal
 * baru dan melahirkan satu rantai proses (cmd -> npx -> cmd -> node -> postgres).
 * Kalau rantai lama belum mati saat restart berikutnya, jendela dan prosesnya
 * menumpuk: hanya yang pertama memegang port 3100, sisanya hidup setengah jadi
 * dan ikut muncul di terminal.
 *
 * Script ini juga menangani postgres yatim: mematikan server saja meninggalkan
 * forkchild embedded-postgres yang menahan port 54329, sehingga start berikutnya
 * gagal bind.
 *
 * Pemakaian:
 *   node scripts/restart-paperclip.mjs            # matikan semua, start satu
 *   node scripts/restart-paperclip.mjs --status   # lihat yang berjalan saja
 *   node scripts/restart-paperclip.mjs --stop     # matikan saja
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const instanceRoot = path.join(root, ".paperclip", "instances", "default");
const stalePostmasterPid = path.join(instanceRoot, "db", "postmaster.pid");
const SERVER_PORT = 3100;
const PG_PORT = 54329;

const args = process.argv.slice(2);
const mode = args.includes("--status") ? "status" : args.includes("--stop") ? "stop" : "restart";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Enumerasi proses milik instalasi ini saja.
// powershell.exe dikecualikan: command line-nya memuat teks pola ini sendiri,
// jadi tanpa pengecualian ia akan mencocoki dirinya dan ikut dibunuh.
// ---------------------------------------------------------------------------
function listProcesses() {
  const script = `
$self = ${process.pid}
Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $self -and
  $_.Name -notin @('powershell.exe','pwsh.exe','WmiPrvSE.exe') -and
  $_.CommandLine -ne $null -and (
    ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'paperclipai') -or
    ($_.Name -eq 'cmd.exe'  -and $_.CommandLine -match 'start-paperclip|paperclipai run') -or
    ($_.Name -eq 'postgres.exe' -and $_.CommandLine -match 'paperclip')
  )
} | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress
`;
  const out = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// Server lebih dulu supaya postgres dimatikan oleh induknya, bukan diputus paksa.
function killPriority(proc) {
  if (proc.Name === "node.exe" && /paperclipai[\\/]dist[\\/]index\.js/.test(proc.CommandLine)) return 0;
  if (proc.Name === "cmd.exe") return 1;
  if (proc.Name === "node.exe") return 2;
  if (proc.Name === "postgres.exe") return 3;
  return 4;
}

function listenerPids() {
  const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
  const found = new Map();
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    const match = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
    if (!match) continue;
    const port = Number(match[1]);
    if (port === SERVER_PORT || port === PG_PORT) found.set(port, Number(match[2]));
  }
  return found;
}

function taskkill(pid) {
  try {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
const before = listProcesses();
const listenersBefore = listenerPids();

if (mode === "status") {
  if (before.length === 0) {
    console.log("Tidak ada proses Paperclip yang berjalan.");
    process.exit(0);
  }
  const servers = before.filter((p) => killPriority(p) === 0);
  console.log(`Proses Paperclip: ${before.length}`);
  for (const proc of before.sort((a, b) => killPriority(a) - killPriority(b))) {
    const cmd = proc.CommandLine.replace(/\s+/g, " ");
    console.log(`  ${String(proc.ProcessId).padEnd(7)} ${proc.Name.padEnd(13)} ${cmd.slice(0, 78)}`);
  }
  console.log("");
  console.log(`Server (pemegang port ${SERVER_PORT}): ${servers.length}`);
  console.log(`Port ${SERVER_PORT}: ${listenersBefore.get(SERVER_PORT) ?? "tidak ada"}`);
  console.log(`Port ${PG_PORT}: ${listenersBefore.get(PG_PORT) ?? "tidak ada"}`);
  if (servers.length > 1) console.log("PERINGATAN: lebih dari satu server - jalankan restart untuk membersihkan.");
  process.exit(servers.length > 1 ? 1 : 0);
}

// ---------------------------------------------------------------------------
console.log(`[1/5] Proses lama: ${before.length} ditemukan`);
if (before.length === 0) console.log("      (tidak ada yang perlu dimatikan)");

// ---------------------------------------------------------------------------
if (before.length > 0) {
  console.log("[2/5] Mematikan proses lama");
  // Server lebih dulu dengan /T: anak-anaknya (npx, cmd, postgres) ikut mati,
  // jadi percobaan berikutnya gagal karena prosesnya sudah tidak ada. Itu
  // hasil yang diinginkan - laporkan berdasarkan keadaan setelah kill,
  // bukan berdasarkan exit code taskkill.
  for (const proc of before.sort((a, b) => killPriority(a) - killPriority(b))) {
    taskkill(proc.ProcessId);
    const stillAlive = listProcesses().some((p) => p.ProcessId === proc.ProcessId);
    console.log(`      ${stillAlive ? "sisa " : "mati "} ${String(proc.ProcessId).padEnd(7)} ${proc.Name}`);
  }
} else {
  console.log("[2/5] Mematikan proses lama - dilewati");
}

// ---------------------------------------------------------------------------
console.log("[3/5] Verifikasi semua sudah mati");
let remaining = [];
let listeners = listenerPids();
for (let attempt = 1; attempt <= 12; attempt++) {
  await sleep(500);
  remaining = listProcesses();
  listeners = listenerPids();
  if (remaining.length === 0 && listeners.size === 0) break;
  if (attempt === 6 && remaining.length > 0) {
    console.log("      masih ada sisa, paksa ulang dengan /T");
    for (const proc of remaining) taskkill(proc.ProcessId);
  }
}

if (remaining.length > 0) {
  console.log(`      GAGAL: ${remaining.length} proses masih hidup`);
  for (const proc of remaining) console.log(`        ${proc.ProcessId} ${proc.Name}`);
  process.exit(1);
}
if (listeners.size > 0) {
  const ports = [...listeners.keys()].join(", ");
  console.log(`      GAGAL: port ${ports} masih terpakai (pid ${[...listeners.values()].join(", ")})`);
  process.exit(1);
}
console.log(`      bersih: 0 proses, port ${SERVER_PORT} & ${PG_PORT} bebas`);

if (fs.existsSync(stalePostmasterPid)) {
  fs.rmSync(stalePostmasterPid, { force: true });
  console.log("      postmaster.pid basi dihapus");
}

if (mode === "stop") {
  console.log("\nSELESAI. Server dihentikan.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
console.log("[4/5] Menjalankan satu instance");
spawn("cmd", ["/c", "start", "Paperclip Server", "cmd", "/c", "start-paperclip.cmd"], {
  cwd: root,
  detached: true,
  stdio: "ignore",
}).unref();

// ---------------------------------------------------------------------------
console.log("[5/5] Menunggu server siap");
let healthy = false;
for (let attempt = 1; attempt <= 60; attempt++) {
  await sleep(1000);
  try {
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      healthy = true;
      break;
    }
  } catch {
    // belum siap
  }
}

const after = listProcesses();
const servers = after.filter((proc) => killPriority(proc) === 0);
const listenersAfter = listenerPids();

if (!healthy) {
  console.log(`      GAGAL: healthz tidak merespons setelah 60 detik`);
  process.exit(1);
}
console.log(`      healthz OK`);

if (servers.length !== 1 || listenersAfter.get(SERVER_PORT) !== servers[0].ProcessId) {
  console.log(`      GAGAL: diharapkan tepat 1 server, ditemukan ${servers.length}`);
  for (const proc of servers) console.log(`        ${proc.ProcessId} ${proc.Name}`);
  process.exit(1);
}
console.log(`      server tunggal: pid ${servers[0].ProcessId} memegang port ${SERVER_PORT}`);
console.log(`      port ${PG_PORT}: pid ${listenersAfter.get(PG_PORT) ?? "tidak ada"}`);

console.log("\nSELESAI. Satu instance berjalan.");
