// Inventaris Aset Customer — Cloudflare Worker + D1
// Binding D1: DB. Secret: ADMIN_PASSWORD (wrangler secret put ADMIN_PASSWORD)
// Akses: siapa pun bisa MELIHAT tanpa login; tambah/ubah/hapus hanya untuk admin (password).
import HTML_TEMPLATE from "./index.html";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdBy TEXT NOT NULL DEFAULT '', code TEXT DEFAULT '', pic TEXT DEFAULT '', note TEXT DEFAULT '', updatedAt TEXT DEFAULT '', updatedBy TEXT DEFAULT '')",
  "CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, customerId TEXT NOT NULL, sn TEXT NOT NULL, type TEXT DEFAULT '', brand TEXT DEFAULT '', model TEXT DEFAULT '', note TEXT DEFAULT '', location TEXT DEFAULT '', warranty TEXT DEFAULT '', eosl TEXT DEFAULT '', updatedAt TEXT DEFAULT '', updatedBy TEXT DEFAULT '')",
  "CREATE INDEX IF NOT EXISTS idx_devices_customer ON devices(customerId)",
  "CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, until INTEGER NOT NULL DEFAULT 0)"
];
const DEV_COLS = ["id","customerId","sn","type","brand","model","note","location","warranty","eosl","updatedAt","updatedBy"];
let schemaReady = false;

class UserError extends Error {}
const clean = v => String(v === undefined || v === null ? "" : v).trim();
const cleanDate = v => { v = clean(v); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new UserError("Date format must be yyyy-mm-dd: " + v); return v; };
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const maskEmails = v => String(v || "").replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1***@$2");
const SN_MASK = "**********";
const uuid = () => crypto.randomUUID();
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map(s => db.prepare(s)));
  const customerColumns = await db.prepare("PRAGMA table_info(customers)").all();
  if (!customerColumns.results.some(column => column.name === "createdBy")) {
    try { await db.prepare("ALTER TABLE customers ADD COLUMN createdBy TEXT NOT NULL DEFAULT ''").run(); }
    catch (e) {
      const columns = await db.prepare("PRAGMA table_info(customers)").all();
      if (!columns.results.some(column => column.name === "createdBy")) throw e;
    }
  }
  try { await db.prepare("ALTER TABLE customers ADD COLUMN presales TEXT DEFAULT ''").run(); } catch (e) { /* kolom sudah ada */ }
  try { await db.prepare("ALTER TABLE devices ADD COLUMN muteWarranty TEXT DEFAULT ''").run(); } catch (e) { /* kolom sudah ada */ }
  try { await db.prepare("ALTER TABLE devices ADD COLUMN renewalStatus TEXT DEFAULT ''").run(); } catch (e) { /* kolom sudah ada */ }
  try { await db.prepare("ALTER TABLE devices ADD COLUMN renewalOwner TEXT DEFAULT ''").run(); } catch (e) { /* kolom sudah ada */ }
  try { await db.prepare("ALTER TABLE devices ADD COLUMN dismantled TEXT DEFAULT ''").run(); } catch (e) { /* kolom sudah ada */ }
  await db.prepare("CREATE TABLE IF NOT EXISTS site_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, sort INTEGER DEFAULT 0, data TEXT NOT NULL, updatedAt TEXT DEFAULT '', updatedBy TEXT DEFAULT '')").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS customer_admins (email TEXT NOT NULL, customerId TEXT NOT NULL, addedBy TEXT DEFAULT '', addedAt TEXT DEFAULT '', PRIMARY KEY (email, customerId))").run();
  schemaReady = true;
}

function normDevice(rec, who) {
  const d = {
    id: clean(rec.id) || uuid(), customerId: clean(rec.customerId), sn: clean(rec.sn), type: clean(rec.type), brand: clean(rec.brand),
    model: clean(rec.model), note: clean(rec.note), location: clean(rec.location),
    warranty: cleanDate(rec.warranty), eosl: cleanDate(rec.eosl), updatedAt: new Date().toISOString(), updatedBy: who
  };
  if (!d.customerId) throw new UserError("No customer selected.");
  if (!d.sn || !d.type || !d.brand) throw new UserError("Serial Number, Device Type, and Brand are required.");
  return d;
}
const upsertDevice = (db, d) => db.prepare(
  "INSERT INTO devices (" + DEV_COLS.join(",") + ") VALUES (" + DEV_COLS.map(() => "?").join(",") + ") " +
  "ON CONFLICT(id) DO UPDATE SET " + DEV_COLS.slice(1).map(c => c + "=excluded." + c).join(",")
).bind(...DEV_COLS.map(c => d[c]));

