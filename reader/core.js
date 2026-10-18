// 棚卸しカウントくん — 画面に依存しない部分（JANの判定・数え方の決まり・記録の集計）
// ブラウザでは window.TanaCore、Node（テスト）では module.exports で使う。
(function (root) {
  'use strict';

  // ---------- JANの判定 ----------

  // 検査数字（モジュラス10・ウェイト3-1）が合っているか
  function checkDigitOk(digits) {
    if (!/^\d+$/.test(digits)) return false;
    var sum = 0;
    var body = digits.slice(0, -1);
    for (var i = 0; i < body.length; i++) {
      var d = +body[body.length - 1 - i];
      sum += (i % 2 === 0) ? d * 3 : d;
    }
    return (10 - (sum % 10)) % 10 === +digits[digits.length - 1];
  }

  // UPC-E（8桁）をUPC-A（12桁）に展開する
  function expandUpcE(upce) {
    if (!/^[01]\d{7}$/.test(upce)) return null;
    var n = upce[0], s = upce.slice(1, 7), c = upce[7];
    var last = s[5], body;
    if (last === '0' || last === '1' || last === '2') body = s.slice(0, 2) + last + '0000' + s.slice(2, 5);
    else if (last === '3') body = s.slice(0, 3) + '00000' + s.slice(3, 5);
    else if (last === '4') body = s.slice(0, 4) + '00000' + s[4];
    else body = s.slice(0, 5) + '0000' + last;
    return n + body + c;
  }

  // 読み取り結果（形式と文字）を、数える用のJANにそろえる。数えないものは null
  // 13桁：そのまま／8桁：そのまま／UPC-A 12桁：先頭に0を付けて13桁／UPC-E：展開して13桁
  // （部品の版3では、UPC-A・UPC-Eは最初から先頭0付きの13桁で返ってくるが、どちらでも受ける）
  var JAN_FORMATS = { EAN13: 1, EAN8: 1, UPCA: 1, UPCE: 1 };
  function normalizeJan(format, text) {
    text = String(text || '').trim();
    var f = String(format || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!JAN_FORMATS[f] || !/^\d+$/.test(text)) return null;
    var out = null;
    if (text.length === 13) out = text;
    else if (text.length === 12) out = '0' + text;
    else if (text.length === 8 && f === 'UPCE') {
      var a = expandUpcE(text);
      out = a ? '0' + a : null;
    } else if (text.length === 8) out = text;
    if (out && !checkDigitOk(out)) return null;
    return out;
  }

  // 手入力・スキャナーの数字をJANにそろえる（12桁はUPC-Aとして13桁に）
  function normalizeTyped(digits) {
    digits = String(digits || '').replace(/\D/g, '');
    if (digits.length === 13) return checkDigitOk(digits) ? digits : null;
    if (digits.length === 8) return checkDigitOk(digits) ? digits : null;
    if (digits.length === 12) return checkDigitOk(digits) ? '0' + digits : null;
    return null;
  }

  // ---------- 数え方の決まり ----------
  // ・2回続けて同じ番号が読めた時だけ数える（読み間違い対策）
  // ・違うJANが来たら、すぐ1個数える
  // ・同じJANは、最後に読めてから gapMs 何も読めなかった後に、また読めたら次の1個
  function createCounter(opts) {
    opts = opts || {};
    var gapMs = opts.gapMs || 600;          // 「枠から外れた」とみなす時間
    var confirmHits = opts.confirmHits || 2; // 何回続けて読めたら数えるか
    var confirmWindowMs = opts.confirmWindowMs || 500; // 続けて読めたとみなす間隔

    var current = null;     // いま枠の中にあって、もう数えたJAN
    var lastSeenAt = 0;
    var pending = null;     // 数える前の確認中のJAN
    var pendingHits = 0;
    var pendingAt = 0;

    function expire(t) {
      if (current && t - lastSeenAt >= gapMs) current = null;
      if (pending && t - pendingAt > confirmWindowMs) { pending = null; pendingHits = 0; }
    }

    // 1コマごとに呼ぶ。code は読めたJAN（読めなかったら null）。数えるべき時はそのJANを返す
    function frame(code, t) {
      expire(t);
      if (!code) return null;
      if (code === current) { lastSeenAt = t; return null; }
      if (code === pending) pendingHits++;
      else { pending = code; pendingHits = 1; }
      pendingAt = t;
      if (pendingHits >= confirmHits) {
        current = code; lastSeenAt = t;
        pending = null; pendingHits = 0;
        return code;
      }
      return null;
    }

    function reset() { current = null; pending = null; pendingHits = 0; }
    function state() { return { current: current, pending: pending, pendingHits: pendingHits }; }

    return { frame: frame, reset: reset, state: state, setGap: function (ms) { gapMs = ms; } };
  }

  // ---------- 記録の集計 ----------
  // 記録は1回ごとの行：{ id, t, jan, qty, src }（src: cam / kb / man / edit）
  function totals(records) {
    var map = new Map();
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (!map.has(r.jan)) map.set(r.jan, { jan: r.jan, qty: 0, firstAt: r.t, lastAt: r.t, count: 0 });
      var e = map.get(r.jan);
      e.qty += r.qty; e.lastAt = r.t; e.count++;
    }
    return Array.from(map.values()); // 最初に読んだ順
  }

  function summary(records) {
    var list = totals(records).filter(function (e) { return e.qty !== 0; });
    var pieces = 0;
    list.forEach(function (e) { pieces += e.qty; });
    return { pieces: pieces, kinds: list.length };
  }

  // ---------- 商品マスタ ----------
  var UNKNOWN = '不明';

  // CSVの文字列を行と列に分ける（"…" の中のカンマ・改行・"" にも対応）
  function parseCsvRows(text) {
    text = String(text || '').replace(/^﻿/, '');
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
        } else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  // 「JAN,商品名」のCSVを読む。見出し行は飛ばす。正しくないJANは bad に入れる
  function parseMasterCsv(text) {
    var items = {}, count = 0, bad = [];
    parseCsvRows(text).forEach(function (r) {
      var raw = (r[0] || '').trim();
      if (!raw || raw === 'JAN') return;
      var jan = normalizeTyped(raw);
      if (!jan || !/^\d+$/.test(raw)) { bad.push(raw); return; }
      if (!(jan in items)) count++;
      items[jan] = (r[1] || '').trim();
    });
    return { items: items, count: count, bad: bad };
  }

  function nameOf(names, jan) {
    return names && Object.prototype.hasOwnProperty.call(names, jan) ? names[jan] : UNKNOWN;
  }
  function csvCell(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

  // Excelに貼る用：「JAN（タブ）商品名（タブ）数量」。個数0のJANは出さない
  function toTsv(records, names) {
    return totals(records)
      .filter(function (e) { return e.qty !== 0; })
      .map(function (e) { return e.jan + '\t' + nameOf(names, e.jan).replace(/[\t\r\n]/g, ' ') + '\t' + e.qty; })
      .join('\n');
  }

  // 記録用のCSV「JAN,商品名,数量」（Excelで文字化けしないよう先頭にBOM）
  function toCsv(records, names) {
    var rows = ['JAN,商品名,数量'];
    totals(records).forEach(function (e) {
      if (e.qty !== 0) rows.push(e.jan + ',' + csvCell(nameOf(names, e.jan)) + ',' + e.qty);
    });
    return '﻿' + rows.join('\r\n') + '\r\n';
  }

  var api = {
    checkDigitOk: checkDigitOk,
    expandUpcE: expandUpcE,
    normalizeJan: normalizeJan,
    normalizeTyped: normalizeTyped,
    createCounter: createCounter,
    totals: totals,
    summary: summary,
    toTsv: toTsv,
    toCsv: toCsv,
    parseMasterCsv: parseMasterCsv,
    nameOf: nameOf,
    UNKNOWN: UNKNOWN
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TanaCore = api;
})(typeof self !== 'undefined' ? self : this);
