// tests/smoke.mjs - uji asap worker terhadap salinan data (tanpa menyentuh live)
// Pakai:  npm test   (otomatis memakai backups/pre-deploy-*.sql terbaru)  atau  node --experimental-sqlite tests/smoke.mjs <backup.sql> [src/worker.js]
// Memeriksa: login manajer terbaca, Services Quota terisi, dan negatif-kontrol (tanpa variabel manajer = gagal).
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let sqlFile = process.argv[2];
const workerFile = process.argv[3] || "src/worker.js";
if (!sqlFile && fs.existsSync("backups")) {   // otomatis: backup pre-deploy terbaru
  const l = fs.readdirSync("backups").filter((f) => /^pre-deploy-.*\.sql$/.test(f)).sort();
  if (l.length) sqlFile = path.join("backups", l[l.length - 1]);
}
if (!sqlFile || !fs.existsSync(sqlFile)) { console.error("Pakai: node --experimental-sqlite tests/smoke.mjs <backup.sql> [src/worker.js]"); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
const base = path.join(tmp, "base.db");
const seed = new DatabaseSync(base);
seed.exec(fs.readFileSync(sqlFile, "utf8"));
seed.close();

const b64u = (b) => Buffer.from(b).toString("base64url");
function dbShim(file) {
  const sq = new DatabaseSync(file);
  return { sq, db: {
    prepare(sql) { let a = []; const o = {
      bind(...x) { a = x; return o; },
      async first() { return sq.prepare(sql).get(...a) || null; },
      async all() { return { results: sq.prepare(sql).all(...a) }; },
      async run() { const r = sq.prepare(sql).run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; },
    async batch(st) { const out = []; for (const s of st) out.push(await s.run()); return out; } } };
}
async function loadWorker() {
  const src = fs.readFileSync(workerFile, "utf8").replace(/import HTML_TEMPLATE from "[^"]+";/, 'const HTML_TEMPLATE="<html></html>";');
  const f = path.join(tmp, "w" + Math.random().toString(36).slice(2) + ".mjs");
  fs.writeFileSync(f, src);
  return (await import(f)).default;
}
const VARS = { ALLOWED_DOMAIN: "berca.co.id", MASTER_EMAILS: "indra.malau@berca.co.id", GOOGLE_CLIENT_ID: "x.apps.googleusercontent.com", REQUEST_PRESALES_MANAGER: "indra.malau@berca.co.id", NOTIFY_KEY: "k", ADMIN_PASSWORD: "p" };

async function scenario(name, vars) {
  const file = path.join(tmp, name + ".db"); fs.copyFileSync(base, file);
  const { sq, db } = dbShim(file); const w = await loadWorker(); const env = { DB: db, ...vars };
  await w.fetch(new Request("http://x/health"), env);
  const sec = sq.prepare("select v from settings where k='session_secret'").get();
  const body = b64u(JSON.stringify({ e: "user:indra.malau@berca.co.id", x: Date.now() + 36e5 }));
  const sig = b64u(crypto.createHmac("sha256", Buffer.from(sec.v, "base64url")).update(body).digest());
  const H = { headers: { cookie: "inv_session=" + body + "." + sig } };
  const me = await (await w.fetch(new Request("http://x/auth/me", H), env)).json();
  const q = await w.fetch(new Request("http://x/api/servicesQuotations", H), env);
  const qj = await q.json().catch(() => ({}));
  const rows = (qj.result && qj.result.rows || []).length;
  const home = await w.fetch(new Request("http://x/"), env);
  return { me, rows, qStatus: q.status, homeStatus: home.status };
}

let fail = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };
const a = await scenario("normal", VARS);
ok(a.me.master === true && a.me.presales === true, "Login master/presales terbaca");
ok(a.me.quotationManager === true, "Presales Manager dikenali (quotationManager)");
ok(a.qStatus === 200 && a.rows > 0, "Services Quota terisi (" + a.rows + " baris)");
ok(a.homeStatus === 200, "Halaman utama menjawab 200");
const b = await scenario("novar", { ...VARS, REQUEST_PRESALES_MANAGER: undefined });
ok(b.me.quotationManager === false && b.rows === 0, "Kontrol negatif: tanpa REQUEST_PRESALES_MANAGER, Services Quota kosong (perilaku yang dilindungi guard CI)");
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? "\nGAGAL: " + fail + " pemeriksaan" : "\nSemua pemeriksaan lolos");
process.exit(fail ? 1 : 0);
