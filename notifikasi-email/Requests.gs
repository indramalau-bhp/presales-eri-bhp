/**
 * Requests.gs — membaca email yang masuk ke Google Group presales dan mengirimnya ke aplikasi
 * (halaman "Request Monitor"). Skrip ini hanya MEMBACA Gmail; tidak mengirim email apa pun.
 *
 * Satu proyek dengan Code.gs: APP_URL dan NOTIFY_KEY dipakai bersama (isi NOTIFY_KEY di Code.gs).
 *
 * Syarat:
 *  1. Dijalankan oleh akun yang menjadi ANGGOTA Google Group dan menerima emailnya di Inbox.
 *  2. Presales membalas dengan "Reply all" supaya alamat group ikut di thread (itu yang
 *     dipakai untuk menghitung respons pertama).
 *
 * Langkah: pilih fungsi setupRequests lalu Run (sekali). Izin Gmail (baca) akan diminta.
 */
const REQ_GROUP = 'tss.solution-architect-eri@berca.co.id';
const REQ_LOOKBACK_DAYS = 14;     // thread yang dipantau (hari terakhir)
const REQ_MAX_THREADS = 100;      // batas thread per putaran
const REQ_EVERY_MIN = 15;         // interval sinkron (menit): 1, 5, 10, 15, atau 30

function setupRequests() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncRequests') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncRequests').timeBased().everyMinutes(REQ_EVERY_MIN).create();
  Logger.log(syncRequests());
}

// Uji cepat tanpa mengirim: hanya mencatat apa yang akan dikirim.
function previewRequests() {
  Logger.log(JSON.stringify(collectThreads_().map(function (t) {
    return { subject: t.subject, from: t.messages[0].from, msgs: t.messages.length };
  }), null, 1));
}

function syncRequests() {
  var threads = collectThreads_();
  var totals = { created: 0, updated: 0, skipped: 0 };
  for (var i = 0; i < threads.length; i += 25) {
    var res = UrlFetchApp.fetch(APP_URL + '/api/requestIngest', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-notify-key': NOTIFY_KEY },
      payload: JSON.stringify({ threads: threads.slice(i, i + 25) }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) throw new Error('requestIngest ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
    var r = (JSON.parse(res.getContentText()).result) || {};
    totals.created += r.created || 0; totals.updated += r.updated || 0; totals.skipped += r.skipped || 0;
  }
  return 'threads=' + threads.length + ' created=' + totals.created + ' updated=' + totals.updated + ' skipped=' + totals.skipped;
}

function collectThreads_() {
  var q = '(to:' + REQ_GROUP + ' OR cc:' + REQ_GROUP + ' OR deliveredto:' + REQ_GROUP + ') newer_than:' + REQ_LOOKBACK_DAYS + 'd';
  var out = [];
  GmailApp.search(q, 0, REQ_MAX_THREADS).forEach(function (th) {
    var msgs = th.getMessages();
    if (!msgs.length) return;
    out.push({
      threadId: th.getId(),
      subject: th.getFirstMessageSubject(),
      link: th.getPermalink(),
      snippet: snippet_(msgs[0]),
      messages: msgs.map(function (m) {
        var f = parseFrom_(m.getFrom());
        return { from: f.email, fromName: f.name, date: m.getDate().toISOString() };
      })
    });
  });
  return out;
}

function parseFrom_(s) {
  s = String(s || '');
  var m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), email: m[2].trim().toLowerCase() } : { name: '', email: s.trim().toLowerCase() };
}

// Awal isi email tanpa kutipan balasan, maksimal 500 karakter (cukup untuk klasifikasi).
function snippet_(msg) {
  var body = String(msg.getPlainBody() || '').split(/\r?\n/).filter(function (l) { return !/^\s*>/.test(l); }).join(' ');
  return body.replace(/\s+/g, ' ').trim().slice(0, 500);
}
