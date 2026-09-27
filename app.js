// 棚卸しカウントくん — 画面と処理
(function () {
  'use strict';
  var VERSION = '2026-09-27-1';
  var STORE_KEY = 'tana.v1';
  var SCAN_INTERVAL_MS = 80;     // 読み取りは1秒に12回ぐらいまで
  var IDLE_PAUSE_MS = 45000;     // これだけ何も読めなかったら一時停止（発熱・電池対策）
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
    catch (e) { alert('保存できませんでした。記録が消えないうちに「送る」で控えを送ってください。'); }
  }
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(function () {});
  }

  var seq = 0;
  function addRecord(jan, qty, src) {
    state.records.push({ id: Date.now() + '-' + (seq++), t: new Date().toISOString(), jan: jan, qty: qty, src: src });
    state.rev++;
    save();
    render();
  }
  function janTotal(jan) {
    var q = 0;
    state.records.forEach(function (r) { if (r.jan === jan) q += r.qty; });
    return q;
  }
  function lastRecord() { return state.records[state.records.length - 1] || null; }

  // ---------- 表示 ----------
  function render() {
    var last = lastRecord();
    $('lastEmpty').hidden = !!last;
    $('lastBody').hidden = !last;
    $('undoBtn').disabled = !last;
    if (last) {
      $('lastJan').textContent = last.jan;
      $('lastQty').textContent = last.qty;
      $('lastQtyBtn').hidden = last.src === 'edit';
      $('lastEditNote').hidden = last.src !== 'edit';
      $('lastTotal').textContent = janTotal(last.jan);
    }
    var s = C.summary(state.records);
    $('sumPieces').textContent = s.pieces;
    $('sumKinds').textContent = s.kinds;
    renderSpeed();
  }

  // 読めた合図：画面の点滅が主役、音は補助
  var audioCtx = null;
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  }
  function beep(freq) {
    if (!audioCtx) return;
    try {
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; o.type = 'square';
      g.gain.setValueAtTime(0.12, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.09);
    } catch (e) {}
  }
  function signal(isSameAsBefore) {
    var f = $('flash');
    f.classList.remove('on', 'same');
    void f.offsetWidth; // アニメーションをやり直すため
    if (isSameAsBefore) f.classList.add('same');
    f.classList.add('on');
    beep(isSameAsBefore ? 1300 : 1900);
  }

  function counted(jan, src) {
    var last = lastRecord();
    var same = !!last && last.jan === jan;
    addRecord(jan, 1, src);
    signal(same);
  }

  // ---------- カメラ ----------
  var video = $('video');
  var stream = null, running = false, wantRunning = false, blocked = false;
  var counter = C.createCounter({ gapMs: 600 });
  var canvas = document.createElement('canvas');
  var ctx2d = canvas.getContext('2d', { willReadFrequently: true });
  var lastCodeAt = 0, fpsCount = 0, fpsAt = 0, fps = 0;
  var wakeLock = null;

  var zxingReady = window.ZXingWASM.prepareZXingModule({
    overrides: {
      // 部品の本体は同じサイトから読む（何も指定しないと外のサイトへ取りに行くため）
      locateFile: function (path, prefix) {
        return /\.wasm$/.test(path) ? new URL(path, location.href).href : prefix + path;
      }
    },
    fireImmediately: true
  });
  var READER_OPTIONS = {
    formats: ['EAN13', 'EAN8', 'UPCA', 'UPCE'],
    tryHarder: true,
    tryRotate: false,
    tryInvert: false,
    maxNumberOfSymbols: 2
  };

  async function startCamera() {
    unlockAudio();
    $('camErr').hidden = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
    } catch (e) {
      $('camErr').hidden = false;
      $('camErr').textContent = cameraErrorMessage(e);
      return;
    }
    video.srcObject = stream;
    try { await video.play(); } catch (e) {}
    try { await zxingReady; } catch (e) {
      $('camErr').hidden = false;
      $('camErr').textContent = '読み取りの部品を読み込めませんでした。ページを開き直してください。';
      return;
    }
    wantRunning = true;
    running = true;
    lastCodeAt = performance.now();
    counter.reset();
    $('camMsg').hidden = true;
    $('pauseBtn').hidden = false;
    $('pauseBtn').textContent = '一時停止';
    setupZoom();
    requestWakeLock();
    loop();
  }
  function stopCamera() {
    running = false;
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    video.srcObject = null;
    $('zoomBox').hidden = true;
    releaseWakeLock();
  }
  function pauseCamera(msg) {
    wantRunning = false;
    stopCamera();
    $('pauseBtn').hidden = true;
    $('camMsg').hidden = false;
    $('startBtn').textContent = '再開する';
    $('camStatus').textContent = '';
    var hint = document.querySelector('.cam-msg .hint');
    if (msg) hint.textContent = msg;
  }
  function cameraErrorMessage(e) {
    if (e && e.name === 'NotAllowedError') return 'カメラが許可されていません。設定 → Safari → カメラ で許可してから、もう一度お試しください。';
    if (e && e.name === 'NotFoundError') return 'カメラが見つかりませんでした。';
    return 'カメラを起動できませんでした（' + (e && e.name || '不明') + '）。';
  }

  // 画面の枠の部分だけを映像から切り出す
  function cropFrame() {
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    var box = $('camBox').getBoundingClientRect();
    var fr = $('frame').getBoundingClientRect();
    var scale = Math.max(box.width / vw, box.height / vh); // object-fit: cover
    var offX = (box.width - vw * scale) / 2, offY = (box.height - vh * scale) / 2;
    var pad = 12; // 枠より少しだけ広めに
    var sx = Math.max(0, (fr.left - box.left - offX - pad) / scale);
    var sy = Math.max(0, (fr.top - box.top - offY - pad) / scale);
    var sw = Math.min(vw - sx, (fr.width + pad * 2) / scale);
    var sh = Math.min(vh - sy, (fr.height + pad * 2) / scale);
    var k = Math.min(1, 1280 / sw);
    var dw = Math.round(sw * k), dh = Math.round(sh * k);
    if (canvas.width !== dw) canvas.width = dw;
    if (canvas.height !== dh) canvas.height = dh;
    ctx2d.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
    return ctx2d.getImageData(0, 0, dw, dh);
  }

  async function loop() {
    if (!running) return;
    var t0 = performance.now();
    if (!blocked && video.readyState >= 2) {
      var code = null, multi = false;
      try {
        var img = cropFrame();
        if (img) {
          var res = await window.ZXingWASM.readBarcodes(img, READER_OPTIONS);
          var codes = [];
          res.forEach(function (r) {
            if (!r.isValid) return;
            var j = C.normalizeJan(r.format, r.text);
            if (j && codes.indexOf(j) < 0) codes.push(j);
          });
          if (codes.length === 1) code = codes[0];
          else if (codes.length > 1) multi = true; // 2つ映っている時は数えない
        }
      } catch (e) {}
      var now = performance.now();
      if (code) lastCodeAt = now;
      var hit = counter.frame(code, now);
      if (hit) counted(hit, 'cam');
      $('frame').classList.toggle('hit', !!code);
      $('frame').classList.toggle('multi', multi);
      fpsCount++;
      if (now - fpsAt >= 1000) { fps = fpsCount; fpsCount = 0; fpsAt = now; }
      $('camStatus').textContent = multi ? 'バーコードが2つ映っています' : ('読み取り ' + fps + '回/秒');
      if (now - lastCodeAt > IDLE_PAUSE_MS) {
        pauseCamera('しばらく読めなかったので一時停止しました。');
        return;
      }
    }
    if (!running) return;
    setTimeout(loop, Math.max(0, SCAN_INTERVAL_MS - (performance.now() - t0)));
  }

  // ズーム（使えるiPhoneだけ）
  function setupZoom() {
    var box = $('zoomBox');
    box.innerHTML = '';
    box.hidden = true;
    var track = stream && stream.getVideoTracks()[0];
    var caps = track && track.getCapabilities ? track.getCapabilities() : {};
    if (!caps.zoom) return;
    var saved = +(localStorage.getItem('tana.zoom') || 1);
    [1, 1.5, 2].forEach(function (z) {
      if (z < caps.zoom.min || z > caps.zoom.max) return;
      var b = document.createElement('button');
      b.textContent = z + '×';
      b.addEventListener('click', function () { applyZoom(z); });
      b.dataset.z = z;
      box.appendChild(b);
    });
    if (box.children.length > 1) { box.hidden = false; applyZoom(saved); }
  }
  function applyZoom(z) {
    var track = stream && stream.getVideoTracks()[0];
    if (!track) return;
    track.applyConstraints({ advanced: [{ zoom: z }] }).catch(function () {});
    try { localStorage.setItem('tana.zoom', z); } catch (e) {}
    Array.prototype.forEach.call($('zoomBox').children, function (b) { b.classList.toggle('on', +b.dataset.z === z); });
  }

  // 画面を点けたままにする
  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; } }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (running) stopCamera(); }
    else if (wantRunning) startCamera();
  });

  $('startBtn').addEventListener('click', startCamera);
  $('pauseBtn').addEventListener('click', function () { pauseCamera('一時停止中です。'); });

  // ---------- Bluetoothスキャナー（キーボードとして入ってくる） ----------
  // 数字が速く続いて最後にEnter、をスキャンとみなす。入力欄を使わず画面全体で拾う
  var kbBuf = '', kbFirst = 0, kbLast = 0;
  window.addEventListener('keydown', function (e) {
    var now = performance.now();
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      if (now - kbLast > 100) { kbBuf = ''; kbFirst = now; }
      kbBuf += e.key; kbLast = now;
    } else if (e.key === 'Enter') {
      e.preventDefault(); // ボタンに残ったフォーカスがEnterで押されないように
      var n = kbBuf.length;
      var fast = n >= 8 && (kbLast - kbFirst) / (n - 1) < 60 && now - kbLast < 150;
      var jan = fast ? C.normalizeTyped(kbBuf) : null;
      kbBuf = '';
      if (jan) {
        unlockAudio();
        if (!$('padSheet').hidden) closePad();
        counted(jan, 'kb');
      }
    }
  }, true);
  // ボタンを押した後にフォーカスを残さない
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button');
    if (b) setTimeout(function () { b.blur(); }, 0);
  });

  // ---------- 取り消し・打ち直し ----------
  $('undoBtn').addEventListener('click', function () {
    var last = state.records.pop();
    if (!last) return;
    state.rev++;
    save();
    counter.reset();
    render();
  });

  // ---------- 数字キー ----------
  var pad = null; // { mode, value, maxLen, onOk }
  (function buildPad() {
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'];
    keys.forEach(function (k) {
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
    blocked = true;
  }
  function closePad() { $('padSheet').hidden = true; pad = null; unblock(); }
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

  $('lastQtyBtn').addEventListener('click', function () {
    var last = lastRecord();
    if (!last || last.src === 'edit') return;
    openPad({
      mode: 'qty', maxLen: 4, title: 'この回の個数を打ち直す', sub: last.jan, value: '',
      onOk: function (v) {
        if (v === '') return '個数を入れてください';
        var cur = lastRecord();
        if (!cur || cur.id !== last.id) return null;
        cur.qty = +v;
        state.rev++; save(); render();
        return null;
      }
    });
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
  $('listBtn').addEventListener('click', function () { renderList(); $('listSheet').hidden = false; blocked = true; });
  $('listClose').addEventListener('click', function () { $('listSheet').hidden = true; unblock(); });
  function renderList() {
    var list = C.totals(state.records).filter(function (e) { return e.qty !== 0; });
    var last = lastRecord();
    var s = C.summary(state.records);
    $('listSum').textContent = s.kinds + '種類・' + s.pieces + '点';
    var ol = $('listBody');
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
            if (delta !== 0) addRecord(e.jan, delta, 'edit');
            renderList();
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
    $('sendSheet').hidden = false; blocked = true;
  });
  $('sendClose').addEventListener('click', function () { $('sendSheet').hidden = true; unblock(); });
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
  $('fileBtn').addEventListener('click', async function () {
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
    $('menuSheet').hidden = false; blocked = true;
  });
  $('menuClose').addEventListener('click', function () { $('menuSheet').hidden = true; unblock(); });
  $('newBtn').addEventListener('click', function () {
    var unsent = state.records.length && state.sentRev !== state.rev;
    var msg = unsent
      ? 'まだ送っていない記録があります（' + C.summary(state.records).pieces + '点）。\n本当に消して、新しい棚卸しを始めますか？'
      : '今の記録を消して、新しい棚卸しを始めますか？';
    if (!confirm(msg)) return;
    if (unsent && !confirm('もう一度確認します。送っていない記録を消してよろしいですか？')) return;
    state = { records: [], rev: 0, sentRev: 0, startedAt: new Date().toISOString() };
    save(); counter.reset(); speed = null; render();
    $('menuSheet').hidden = true; unblock();
  });

  function unblock() {
    if ($('padSheet').hidden && $('listSheet').hidden && $('sendSheet').hidden && $('menuSheet').hidden) {
      blocked = false;
      counter.reset();
      lastCodeAt = performance.now();
    }
  }

  // ---------- 1分計測（試作の合格ラインを測る用） ----------
  var speed = null; // { startAt, startPieces, timer }
  $('speedBtn').addEventListener('click', function () {
    if (speed && speed.timer) { clearInterval(speed.timer); speed = null; renderSpeed(); return; }
    speed = { startAt: Date.now(), startPieces: C.summary(state.records).pieces };
    speed.timer = setInterval(renderSpeed, 250);
    renderSpeed();
  });
  function renderSpeed() {
    if (!speed) { $('speedOut').textContent = ''; $('speedBtn').textContent = '1分計測'; return; }
    var got = C.summary(state.records).pieces - speed.startPieces;
    var left = 60 - Math.floor((Date.now() - speed.startAt) / 1000);
    if (left <= 0 && speed.timer) {
      clearInterval(speed.timer); speed.timer = null;
      speed.result = got;
      beep(900);
    }
    if (speed.timer) { $('speedBtn').textContent = 'やめる'; $('speedOut').textContent = '残り' + left + '秒・' + got + '点'; }
    else { $('speedBtn').textContent = 'もう一度'; $('speedOut').textContent = '1分で ' + speed.result + '点'; }
  }

  render();
})();