// Data awal (Indonesia Power, 79 perangkat) — otomatis diisi saat database masih kosong
const SEED_CUSTOMERS = [["indonesia-power","Indonesia Power","IP","","","2026-10-30T06:00:00Z"]];
const SEED_DEV_COLS = ["id","customerId","sn","type","brand","model","note","location","warranty","eosl","updatedAt"];
const SEED_DEVICES = [["1I02130C19","indonesia-power","1I02130C19","Network Switch","HPE","SN2410bM 24SFP+ 4QSFP28 P2C Swch","SW COHE 2","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["1Y7NYX3","indonesia-power","1Y7NYX3","Server","Dell","PowerEdge R750","Nibiru 1","DC-Gandul","2027-07-12","","2026-10-30T02:00:00Z"],["2S6845B100","indonesia-power","2S6845B100","Storage","HPE","MSA 2050","","Kantor Pusat","","","2026-10-30T05:42:08.860Z"],["2Y7NYX3","indonesia-power","2Y7NYX3","Server","Dell","PowerEdge R750","Nibiru 2","DC-Gandul","2027-07-12","","2026-10-30T02:00:00Z"],["3TF11801JD","indonesia-power","3TF11801JD","Network Switch","HPE","SN2010M 18SFP28 4QSFP28 P2C Swch","SW DHCI 1","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["3TF119004J","indonesia-power","3TF119004J","Network Switch","HPE","SN2010M 18SFP28 4QSFP28 P2C Swch","SW DHCI 2","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["3Y7NYX3","indonesia-power","3Y7NYX3","Server","Dell","PowerEdge R750","Nibiru 3","DC-Gandul","2027-07-12","","2026-10-30T02:00:00Z"],["411378","indonesia-power","411378","Storage","Hitachi Vantara","VSP G600","Storage DEV","DC-Gandul","","","2026-10-30T00:00:00Z"],["490568","indonesia-power","490568","Storage","Hitachi Vantara","VSP G350","DRC Batam","DRC-Batam","","","2026-10-30T01:00:00Z"],["5Q4BL94","indonesia-power","5Q4BL94","Server","Dell","PowerEdge R760","azura4","DC-Gandul","2030-07-20","","2026-10-30T00:00:00Z"],["5UM133006T","indonesia-power","5UM133006T","Storage","HPE","NS dHCI AF40 AF DC 2p CTO Base Array","DC Gandul · NMB SN AF-234120","DC-Gandul","2024-09-03","","2026-10-30T01:00:00Z"],["5UMHN000H0","indonesia-power","5UMHN000H0","Storage","HPE","NS AF All Flash AFS3 CTO Exp Shelf","DC Gandul · NMB SN AF-246190","DC-Gandul","2027-02-01","","2026-10-30T02:00:00Z"],["611725","indonesia-power","611725","Storage","Hitachi Vantara","VSP E590","DC Gandul","DC-Gandul","","","2026-10-30T01:00:00Z"],["613126","indonesia-power","613126","Storage","Hitachi Vantara","VSP E590","DRC Batam","DRC-Batam","","","2026-10-30T05:41:45.868Z"],["8Q4BL94","indonesia-power","8Q4BL94","Server","Dell","PowerEdge R760","azura3","DC-Gandul","2030-07-20","","2026-10-30T00:00:00Z"],["92213550","indonesia-power","92213550","Storage","Hitachi Vantara","HUS130","Storage DEV","DC-Gandul","","","2026-10-30T00:00:00Z"],["93MC874","indonesia-power","93MC874","Server","Dell","PowerEdge R760","anubis11","DRC-Batam","2028-02-27","","2026-10-30T00:00:00Z"],["9WTMF14","indonesia-power","9WTMF14","Server","Dell","PowerEdge R750","VBR","DC-Gandul","2027-03-07","","2026-10-30T01:00:00Z"],["9XX7R44","indonesia-power","9XX7R44","Server","Dell","PowerEdge R760","Skypiea 1","DC-Gandul","2027-10-18","","2026-10-30T01:00:00Z"],["ACA20201BF","indonesia-power","ACA20201BF","Network Switch","HPE","SN2410bM 24SFP+ 4QSFP28 P2C Swch","SW COHE 1","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["BP4BL94","indonesia-power","BP4BL94","Server","Dell","PowerEdge R760","azura1","DC-Gandul","2030-07-20","","2026-10-30T00:00:00Z"],["BXX7R44","indonesia-power","BXX7R44","Server","Dell","PowerEdge R760","Skypiea 2","DC-Gandul","2027-10-18","","2026-10-30T01:00:00Z"],["CN1AGMW2GT","indonesia-power","CN1AGMW2GT","Network Switch","HPE","Office Connect","Switch Management DRC","DRC-Batam","2025-01-27","","2026-10-30T00:00:00Z"],["CN2BKFT00J","indonesia-power","CN2BKFT00J","Network Switch","HPE","5710 48XGT 6QS+/2QS28 Switch","Switch Storage HDS","DRC-Batam","","","2026-10-30T05:41:31.804Z"],["CN2BKFT00P","indonesia-power","CN2BKFT00P","Network Switch","HPE","5710 48XGT 6QS+/2QS28 Switch","Switch Storage HDS","DRC-Batam","","","2026-10-30T05:42:03.123Z"],["CN762508HW","indonesia-power","CN762508HW","Server","HPE","ProLiant DL380 Gen9","testho3.indonesiapower","Kantor Pusat","2025-03-31","","2026-10-30T00:00:00Z"],["CXX7R44","indonesia-power","CXX7R44","Server","Dell","PowerEdge R750","Nibiru 5","DC-Gandul","2027-10-18","","2026-10-30T01:00:00Z"],["CZC002WS8V","indonesia-power","CZC002WS8V","SAN Switch","HPE","SN3600B 32Gb 24/8 FC Switch","SAN SW STR BACKUP 1","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["CZC002WSDM","indonesia-power","CZC002WSDM","SAN Switch","HPE","SN3600B 32Gb 24/8 FC Switch","SAN SW STR BACKUP 2","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["DEC31007YL","indonesia-power","DEC31007YL","Tape Library","HPE","StoreEver MSL2024","Tape Library","DC-Gandul","2027-06-14","","2026-10-30T02:00:00Z"],["HTVJL94","indonesia-power","HTVJL94","Storage","Dell","PowerStore 1200T","Storage Production","DC-Gandul","2030-07-20","","2026-10-30T00:00:00Z"],["ILC2330517","indonesia-power","ILC2330517","Network Switch","HPE","SN2410M 24SFP28 4QSFP28 P2C Swch","Switch Cluster DELL 1","DC-Gandul","2027-03-12","","2026-10-30T02:00:00Z"],["ILC233051G","indonesia-power","ILC233051G","Network Switch","HPE","SN2410M 24SFP28 4QSFP28 P2C Swch","Switch Cluster DELL 2","DC-Gandul","2027-03-12","","2026-10-30T02:00:00Z"],["J71Y6Y3","indonesia-power","J71Y6Y3","Storage","Dell","Unity XT480","DC Gandul","DC-Gandul","2027-07-12","","2026-10-30T02:00:00Z"],["JP4BL94","indonesia-power","JP4BL94","Server","Dell","PowerEdge R760","azura2","DC-Gandul","2030-07-20","","2026-10-30T00:00:00Z"],["JX7NYX3","indonesia-power","JX7NYX3","Server","Dell","PowerEdge R750","Nibiru 4","DC-Gandul","2027-07-12","","2026-10-30T02:00:00Z"],["Q23AI12882","indonesia-power","Q23AI12882","Storage","QNAP","TVS-872XT-i5-16G","Storage CCTV","Kantor Pusat","2028-06-08","","2026-10-30T00:00:00Z"],["SG22KRT01V","indonesia-power","SG22KRT01V","Network Switch","HPE","Aruba 8360-48XT","TOR Switch DRC","DRC-Batam","2047-08-04","","2026-10-30T00:00:00Z"],["SG22KRT023","indonesia-power","SG22KRT023","Network Switch","HPE","Aruba 8360-48XT","TOR Switch DRC","DRC-Batam","2047-08-04","","2026-10-30T00:00:00Z"],["SGH039WDS1","indonesia-power","SGH039WDS1","HCI Node","HPE","SimpliVity 380 Gen10 Node","Target Airgap","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["SGH121SN0B","indonesia-power","SGH121SN0B","Server","HPE","DL180 Gen10","Server HLR VEEAM","DC-Gandul","2024-07-02","","2026-10-30T00:00:00Z"],["SGH131YLRV","indonesia-power","SGH131YLRV","Server","HPE","DL380 Gen10 8SFF NC CTO Svr","ESXHO 1","Kantor Pusat","2027-03-31","","2026-10-30T02:00:00Z"],["SGH131YLTS","indonesia-power","SGH131YLTS","Server","HPE","DL380 Gen10 8SFF NC CTO Svr","Odin 2 GPU","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["SGH131YLY8","indonesia-power","SGH131YLY8","Server","HPE","DL360 Gen10 8SFF NC CTO Svr","Odin 3","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["SGH131YLYB","indonesia-power","SGH131YLYB","Server","HPE","DL360 Gen10 8SFF NC CTO Svr","Odin 1","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["SGH201YK4S","indonesia-power","SGH201YK4S","Server","HPE","ProLiant DL360 Gen10","anubis3","DRC-Batam","2025-07-20","","2026-10-30T00:00:00Z"],["SGH201YK51","indonesia-power","SGH201YK51","Server","HPE","ProLiant DL360 Gen10","anubis4","DRC-Batam","2028-07-20","","2026-10-30T00:00:00Z"],["SGH201YK55","indonesia-power","SGH201YK55","Server","HPE","ProLiant DL360 Gen10","anubis2","DRC-Batam","2028-07-20","","2026-10-30T00:00:00Z"],["SGH201YK59","indonesia-power","SGH201YK59","Server","HPE","ProLiant DL360 Gen10","anubis7","DRC-Batam","2025-07-20","","2026-10-30T00:00:00Z"],["SGH201YK5T","indonesia-power","SGH201YK5T","Server","HPE","ProLiant DL360 Gen10","anubis1","DRC-Batam","2025-07-20","","2026-10-30T00:00:00Z"],["SGH218WC4T","indonesia-power","SGH218WC4T","Server","HPE","DL360 Gen10 8SFF NC CTO Svr","Odin 4","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["SGH220SGNB","indonesia-power","SGH220SGNB","Server","HPE","DL380 Gen10 8SFF NC CTO Svr","ESXHO 2","Kantor Pusat","2027-03-31","","2026-10-30T02:00:00Z"],["SGH238T9XK","indonesia-power","SGH238T9XK","Backup Appliance","HPE","ProLiant DL380 Gen10 48TB Server for Cohesity DataPlatform","Repo DRC Node 1","DRC-Batam","2027-03-31","","2026-10-30T02:00:00Z"],["SGH238T9XW","indonesia-power","SGH238T9XW","Backup Appliance","HPE","DL380 G10 48TB CTO Svr for Cohesity","Repo DC Node 2","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["SGH238T9Y4","indonesia-power","SGH238T9Y4","Backup Appliance","HPE","ProLiant DL380 Gen10 48TB Server for Cohesity DataPlatform","Repo DRC Node 2","DRC-Batam","2027-03-31","","2026-10-30T02:00:00Z"],["SGH238T9YT","indonesia-power","SGH238T9YT","Backup Appliance","HPE","DL380 G10 48TB CTO Svr for Cohesity","Repo DC Node 3","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["SGH238T9YV","indonesia-power","SGH238T9YV","Backup Appliance","HPE","ProLiant DL380 Gen10 48TB Server for Cohesity DataPlatform","Repo DRC Node 3","DRC-Batam","2027-03-31","","2026-10-30T02:00:00Z"],["SGH238T9ZN","indonesia-power","SGH238T9ZN","Backup Appliance","HPE","DL380 G10 48TB CTO Svr for Cohesity","Repo DC Node 1","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["SGH238TBF6","indonesia-power","SGH238TBF6","Backup Appliance","HPE","DL380 G10 48TB CTO Svr for Cohesity","Obj DR Node 2","DRC-Batam","2027-03-31","","2026-10-30T02:00:00Z"],["SGH238TBFM","indonesia-power","SGH238TBFM","Backup Appliance","HPE","DL380 G10 48TB CTO Svr for Cohesity","Obj DR Node 4","DRC-Batam","2027-03-31","","2026-10-30T02:00:00Z"],["SGH238TBG1","indonesia-power","SGH238TBG1","Backup Appliance","HPE","DL380 G10 48TB CTO Svr for Cohesity","Obj DR Node 5","DRC-Batam","2027-03-31","","2026-10-30T02:00:00Z"],["SGH238TBGG","indonesia-power","SGH238TBGG","Backup Appliance","HPE","DL380 G10 48TB CTO Svr for Cohesity","Obj DR Node 3","DRC-Batam","2027-03-31","","2026-10-30T02:00:00Z"],["SGH238TBGW","indonesia-power","SGH238TBGW","Backup Appliance","HPE","DL380 G10 48TB CTO Svr for Cohesity","Obj DR Node 1","DRC-Batam","2027-03-31","","2026-10-30T02:00:00Z"],["SGH308XXLQ","indonesia-power","SGH308XXLQ","Backup Appliance","HPE","DL380 G10 48TB CTO Svr for Cohesity","Repo DC Node 4","DC-Gandul","","","2026-10-30T05:41:54.660Z"],["SGH308XXQV","indonesia-power","SGH308XXQV","Backup Appliance","HPE","DL380 G10 48TB CTO Svr for Cohesity","Repo DRC Node 4 · cek: di file warranty tertulis Repo DC Node 4","DC-Gandul","2027-03-07","","2026-10-30T02:00:00Z"],["SGH319TS3Y","indonesia-power","SGH319TS3Y","Server","HPE","Proliant DL360 Gen10+","Qstar","DC-Gandul","2027-06-16","","2026-10-30T02:00:00Z"],["SGH413HMGB","indonesia-power","SGH413HMGB","Backup Appliance","HPE","ProLiant DL380 Gen10+ 48TB Server for Cohesity","Repo DC Node 5","DC-Gandul","2028-08-28","","2026-10-30T00:00:00Z"],["SGH806T6HS","indonesia-power","SGH806T6HS","HCI Node","HPE","SimpliVity 380 Gen10 Node","Balder 2","DC-Gandul","2025-03-31","","2026-10-30T01:00:00Z"],["SGH806T6HV","indonesia-power","SGH806T6HV","HCI Node","HPE","SimpliVity 380 Gen10 Node","Balder 1","DC-Gandul","2025-03-31","","2026-10-30T01:00:00Z"],["SGH806TML1","indonesia-power","SGH806TML1","HCI Node","HPE","SimpliVity 380 Gen10 Node","Balder 3 · cek SN: di file warranty tertulis SGH826TML1","DC-Gandul","2025-03-31","","2026-10-30T01:00:00Z"],["SGH806TML3","indonesia-power","SGH806TML3","HCI Node","HPE","SimpliVity 380 Gen10 Node","Balder 4 · cek SN: di file warranty tertulis SGH826TML3","DC-Gandul","2025-03-31","","2026-10-30T01:00:00Z"],["SGH909V743","indonesia-power","SGH909V743","HCI Node","HPE","SimpliVity 380 Gen10 Node","Dimirio 2","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["SGH909V745","indonesia-power","SGH909V745","HCI Node","HPE","SimpliVity 380 Gen10 Node","Dimirio 3","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["SGH941V741","indonesia-power","SGH941V741","HCI Node","HPE","SimpliVity 380 Gen10 Node","Balder 6 · cek SN: di file warranty tertulis SGH909V741","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["SGH941V747","indonesia-power","SGH941V747","HCI Node","HPE","SimpliVity 380 Gen10 Node","Balder 5 · cek SN: di file warranty tertulis SGH909V747","DC-Gandul","2025-03-31","","2026-10-30T01:00:00Z"],["SGH941VTCP","indonesia-power","SGH941VTCP","HCI Node","HPE","SimpliVity 380 Gen10 Node","Dimirio 6","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["SGH941VTCR","indonesia-power","SGH941VTCR","HCI Node","HPE","SimpliVity 380 Gen10 Node","Dimirio 5","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["SGH941VTCT","indonesia-power","SGH941VTCT","HCI Node","HPE","SimpliVity 380 Gen10 Node","Dimirio 1","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"],["SGH941VTCW","indonesia-power","SGH941VTCW","HCI Node","HPE","SimpliVity 380 Gen10 Node","Dimirio 4","DC-Gandul","2027-03-31","","2026-10-30T02:00:00Z"]];
async function seedIfEmpty(db) {
  const c = await db.prepare("SELECT (SELECT COUNT(*) FROM customers) + (SELECT COUNT(*) FROM devices) AS n").first();
  if (c && c.n) return;
  const st = SEED_CUSTOMERS.map(r => db.prepare("INSERT OR IGNORE INTO customers (id,name,code,pic,note,updatedAt,updatedBy) VALUES (?,?,?,?,?,?,'seed')").bind(...r));
  for (const r of SEED_DEVICES) st.push(db.prepare("INSERT OR IGNORE INTO devices (" + SEED_DEV_COLS.join(",") + ",updatedBy) VALUES (" + SEED_DEV_COLS.map(() => "?").join(",") + ",'seed')").bind(...r));
  for (let i = 0; i < st.length; i += 50) await db.batch(st.slice(i, i + 50));
}

// Customer BAYAN (BYAN) — 22 server HPE; ditambahkan otomatis satu kali saat deploy
const SEED_BAYAN_DEVICES = [["SGH123TS8P","bayan","SGH123TS8P","Server","HPE","ProLiant DL380 Gen10","bct-esx-01","SITE-BCT","2024-07-08","","2026-11-02T02:00:00Z"],["SGH123TS8N","bayan","SGH123TS8N","Server","HPE","ProLiant DL380 Gen10","bct-esx-02","SITE-BCT","2024-07-08","","2026-11-02T02:00:00Z"],["SGH015YPG9","bayan","SGH015YPG9","Server","HPE","ProLiant DL380 Gen10","bpn-esx01","HQ-BPN","2023-07-13","","2026-11-02T02:00:00Z"],["SGH015YPGC","bayan","SGH015YPGC","Server","HPE","ProLiant DL380 Gen10","bpn-esx02","HQ-BPN","2023-07-13","","2026-11-02T02:00:00Z"],["SGH533W45R","bayan","SGH533W45R","Server","HPE","ProLiant DL160 Gen9","gb2-esx-01","SITE-GB2","2020-01-09","","2026-11-02T02:00:00Z"],["SGH701TLK4","bayan","SGH701TLK4","Server","HPE","ProLiant DL160 Gen9","gb2-esx-02","SITE-GB2","2020-01-09","","2026-11-02T02:00:00Z"],["SGH827V0SJ","bayan","SGH827V0SJ","Server","HPE","ProLiant DL380 Gen10","jkt-esx-01","DC- JKT","2021-10-08","","2026-11-02T02:00:00Z"],["SGH828VRC5","bayan","SGH828VRC5","Server","HPE","ProLiant DL380 Gen10","jkt-esx-02","DC- JKT","2021-10-08","","2026-11-02T02:00:00Z"],["SGH827V0SR","bayan","SGH827V0SR","Server","HPE","ProLiant DL380 Gen10","jkt-esx-03","DC- JKT","2021-10-08","","2026-11-02T02:00:00Z"],["SGH827V0SM","bayan","SGH827V0SM","Server","HPE","ProLiant DL380 Gen10","jkt-esx-04","DC- JKT","2021-10-08","","2026-11-02T02:00:00Z"],["SGH238V4FQ","bayan","SGH238V4FQ","Server","HPE","ProLiant DL380 Gen10 Plus","jkt-esx-05","DC - JKT 2","2025-11-01","","2026-11-02T02:00:00Z"],["SGH238V4FH","bayan","SGH238V4FH","Server","HPE","ProLiant DL380 Gen10 Plus","jkt-esx-06","DC - JKT 2","2025-11-01","","2026-11-02T02:00:00Z"],["SGH015YPGL","bayan","SGH015YPGL","Server","HPE","ProLiant DL380 Gen10","mp-esx-01","SITE-MP","2023-07-13","","2026-11-02T02:00:00Z"],["SGH015YPGM","bayan","SGH015YPGM","Server","HPE","ProLiant DL380 Gen10","mp-esx-02","SITE-MP","2023-07-13","","2026-11-02T02:00:00Z"],["SGH827V0SN","bayan","SGH827V0SN","Server","HPE","ProLiant DL380 Gen10","pik-esx-01","SITE-PIK","2021-10-08","","2026-11-02T02:00:00Z"],["SGH827V0SH","bayan","SGH827V0SH","Server","HPE","ProLiant DL380 Gen10","pik-esx-02","SITE-PIK","2021-10-08","","2026-11-02T02:00:00Z"],["SGH427M6YY","bayan","SGH427M6YY","Server","HPE","ProLiant DL380 Gen11","tbg-esx-01","TBG-CLUSTER-01","2027-08-15","","2026-11-02T02:00:00Z"],["SGH427M6ZR","bayan","SGH427M6ZR","Server","HPE","ProLiant DL380 Gen11","tbg-esx-02","TBG-CLUSTER-01","2027-08-15","","2026-11-02T02:00:00Z"],["SGH827V0SK","bayan","SGH827V0SK","Server","HPE","ProLiant DL380 Gen10","tsa-esx-01","SITE-TSA","2021-10-08","","2026-11-02T02:00:00Z"],["SGH827V0SL","bayan","SGH827V0SL","Server","HPE","ProLiant DL380 Gen10","tsa-esx-02","SITE-TSA","2021-10-08","","2026-11-02T02:00:00Z"],["SGH827V0SP","bayan","SGH827V0SP","Server","HPE","ProLiant DL380 Gen10","wbm-esx-01","SITE-WBM","2021-10-08","","2026-11-02T02:00:00Z"],["SGH827V0SF","bayan","SGH827V0SF","Server","HPE","ProLiant DL380 Gen10","wbm-esx-02","SITE-WBM","2021-10-08","","2026-11-02T02:00:00Z"]];
async function seedBayanIfNeeded(db) {
  if (await db.prepare("SELECT 1 FROM settings WHERE k='seed_bayan_v1'").first()) return;
  const st = [db.prepare("INSERT OR IGNORE INTO customers (id,name,code,pic,note,updatedAt,updatedBy) VALUES ('bayan','BAYAN','BYAN','','','2026-11-02T02:00:00Z','seed')")];
  for (const r of SEED_BAYAN_DEVICES) st.push(db.prepare("INSERT OR IGNORE INTO devices (" + SEED_DEV_COLS.join(",") + ",updatedBy) VALUES (" + SEED_DEV_COLS.map(() => "?").join(",") + ",'seed')").bind(...r));
  st.push(db.prepare("INSERT OR IGNORE INTO settings (k,v) VALUES ('seed_bayan_v1','1')"));
  for (let i = 0; i < st.length; i += 50) await db.batch(st.slice(i, i + 50));
}

// ---------- Konten portal (Beranda, Layanan, Tim, Reports, Kontak) ----------
const SITE_DEFAULT_EN = {
  tagline: "From Assessment to Architecture \u2014 We Build IT Right",
  heroTitle: "IT Solutions for Energy & Resources",
  heroDesc: "Presales solution architects for Oil & Gas, Mining, Coal and Power \u2014 from assessment and sizing to architecture design, proposals and RFP support.",
  servicesIntro: "End-to-end presales support for enterprise infrastructure: compute, storage, virtualization, data protection, HCI, network and hybrid cloud.",
  contactTitle: "Get In Touch",
  contactDesc: "Ready to transform your IT infrastructure? Let's discuss how our team can help architect the right solution for your business needs.",
  contactEmail: "tss.solution-architect-eri@berca.co.id",
  technologies: "VMware, Red Hat OpenShift, Microsoft Hyper-V, Dell Technologies, HPE, Lenovo, NetApp, Hitachi Vantara, Huawei, Cohesity, Veeam, Quantum, Cisco, Juniper, NVIDIA",
  footer: "TSS SA ERI \u2014 Let\u2019s Achieve Success Together."
};
const SEED_ITEMS = [
  ["service", "Solution Design & Architecture", "We design IT solution architectures that are efficient, scalable, and aligned with customer business needs. From compute, storage, and virtualization to data protection \u2014 every solution is built with performance, reliability, and cost efficiency in mind."],
  ["service", "Technical Assessment & Requirement Analysis", "We conduct comprehensive assessments of existing infrastructures to understand capacity requirements, workloads, and operational challenges. The results form the foundation for determining the most relevant and effective solutions."],
  ["service", "Sizing & Capacity Planning", "We perform capacity and performance calculations to ensure the proposed solution fits the customer's workload and supports future growth, balancing performance, scalability, and investment efficiency."],
  ["service", "Proposal & Technical Documentation", "We prepare detailed technical documents such as proposals, High-Level Designs (HLD), and Low-Level Designs (LLD) that serve as implementation blueprints for customers and delivery teams."],
  ["service", "Vendor & Solution Comparison", "We help customers select the most suitable solution from multiple vendors through detailed comparisons of features, performance, and costs \u2014 so every decision is data-driven."],
  ["service", "RFP / RFQ Technical Support", "We support the sales and tender teams in preparing technical responses for RFPs and RFQs, ensuring every proposal meets customer specifications."]
];
const SEED_TEAM = [
  ["Indra Malau", "Presales Solution Architect", "", "indra.malau@berca.co.id"],
  ["Sabiq Hammam", "Presales Solution Engineer", "Sulawesi Region", "sabiq.hammam@berca.co.id"],
  ["Dendy Aryga", "Presales Solution Engineer", "Kalimantan Region", "dendy.aryga@berca.co.id"],
  ["Tasya Putri", "Presales Solution Architect", "", "tasya.kamila@berca.co.id"],
  ["Eric Eric", "Presales Solution Architect", "", "eric.eric@berca.co.id"],
  ["Michael Valentino", "Presales Solution Architect", "", "michael.valentino@berca.co.id"],
  ["Fransiska Setyawan", "Presales Solution Architect", "", "fransiska.setyawan@berca.co.id"]
];
const SEED_SALES = [
  ["Joddy Himawan", "joddy.himawan@berca.co.id", "ERI 1", "Herry Priasmoro", "ERI 1 A", "Eveline Yulian", "Michael Valentino, Tasya Kamila, Indra Malau"],
  ["Felizio Kostka", "felizio.kostka@berca.co.id", "ERI 1", "Herry Priasmoro", "ERI 1 A", "Eveline Yulian", "Eric Eric, Michael Valentino"],
  ["Natalia Desy Dwi Cahyani", "natalia.cahyani@berca.co.id", "ERI 1", "Herry Priasmoro", "ERI 1 A", "Eveline Yulian", "Tasya Kamila, Fransiska Setyawan"],
  ["Putri Regita Pricilia", "putri.pricilia@berca.co.id", "ERI 1", "Herry Priasmoro", "ERI 1 A", "Eveline Yulian", "Fransiska Setyawan, Eric Eric"],
  ["Felicia Handojono", "felicia.handojono@berca.co.id", "ERI 1", "Herry Priasmoro", "ERI 1 A", "Eveline Yulian", "Fransiska Setyawan, Eric Eric"],
  ["Fitri Mardhiyah", "fitri.mardhiyah@berca.co.id", "ERI 1", "Herry Priasmoro", "ERI 1 B", "Exsan Bukhori", "Eric Eric, Michael Valentino"],
  ["Daffa Adlianto Yuwono", "daffa.yuwono@berca.co.id", "ERI 1", "Herry Priasmoro", "ERI 1 B", "Exsan Bukhori", "Michael Valentino, Tasya Kamila"],
  ["Chynthia Ludya Soen", "chynthia.soen@berca.co.id", "ERI 1", "Herry Priasmoro", "ERI 1 C - BPN", "Novita Supriyanto", "Dendy Ariga"],
  ["Ahmad Ahimsyah Halil", "ahmad.halil@berca.co.id", "ERI 1", "Herry Priasmoro", "ERI 1 C - BPN", "Novita Supriyanto", "Dendy Ariga"],
  ["Farrel Simon", "farrel.simon@berca.co.id", "ERI 2", "Eros Nainggolan", "ERI 2 A", "Handijaya", "Eric Eric, Michael Valentino"],
  ["Shada Mahira Ramadhani", "shada.ramadhani@berca.co.id", "ERI 2", "Eros Nainggolan", "ERI 2 A", "Handijaya", "Tasya Kamila, Fransiska Setyawan"],
  ["Nadia Puspitasari", "nadia.puspitasari@berca.co.id", "ERI 2", "Eros Nainggolan", "ERI 2 A", "Handijaya", "Tasya Kamila, Fransiska Setyawan"],
  ["Gesya Alisa Apriany", "gesya.apriany@berca.co.id", "ERI 2", "Eros Nainggolan", "ERI 2 B", "Alwazier Bahanan", "Tasya Kamila, Fransiska Setyawan"],
  ["Agung Primananda", "agung.primananda@berca.co.id", "ERI 2", "Eros Nainggolan", "ERI 2 B", "Alwazier Bahanan", "Michael Valentino, Tasya Kamila"],
  ["RIska Islamiati", "riska.islamiati@berca.co.id", "ERI 2", "Eros Nainggolan", "ERI 2 B", "Alwazier Bahanan", "Tasya Kamila, Fransiska Setyawan"],
  ["Shinta Oktriviani", "shinta.oktriviani@berca.co.id", "ERI 3", "Elviliana", "ERI 3 A", "Arulla Ryandiza", "Eric Eric, Michael Valentino"],
  ["Gebby Veronika", "gebby.veronika@berca.co.id", "ERI 3", "Elviliana", "ERI 3 A", "Arulla Ryandiza", "Tasya Kamila, Fransiska Setyawan"],
  ["Puti Salsabila", "puti.salsabila@berca.co.id", "ERI 3", "Elviliana", "ERI 3 A", "Arulla Ryandiza", "Tasya Kamila, Fransiska Setyawan"],
  ["Edina Nurul Hafifah", "edina.hafifah@berca.co.id", "ERI 3", "Elviliana", "ERI 3 A", "Arulla Ryandiza", "Fransiska Setyawan, Eric Eric"],
  ["Fennysa", "fennysa.fennysa@berca.co.id", "ERI 3", "Elviliana", "ERI 3 B", "Maria Villya", "Eric Eric, Michael Valentino"],
  ["Ersa Mayori Raharjo", "ersa.raharjo@berca.co.id", "ERI 3", "Elviliana", "ERI 3 B", "Maria Villya", "Michael Valentino, Tasya Kamila"],
  ["Fahmi Ardiansyah", "fahmi.ardiansyah@berca.co.id", "ERI 3", "Elviliana", "ERI 3 B", "Maria Villya", "Tasya Kamila, Fransiska Setyawan"],
  ["Sophie", "sophie.evans@berca.co.id", "ERI 3", "Elviliana", "ERI 3 D MKS", "Arulla Ryandiza", "Sabiq Hammam"],
  ["Kiki Nuril", "nuril.hakikiyah@berca.co.id", "ERI 3", "Elviliana", "ERI 3 D MKS", "Arulla Ryandiza", "Sabiq Hammam"],
  ["Khalif El Hamidi", "khalif.hamidi@berca.co.id", "ERI 3", "Elviliana", "ERI 3 C PKU", "Sri Dewi Hutami", "Michael Valentino, Tasya Kamila"],
  ["Stanley Aditya", "stanley.aditya@berca.co.id", "ERI 3", "Elviliana", "ERI 3 C PKU", "Sri Dewi Hutami", "Eric Eric, Michael Valentino"]
];
const SITE_DEFAULT = { ...SITE_DEFAULT_EN };   // diganti versi Indonesia setelah SITE_ID didefinisikan
const SITE_KEYS = Object.keys(SITE_DEFAULT);
const ITEM_KINDS = { service: ["title", "desc", "sla", "inputs"], member: ["name", "role", "region", "email", "photo", "expertise", "coverage"], report: ["title", "desc", "url"], resource: ["title", "desc", "url", "category"], sales: ["name", "email", "director", "directorName", "gm", "gmName", "team", "mgr", "mgrEmail", "presales", "active"], salesContact: ["name", "type", "email"], vendor: ["brand", "product", "category", "eosl", "url", "note"], skill: ["person", "domain", "level", "cert", "certDate", "certFile", "certFileName", "note"], org: ["name", "title", "dept", "level", "photo", "you"], proposal: ["title", "customer", "sales", "presales", "productBrand", "productPics", "productPicEmails", "notifyEmails", "prebid", "submission", "rksUrl", "status", "adminDocumentsReady", "productPricingConfirmed", "proposalUploaded", "analysis", "note", "submittedAt", "archivedAt", "cancelledAt"] };
const PROPOSAL_SUBMISSION_CHECKS = [["adminDocumentsReady","Administrative documents are ready"],["productPricingConfirmed","Product pricing is confirmed"],["proposalUploaded","Proposal has been uploaded"]];
function proposalSubmissionGaps(proposal) {
  const missing = PROPOSAL_SUBMISSION_CHECKS.filter(([key]) => proposal[key] !== "1").map(([, label]) => label);
  let validDriveLink = false;
  try {
    const link = new URL(proposal.rksUrl);
    validDriveLink = link.protocol === "https:" && link.hostname === "drive.google.com" && link.pathname !== "/";
  } catch (_) {}
  if (!validDriveLink) missing.push("Add the Google Drive link for the uploaded proposal");
  return missing;
}
const PROP_STATUS = ["Prebid", "RKS diterima", "Analisis", "Draft proposal", "Review", "Submitted", "Cancelled", "Menang", "Kalah"];
// ---- Internal portal copy (professional English) for the Berca sales team ----
const SITE_ID = {
  tagline: "Presales Solution Architect \u00b7 Energy & Resources",
  heroTitle: "Presales support for the Berca sales team",
  heroDesc: "Technical assessment, sizing & BoM, solution design, technical proposals, and RFP/RFQ support for Oil & Gas, Mining, Coal, and Power.",
  servicesIntro: "End-to-end presales support for enterprise infrastructure \u2014 compute, storage, virtualization, HCI, data protection, networking, and hybrid cloud.",
  contactTitle: "Need to reach the team?",
  contactDesc: "Email the presales group, or contact the right engineer by region and expertise in the Team section below.",
  footer: "Presales ERI \u00b7 Internal \u2014 PT Berca Hardayaperkasa"
};
// Previous Indonesian copy, kept only so any already-migrated database is refreshed to English.
const OLD_ID = {
  heroTitle: "Dukungan presales untuk tim sales Berca",
  heroDesc: "Ajukan kebutuhan assessment, sizing & BoM, desain solusi, proposal teknis, RFP/RFQ hingga PoC \u2014 lalu pantau statusnya di sini.",
  servicesIntro: "Pilih layanan sesuai kebutuhan. Siapkan data pada bagian \u201cyang perlu disiapkan\u201d agar request bisa langsung dikerjakan.",
  contactTitle: "Butuh diskusi cepat?",
  contactDesc: "Kirim email ke grup tim presales, atau hubungi langsung PIC sesuai wilayah dan keahlian di bagian Tim.",
  footer: "Presales ERI \u00b7 Internal Berca"
};
const SVC_ID = {
  "svc-1": ["Solution Design & Architecture", "Architecture design across compute, storage, virtualization, HCI, backup/DR, and hybrid cloud \u2014 balanced for performance, reliability, and cost.", "Business requirements & workload list\nExisting infrastructure condition\nTarget budget & timeline"],
  "svc-2": ["Technical Assessment & Requirement Analysis", "Assessment of the existing infrastructure, workloads, and operational constraints as the basis for the recommended solution.", "Schedule & access to the customer\nInventory/utilization data (e.g. RVTools, capacity report)\nCustomer technical PIC"],
  "svc-3": ["Sizing, Capacity Planning & BoM", "Capacity and performance calculation for current needs and 3\u20135 year growth, with a complete Bill of Materials.", "Number of VMs/applications & their specs\nData capacity & annual growth\nRPO/RTO & backup retention requirements"],
  "svc-4": ["Proposal & Technical Documentation", "Technical proposals, High-Level Design (HLD), and Low-Level Design (LLD) ready to present to the customer.", "Final scope & BoM\nCustomer template/format (if any)\nSubmission deadline"],
  "svc-5": ["Vendor & Solution Comparison", "Comparison of features, performance, and cost across vendors so the customer's decision is data-driven.", "List of vendors/solutions to compare\nCustomer evaluation criteria\nBudget range"],
  "svc-6": ["RFP / RFQ Technical Support", "Technical responses, compliance matrix, and supporting documents for tenders per customer specifications.", "RFP/RFQ documents & addenda\nAanwijzing & submission schedule\nCompliance matrix (if any)"]
};
async function migrateInternal(db) {
  if (await db.prepare("SELECT 1 FROM settings WHERE k='migr_internal_v2'").first()) return;
  const auto = k => [SITE_DEFAULT_EN[k], OLD_ID[k]];
  const st = [];
  const r = await db.prepare("SELECT v FROM settings WHERE k='site'").first();
  const cur = r ? JSON.parse(r.v) : {};
  const next = { ...cur };
  for (const k of Object.keys(SITE_ID)) if (!cur[k] || auto(k).includes(cur[k])) next[k] = SITE_ID[k];
  st.push(db.prepare("INSERT INTO settings (k,v) VALUES ('site',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(next)));
  for (const [id, v] of Object.entries(SVC_ID)) st.push(db.prepare("UPDATE site_items SET data=? WHERE id=? AND updatedBy='seed'").bind(JSON.stringify({ title: v[0], desc: v[1], inputs: v[2] }), id));
  st.push(db.prepare("INSERT OR IGNORE INTO settings (k,v) VALUES ('migr_internal_v2','1')"));
  await db.batch(st);
}
async function seedSalesIfEmpty(db) {
  if (await db.prepare("SELECT 1 FROM settings WHERE k='seed_sales_v1'").first()) return;
  const now = new Date().toISOString(), st = [];
  SEED_SALES.forEach((r, i) => st.push(db.prepare("INSERT OR IGNORE INTO site_items (id,kind,sort,data,updatedAt,updatedBy) VALUES (?,?,?,?,?,'seed')")
    .bind("sl-" + (i + 1), "sales", (i + 1) * 10, JSON.stringify({ name: r[0], email: r[1], gm: r[2], gmName: r[3], team: r[4], mgr: r[5], presales: r[6], active: "1" }), now)));
  st.push(db.prepare("INSERT OR IGNORE INTO settings (k,v) VALUES ('seed_sales_v1','1')"));
  for (let i = 0; i < st.length; i += 50) await db.batch(st.slice(i, i + 50));
}
// Pindahkan Kiki Nuril & Sophie ke divisi ERI 3 D - Makassar (manager tetap Arulla Ryandiza) — jalan sekali saat deploy
async function fixEri3dIfNeeded(db) {
  if (await db.prepare("SELECT 1 FROM settings WHERE k='fix_eri3d_v1'").first()) return;
  const emails = new Set(["nuril.hakikiyah@berca.co.id", "sophie.evans@berca.co.id"]);
  const rows = (await db.prepare("SELECT id,data FROM site_items WHERE kind='sales'").all()).results;
  const st = [];
  for (const r of rows) {
    let d; try { d = JSON.parse(r.data); } catch (e) { continue; }
    if (emails.has(String(d.email || "").toLowerCase())) {
      d.team = "ERI 3 D - Makassar";
      st.push(db.prepare("UPDATE site_items SET data=? WHERE id=?").bind(JSON.stringify(d), r.id));
    }
  }
  st.push(db.prepare("INSERT OR IGNORE INTO settings (k,v) VALUES ('fix_eri3d_v1','1')"));
  for (let i = 0; i < st.length; i += 50) await db.batch(st.slice(i, i + 50));
}
// Roster resmi Sales PIC (Director > GM > Manager > Sales) — mengganti SELURUH data sales satu kali saat deploy
const SEED_ROSTER = [{"name":"Joddy Himawan","email":"joddy.himawan@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 1","gmName":"Herry Priasmoro","team":"ERI 1 A","mgr":"Eveline Yulian","presales":"Michael Valentino, Tasya Kamila, Indra Malau","active":"1"},{"name":"Felizio Kostka","email":"Felizio.Kostka@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 1","gmName":"Herry Priasmoro","team":"ERI 1 A","mgr":"Eveline Yulian","presales":"Eric Eric, Michael Valentino","active":"1"},{"name":"Fitri Mardhiyah","email":"fitri.mardhiyah@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 1","gmName":"Herry Priasmoro","team":"ERI 1 B","mgr":"Exsan Bukhori","presales":"Eric Eric, Michael Valentino","active":"1"},{"name":"Daffa Adlianto Yuwono","email":"daffa.yuwono@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 1","gmName":"Herry Priasmoro","team":"ERI 1 B","mgr":"Exsan Bukhori","presales":"Michael Valentino, Tasya Kamila","active":"1"},{"name":"Chynthia Ludya Soen","email":"chynthia.soen@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 1","gmName":"Herry Priasmoro","team":"ERI 1 C - BPN","mgr":"Novita Supriyanto","presales":"Dendy Ariga","active":"1"},{"name":"Ahmad Ahimsyah Halil","email":"ahmad.halil@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 1","gmName":"Herry Priasmoro","team":"ERI 1 C - BPN","mgr":"Novita Supriyanto","presales":"Dendy Ariga","active":"1"},{"name":"Farrel Simon","email":"farrel.simon@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 2","gmName":"Eros Nainggolan","team":"ERI 2 A","mgr":"Handijaya","presales":"Eric Eric, Michael Valentino","active":"1"},{"name":"Shada Mahira Ramadhani","email":"shada.ramadhani@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 2","gmName":"Eros Nainggolan","team":"ERI 2 A","mgr":"Handijaya","presales":"Tasya Kamila, Fransiska Setyawan","active":"1"},{"name":"Nadia Puspitasari","email":"nadia.puspitasari@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 2","gmName":"Eros Nainggolan","team":"ERI 2 A","mgr":"Handijaya","presales":"Tasya Kamila, Fransiska Setyawan","active":"1"},{"name":"Gesya Alisa Apriany","email":"gesya.apriany@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 2","gmName":"Eros Nainggolan","team":"ERI 2 B","mgr":"Alwazier Bahanan","presales":"Tasya Kamila, Fransiska Setyawan","active":"1"},{"name":"Agung Primananda","email":"agung.primananda@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 2","gmName":"Eros Nainggolan","team":"ERI 2 B","mgr":"Alwazier Bahanan","presales":"Michael Valentino, Tasya Kamila","active":"1"},{"name":"RIska Islamiati","email":"Riska.Islamiati@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 2","gmName":"Eros Nainggolan","team":"ERI 2 B","mgr":"Alwazier Bahanan","presales":"Tasya Kamila, Fransiska Setyawan","active":"1"},{"name":"Shinta Oktriviani","email":"shinta.oktriviani@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 3","gmName":"Elviliana","team":"ERI 3 A","mgr":"Arulla Ryandiza","presales":"Eric Eric, Michael Valentino","active":"1"},{"name":"Gebby Veronika","email":"gebby.veronika@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 3","gmName":"Elviliana","team":"ERI 3 A","mgr":"Arulla Ryandiza","presales":"Tasya Kamila, Fransiska Setyawan","active":"1"},{"name":"Puti Salsabila","email":"puti.salsabila@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 3","gmName":"Elviliana","team":"ERI 3 A","mgr":"Arulla Ryandiza","presales":"Tasya Kamila, Fransiska Setyawan","active":"1"},{"name":"Edina Nurul Hafifah","email":"edina.hafifah@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 3","gmName":"Elviliana","team":"ERI 3 A","mgr":"Arulla Ryandiza","presales":"Fransiska Setyawan, Eric Eric","active":"1"},{"name":"Fennysa","email":"fennysa.fennysa@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 3","gmName":"Elviliana","team":"ERI 3 B","mgr":"Maria Villya","presales":"Eric Eric, Michael Valentino","active":"1"},{"name":"Ersa Mayori Raharjo","email":"ersa.raharjo@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 3","gmName":"Elviliana","team":"ERI 3 B","mgr":"Maria Villya","presales":"Michael Valentino, Tasya Kamila","active":"1"},{"name":"Fahmi Ardiansyah","email":"fahmi.ardiansyah@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 3","gmName":"Elviliana","team":"ERI 3 B","mgr":"Maria Villya","presales":"Tasya Kamila, Fransiska Setyawan","active":"1"},{"name":"Sophie","email":"sophie.evans@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 3","gmName":"Elviliana","team":"ERI 3 D MKS","mgr":"Arulla Ryandiza","presales":"Sabiq Hammam","active":"1"},{"name":"Kiki Nuril","email":"nuril.hakikiyah@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 3","gmName":"Elviliana","team":"ERI 3 D MKS","mgr":"Arulla Ryandiza","presales":"Sabiq Hammam","active":"1"},{"name":"Khalif El Hamidi","email":"khalif.hamidi@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 3","gmName":"Elviliana","team":"ERI 3 C PKU","mgr":"Sri Dewi Hutami","presales":"Michael Valentino, Tasya Kamila","active":"1"},{"name":"Stanley Aditya","email":"Stanley.Aditya@berca.co.id","director":"ERI","directorName":"Cornelia Agustin","gm":"ERI 3","gmName":"Elviliana","team":"ERI 3 C PKU","mgr":"Sri Dewi Hutami","presales":"Eric Eric, Michael Valentino","active":"1"}];
const SEED_ORG = [
  { name: "Natanael", title: "Director", dept: "TSS", level: "Director", you: "" },
  { name: "Ronald", title: "Division Lead", dept: "TSS MDCS", level: "Division Lead", you: "" },
  { name: "Indra Karvov Malau", title: "Presales Manager", dept: "Presales ERI", level: "Manager", you: "1" },
  { name: "Dendy Habibe Aryga", title: "Presales Engineer", dept: "ERI", level: "Staff", you: "" },
  { name: "Eric Eric", title: "Solution Architect", dept: "ERI", level: "Staff", you: "" },
  { name: "Fransiska Setyawan", title: "Solution Architect", dept: "ERI", level: "Staff", you: "" },
  { name: "Michael Valentino", title: "Solution Architect", dept: "ERI", level: "Staff", you: "" },
  { name: "Sabiq Hammam", title: "Presales Engineer", dept: "ERI", level: "Staff", you: "" },
  { name: "Taxya Putri Kamila", title: "Solution Architect", dept: "ERI", level: "Staff", you: "" }
];
async function seedOrgIfNeeded(db) {
  if (await db.prepare("SELECT 1 FROM settings WHERE k='seed_org_v1'").first()) return;
  const now = new Date().toISOString(), st = [];
  SEED_ORG.forEach((r, i) => st.push(db.prepare("INSERT OR IGNORE INTO site_items (id,kind,sort,data,updatedAt,updatedBy) VALUES (?,?,?,?,?,'seed')").bind("org-" + (i + 1), "org", (i + 1) * 10, JSON.stringify({ ...r, photo: "" }), now)));
  st.push(db.prepare("INSERT OR IGNORE INTO settings (k,v) VALUES ('seed_org_v1','1')"));
  await db.batch(st);
}
async function loadRosterIfNeeded(db) {
  if (await db.prepare("SELECT 1 FROM settings WHERE k='roster_v1'").first()) return;
  const now = new Date().toISOString();
  const st = [db.prepare("DELETE FROM site_items WHERE kind='sales'")];
  SEED_ROSTER.forEach((r, i) => st.push(db.prepare("INSERT OR REPLACE INTO site_items (id,kind,sort,data,updatedAt,updatedBy) VALUES (?,?,?,?,?,'roster')").bind("sl-r" + (i + 1), "sales", (i + 1) * 10, JSON.stringify(r), now)));
  st.push(db.prepare("INSERT OR IGNORE INTO settings (k,v) VALUES ('roster_v1','1')"));
  for (let i = 0; i < st.length; i += 50) await db.batch(st.slice(i, i + 50));
}
async function seedSiteIfEmpty(db) {
  if (await db.prepare("SELECT v FROM settings WHERE k='site'").first()) return;
  const now = new Date().toISOString(), st = [db.prepare("INSERT OR IGNORE INTO settings (k,v) VALUES ('site',?)").bind(JSON.stringify(SITE_DEFAULT))];
  SEED_ITEMS.forEach((r, i) => st.push(db.prepare("INSERT OR IGNORE INTO site_items (id,kind,sort,data,updatedAt,updatedBy) VALUES (?,?,?,?,?,'seed')").bind("svc-" + (i + 1), r[0], (i + 1) * 10, JSON.stringify({ title: r[1], desc: r[2] }), now)));
  SEED_TEAM.forEach((r, i) => st.push(db.prepare("INSERT OR IGNORE INTO site_items (id,kind,sort,data,updatedAt,updatedBy) VALUES (?,?,?,?,?,'seed')").bind("tm-" + (i + 1), "member", (i + 1) * 10, JSON.stringify({ name: r[0], role: r[1], region: r[2], email: r[3], photo: "" }), now)));
  st.push(db.prepare("INSERT OR IGNORE INTO site_items (id,kind,sort,data,updatedAt,updatedBy) VALUES (?,?,?,?,?,'seed')").bind("rp-1", "report", 10, JSON.stringify({ title: "Analytics Dashboard", desc: "Performance insights: project delivery metrics, solution effectiveness and team performance.", url: "https://lookerstudio.google.com/u/0/reporting/a1939f42-82ad-44a5-a770-9a3932504754/page/xn1OF" }), now));
  await db.batch(st);
}
async function readSite(db, withPrivate) {
  Object.assign(SITE_DEFAULT, SITE_ID);
  await seedSiteIfEmpty(db);
  await migrateInternal(db);
  const r = await db.prepare("SELECT v FROM settings WHERE k='site'").first();
  const site = { ...SITE_DEFAULT, ...(r ? JSON.parse(r.v) : {}) };
  await seedSalesIfEmpty(db);
  await fixEri3dIfNeeded(db);
  await loadRosterIfNeeded(db);
  await seedOrgIfNeeded(db);
  const kinds = ["service", "member", "resource", "sales", "salesContact", "vendor", "skill", "org", "proposal"];
  const rows = (await db.prepare("SELECT id,kind,sort,CASE WHEN kind='skill' THEN json_remove(data,'$.certFile') ELSE data END AS data FROM site_items WHERE kind IN (" + kinds.map(() => "?").join(",") + ") ORDER BY sort, id").bind(...kinds).all()).results;
  const out = { site, services: [], members: [], resources: [], sales: [], salesContacts: [], vendors: [], skills: [], org: [], proposals: [] };
  const kmap = { service: "services", member: "members", resource: "resources", sales: "sales", salesContact: "salesContacts", vendor: "vendors", skill: "skills", org: "org", proposal: "proposals" };
  for (const x of rows) (out[kmap[x.kind]] || []).push({ id: x.id, sort: x.sort, ...JSON.parse(x.data) });
  return out;
}

const PRODUCT_TEAM = [
  {
    "name": "Usi Fajri",
    "level": "Staff",
    "role": "PS",
    "group": "PM 1",
    "manager": "Min Ni",
    "products": [
      "HPE"
    ]
  },
  {
    "name": "Putri",
    "level": "Staff",
    "role": "PS",
    "group": "PM 1",
    "manager": "Min Ni",
    "products": [
      "Forti",
      "Rapid7",
      "SUSE"
    ]
  },
  {
    "name": "Grace",
    "level": "Staff",
    "role": "PS",
    "group": "PM 1",
    "manager": "Min Ni",
    "products": [
      "HPE",
      "HPEN",
      "HP Inc"
    ]
  },
  {
    "name": "Helda",
    "level": "Staff",
    "role": "PS",
    "group": "PM 1",
    "manager": "Min Ni",
    "products": [
      "Forti"
    ]
  },
  {
    "name": "Ronald",
    "level": "Staff",
    "role": "PS",
    "group": "PM 1",
    "manager": "Min Ni",
    "products": [
      "HPEN",
      "ASUS",
      "BitDef"
    ]
  },
  {
    "name": "Shaby",
    "level": "Staff",
    "role": "PS",
    "group": "PM 1",
    "manager": "Min Ni",
    "products": [
      "HP Inc",
      "Nutanix"
    ]
  },
  {
    "name": "Christine",
    "level": "Staff",
    "role": "PS",
    "group": "PM 1",
    "manager": "Min Ni",
    "products": [
      "HP Inc"
    ]
  },
  {
    "name": "",
    "level": "Staff",
    "role": "PS",
    "group": "PM 1",
    "manager": "Min Ni",
    "products": [
      "HPE"
    ]
  },
  {
    "name": "",
    "level": "",
    "role": "PS",
    "group": "PM 1",
    "manager": "Min Ni",
    "products": [
      "Kaytus",
      "Axway",
      "Okta",
      "ForcePoint",
      "Crwdstrike"
    ]
  },
  {
    "name": "Adelia",
    "level": "SPV",
    "role": "PS",
    "group": "PM 2",
    "manager": "Isabelle",
    "products": [
      "AWS",
      "Idira",
      "New Relic",
      "Lenovo",
      "Checkpoint",
      "Acer",
      "Solarwind"
    ]
  },
  {
    "name": "Ryan Felim",
    "level": "Staff",
    "role": "PS",
    "group": "PM 2",
    "manager": "Isabelle",
    "products": [
      "AWS Indirect",
      "New Relic"
    ]
  },
  {
    "name": "Azzahra",
    "level": "Staff",
    "role": "PS",
    "group": "PM 2",
    "manager": "Isabelle",
    "products": [
      "AWS CPPO",
      "Lenovo IDG"
    ]
  },
  {
    "name": "Tasya Fajar",
    "level": "Staff",
    "role": "PS",
    "group": "PM 2",
    "manager": "Isabelle",
    "products": [
      "AWS Scale",
      "Idira"
    ]
  },
  {
    "name": "Marselia Anisa",
    "level": "Staff",
    "role": "PS",
    "group": "PM 2",
    "manager": "Isabelle",
    "products": [
      "Lenovo ISG",
      "Checkpoint",
      "Acer",
      "Solarwind"
    ]
  },
  {
    "name": "Rizki Nurul",
    "level": "SPV",
    "role": "PS",
    "group": "PM 2",
    "manager": "Isabelle",
    "products": [
      "VMware",
      "Netapp",
      "Redhat",
      "OpenText",
      "Sophos",
      "Trellix"
    ]
  },
  {
    "name": "Najla",
    "level": "Staff",
    "role": "PS",
    "group": "PM 2",
    "manager": "Isabelle",
    "products": [
      "Redhat",
      "Sophos"
    ]
  },
  {
    "name": "Giovanni",
    "level": "Staff",
    "role": "PS",
    "group": "PM 2",
    "manager": "Isabelle",
    "products": [
      "VMware",
      "Trellix"
    ]
  },
  {
    "name": "Salsabila",
    "level": "Staff",
    "role": "PS",
    "group": "PM 2",
    "manager": "Isabelle",
    "products": [
      "Netapp",
      "OpenText"
    ]
  },
  {
    "name": "Dina Novita",
    "level": "SPV",
    "role": "PS",
    "group": "PM 2",
    "manager": "Isabelle",
    "products": [
      "AWS",
      "Cohesity",
      "Nvidia",
      "Netscout",
      "Arctera"
    ]
  },
  {
    "name": "Mega Putri",
    "level": "Staff",
    "role": "PS",
    "group": "PM 2",
    "manager": "Isabelle",
    "products": [
      "AWS Focus",
      "AWS PS",
      "Nvidia",
      "Netscout"
    ]
  },
  {
    "name": "Dithe",
    "level": "Staff",
    "role": "PS",
    "group": "PM 2",
    "manager": "Isabelle",
    "products": [
      "Cohesity",
      "AWS Deep",
      "Arctera"
    ]
  },
  {
    "name": "Gena Pradita",
    "level": "SPV",
    "role": "PS",
    "group": "PM 3",
    "manager": "Devi Andria",
    "products": [
      "Huawei",
      "Veeam",
      "Palo Alto",
      "Uipath",
      "Zscaler",
      "Xfusion",
      "Citrix",
      "Super Micro"
    ]
  },
  {
    "name": "Valerie",
    "level": "Staff",
    "role": "PS",
    "group": "PM 3",
    "manager": "Devi Andria",
    "products": [
      "Huawei ENT",
      "Huawei Cloud",
      "Uipath",
      "Xfusion"
    ]
  },
  {
    "name": "Syamsu",
    "level": "Staff",
    "role": "PS",
    "group": "PM 3",
    "manager": "Devi Andria",
    "products": [
      "Huawei ENT",
      "Palo Alto",
      "Zscaler",
      "Citrix"
    ]
  },
  {
    "name": "Dhyana",
    "level": "Staff",
    "role": "PS",
    "group": "PM 3",
    "manager": "Devi Andria",
    "products": [
      "Huawei ENT",
      "Ivanti",
      "F5"
    ]
  },
  {
    "name": "Zoffy",
    "level": "Staff",
    "role": "PS",
    "group": "PM 3",
    "manager": "Devi Andria",
    "products": [
      "Datadog",
      "Sangfor",
      "Aware",
      "Proofpoint"
    ]
  },
  {
    "name": "",
    "level": "Staff",
    "role": "PS",
    "group": "PM 3",
    "manager": "Devi Andria",
    "products": [
      "Sangfor",
      "Taraa Connect"
    ]
  },
  {
    "name": "Okta",
    "level": "Staff",
    "role": "PS",
    "group": "PM 4",
    "manager": "Sukma",
    "products": [
      "Dell ISG",
      "Alibaba"
    ]
  },
  {
    "name": "Fasya",
    "level": "Staff",
    "role": "PS",
    "group": "PM 4",
    "manager": "Sukma",
    "products": [
      "Dell ISG",
      "Dell CSG"
    ]
  },
  {
    "name": "Anindya",
    "level": "Staff",
    "role": "PS",
    "group": "PM 4",
    "manager": "Sukma",
    "products": [
      "Cisco",
      "Forescout",
      "Akamai",
      "Cyble"
    ]
  },
  {
    "name": "Kemal",
    "level": "Staff",
    "role": "PS",
    "group": "PM 4",
    "manager": "Sukma",
    "products": [
      "Hitachi",
      "EDB",
      "Intel",
      "IBM",
      "Weka",
      "Adobe",
      "Aiven",
      "Logitech"
    ]
  },
  {
    "name": "Genta",
    "level": "Staff",
    "role": "PS",
    "group": "PM 4",
    "manager": "Sukma",
    "products": [
      "Dell CSG",
      "Alibaba",
      "AMD"
    ]
  },
  {
    "name": "Syawal",
    "level": "SPV",
    "role": "TPS",
    "group": "TPS 1",
    "manager": "Rizki Ardiansyah",
    "products": [
      "VMware",
      "Veeam",
      "Sangfor"
    ]
  },
  {
    "name": "Roihan",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 1",
    "manager": "Rizki Ardiansyah",
    "products": [
      "VMware",
      "Sangfor"
    ]
  },
  {
    "name": "Zoni",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 1",
    "manager": "Rizki Ardiansyah",
    "products": [
      "Veeam",
      "Lenovo"
    ]
  },
  {
    "name": "Virgo",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 1",
    "manager": "Rizki Ardiansyah",
    "products": [
      "Veeam"
    ]
  },
  {
    "name": "Endra",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 1",
    "manager": "Rizki Ardiansyah",
    "products": [
      "Dell",
      "Lenovo",
      "Omnissa"
    ]
  },
  {
    "name": "Imam",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 1",
    "manager": "Rizki Ardiansyah",
    "products": [
      "Ivanti",
      "ME"
    ]
  },
  {
    "name": "Gunawan",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 1",
    "manager": "Rizki Ardiansyah",
    "products": [
      "Dell",
      "Hitachi"
    ]
  },
  {
    "name": "Adenan",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 1",
    "manager": "Rizki Ardiansyah",
    "products": [
      "Dell",
      "Lenovo"
    ]
  },
  {
    "name": "Rausal",
    "level": "SPV",
    "role": "TPS",
    "group": "TPS 2",
    "manager": "Nur Akbar",
    "products": [
      "Cohesity",
      "Huawei",
      "HPE"
    ]
  },
  {
    "name": "Dodi",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 2",
    "manager": "Nur Akbar",
    "products": [
      "Cohesity",
      "Huawei (OP)"
    ]
  },
  {
    "name": "Frisca",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 2",
    "manager": "Nur Akbar",
    "products": [
      "HPE"
    ]
  },
  {
    "name": "Aqila",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 2",
    "manager": "Nur Akbar",
    "products": [
      "HPE",
      "Huawei"
    ]
  },
  {
    "name": "Ghifari",
    "level": "SPV",
    "role": "TPS",
    "group": "TPS 2",
    "manager": "Nur Akbar",
    "products": [
      "Forti",
      "Nutanix",
      "Netapp"
    ]
  },
  {
    "name": "Raihan",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 2",
    "manager": "Nur Akbar",
    "products": [
      "Forti"
    ]
  },
  {
    "name": "Ave",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 2",
    "manager": "Nur Akbar",
    "products": [
      "New Relic",
      "DATADOG"
    ]
  },
  {
    "name": "Febry",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 2",
    "manager": "Nur Akbar",
    "products": [
      "Netapp"
    ]
  },
  {
    "name": "Habib",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 2",
    "manager": "Nur Akbar",
    "products": [
      "RedHat",
      "Nutanix"
    ]
  },
  {
    "name": "Wahid",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 3",
    "manager": "Muchlis Sadat",
    "products": [
      "Opentext",
      "F5",
      "Proofpoint",
      "Aware"
    ]
  },
  {
    "name": "Veliks",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 3",
    "manager": "Muchlis Sadat",
    "products": [
      "Crowdstrike",
      "Bitdef",
      "Sophos",
      "TM",
      "Trellix"
    ]
  },
  {
    "name": "Jimmy",
    "level": "SPV",
    "role": "TPS",
    "group": "TPS 3",
    "manager": "Muchlis Sadat",
    "products": [
      "Cisco",
      "HPEN",
      "CyberArk-Palo Alto",
      "SIEM",
      "Rapid7"
    ]
  },
  {
    "name": "Indra",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 3",
    "manager": "Muchlis Sadat",
    "products": [
      "Cisco",
      "HPEN"
    ]
  },
  {
    "name": "Walid",
    "level": "Staff",
    "role": "TPS",
    "group": "TPS 3",
    "manager": "Muchlis Sadat",
    "products": [
      "CyberArk-Palo Alto",
      "SIEM",
      "Rapid7"
    ]
  }
];

const productTeamKey=row=>"product_team_email:"+JSON.stringify([row.role,row.group,row.name]);

const productTeamSpvKey=row=>"product_team_spv:"+JSON.stringify([row.role,row.group,row.name]);

const productTeamManagerKey=row=>"product_team_email:"+JSON.stringify(["manager",row.group,row.manager]);

function proposalReminderRecipients(proposal, site, productTeam) {
  const normalize=value=>String(value||"").trim().toLowerCase();
  const split=value=>String(value||"").split(/[;,\s]+/).filter(Boolean);
  const assigned=new Set(String(proposal.presales||"").split(/[,;\n]+/).map(normalize).filter(Boolean));
  const salesName=normalize(proposal.sales);
  const sales=salesName?(site.sales||[]).find(row=>[row.name,row.email].some(value=>normalize(value)===salesName)):null;
  const manager=sales&&(site.salesContacts||[]).find(row=>row.type==="Manager"&&row.email&&normalize(row.name)===normalize(sales.mgr));
  const gm=sales&&(site.salesContacts||[]).find(row=>row.type==="GM"&&row.email&&normalize(row.name)===normalize(sales.gmName));
  const brand=normalize(proposal.productBrand);
  const tpsAlias=brand==="dell isg"?"dell":"";
  const specialists=brand?productTeam.filter(row=>row.products.some(value=>{
    const product=normalize(value);
    return product===brand||(row.role==="TPS"&&tpsAlias&&product===tpsAlias);
  })):[];
  const candidates=[
    ...split(proposal.notifyEmails),...split(proposal.productPicEmails),
    sales?.email,manager?.email||sales?.mgrEmail,gm?.email,
    ...(assigned.size?["tss.solution-architect-eri@berca.co.id"]:[]),
    ...(site.members||[]).filter(row=>assigned.has(normalize(row.name))||assigned.has(normalize(row.email))).map(row=>row.email),
    ...specialists.flatMap(row=>[row.email,row.managerEmail])
  ];
  return [...new Set(candidates.map(normalize).filter(email=>/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email)))].join(", ");
}

const API = {
  async getProductTeam(db) {
    const saved=await db.prepare("SELECT k,v FROM settings WHERE k LIKE 'product_team_email:%' OR k LIKE 'product_team_spv:%'").all();
    const emails=new Map(saved.results.map(row=>[row.k,row.v]));
    return PRODUCT_TEAM.map(row=>{
      const id=row.name?productTeamKey(row):"";
      const managerId=row.manager?productTeamManagerKey(row):"";
      const spvId=row.name&&row.level!=="SPV"?productTeamSpvKey(row):"";
      const spv=spvId?emails.get(spvId)||"":"";
      return {...row,id,email:emails.get(id)||"",managerId,managerEmail:emails.get(managerId)||"",spvId,spv:PRODUCT_TEAM.some(x=>x.level==="SPV"&&x.name===spv&&x.role===row.role&&x.group===row.group)?spv:""};
    });
  },
  // Atasan langsung (SPV) untuk anggota non-SPV; hanya boleh SPV dari role+grup yang sama. Kosong = hapus.
  async saveProductTeamSpv(db,id,value) {
    const person=typeof id==="string"?PRODUCT_TEAM.find(row=>row.name&&row.level!=="SPV"&&productTeamSpvKey(row)===id):null;
    if(!person||typeof value!=="string") return null;
    const spv=value.trim();
    if(spv&&!PRODUCT_TEAM.some(x=>x.level==="SPV"&&x.name===spv&&x.role===person.role&&x.group===person.group)) return null;
    if(spv) await db.prepare("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(id,spv).run();
    else await db.prepare("DELETE FROM settings WHERE k=?").bind(id).run();
    return {id,spv};
  },
  async saveProductTeamEmail(db,id,value) {
    if(typeof value!=="string"||!PRODUCT_TEAM.some(row=>(row.name&&productTeamKey(row)===id)||(row.manager&&productTeamManagerKey(row)===id))) return null;
    const email=value.trim();
    if(email&&(email.length>254||!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email))) return null;
    await db.prepare("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(id,email).run();
    return {id,email};
  },
  // portal: publik (Beranda/Layanan/Kontak) dan lengkap untuk pengguna login
  async getPublic(db) { return readSite(db, false); },
  async getSite(db) {
    const data = await readSite(db, true);
    data.skills = data.skills.map(({ certFile, ...skill }) => skill);
    return data;
  },
  async saveSiteText(db, who, rec) {
    const cur = (await readSite(db, false)).site, next = { ...cur };
    for (const k of SITE_KEYS) if (rec && rec[k] !== undefined) next[k] = clean(rec[k]).slice(0, 600);
    if (next.contactEmail && !EMAIL_RE.test(next.contactEmail)) throw new UserError("Contact email is not valid.");
    await db.prepare("INSERT INTO settings (k,v) VALUES ('site',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(next)).run();
    return next;
  },
  async saveItem(db, who, kind, rec) {
    const fields = ITEM_KINDS[kind]; if (!fields) throw new UserError("Unknown content type.");
    rec = rec || {};
    const d = {};
    let oldSkill = null;
    if (kind === "skill" && rec.id && (rec.certFile === undefined || rec.certFileName === undefined)) {
      const old = await db.prepare("SELECT data FROM site_items WHERE id=? AND kind='skill'").bind(clean(rec.id)).first();
      if (old) oldSkill = JSON.parse(old.data);
    }
    for (const f of fields) {
      if (kind === "skill" && f === "certFile" && rec.certFile === undefined) d[f] = String(oldSkill && oldSkill.certFile || "");
      else if (kind === "skill" && f === "certFileName" && rec.certFileName === undefined) d[f] = String(oldSkill && oldSkill.certFileName || "");
      else if (f === "photo") d[f] = String(rec.photo || "");
      else if (f === "analysis") d[f] = String(rec.analysis || "").slice(0, 40000);
      else if (kind === "skill" && f === "certFile") d[f] = String(rec[f] || "");
      else d[f] = clean(rec[f]).slice(0, (f === "desc" || f === "note") ? 1200 : f === "certFileName" ? 180 : 300);
    }
    if (kind === "service" && !d.title) throw new UserError("Service title is required.");
    if (kind === "sales") { if (!d.name) throw new UserError("Sales name is required."); if (d.email && !EMAIL_RE.test(d.email)) throw new UserError("Sales email is not valid."); if (d.mgrEmail && !EMAIL_RE.test(d.mgrEmail)) throw new UserError("Email manager tidak valid."); d.active = d.active ? "1" : ""; }
    if (kind === "salesContact") { if (!d.name) throw new UserError("GM/Manager name is required."); if (!["GM", "Manager"].includes(d.type)) throw new UserError("Contact type must be GM or Manager."); if (d.email && !EMAIL_RE.test(d.email)) throw new UserError("Format email GM/Manager tidak valid."); }
    if ((kind === "report" || kind === "resource") && (!d.title || !/^https:\/\//.test(d.url))) throw new UserError("Title and link (https://) are required.");
    if (kind === "vendor") { if (!d.brand || !d.product) throw new UserError("Vendor and product are required."); if (d.url && !/^https:\/\//.test(d.url)) throw new UserError("EoSL link must start with https://"); }
    if (kind === "skill" && (!d.person || !d.domain)) throw new UserError("Member name and domain are required.");
    if (kind === "skill" && d.certFile) {
      if (d.certFile.length > 700000) throw new UserError("Certificate file exceeds the 500 KB upload limit.");
      if (!/^data:(application\/pdf|image\/(jpeg|png|webp));base64,[A-Za-z0-9+/=]+$/.test(d.certFile)) throw new UserError("Use a PDF, JPEG, PNG, or WebP certificate file.");
      if (!d.certFileName) d.certFileName = "certificate";
    }
    if (kind === "skill" && !d.certFile) d.certFileName = "";
    if (kind === "member") {
      if (!d.name) throw new UserError("Member name is required.");
      if (d.email && !EMAIL_RE.test(d.email)) throw new UserError("Member email is not valid.");
      if (d.photo && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d.photo)) throw new UserError("Photo format is not supported.");
      if (d.photo.length > 300000) throw new UserError("Photo size is too large.");
    }
    if (kind === "org") {
      if (!d.name) throw new UserError("Name is required.");
      if (d.photo && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d.photo)) throw new UserError("Photo format is not supported.");
      if (d.photo.length > 300000) throw new UserError("Photo size is too large.");
      d.you = d.you ? "1" : "";
    }
    if (kind === "proposal") {
      if (!d.customer && !d.title) throw new UserError("Customer name is required.");
      if (!d.status) d.status = "Prebid";
      if (!PROP_STATUS.includes(d.status)) throw new UserError("Unknown proposal status.");
      if (d.rksUrl && !/^https:\/\//.test(d.rksUrl)) throw new UserError("RKS link must start with https://");
      for (const [key] of PROPOSAL_SUBMISSION_CHECKS) d[key] = d[key] === "1" ? "1" : "";
      if (d.status === "Submitted") {
        const existing = rec.id
          ? await db.prepare("SELECT data FROM site_items WHERE id=? AND kind='proposal'").bind(clean(rec.id)).first()
          : null;
        const previousStatus = existing ? JSON.parse(existing.data).status : "";
        if (previousStatus !== "Submitted") {
          const missing = proposalSubmissionGaps(d);
          if (missing.length) throw new UserError("Before submitting: " + missing.join("; ") + ".");
        }
      }
    }
    const id = clean(rec.id) || (kind.slice(0, 3) + "-" + uuid().slice(0, 8));
    const sort = Number.isFinite(+rec.sort) && rec.sort !== "" ? Math.round(+rec.sort) : Date.now() % 1e6;
    await db.prepare("INSERT INTO site_items (id,kind,sort,data,updatedAt,updatedBy) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sort=excluded.sort,data=excluded.data,updatedAt=excluded.updatedAt,updatedBy=excluded.updatedBy")
      .bind(id, kind, sort, JSON.stringify(d), new Date().toISOString(), who).run();
    return { id, sort, ...d };
  },
  async deleteItem(db, who, id) {
    await db.prepare("DELETE FROM site_items WHERE id=?").bind(clean(id)).run();
    return true;
  },
  async getAll(db, ctx, full) {
    // ctx: { master:boolean, edit:Set(customerId) } — hak lihat detail (SN, PIC, email) per customer
    ctx = ctx || { master: false, edit: new Set() };
    const canSee = id => full || ctx.master || ctx.edit.has(id);
    await seedIfEmpty(db);
    await seedBayanIfNeeded(db);
    const c = await db.prepare("SELECT id,name,code,pic,note,presales,updatedAt,createdBy FROM customers").all();
    const d = await db.prepare("SELECT " + DEV_COLS.join(",") + ",COALESCE(muteWarranty,'') AS muteWarranty,COALESCE(renewalStatus,'') AS renewalStatus,COALESCE(renewalOwner,'') AS renewalOwner,COALESCE(dismantled,'') AS dismantled FROM devices").all();
    // Pengunjung tanpa login: alamat email disamarkan (h***@berca.co.id)
    const customers = c.results.map(({ createdBy, ...customer }) => {
      const canEdit = mayEditCustomer(ctx, { id: customer.id, createdBy });
      return (canSee(customer.id) || canEdit) ? { ...customer, canEdit }
        : { ...customer, pic: "", note: maskEmails(customer.note), presales: maskEmails(customer.presales), canEdit };
    });
    let devices = d.results;
    if (devices.some(x => !canSee(x.customerId))) {
      // Pengunjung tanpa login: Serial Number disembunyikan, termasuk SN yang tertulis di keterangan
      const sns = [...new Set(devices.map(x => String(x.sn || "").trim()).filter(v => v.length >= 4))]
        .sort((x, y) => y.length - x.length).map(v => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const snRe = sns.length ? new RegExp(sns.join("|"), "gi") : null;
      const hideNote = v => {
        let t = String(v || "")
          .replace(/(tertulis\s+)(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{5,}/gi, "$1" + SN_MASK)
          .replace(/(\bSN\s*:?\s+)(?=[\w-]*\d)[\w-]{5,}/g, "$1" + SN_MASK);
        return snRe ? t.replace(snRe, SN_MASK) : t;
      };
      devices = devices.map(x => canSee(x.customerId) ? x : ({ ...x, sn: SN_MASK, note: hideNote(x.note), muteWarranty: x.muteWarranty ? "*" : "", renewalStatus: "", renewalOwner: "" }));
    }
    return { customers, devices, canWrite: ctx.master || ctx.edit.size > 0, isMaster: !!ctx.master, editable: [...ctx.edit], sheetUrl: "" };
  },
  async saveCustomer(db, who, rec) {
    const existingId = clean(rec && rec.id);
    const c = { id: existingId || uuid(), name: clean(rec && rec.name), code: clean(rec && rec.code), pic: clean(rec && rec.pic), note: clean(rec && rec.note), presales: clean(rec && rec.presales), updatedAt: new Date().toISOString(), updatedBy: who };
    if (!c.name) throw new UserError("Customer name is required.");
    const dup = await db.prepare("SELECT 1 FROM customers WHERE lower(name)=lower(?) AND id<>?").bind(c.name, c.id).first();
    if (dup) throw new UserError("Customer " + c.name + " already exists.");
    const bad = c.presales.split(/[\s,;]+/).filter(Boolean).filter(e => !EMAIL_RE.test(e));
    if (bad.length) throw new UserError("Presales PIC email is not valid: " + bad.join(", ") + ". Separate multiple emails with commas.");
    const values = [c.name, c.code, c.pic, c.note, c.presales, c.updatedAt, c.updatedBy];
    if (existingId) {
      const result = await db.prepare("UPDATE customers SET name=?,code=?,pic=?,note=?,presales=?,updatedAt=?,updatedBy=? WHERE id=?")
        .bind(...values, existingId).run();
      if (!result.meta.changes) throw new UserError("Customer not found.");
    } else {
      await db.prepare("INSERT INTO customers (name,code,pic,note,presales,updatedAt,updatedBy,id,createdBy) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(...values, c.id, who).run();
    }
    return c;
  },
  // ---- Kelola admin per customer (khusus master admin) ----
  async listAdmins(db) {
    const r = await db.prepare("SELECT email, customerId, addedBy, addedAt FROM customer_admins ORDER BY email").all();
    const m = new Map();
    for (const x of r.results) { if (!m.has(x.email)) m.set(x.email, { email: x.email, customers: [], addedBy: x.addedBy, addedAt: x.addedAt }); m.get(x.email).customers.push(x.customerId); }
    return [...m.values()];
  },
  async saveAdmin(db, who, email, customerIds, domain) {
    email = clean(email).toLowerCase();
    if (!EMAIL_RE.test(email) || !email.endsWith("@" + domain)) throw new UserError("Admin email must be an @" + domain + " account.");
    const ids = [...new Set((Array.isArray(customerIds) ? customerIds : []).map(clean).filter(Boolean))];
    if (!ids.length) throw new UserError("Pilih minimal satu customer.");
    const known = new Set((await db.prepare("SELECT id FROM customers").all()).results.map(x => x.id));
    const bad = ids.filter(i => !known.has(i)); if (bad.length) throw new UserError("Customer not found: " + bad.join(", "));
    const now = new Date().toISOString();
    await db.batch([db.prepare("DELETE FROM customer_admins WHERE email=?").bind(email),
      ...ids.map(i => db.prepare("INSERT INTO customer_admins (email,customerId,addedBy,addedAt) VALUES (?,?,?,?)").bind(email, i, who, now))]);
    return { email, customers: ids };
  },
  async deleteAdmin(db, who, email) {
    await db.prepare("DELETE FROM customer_admins WHERE email=?").bind(clean(email).toLowerCase()).run();
    return true;
  },
  async deleteCustomer(db, who, id) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM devices WHERE customerId=?").bind(clean(id)).first();
    if (n && n.n) throw new UserError("Customer ini masih punya " + n.n + " perangkat.");
    await db.batch([db.prepare("DELETE FROM customers WHERE id=?").bind(clean(id)), db.prepare("DELETE FROM customer_admins WHERE customerId=?").bind(clean(id))]);
    return true;
  },
  // Tandai warranty sudah diperpanjang -> notifikasi email untuk tanggal warranty ini diabaikan.
  // Jika tanggal warranty nanti diubah, notifikasi otomatis aktif lagi untuk tanggal yang baru.
  async muteDevice(db, who, id, on) {
    const r = await db.prepare("SELECT warranty FROM devices WHERE id=?").bind(clean(id)).first();
    if (!r) throw new UserError("Device not found.");
    const v = on ? String(r.warranty || "") : "";
    if (on && !v) throw new UserError("This device has no warranty date yet.");
    await db.prepare("UPDATE devices SET muteWarranty=?, updatedAt=?, updatedBy=? WHERE id=?").bind(v, new Date().toISOString(), who, clean(id)).run();
    return { id: clean(id), muteWarranty: v };
  },
  // Pipeline renewal: status tindak lanjut perpanjangan warranty per perangkat.
  async setRenewal(db, who, id, status, owner) {
    const S = new Set(["", "contacted", "quoting", "po", "won", "lost"]);
    const st = String(status || "").trim(); if (!S.has(st)) throw new UserError("Unknown renewal status.");
    const ow = String(owner || "").trim().slice(0, 120);
    const r = await db.prepare("SELECT 1 FROM devices WHERE id=?").bind(clean(id)).first();
    if (!r) throw new UserError("Device not found.");
    await db.prepare("UPDATE devices SET renewalStatus=?, renewalOwner=?, updatedAt=?, updatedBy=? WHERE id=?").bind(st, ow, new Date().toISOString(), who, clean(id)).run();
    return { id: clean(id), renewalStatus: st, renewalOwner: ow };
  },
  // Dismantle: perangkat yang sudah dicabut / tidak dipakai lagi. Data tetap disimpan (riwayat),
  // tapi dikecualikan dari KPI warranty, grafik, pipeline renewal, dan notifikasi email. Bisa diaktifkan lagi.
  async setDismantle(db, who, id, on) {
    const r = await db.prepare("SELECT 1 FROM devices WHERE id=?").bind(clean(id)).first();
    if (!r) throw new UserError("Device not found.");
    const v = on ? new Date().toISOString() : "";
    await db.prepare("UPDATE devices SET dismantled=?, updatedAt=?, updatedBy=? WHERE id=?").bind(v, new Date().toISOString(), who, clean(id)).run();
    return { id: clean(id), dismantled: v };
  },
  async saveDevice(db, who, rec) {
    const d = normDevice(rec || {}, who);
    const dup = await db.prepare("SELECT 1 FROM devices WHERE customerId=? AND lower(sn)=lower(?) AND id<>?").bind(d.customerId, d.sn, d.id).first();
    if (dup) throw new UserError("Serial Number " + d.sn + " already exists in this customer's inventory.");
    await upsertDevice(db, d).run();
    return d;
  },
  async deleteDevice(db, who, id) {
    await db.prepare("DELETE FROM devices WHERE id=?").bind(clean(id)).run();
    return true;
  },
  async importDevices(db, who, list) {
    const rows = await db.prepare("SELECT customerId, lower(sn) AS sn FROM devices").all();
    const existing = new Set(rows.results.map(r => r.customerId + "|" + r.sn));
    const stmts = [];
    for (const r of (Array.isArray(list) ? list : [])) {
      const d = normDevice(r, who);
      const k = d.customerId + "|" + d.sn.toLowerCase();
      if (existing.has(k)) continue;
      existing.add(k);
      stmts.push(upsertDevice(db, d));
    }
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    return stmts.length;
  }
};


// ---------- Auth: Google ID token -> signed session cookie ----------
const COOKIE = "inv_session";
const SESSION_HOURS = 12;
const VERSION = "2026-11-23.4";   // dinaikkan tiap rilis; tampil di /health untuk memastikan deploy berhasil
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uDecode = s => { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(s + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0)); };
let hmacKey = null;

async function getHmacKey(db) {
  if (hmacKey) return hmacKey;
  let row = await db.prepare("SELECT v FROM settings WHERE k='session_secret'").first();
  if (!row) {
    const secret = b64u(crypto.getRandomValues(new Uint8Array(32)));
    await db.prepare("INSERT OR IGNORE INTO settings (k,v) VALUES ('session_secret',?)").bind(secret).run();
    row = await db.prepare("SELECT v FROM settings WHERE k='session_secret'").first();
  }
  hmacKey = await crypto.subtle.importKey("raw", b64uDecode(row.v), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return hmacKey;
}
async function makeSession(db, email) {
  const body = b64u(new TextEncoder().encode(JSON.stringify({ e: email, x: Date.now() + SESSION_HOURS * 3600e3 })));
  const sig = b64u(await crypto.subtle.sign("HMAC", await getHmacKey(db), new TextEncoder().encode(body)));
  return body + "." + sig;
}
async function readSession(db, request) {
  const m = (request.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]+)"));
  if (!m) return null;
  const [body, sig] = m[1].split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await getHmacKey(db), b64uDecode(sig), new TextEncoder().encode(body)).catch(() => false);
  if (!ok) return null;
  try { const p = JSON.parse(new TextDecoder().decode(b64uDecode(body))); return p.x > Date.now() ? p.e : null; } catch { return null; }
}
const cookieHeader = (val, maxAge) => COOKIE + "=" + val + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge;

// ---------- Login Google (hanya domain ALLOWED_DOMAIN) ----------
let jwksCache = null, jwksAt = 0;
async function googleKeys() {
  if (jwksCache && Date.now() - jwksAt < 3600e3) return jwksCache;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw new UserError("Unable to reach Google to verify the sign-in.");
  jwksCache = (await r.json()).keys || []; jwksAt = Date.now();
  return jwksCache;
}
async function verifyGoogleToken(token, clientId, domain) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new UserError("Sign-in token is not valid.");
  const dec = s => JSON.parse(new TextDecoder().decode(b64uDecode(s)));
  let head, pl;
  try { head = dec(parts[0]); pl = dec(parts[1]); b64uDecode(parts[2]); } catch (e) { throw new UserError("Sign-in token is not valid."); }
  let jwk = (await googleKeys()).find(k => k.kid === head.kid);
  if (!jwk) { jwksCache = null; jwk = (await googleKeys()).find(k => k.kid === head.kid); }
  if (!jwk || head.alg !== "RS256") throw new UserError("Sign-in token is not recognized.");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uDecode(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new UserError("Sign-in token signature is not valid.");
  if (pl.aud !== clientId) throw new UserError("Sign-in token is not for this application.");
  if (pl.iss !== "accounts.google.com" && pl.iss !== "https://accounts.google.com") throw new UserError("Token issuer is not valid.");
  if (!pl.exp || pl.exp * 1000 < Date.now()) throw new UserError("Google session expired, please sign in again.");
  const email = String(pl.email || "").toLowerCase();
  if (!pl.email_verified || pl.hd !== domain || !email.endsWith("@" + domain)) throw new UserError("Only @" + domain + " accounts may access this application.");
  return email;
}
// ---------- Hak akses: master admin vs admin per customer ----------
async function accessCtx(env, me) {
  const masters = String(env.MASTER_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const master = me.admin || (!!me.email && masters.includes(me.email));
  let presales = master;
  if (!presales && me.email) {
    const members = await env.DB.prepare("SELECT data FROM site_items WHERE kind='member'").all();
    presales = (members.results || []).some(r => {
      try { return String(JSON.parse(r.data).email || "").trim().toLowerCase() === me.email; } catch (_) { return false; }
    });
  }
  const edit = new Set();
  if (!master && me.email) (await env.DB.prepare("SELECT customerId FROM customer_admins WHERE email=?").bind(me.email).all()).results.forEach(r => edit.add(r.customerId));
  // Presales who created a customer can manage that customer's devices automatically
  if (!master && presales && me.email) (await env.DB.prepare("SELECT id FROM customers WHERE lower(createdBy)=?").bind(me.email).all()).results.forEach(r => edit.add(r.id));
  return { master, presales, edit, email: me.email };
}
function proposalsVisibleTo(data, ctx, email) {
  if (ctx.master) return data;
  const userEmail = String(email || "").trim().toLowerCase();
  if (!userEmail) return { ...data, proposals: [] };
  const memberNames = new Set((data.members || [])
    .filter(x => String(x.email || "").trim().toLowerCase() === userEmail)
    .map(x => String(x.name || "").trim().toLowerCase()).filter(Boolean));
  const salesNames = new Set((data.sales || [])
    .filter(x => String(x.email || "").trim().toLowerCase() === userEmail)
    .map(x => String(x.name || "").trim().toLowerCase()).filter(Boolean));
  return {
    ...data,
    proposals: (data.proposals || []).filter(p => {
      const sales = String(p.sales || "").trim().toLowerCase();
      if (sales && salesNames.has(sales)) return true;
      return String(p.presales || "").split(/[,;\n]+/).some(name => memberNames.has(name.trim().toLowerCase()));
    })
  };
}
const MASTER_ONLY = new Set(["deleteCustomer", "listAdmins", "saveAdmin", "deleteAdmin", "saveSiteText", "saveItem", "deleteItem"]);
function mayEditCustomer(ctx, customer) {
  return !!(ctx && (ctx.master || (ctx.presales
    ? ctx.email && customer.createdBy === ctx.email
    : ctx.edit.has(customer.id))));
}
async function authorize(db, ctx, fn, args) {
  const deny = () => { const e = new UserError("You do not have admin rights for this customer."); e.status = 403; throw e; };
  if (ctx.master) return;
  if (fn === "saveItem") {
    const kind = args[0], rec = args[1] || {};
    if (kind === "proposal" && ctx.presales && !clean(rec.id)) {
      if (["Submitted", "Cancelled", "Won", "Lost", "Menang", "Kalah"].includes(clean(rec.status))) {
        throw new UserError("A new proposal must start at an active stage. Submit it or mark it Won/Lost after it has been saved.");
      }
      return;
    }
    deny();
  }
  if (fn === "saveCustomer") {
    const id = clean(args[0] && args[0].id);
    if (!id && ctx.presales && ctx.email) return;
    const customer = id && await db.prepare("SELECT id,createdBy FROM customers WHERE id=?").bind(id).first();
    if (!customer || !mayEditCustomer(ctx, customer)) deny();
    return;
  }
  if (!ctx.edit.size || MASTER_ONLY.has(fn)) deny();
  const devCust = async id => { const r = await db.prepare("SELECT customerId FROM devices WHERE id=?").bind(clean(id)).first(); return r ? r.customerId : null; };
  if (fn === "saveDevice") {
    const rec = args[0] || {};
    if (!ctx.edit.has(clean(rec.customerId))) deny();
    const old = rec.id ? await devCust(rec.id) : null;
    if (old && !ctx.edit.has(old)) deny();
  } else if (fn === "deleteDevice" || fn === "muteDevice" || fn === "setRenewal" || fn === "setDismantle") {
    const c = await devCust(args[0]); if (!c || !ctx.edit.has(c)) deny();
  } else if (fn === "importDevices") {
    const list = Array.isArray(args[0]) ? args[0] : [];
    if (list.some(r => !ctx.edit.has(clean(r && r.customerId)))) deny();
  } else deny();
}

// isi sesi: "admin" | "admin|email" | "user:email"
function parseWho(who) {
  if (!who) return { admin: false, email: "" };
  if (who === "admin") return { admin: true, email: "" };
  if (who.startsWith("admin|")) return { admin: true, email: who.slice(6) };
  if (who.startsWith("user:")) return { admin: false, email: who.slice(5) };
  return { admin: false, email: "" };
}

// ---------- Admin login (password) with simple brute-force throttle ----------
async function sha256(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function safeEqual(a, b) {
  const [x, y] = [await sha256(a), await sha256(b)];
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
const MAX_FAILS = 10, LOCK_MIN = 15;
async function checkThrottle(db, ip) {
  const r = await db.prepare("SELECT fails, until FROM login_attempts WHERE ip=?").bind(ip).first();
  if (r && r.until && r.until > Date.now()) throw new UserError("Too many attempts. Try again in " + Math.ceil((r.until - Date.now()) / 60000) + " minutes.");
  return r;
}
async function recordFail(db, ip, prev) {
  const fails = (prev && (!prev.until || prev.until <= Date.now()) ? prev.fails : 0) + 1;
  const until = fails >= MAX_FAILS ? Date.now() + LOCK_MIN * 60000 : 0;
  await db.prepare("INSERT INTO login_attempts (ip,fails,until) VALUES (?,?,?) ON CONFLICT(ip) DO UPDATE SET fails=excluded.fails, until=excluded.until").bind(ip, until ? 0 : fails, until).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    // Health check untuk uptime monitor. Publik: status ringkas (tanpa data sensitif).
    // Dengan header x-notify-key yang benar: status DB + jumlah customer/perangkat.
    if (p === "/health") {
      const base = { ok: true, service: "inventory-aset", version: VERSION, time: new Date().toISOString() };
      const keyed = !!env.NOTIFY_KEY && await safeEqual(String(request.headers.get("x-notify-key") || ""), String(env.NOTIFY_KEY));
      if (!keyed) return json(base);
      try {
        await ensureSchema(env.DB);
        const c = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM customers) AS customers, (SELECT COUNT(*) FROM devices) AS devices").first();
        return json({ ...base, db: "up", customers: c.customers, devices: c.devices });
      } catch (e) {
        return json({ ...base, ok: false, db: "down", error: String((e && e.message) || e) }, 503);
      }
    }
    if (request.method === "GET" && (p === "/" || p === "/index.html")) {
      return new Response(HTML_TEMPLATE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "content-security-policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline' https://accounts.google.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self' https://accounts.google.com; frame-src https://accounts.google.com" } });
    }
    if (!env.DB) return json({ error: "The D1 database is not bound (binding name: DB)." }, 500);
    try {
      await ensureSchema(env.DB);
      if (p === "/auth/admin" && request.method === "POST") {
        if (!env.ADMIN_PASSWORD) throw new UserError("The admin password is not set on the server (wrangler secret put ADMIN_PASSWORD).");
        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        const prev = await checkThrottle(env.DB, ip);
        const body = await request.json().catch(() => ({}));
        if (!(await safeEqual(String(body.password || ""), env.ADMIN_PASSWORD))) {
          await recordFail(env.DB, ip, prev);
          await new Promise(r => setTimeout(r, 800));
          throw new UserError("Incorrect admin password.");
        }
        await env.DB.prepare("DELETE FROM login_attempts WHERE ip=?").bind(ip).run();
        const prevEmail = parseWho(await readSession(env.DB, request)).email;
        return new Response(JSON.stringify({ admin: true }), { headers: { "content-type": "application/json", "set-cookie": cookieHeader(await makeSession(env.DB, prevEmail ? "admin|" + prevEmail : "admin"), SESSION_HOURS * 3600) } });
      }
      const domain = String(env.ALLOWED_DOMAIN || "berca.co.id").toLowerCase();
      const gated = !!env.GOOGLE_CLIENT_ID;   // login Google wajib untuk melihat data bila Client ID diisi
      if (p === "/auth/google" && request.method === "POST") {
        if (!gated) throw new UserError("Google sign-in is not configured (GOOGLE_CLIENT_ID).");
        const body = await request.json().catch(() => ({}));
        const email = await verifyGoogleToken(body.credential, env.GOOGLE_CLIENT_ID, domain);
        const cur = parseWho(await readSession(env.DB, request));
        const sess = cur.admin ? "admin|" + email : "user:" + email;
        return new Response(JSON.stringify({ ok: true, email }), { headers: { "content-type": "application/json", "set-cookie": cookieHeader(await makeSession(env.DB, sess), SESSION_HOURS * 3600) } });
      }
      if (p === "/auth/logout" && request.method === "POST") {
        // keluar admin -> kembali jadi viewer (jika sudah login Google); ?all=1 -> keluar total
        const cur = parseWho(await readSession(env.DB, request));
        const keep = cur.admin && cur.email && url.searchParams.get("all") !== "1";
        const val = keep ? await makeSession(env.DB, "user:" + cur.email) : "";
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": cookieHeader(val, keep ? SESSION_HOURS * 3600 : 0) } });
      }
      const me = parseWho(await readSession(env.DB, request));
      const isAdmin = me.admin;
      const isViewer = isAdmin || !!me.email || !gated;
      const ctx = isViewer ? await accessCtx(env, me) : { master: false, edit: new Set() };
      if (p === "/auth/me") return json({ admin: ctx.master, master: ctx.master, presales: ctx.presales, pwAdmin: isAdmin, editable: [...ctx.edit], viewer: isViewer, email: me.email, gated, clientId: gated ? env.GOOGLE_CLIENT_ID : "", domain });
      const certMatch = p.match(/^\/api\/certificate\/([A-Za-z0-9_-]+)$/);
      if (certMatch && request.method === "GET") {
        if (!isViewer) return json({ error: "Sign in with an authorized company account to view certificates.", login: true }, 401);
        const row = await env.DB.prepare("SELECT data FROM site_items WHERE id=? AND kind='skill'").bind(certMatch[1]).first();
        if (!row) return new Response("Certificate not found", { status: 404 });
        const skill = JSON.parse(row.data);
        const match = String(skill.certFile || "").match(/^data:(application\/pdf|image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (!match) return new Response("Certificate not found", { status: 404 });
        const bytes = Uint8Array.from(atob(match[3]), ch => ch.charCodeAt(0));
        const filename = String(skill.certFileName || "certificate").replace(/[\r\n"]/g, "_");
        return new Response(bytes, { headers: { "content-type": match[1], "content-disposition": "inline; filename=\"" + filename + "\"", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
      }
      if (p === "/api/notifyData") {
        // Dipakai script notifikasi email (Google Apps Script) — butuh kunci rahasia NOTIFY_KEY
        if (!env.NOTIFY_KEY) return json({ error: "NOTIFY_KEY is not set in Cloudflare." }, 503);
        if (!(await safeEqual(String(request.headers.get("x-notify-key") || ""), String(env.NOTIFY_KEY)))) return json({ error: "Incorrect notification key." }, 401);
        return json({ result: await API.getAll(env.DB, null, true) });
      }
      if (p === "/api/proposalData") {
        // Dipakai script pengingat proposal (Apps Script) — butuh NOTIFY_KEY
        if (!env.NOTIFY_KEY) return json({ error: "NOTIFY_KEY is not set in Cloudflare." }, 503);
        if (!(await safeEqual(String(request.headers.get("x-notify-key") || ""), String(env.NOTIFY_KEY)))) return json({ error: "Incorrect notification key." }, 401);
        const site = await readSite(env.DB, true);
        const productTeam = await API.getProductTeam(env.DB);
        const props = site.proposals.map(x => ({ id: x.id, title: x.title || "", customer: x.customer || "", sales: x.sales || "", presales: x.presales || "", submission: x.submission || "", status: x.status || "", notifyEmails: proposalReminderRecipients(x, site, productTeam) }));
        return json({ result: props });
      }
      const m = p.match(/^\/api\/([A-Za-z]+)$/);
      if (m && request.method === "POST" && API[m[1]]) {
        if (!isViewer) return json({ error: "Please sign in with a Google @" + domain + " account.", login: true }, 401);
        if (m[1] === "getProductTeam") return me.email || isAdmin ? json({ result: await API.getProductTeam(env.DB) }) : json({ error: "Sign in to view the directory." }, 403);
        if (m[1] === "saveProductTeamEmail") {
          if(!ctx.master) return json({error:"Master Admin access required."},403);
          const args=await request.json().catch(()=>null);
          if(!Array.isArray(args)) return json({error:"Invalid request."},400);
          const saved=await API.saveProductTeamEmail(env.DB,args[0],args[1]);
          return saved?json({result:saved}):json({error:"Invalid PIC or email address."},400);
        }
        if (m[1] === "saveProductTeamSpv") {
          if(!ctx.master) return json({error:"Master Admin access required."},403);
          const args=await request.json().catch(()=>null);
          if(!Array.isArray(args)) return json({error:"Invalid request."},400);
          const saved=await API.saveProductTeamSpv(env.DB,args[0],args[1]);
          return saved?json({result:saved}):json({error:"Invalid person or SPV."},400);
        }
        if (m[1] === "getAll") return json({ result: await API.getAll(env.DB, ctx) });
        if (m[1] === "getSite") return json({ result: { ...proposalsVisibleTo(await API.getSite(env.DB), ctx, me.email), isMaster: ctx.master } });
        if (m[1] === "getPublic") return json({ result: proposalsVisibleTo(await API.getSite(env.DB), ctx, me.email) });
        let args = await request.json().catch(() => []); if (!Array.isArray(args)) args = [];
        const canCreateProposal = m[1] === "saveItem" && args[0] === "proposal" && ctx.presales && !clean(args[1] && args[1].id);
        const canSaveCustomer = m[1] === "saveCustomer" && ctx.presales && !!ctx.email;
        if (!ctx.master && !ctx.edit.size && !canCreateProposal && !canSaveCustomer) return json({ error: "You do not have permission to perform this action." }, 403);
        await authorize(env.DB, ctx, m[1], args);
        const who = me.email || "admin";
        if (m[1] === "saveAdmin") args = [args[0], args[1], domain];
        return json({ result: await API[m[1]](env.DB, who, ...args) });
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ error: e instanceof UserError ? e.message : "Server error: " + (e && e.message || e) }, e instanceof UserError ? (e.status || 400) : 500);
    }
  }
};
