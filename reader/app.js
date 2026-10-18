// 棚卸しカウントくん（リーダー版）— 画面と処理
// カメラは使わず、Bluetoothのバーコードリーダー（キーボードとして入ってくる）で読む。
(function () {
  'use strict';
  var VERSION = '2026-10-18-R1';
  var STORE_KEY = 'tana-reader.v1'; // カメラ版（tana.v1）とは別の場所に保存する
  var MAX_QTY_LEN = 4;              // この回の個数は 9999 まで
  var C = window.TanaCore;
  var $ = function (id) { return document.getElementById(id); };

  $('verLabel').textContent = VERSION;

  // ---------- 記録 ----------
  var state = load();
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s && Array.isArray(s.records)) return s;
    } catch (e) {}
    return { records: [], rev: 0, sentRev: 0, startedAt: new Date().toISOString() };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { alert('保存できませんでした。記録が消えないうちに「CSVで送る」で控えを送ってください。'); }
  }
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(function () {});
  }

  var seq = 0;
  function addRecord(jan, qty, src) {
    state.records.push({ id: Date.now() + '-' + (seq++), t: new Date().toISOString(), jan: jan, qty: qty, src: src });
    state.rev++;
    save();
  }
  function janTotal(jan) {
    var q = 0;
    state.records.forEach(function (r) { if (r.jan === jan) q += r.qty; });
    return q;
  }
  function lastRecord() { return state.records[state.records.length - 1] || null; }
  function qtyEditable(r) { return !!r && r.src !== 'edit'; }

  // ---------- 表示 ----------
  var wide = matchMedia('(min-width: 700px)');
  function render() {
    var last = lastRecord();
    $('lastEmpty').hidden = !!last;
    $('lastBody').hidden = !last;
    $('undoBtn').disabled = !last;
    if (last) {
      $('lastJan').textContent = last.jan;
      $('lastQty').textContent = last.qty;
      $('lastTotal').textContent = janTotal(last.jan);
      $('qtyBox').classList.toggle('typing', typed !== '');
      $('qtyHint').textContent = !qtyEditable(last) ? '一覧で直した記録です'
        : typed !== '' ? '次のバーコードを読むと、この個数で決まります'
        : '数字キーで打つと、この回の個数になります';
    }
    var on = qtyEditable(last);
    Array.prototype.forEach.call($('keypad').children, function (b) { b.disabled = !on; });
    var s = C.summary(state.records);
    $('sumPieces').textContent = s.pieces;
    $('sumKinds').textContent = s.kinds;
    if (wide.matches) renderList($('sideList'), $('sideSum'));
  }
  if (wide.addEventListener) wide.addEventListener('change', render);

  // 読めた合図：画面の点滅と文字が主役、音は補助
  var audioCtx = null;
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  }
  function beep(freq, len) {
    if (!audioCtx) return;
    len = len || 0.08;
    try {
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; o.type = 'square';
      g.gain.setValueAtTime(0.12, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + len);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + len + 0.01);
    } catch (e) {}
  }
  function signal(kind, text) { // kind: new / same / bad
    var f = $('flash');
    f.classList.remove('on', 'same', 'bad');
    void f.offsetWidth; // アニメーションをやり直すため
    if (kind !== 'new') f.classList.add(kind);
    f.classList.add('on');
    $('statusBox').classList.toggle('ok', kind !== 'bad');
    $('statusBox').classList.toggle('bad', kind === 'bad');
    $('statusText').textContent = text;
    if (kind === 'bad') beep(300, 0.25);
    else beep(kind === 'same' ? 1300 : 1900);
  }

  function counted(jan, src) {
    var last = lastRecord();
    var same = !!last && last.jan === jan;
    typed = '';
    addRecord(jan, 1, src);
    render();
    signal(same ? 'same' : 'new', same ? '同じJANをもう1個（合計 ' + janTotal(jan) + '）' : '読めました');
  }

  // ---------- バーコードリーダー（キーボードとして入ってくる） ----------
  // 文字が速く続いて最後にEnter（またはTab）、をスキャンとみなす。入力欄を使わず画面全体で拾う
  var kbBuf = '', kbFirst = 0, kbLast = 0;
  function toHalf(ch) { return ch.replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }); }
  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var now = performance.now();
    if (e.key.length === 1) {
      e.preventDefault();
      if (now - kbLast > 150) { kbBuf = ''; kbFirst = now; }
      kbBuf += toHalf(e.key); kbLast = now;
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault(); // ボタンに残ったフォーカスがEnterで押されないように
      var buf = kbBuf, n = buf.length;
      kbBuf = '';
      var fast = n >= 6 && (kbLast - kbFirst) / (n - 1) < 80 && now - kbLast < 200;
      if (!fast) return; // 人の手で打った文字は無視する
      unlockAudio();
      requestWakeLock();
      if (!$('padSheet').hidden) closePad();
      if (!/^\d+$/.test(buf)) { signal('bad', 'JANではないバーコードです（数えていません）'); return; }
      var jan = C.normalizeTyped(buf);
      if (!jan) { signal('bad', '番号が正しくありません（' + n + '桁）。もう一度読んでください'); return; }
      counted(jan, 'kb');
    }
  }, true);
  // ボタンを押した後にフォーカスを残さない
  document.addEventListener('click', function (e) {
    unlockAudio();
    requestWakeLock();
    var b = e.target.closest && e.target.closest('button');
    if (b) setTimeout(function () { b.blur(); }, 0);
  });

  // ---------- 画面を点けたままにする ----------
  var wakeLock = null;
  async function requestWakeLock() {
    if (wakeLock || document.hidden) return;
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', function () { wakeLock = null; });
      }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) requestWakeLock(); });

  // ---------- いつも出しておく数字キー（この回の個数） ----------
  var typed = ''; // 打っている途中の個数。空なら1個のまま
  (function buildKeypad() {
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].forEach(function (k) {
      var b = document.createElement('button');
      b.textContent = k;
      if (k === 'C' || k === '⌫') b.className = 'sub';
      b.addEventListener('click', function () { qtyKey(k); });
      $('keypad').appendChild(b);
    });
  })();
  function qtyKey(k) {
    var last = lastRecord();
    if (!qtyEditable(last)) return;
    if (k === 'C') typed = '';
    else if (k === '⌫') typed = typed.slice(0, -1);
    else if (typed === '0') typed = k;
    else if (typed.length < MAX_QTY_LEN) typed += k;
    last.qty = typed === '' ? 1 : +typed;
    state.rev++;
    save();
    render();
  }

  // ---------- 取り消し ----------
  $('undoBtn').addEventListener('click', function () {
    var last = state.records.pop();
    if (!last) return;
    typed = '';
    state.rev++;
    save();
    render();
    $('statusBox').classList.remove('ok', 'bad');
    $('statusText').textContent = '直前の1回を取り消しました（' + last.jan + '）';
  });

  // ---------- 数字キー（シート：JANの手入力・一覧の修正） ----------
  var pad = null; // { mode, value, maxLen, onOk }
  (function buildPad() {
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].forEach(function (k) {
      var b = document.createElement('button');
      b.textContent = k;
      b.addEventListener('click', function () { padKey(k); });
      $('padGrid').appendChild(b);
    });
  })();
  function openPad(opt) {
    pad = opt;
    pad.value = opt.value || '';
    $('padTitle').textContent = opt.title;
    $('padSub').textContent = opt.sub || '';
    $('padErr').textContent = '';
    $('padDisplay').textContent = pad.value;
    $('padSheet').hidden = false;
  }
  function closePad() { $('padSheet').hidden = true; pad = null; }
  function padKey(k) {
    if (!pad) return;
    if (k === 'C') pad.value = '';
    else if (k === '⌫') pad.value = pad.value.slice(0, -1);
    else if (pad.value.length < pad.maxLen) pad.value = (pad.value === '0' && pad.mode !== 'jan') ? k : pad.value + k;
    $('padErr').textContent = '';
    $('padDisplay').textContent = pad.value;
  }
  $('padCancel').addEventListener('click', closePad);
  $('padOk').addEventListener('click', function () {
    if (!pad) return;
    var err = pad.onOk(pad.value);
    if (err) { $('padErr').textContent = err; return; }
    closePad();
  });

  $('manualBtn').addEventListener('click', function () {
    openPad({
      mode: 'jan', maxLen: 13, title: 'JANを手入力', sub: '13桁・8桁（12桁のUPCも可）', value: '',
      onOk: function (v) {
        var jan = C.normalizeTyped(v);
        if (!jan) return v.length ? '番号が正しくありません（桁数か最後の数字を確認）' : 'JANを入れてください';
        counted(jan, 'man');
        return null;
      }
    });
  });

  // ---------- 一覧 ----------
  $('listBtn').addEventListener('click', function () { renderList($('listBody'), $('listSum')); $('listSheet').hidden = false; });
  $('listClose').addEventListener('click', function () { $('listSheet').hidden = true; });
  function renderList(ol, sumEl) {
    var list = C.totals(state.records).filter(function (e) { return e.qty !== 0; });
    var last = lastRecord();
    var s = C.summary(state.records);
    sumEl.textContent = s.kinds + '種類・' + s.pieces + '点';
    ol.innerHTML = '';
    list.slice().reverse().forEach(function (e) {
      var li = document.createElement('li');
      if (last && last.jan === e.jan) li.className = 'latest';
      var a = document.createElement('span'); a.className = 'jan mono'; a.textContent = e.jan;
      var b = document.createElement('span'); b.className = 'q mono'; b.textContent = e.qty;
      li.appendChild(a); li.appendChild(b);
      li.addEventListener('click', function () {
        openPad({
          mode: 'total', maxLen: 5, title: '合計の個数を直す', sub: e.jan + '（今 ' + e.qty + '個）', value: '',
          onOk: function (v) {
            if (v === '') return '個数を入れてください';
            var delta = +v - janTotal(e.jan);
            if (delta !== 0) { typed = ''; addRecord(e.jan, delta, 'edit'); }
            render();
            if (!$('listSheet').hidden) renderList($('listBody'), $('listSum'));
            return null;
          }
        });
      });
      ol.appendChild(li);
    });
    if (!list.length) ol.innerHTML = '<li class="lbl">まだ何もありません</li>';
  }

  // ---------- 送る ----------
  function stamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }
  function markSent(msg) { state.sentRev = state.rev; save(); $('sendDone').textContent = msg; }
  $('sendBtn').addEventListener('click', function () {
    var s = C.summary(state.records);
    $('sendSum').textContent = s.kinds + '種類・合計' + s.pieces + '点';
    $('sendDone').textContent = '';
    $('sendSheet').hidden = false;
  });
  $('sendClose').addEventListener('click', function () { $('sendSheet').hidden = true; });
  $('fileBtn').addEventListener('click', async function () {
    if (!C.summary(state.records).kinds) { $('sendDone').textContent = 'まだ何もありません'; return; }
    var name = '棚卸し_' + stamp() + '.csv';
    var blob = new Blob([C.toCsv(state.records)], { type: 'text/csv' });
    var file = new File([blob], name, { type: 'text/csv' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); markSent('送りました：' + name); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    markSent('保存しました：' + name);
  });
  $('copyBtn').addEventListener('click', async function () {
    var text = C.toTsv(state.records);
    if (!text) { $('sendDone').textContent = 'まだ何もありません'; return; }
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    markSent('コピーしました。TeamsやSlackに貼ってください。');
  });

  // ---------- メニュー ----------
  var standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  $('safariNotice').hidden = standalone;
  $('menuBtn').addEventListener('click', async function () {
    var persisted = false;
    try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) {}
    $('menuInfo').textContent =
      '開き方：' + (standalone ? 'ホーム画面から' : 'Safari（ブラウザ）') + '\n' +
      '記録：' + state.records.length + '回分（' + new Date(state.startedAt).toLocaleString('ja-JP') + ' から）\n' +
      '消えにくい設定：' + (persisted ? '有効' : '無効') + '\n' +
      '版：' + VERSION;
    $('menuSheet').hidden = false;
  });
  $('menuClose').addEventListener('click', function () { $('menuSheet').hidden = true; });
  $('newBtn').addEventListener('click', function () {
    var unsent = state.records.length && state.sentRev !== state.rev;
    var msg = unsent
      ? 'まだ送っていない記録があります（' + C.summary(state.records).pieces + '点）。\n本当に消して、新しい棚卸しを始めますか？'
      : '今の記録を消して、新しい棚卸しを始めますか？';
    if (!confirm(msg)) return;
    if (unsent && !confirm('もう一度確認します。送っていない記録を消してよろしいですか？')) return;
    state = { records: [], rev: 0, sentRev: 0, startedAt: new Date().toISOString() };
    typed = '';
    save(); render();
    $('statusBox').classList.remove('ok', 'bad');
    $('statusText').textContent = 'バーコードリーダーで読んでください';
    $('menuSheet').hidden = true;
  });

  render();
})();
