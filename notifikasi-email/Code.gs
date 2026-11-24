// CATATAN: salinan untuk repo. Nilai NOTIFY_KEY sengaja dikosongkan (placeholder).
// Isi nilai aslinya hanya di editor Google Apps Script, JANGAN di-commit ke GitHub.
/**
 * Notifikasi Email END OF WARRANTY — Inventaris Aset Customer
 *
 * Setiap hari SENIN jam 07:00 WIB (1x seminggu) script mengecek aplikasi. Email dikirim PER CUSTOMER
 * hanya bila ada perangkat yang BARU masuk tahap menjelang End of Warranty:
 *     ≤ 150 hari  →  ≤ 90 hari  →  ≤ 60 hari  →  ≤ 30 hari  →  ≤ 14 hari  →  ≤ 7 hari
 * Penerima: email di kolom "Catatan / Manager Sales" + "PIC Presales" customer tsb.
 *
 * Fungsi:
 *   setup       – jalankan SEKALI: pasang jadwal mingguan (Senin) + kirim email pertama
 *   checkNow    – kirim email sekarang (semua perangkat yang akan End of Warranty ≤ 150 hari)
 *   resetState  – lupakan riwayat, supaya semua perangkat dianggap baru lagi
 */

const APP_URL = 'https://presales.bhp-eri.workers.dev';
const NOTIFY_KEY = 'ISI_DENGAN_NOTIFY_KEY';   // harus sama dengan secret NOTIFY_KEY di Cloudflare
const FALLBACK_RECIPIENTS = 'indra.malau@berca.co.id';   // dipakai bila customer belum punya email
const ALWAYS_CC = '';                                     // opsional: email yang selalu dapat salinan
const RUN_HOUR = 7;                                       // jam kirim (WIB) — setiap Senin
const STAGES = [150, 90, 60, 30, 14, 7];                     // tahap pengingat (hari sebelum End of Warranty)

