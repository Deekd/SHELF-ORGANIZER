/*
 * Shelf core: pure inventory logic with no DOM access.
 * Works in the browser (window.ShelfCore) and in Node (require) so it can be unit tested.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShelfCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CSV_COLUMNS = ['name', 'category', 'qty', 'unit', 'min', 'location', 'expires', 'notes'];
  const CSV_HEADERS = ['Name', 'Category', 'Quantity', 'Unit', 'Low stock at', 'Location', 'Expires', 'Notes'];

  // Header aliases accepted on import (lowercased, non-alphanumerics removed).
  const HEADER_ALIASES = {
    name: 'name', item: 'name', itemname: 'name',
    category: 'category', type: 'category', group: 'category',
    qty: 'qty', quantity: 'qty', count: 'qty', stock: 'qty', onhand: 'qty',
    unit: 'unit', units: 'unit',
    min: 'min', minimum: 'min', lowstockat: 'min', reorderat: 'min', lowstock: 'min', threshold: 'min',
    location: 'location', shelf: 'location', bin: 'location', where: 'location',
    expires: 'expires', expiry: 'expires', expiration: 'expires', expirationdate: 'expires', expirydate: 'expires', bestby: 'expires',
    notes: 'notes', note: 'notes', description: 'notes'
  };

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function toCount(value, fallback) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  function cleanText(value, max) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
  }

  // Accepts YYYY-MM-DD only, and only real calendar dates. Returns '' otherwise.
  function normalizeDate(value) {
    const s = String(value == null ? '' : value).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return '';
    const y = +m[1], mo = +m[2], d = +m[3];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
    return s;
  }

  // Coerce arbitrary input into a valid item, or null when there is no usable name.
  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = cleanText(raw.name, 120);
    if (!name) return null;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
      name: name,
      category: cleanText(raw.category, 60),
      qty: toCount(raw.qty, 0),
      unit: cleanText(raw.unit, 20),
      min: toCount(raw.min, 0),
      location: cleanText(raw.location, 80),
      expires: normalizeDate(raw.expires),
      notes: String(raw.notes == null ? '' : raw.notes).trim().slice(0, 500),
      updated: typeof raw.updated === 'string' && raw.updated ? raw.updated : new Date().toISOString()
    };
  }

  function adjustedQty(item, delta) {
    return Math.max(0, item.qty + Math.trunc(Number(delta) || 0));
  }

  // 'out' (nothing left), 'low' (at or under the alert level), or 'ok'.
  function stockStatus(item) {
    if (item.qty === 0) return 'out';
    if (item.min > 0 && item.qty <= item.min) return 'low';
    return 'ok';
  }

  function todayStr(now) {
    const d = now || new Date();
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function daysBetween(fromStr, toStrValue) {
    const a = fromStr.split('-').map(Number);
    const b = toStrValue.split('-').map(Number);
    return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
  }

  // '' (no concern), 'expired', or 'soon' (within windowDays, default 14).
  function expiryStatus(item, today, windowDays) {
    if (!item.expires) return '';
    const days = daysBetween(today, item.expires);
    if (days < 0) return 'expired';
    if (days <= (windowDays == null ? 14 : windowDays)) return 'soon';
    return '';
  }

  function categories(items) {
    const seen = new Map();
    items.forEach(function (it) {
      if (it.category) {
        const key = it.category.toLowerCase();
        if (!seen.has(key)) seen.set(key, it.category);
      }
    });
    return Array.from(seen.values()).sort(function (a, b) { return a.localeCompare(b); });
  }

  // opts: { query, category, view: 'all' | 'low' | 'expiring', today }
  function filterItems(items, opts) {
    const o = opts || {};
    const q = (o.query || '').trim().toLowerCase();
    const today = o.today || todayStr();
    return items.filter(function (it) {
      if (o.category && it.category.toLowerCase() !== o.category.toLowerCase()) return false;
      if (o.view === 'low' && stockStatus(it) === 'ok') return false;
      if (o.view === 'expiring' && !expiryStatus(it, today)) return false;
      if (q) {
        const hay = (it.name + ' ' + it.category + ' ' + it.location + ' ' + it.notes).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  // key: 'name' | 'qty' | 'category' | 'expires' | 'updated'
  function sortItems(items, key) {
    const copy = items.slice();
    const byName = function (a, b) { return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }); };
    copy.sort(function (a, b) {
      switch (key) {
        case 'qty': return a.qty - b.qty || byName(a, b);
        case 'category': return a.category.localeCompare(b.category) || byName(a, b);
        case 'expires':
          if (!a.expires && !b.expires) return byName(a, b);
          if (!a.expires) return 1;
          if (!b.expires) return -1;
          return a.expires.localeCompare(b.expires) || byName(a, b);
        case 'updated': return b.updated.localeCompare(a.updated) || byName(a, b);
        default: return byName(a, b);
      }
    });
    return copy;
  }

  function summarize(items, today) {
    const t = today || todayStr();
    let units = 0, low = 0, expiring = 0;
    items.forEach(function (it) {
      units += it.qty;
      if (stockStatus(it) !== 'ok') low++;
      if (expiryStatus(it, t)) expiring++;
    });
    return { items: items.length, units: units, low: low, expiring: expiring };
  }

  // ---------- CSV ----------

  function csvCell(value) {
    let s = String(value == null ? '' : value);
    // Stop spreadsheet apps from running cells that start with a formula character.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSV(items) {
    const lines = [CSV_HEADERS.map(csvCell).join(',')];
    items.forEach(function (it) {
      lines.push(CSV_COLUMNS.map(function (c) { return csvCell(it[c]); }).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  // Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF or LF, embedded newlines.
  function parseCSV(text) {
    const src = String(text).replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', inQuotes = false, i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(field); field = ''; rows.push(row); row = []; i++; continue;
      }
      field += ch; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return c.trim() !== ''; }); });
  }

  // Returns { items, skipped } or throws if there is no Name column.
  function itemsFromCSV(text) {
    const rows = parseCSV(text);
    if (!rows.length) throw new Error('That file is empty.');
    const map = rows[0].map(function (h) {
      return HEADER_ALIASES[String(h).toLowerCase().replace(/[^a-z0-9]/g, '')] || null;
    });
    if (map.indexOf('name') === -1) throw new Error('No "Name" column found. The first row must be a header row.');
    const items = [];
    let skipped = 0;
    rows.slice(1).forEach(function (r) {
      const raw = {};
      map.forEach(function (field, idx) {
        if (field && r[idx] !== undefined) {
          let v = r[idx];
          if (/^'[=+\-@\t\r]/.test(v)) v = v.slice(1); // undo the export guard
          raw[field] = v;
        }
      });
      const item = normalizeItem(raw);
      if (item) items.push(item); else skipped++;
    });
    return { items: items, skipped: skipped };
  }

  // Merge incoming items into existing ones. Same name (case-insensitive) + same location updates in place.
  function mergeItems(existing, incoming) {
    const result = existing.slice();
    const key = function (it) { return it.name.toLowerCase() + '|' + it.location.toLowerCase(); };
    const index = new Map(result.map(function (it, i) { return [key(it), i]; }));
    let added = 0, updated = 0;
    incoming.forEach(function (it) {
      const k = key(it);
      if (index.has(k)) {
        const i = index.get(k);
        result[i] = Object.assign({}, it, { id: result[i].id, updated: new Date().toISOString() });
        updated++;
      } else {
        index.set(k, result.length);
        result.push(it);
        added++;
      }
    });
    return { items: result, added: added, updated: updated };
  }

  function sampleItems() {
    const d = new Date();
    const inDays = function (n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); return todayStr(x); };
    const rows = [
      { name: 'Canned black beans', category: 'Canned goods', qty: 48, unit: 'cans', min: 20, location: 'Shelf A1', expires: inDays(420) },
      { name: 'Canned tomatoes', category: 'Canned goods', qty: 12, unit: 'cans', min: 15, location: 'Shelf A1', expires: inDays(300) },
      { name: 'Pasta', category: 'Dry goods', qty: 30, unit: 'boxes', min: 10, location: 'Shelf B2', expires: inDays(250) },
      { name: 'White rice (2 lb)', category: 'Dry goods', qty: 0, unit: 'bags', min: 8, location: 'Shelf B2', expires: inDays(500) },
      { name: 'Peanut butter', category: 'Spreads', qty: 22, unit: 'jars', min: 10, location: 'Shelf B3', expires: inDays(160) },
      { name: 'Milk', category: 'Refrigerated', qty: 14, unit: 'gallons', min: 6, location: 'Fridge 1', expires: inDays(6), notes: 'Use oldest first' },
      { name: 'Bread loaves', category: 'Bakery', qty: 9, unit: 'loaves', min: 5, location: 'Counter', expires: inDays(-1), notes: 'Donated yesterday' },
      { name: 'Diapers (size 3)', category: 'Non-food', qty: 40, unit: 'packs', min: 12, location: 'Back room' }
    ];
    return rows.map(normalizeItem);
  }

  return {
    CSV_COLUMNS: CSV_COLUMNS,
    uid: uid,
    normalizeItem: normalizeItem,
    normalizeDate: normalizeDate,
    adjustedQty: adjustedQty,
    stockStatus: stockStatus,
    expiryStatus: expiryStatus,
    todayStr: todayStr,
    daysBetween: daysBetween,
    categories: categories,
    filterItems: filterItems,
    sortItems: sortItems,
    summarize: summarize,
    toCSV: toCSV,
    parseCSV: parseCSV,
    itemsFromCSV: itemsFromCSV,
    mergeItems: mergeItems,
    sampleItems: sampleItems
  };
});