function setup() {
  // Hapus trigger lama, lalu pasang: warranty = mingguan (Senin), proposal = harian.
  ScriptApp.getProjectTriggers()
    .filter(t => ['dailyCheck', 'checkRequests', 'checkProposals'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyCheck').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(RUN_HOUR).create();
  ScriptApp.newTrigger('checkProposals').timeBased().everyDays(1).atHour(RUN_HOUR).create();
  Logger.log(dailyCheck(true));
  Logger.log(checkProposals(true));
}

function checkNow() { Logger.log(dailyCheck(true)); }
function checkProposalsNow() { Logger.log(checkProposals(true)); }

// ============ PENGINGAT PROPOSAL (harian) ============
// Pengingat dikirim tiap 2 hari; saat sisa ≤ 3 hari menjadi tiap hari. Berhenti setelah Submitted/Menang/Kalah.
function checkProposals(force) {
  var resp = UrlFetchApp.fetch(APP_URL + '/api/proposalData', {
    method: 'post', headers: { 'x-notify-key': NOTIFY_KEY }, muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) return 'Gagal ambil data proposal: HTTP ' + resp.getResponseCode();
  var props = (JSON.parse(resp.getContentText()).result) || [];
  var tz = 'Asia/Jakarta';
  var today = new Date(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd') + 'T00:00:00');
  var DONE = ['Submitted', 'Menang', 'Kalah'];
  var sent = 0, out = [];
  props.forEach(function (pp) {
    if (DONE.indexOf(pp.status) >= 0) return;
    if (!/^\d{4}-\d{2}-\d{2}/.test(pp.submission || '')) return;
    var sub = new Date(pp.submission.slice(0, 10) + 'T00:00:00');
    var daysLeft = Math.round((sub - today) / 86400000);
    if (daysLeft < 0) return;                                  // sudah lewat
    var due = force || daysLeft <= 3 || (daysLeft % 2 === 0);   // ≤3 tiap hari, selain itu tiap 2 hari
    if (!due) return;
    var to = String(pp.notifyEmails || '').split(/[,;]+/).map(function (x) { return x.trim(); }).filter(function (x) { return /@/.test(x); });
    if (!to.length) to = [FALLBACK_RECIPIENTS];
    var urg = daysLeft <= 3 ? '#b42318' : (daysLeft <= 7 ? '#b54708' : '#1677b3');
    var nm = (pp.customer || pp.title || 'Proposal');
    var subj = 'Pengingat Proposal: ' + nm + ' — ' + (daysLeft === 0 ? 'SUBMIT HARI INI' : 'H-' + daysLeft);
    var html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#1a2233">' +
      '<h2 style="margin:0 0 4px;color:' + urg + '">' + (daysLeft === 0 ? 'Submit hari ini' : 'Sisa ' + daysLeft + ' hari menuju submission') + '</h2>' +
      '<p style="margin:0 0 14px;color:#556">Pengingat progres proposal/tender.</p>' +
      '<table style="border-collapse:collapse;font-size:14px">' +
      '<tr><td style="padding:5px 12px;color:#667">Customer</td><td style="padding:5px 12px"><b>' + esc_(nm) + '</b></td></tr>' +
      (pp.title ? '<tr><td style="padding:5px 12px;color:#667">Tender</td><td style="padding:5px 12px">' + esc_(pp.title) + '</td></tr>' : '') +
      '<tr><td style="padding:5px 12px;color:#667">Sales</td><td style="padding:5px 12px">' + esc_(pp.sales || '-') + '</td></tr>' +
      '<tr><td style="padding:5px 12px;color:#667">Presales</td><td style="padding:5px 12px">' + esc_(pp.presales || '-') + '</td></tr>' +
      '<tr><td style="padding:5px 12px;color:#667">Status</td><td style="padding:5px 12px">' + esc_(pp.status || '-') + '</td></tr>' +
      '<tr><td style="padding:5px 12px;color:#667">Submission</td><td style="padding:5px 12px"><b>' + esc_(pp.submission) + '</b></td></tr>' +
      '</table>' +
      '<p style="margin:18px 0"><a href="' + APP_URL + '/#/presales/proposal" style="background:' + urg + ';color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px">Buka Monitor Proposal</a></p>' +
      '</div>';
    var opt = { to: to.join(','), subject: subj, htmlBody: html, name: 'Monitor Proposal' };
    if (ALWAYS_CC) opt.cc = ALWAYS_CC;
    MailApp.sendEmail(opt);
    sent++; out.push(nm + ' (H-' + daysLeft + ' → ' + to.join(',') + ')');
  });
  return 'Proposal: ' + sent + ' email terkirim. ' + out.join('; ');
}

function resetState() { PropertiesService.getScriptProperties().deleteProperty('eowState'); }

function fetchData_() {
  const res = UrlFetchApp.fetch(APP_URL + '/api/notifyData', {
    method: 'post', headers: { 'x-notify-key': NOTIFY_KEY }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('Gagal membaca aplikasi: HTTP ' + res.getResponseCode() + ' ' + res.getContentText());
  const j = JSON.parse(res.getContentText());
  return j.result || j;
}

function daysTo_(iso, today) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const p = iso.split('-').map(Number);
  return Math.round((Date.UTC(p[0], p[1] - 1, p[2]) - today) / 86400000);
}

/** tahap terkecil yang sudah dicapai (mis. 25 hari → 30). null = belum ≤ 150 hari atau sudah lewat */
function stageOf_(days) {
  if (days === null || days < 0) return null;
  let s = null;
  STAGES.forEach(x => { if (days <= x) s = (s === null ? x : Math.min(s, x)); });
  return s;
}

/** force=true: kirim daftar lengkap walaupun tidak ada perubahan */
function dailyCheck(force) {
  force = force === true;
  const data = fetchData_();
  const custName = {}, custMail = {};
  (data.customers || []).forEach(c => {
    custName[c.id] = c.name;
    custMail[c.id] = emailsIn_([c.note, c.presales].join(' '));
  });

  const ymd = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd').split('-').map(Number);
  const today = Date.UTC(ymd[0], ymd[1] - 1, ymd[2]);

  const props = PropertiesService.getScriptProperties();
  const old = JSON.parse(props.getProperty('eowState') || '{}');
  const state = {};
  const upcoming = [];

  (data.devices || []).forEach(d => {
    if (d.dismantled) return;   // perangkat sudah dismantle / tidak dipakai lagi
    if (d.muteWarranty && d.muteWarranty === d.warranty) return;   // ditandai "warranty sudah diperpanjang"
    const days = daysTo_(d.warranty, today);
    const st = stageOf_(days);
    if (st === null) return;
    const key = d.customerId + '|' + String(d.sn).toLowerCase() + '|' + d.warranty;
    state[key] = st;
    upcoming.push({
      customerId: d.customerId, sn: d.sn, type: d.type, brand: d.brand, model: d.model,
      note: d.note, location: d.location, warranty: d.warranty, days: days, stage: st,
      isNew: !(key in old) || st < old[key]
    });
  });
  props.setProperty('eowState', JSON.stringify(state));

  let sent = 0, newCount = 0;
  Object.keys(custName).forEach(id => {
    const list = upcoming.filter(r => r.customerId === id).sort((a, b) => a.days - b.days);
    const fresh = list.filter(r => r.isNew);
    if (!fresh.length && !(force && list.length)) return;
    const to = (custMail[id].length ? custMail[id] : emailsIn_(FALLBACK_RECIPIENTS)).join(',');
    if (!to) return;
    sendMail_(custName[id], to, list);
    sent++; newCount += fresh.length;
  });

  // Heartbeat: selalu kirim ringkasan ke admin setiap kali script jalan.
  // Jika Senin pagi email ini TIDAK datang, berarti script gagal/berhenti — itu sinyalnya.
  const stageCount = {}; STAGES.forEach(s => stageCount[s] = 0);
  upcoming.forEach(r => { stageCount[r.stage] = (stageCount[r.stage] || 0) + 1; });
  sendHeartbeat_({
    ran: Utilities.formatDate(new Date(), 'Asia/Jakarta', 'EEEE, d MMMM yyyy HH:mm') + ' WIB',
    customers: Object.keys(custName).length,
    devices: (data.devices || []).length,
    upcoming: upcoming.length, stageCount: stageCount, sent: sent, newCount: newCount
  });

  return sent ? 'Email terkirim untuk ' + sent + ' customer (' + newCount + ' perangkat baru masuk tahap)' : 'Tidak ada perangkat baru yang mendekati End of Warranty';
}

/** Ringkasan "script sehat" ke admin (bukan ke customer). */
function sendHeartbeat_(s) {
  const admin = emailsIn_(FALLBACK_RECIPIENTS).join(',');
  if (!admin) return;
  const stageRows = STAGES.map(x => '&le;' + x + ' hari: <b>' + (s.stageCount[x] || 0) + '</b>').join(' &nbsp;·&nbsp; ');
  const subject = '[Inventaris Aset] ✅ Cek warranty mingguan OK — ' + s.upcoming + ' perangkat dipantau';
  const html = '<div style="font-family:Arial,sans-serif;color:#1d2733;max-width:600px;line-height:1.6">' +
    '<div style="border-bottom:3px solid #2f9e5c;padding-bottom:8px;margin-bottom:14px"><b style="font-size:16px">✅ Script notifikasi berjalan normal</b></div>' +
    '<p style="font-size:14px">Ini ringkasan pengecekan otomatis (heartbeat). <b>Jika suatu Senin Anda tidak menerima email ini, berarti script mungkin gagal atau berhenti</b> — mohon dicek.</p>' +
    '<table style="border-collapse:collapse;font-size:13.5px;background:#f6f8fa;border-radius:8px">' +
    '<tr><td style="padding:6px 12px;color:#556">Waktu jalan</td><td style="padding:6px 12px"><b>' + esc_(s.ran) + '</b></td></tr>' +
    '<tr><td style="padding:6px 12px;color:#556">Total customer</td><td style="padding:6px 12px">' + s.customers + '</td></tr>' +
    '<tr><td style="padding:6px 12px;color:#556">Total perangkat</td><td style="padding:6px 12px">' + s.devices + '</td></tr>' +
    '<tr><td style="padding:6px 12px;color:#556">Mendekati End of Warranty (&le;' + Math.max.apply(null, STAGES) + ' hari)</td><td style="padding:6px 12px"><b>' + s.upcoming + '</b></td></tr>' +
    '<tr><td style="padding:6px 12px;color:#556">Rincian tahap</td><td style="padding:6px 12px">' + stageRows + '</td></tr>' +
    '<tr><td style="padding:6px 12px;color:#556">Email customer terkirim</td><td style="padding:6px 12px">' + s.sent + ' customer (' + s.newCount + ' perangkat baru masuk tahap)</td></tr>' +
    '</table>' +
    '<p style="margin:16px 0"><a href="' + APP_URL + '" style="background:#1677b3;color:#fff;padding:9px 15px;border-radius:6px;text-decoration:none;font-size:13.5px">Buka Inventaris Aset</a></p>' +
    '<p style="font-size:11px;color:#889">Email heartbeat otomatis — hanya ke admin, tidak dikirim ke customer.</p></div>';
  MailApp.sendEmail({ to: admin, subject: subject, htmlBody: html, name: 'Inventaris Aset – Monitoring' });
}

function emailsIn_(text) {
  const m = String(text || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  return m.map(e => e.toLowerCase()).filter((e, i, a) => a.indexOf(e) === i);
}

function esc_(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate_(iso) {
  const b = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const p = iso.split('-');
  return Number(p[2]) + ' ' + b[Number(p[1]) - 1] + ' ' + p[0];
}

function sendMail_(customer, to, list) {
  const n = list.length;
  const first = list[0];
  const subject = '[Notifikasi End of Warranty] ' + customer + ' — ' + n + ' perangkat akan berakhir warranty' +
    (first.days <= 30 ? ' (terdekat ' + first.days + ' hari lagi)' : '');

  const th = 'style="text-align:left;padding:8px;background:#f1f5f9;border-bottom:2px solid #d0d7e0;font-size:12px;color:#445"';
  const td = 'style="padding:8px;border-bottom:1px solid #e6eaf0;font-size:13px;vertical-align:top"';
  let rows = '';
  list.forEach((r, i) => {
    const color = r.days <= 30 ? '#c42b3a' : '#c07a00';
    rows += '<tr>' +
      '<td ' + td + '>' + (i + 1) + '</td>' +
      '<td ' + td + '><b style="font-family:Consolas,monospace">' + esc_(r.sn) + '</b>' + (r.isNew ? ' <span style="background:#e8f2fb;color:#1677b3;font-size:10px;padding:1px 5px;border-radius:3px">BARU</span>' : '') + '</td>' +
      '<td ' + td + '>' + esc_(r.type) + '</td>' +
      '<td ' + td + '>' + esc_(String(r.model || '').toLowerCase().indexOf(String(r.brand || '').toLowerCase()) === 0 && r.brand ? r.model : [r.brand, r.model].filter(Boolean).join(' ')) + '</td>' +
      '<td ' + td + '>' + esc_(r.note || '—') + (r.location ? '<br><span style="color:#667">' + esc_(r.location) + '</span>' : '') + '</td>' +
      '<td ' + td + '><b>' + fmtDate_(r.warranty) + '</b></td>' +
      '<td ' + td + '><b style="color:' + color + '">' + (r.days === 0 ? 'Hari ini' : r.days + ' hari lagi') + '</b></td>' +
      '</tr>';
  });

  const html =
    '<div style="font-family:Arial,sans-serif;color:#1d2733;max-width:900px;line-height:1.5">' +
    '<div style="border-bottom:3px solid #1677b3;padding-bottom:8px;margin-bottom:16px">' +
    '<b style="font-size:17px">Notifikasi End of Warranty</b><br>' +
    '<span style="font-size:13px;color:#556">Customer: <b>' + esc_(customer) + '</b></span></div>' +
    '<p style="font-size:14px">Yth. Tim Sales &amp; Presales,</p>' +
    '<p style="font-size:14px">Berikut <b>' + n + ' perangkat</b> milik <b>' + esc_(customer) + '</b> yang akan memasuki ' +
    '<b>End of Warranty</b> dalam ' + Math.max.apply(null, STAGES) + ' hari ke depan. Mohon ditindaklanjuti dengan customer untuk ' +
    'perpanjangan warranty / support (renewal) sebelum tanggal berakhir.</p>' +
    '<p style="font-size:14px;background:#fff6e0;border-left:4px solid #c07a00;padding:8px 12px"><b>Abaikan email ini jika warranty perangkat sudah diperbaharui.</b></p>' +
    '<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;margin:8px 0 4px">' +
    '<tr><th ' + th + '>No</th><th ' + th + '>Serial Number</th><th ' + th + '>Tipe</th><th ' + th + '>Brand / Model</th>' +
    '<th ' + th + '>Keterangan / Lokasi</th><th ' + th + '>End of Warranty</th><th ' + th + '>Sisa waktu</th></tr>' +
    rows + '</table>' +
    '<p style="font-size:12px;color:#667">Label <b>BARU</b> = perangkat yang baru masuk tahap pengingat (' + STAGES.join(' / ') + ' hari) sejak email sebelumnya.</p>' +
    '<p style="margin:18px 0"><a href="' + APP_URL + '" style="background:#1677b3;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px">Buka Inventaris Aset</a></p>' +
    '<p style="font-size:14px">Terima kasih.</p>' +
    '<p style="font-size:11px;color:#889;border-top:1px solid #e6eaf0;padding-top:10px;margin-top:20px">' +
    'Email otomatis dari aplikasi Inventaris Aset Customer (Presales Solution Architect). ' +
    'Pengingat dikirim saat perangkat memasuki ' + STAGES.join(', ') + ' hari sebelum End of Warranty.</p></div>';

  const opt = { to: to, subject: subject, htmlBody: html, name: 'Inventaris Aset – Presales' };
  if (ALWAYS_CC) opt.cc = ALWAYS_CC;
  MailApp.sendEmail(opt);
}
