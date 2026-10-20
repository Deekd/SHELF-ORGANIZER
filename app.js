/* Shelf UI. All data lives in localStorage; nothing leaves the browser. */
(function () {
  'use strict';

  const C = window.ShelfCore;
  const KEY = 'shelf.v1';
  const WHO_KEY = 'shelf.who';
  const LOG_MAX = 500;
  const COALESCE_MS = 60 * 1000;
  const DEFAULT_TITLE = document.title;

  const $ = function (id) { return document.getElementById(id); };

  let state = load();
  const filters = { query: '', category: '', view: 'all', sort: 'name' };
  let editingId = null;
  let toastTimer = null;

  // ---------- storage ----------

  function clean(data) {
    const d = data && typeof data === 'object' ? data : {};
    const num = function (v) { return typeof v === 'number' && isFinite(v) ? v : 0; };
    return {
      org: typeof d.org === 'string' ? d.org.slice(0, 60) : '',
      items: (Array.isArray(d.items) ? d.items : []).map(C.normalizeItem).filter(Boolean),
      log: (Array.isArray(d.log) ? d.log : [])
        .filter(function (e) { return e && typeof e.t === 'string' && typeof e.text === 'string'; })
        .slice(0, LOG_MAX)
        .map(function (e) {
          return {
            t: e.t, text: e.text.slice(0, 300), who: String(e.who || '').slice(0, 40),
            kind: String(e.kind || ''), itemId: String(e.itemId || ''), delta: num(e.delta), qty: num(e.qty), name: String(e.name || '').slice(0, 120)
          };
        })
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return clean(JSON.parse(raw));
    } catch (e) { /* corrupt or blocked storage: start fresh */ }
    return { org: '', items: [], log: [] };
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      toast("Couldn't save: browser storage is full or blocked. Download a backup now.");
    }
  }

  function who() {
    try { return localStorage.getItem(WHO_KEY) || ''; } catch (e) { return ''; }
  }

  // ---------- history ----------

  function record(entry) {
    const e = Object.assign({ t: new Date().toISOString(), who: who(), kind: '', itemId: '', delta: 0, qty: 0, name: '' }, entry);
    state.log.unshift(e);
    if (state.log.length > LOG_MAX) state.log.length = LOG_MAX;
  }

  function recordAdjust(item, delta) {
    const now = Date.now();
    const top = state.log[0];
    const name = who();
    if (top && top.kind === 'adjust' && top.itemId === item.id && top.who === name && now - Date.parse(top.t) < COALESCE_MS) {
      top.delta += delta;
      top.qty = item.qty;
      top.t = new Date(now).toISOString();
      top.text = adjustText(item.name, top.delta, item.qty);
      return;
    }
    record({ kind: 'adjust', itemId: item.id, name: item.name, delta: delta, qty: item.qty, text: adjustText(item.name, delta, item.qty) });
  }

  function adjustText(name, delta, qty) {
    return name + ': ' + (delta > 0 ? '+' : '') + delta + ' (now ' + qty + ')';
  }

  // ---------- DOM helper ----------

  function h(tag, attrs) {
    const el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      const v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (let i = 2; i < arguments.length; i++) {
      const kid = arguments[i];
      if (kid == null || kid === false) continue;
      if (Array.isArray(kid)) kid.forEach(function (k) { el.append(k); });
      else el.append(kid);
    }
    return el;
  }

  // ---------- rendering ----------

  function render() {
    renderStats();
    renderCategories();
    renderList();
  }

  function renderStats() {
    const s = C.summarize(state.items);
    const stat = function (n, label, alert) {
      return h('div', { class: 'stat' + (alert && n > 0 ? ' alert' : '') }, h('b', {}, String(n)), h('span', {}, label));
    };
    $('stats').replaceChildren(
      stat(s.items, 'Items'),
      stat(s.units, 'Total units'),
      stat(s.low, 'Low or out', true),
      stat(s.expiring, 'Expired / expiring', true)
    );
  }

  function renderCategories() {
    const cats = C.categories(state.items);
    const select = $('category');
    if (filters.category && !cats.some(function (c) { return c.toLowerCase() === filters.category.toLowerCase(); })) filters.category = '';
    select.replaceChildren(h('option', { value: '' }, 'All categories'));
    cats.forEach(function (c) { select.append(h('option', { value: c }, c)); });
    select.value = filters.category;
    $('categoryList').replaceChildren.apply($('categoryList'), cats.map(function (c) { return h('option', { value: c }); }));
  }

  function renderList() {
    const today = C.todayStr();
    const shown = C.sortItems(C.filterItems(state.items, {
      query: filters.query, category: filters.category, view: filters.view, today: today
    }), filters.sort);

    $('list').replaceChildren.apply($('list'), shown.map(function (it) { return row(it, today); }));

    const empty = $('empty');
    if (!state.items.length) {
      empty.hidden = false;
      empty.replaceChildren(
        h('p', {}, h('strong', {}, 'Nothing here yet.')),
        h('p', {}, 'Add your first item, import a spreadsheet, or look around with sample data.'),
        h('button', { class: 'btn primary', type: 'button', onclick: function () { openItem(null); } }, '+ Add item'),
        h('button', { class: 'btn', type: 'button', onclick: function () { $('importBtn').click(); } }, 'Import CSV…'),
        h('button', { class: 'btn', type: 'button', onclick: loadSample }, 'Load sample data')
      );
    } else if (!shown.length) {
      empty.hidden = false;
      empty.replaceChildren(h('p', {}, 'No items match these filters.'));
    } else {
      empty.hidden = true;
    }
  }

  function row(it, today) {
    const status = C.stockStatus(it);
    const exp = C.expiryStatus(it, today);

    const meta = [];
    if (it.category) meta.push(h('span', {}, it.category));
    if (it.location) meta.push(h('span', {}, 'Location: ' + it.location));
    if (it.expires) meta.push(h('span', {}, 'Expires ' + it.expires));
    if (it.min > 0) meta.push(h('span', {}, 'Alert at ' + it.min));

    const badges = [];
    if (status === 'out') badges.push(h('span', { class: 'badge out' }, 'Out of stock'));
    else if (status === 'low') badges.push(h('span', { class: 'badge low' }, 'Low stock'));
    if (exp === 'expired') badges.push(h('span', { class: 'badge expired' }, 'Expired'));
    else if (exp === 'soon') badges.push(h('span', { class: 'badge soon' }, 'Expires soon'));

    const qtyInput = h('input', {
      class: 'qty', type: 'number', min: '0', step: '1', inputmode: 'numeric', value: String(it.qty),
      'aria-label': 'Quantity of ' + it.name,
      onchange: function (e) { setQty(it.id, e.target.value); }
    });

    return h('li', { class: 'row ' + status },
      h('div', { class: 'info' },
        h('div', { class: 'name' }, it.name),
        meta.length ? h('div', { class: 'meta' }, meta) : null,
        it.notes ? h('div', { class: 'meta' }, h('span', {}, it.notes)) : null,
        badges.length ? h('div', { class: 'badges' }, badges) : null
      ),
      h('div', { class: 'qty-col' },
        h('div', { class: 'stepper' },
          h('button', { class: 'step', type: 'button', 'data-id': it.id, 'data-kind': 'dec', 'aria-label': 'Remove one ' + it.name, onclick: function () { adjust(it.id, -1, 'dec'); } }, '−'),
          qtyInput,
          h('button', { class: 'step', type: 'button', 'data-id': it.id, 'data-kind': 'inc', 'aria-label': 'Add one ' + it.name, onclick: function () { adjust(it.id, 1, 'inc'); } }, '+')
        ),
        h('div', { class: 'unit' }, it.unit)
      ),
      h('button', { class: 'btn edit', type: 'button', 'aria-label': 'Edit ' + it.name, onclick: function () { openItem(it.id); } }, 'Edit')
    );
  }

  // ---------- actions ----------

  function find(id) {
    return state.items.find(function (it) { return it.id === id; });
  }

  function adjust(id, delta, focusKind) {
    const it = find(id);
    if (!it) return;
    const next = C.adjustedQty(it, delta);
    if (next === it.qty) return;
    const applied = next - it.qty;
    it.qty = next;
    it.updated = new Date().toISOString();
    recordAdjust(it, applied);
    save();
    render();
    if (focusKind) {
      const btn = document.querySelector('button[data-id="' + id + '"][data-kind="' + focusKind + '"]');
      if (btn) btn.focus();
    }
  }

  function setQty(id, raw) {
    const it = find(id);
    if (!it) return;
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < 0) {
      toast('Quantity must be a whole number, 0 or more.');
      render();
      return;
    }
    adjust(id, n - it.qty, null);
  }

  function loadSample() {
    state.items = C.sampleItems();
    state.log = [];
    record({ kind: 'import', text: 'Loaded sample data' });
    save();
    render();
  }

  // ---------- add / edit dialog ----------

  function openItem(id) {
    const form = $('itemForm');
    const it = id ? find(id) : null;
    editingId = it ? it.id : null;
    form.reset();
    $('formError').hidden = true;
    $('itemTitle').textContent = it ? 'Edit item' : 'Add item';
    $('deleteBtn').hidden = !it;
    const f = form.elements;
    f.name.value = it ? it.name : '';
    f.category.value = it ? it.category : (filters.category || '');
    f.location.value = it ? it.location : '';
    f.qty.value = it ? it.qty : 0;
    f.unit.value = it ? it.unit : '';
    f.min.value = it ? it.min : 0;
    f.expires.value = it ? it.expires : '';
    f.notes.value = it ? it.notes : '';
    $('itemDialog').showModal();
    f.name.focus();
  }

  function closeItem() {
    $('itemDialog').close();
  }

  function showFormError(msg, field) {
    const box = $('formError');
    box.textContent = msg;
    box.hidden = false;
    if (field) field.focus();
  }

  function whole(value) {
    const s = String(value).trim();
    if (s === '') return 0;
    const n = Number(s);
    return Number.isInteger(n) && n >= 0 ? n : NaN;
  }

  function submitItem(e) {
    e.preventDefault();
    const f = $('itemForm').elements;
    const name = f.name.value.trim();
    if (!name) return showFormError('Please enter a name.', f.name);
    const qty = whole(f.qty.value);
    if (isNaN(qty)) return showFormError('Quantity must be a whole number, 0 or more.', f.qty);
    const min = whole(f.min.value);
    if (isNaN(min)) return showFormError('The alert level must be a whole number, 0 or more.', f.min);
    if (f.expires.value && !C.normalizeDate(f.expires.value)) return showFormError('That date is not valid.', f.expires);

    const raw = {
      name: name, category: f.category.value, location: f.location.value, qty: qty, unit: f.unit.value,
      min: min, expires: f.expires.value, notes: f.notes.value, updated: new Date().toISOString()
    };

    if (editingId) {
      const old = find(editingId);
      const item = C.normalizeItem(Object.assign({}, raw, { id: editingId }));
      const i = state.items.indexOf(old);
      state.items[i] = item;
      if (old.qty !== item.qty) {
        record({ kind: 'edit', itemId: item.id, name: item.name, qty: item.qty, text: item.name + ': quantity set to ' + item.qty + ' (was ' + old.qty + ')' });
      } else {
        record({ kind: 'edit', itemId: item.id, name: item.name, qty: item.qty, text: item.name + ': details edited' });
      }
    } else {
      const item = C.normalizeItem(raw);
      state.items.push(item);
      record({ kind: 'add', itemId: item.id, name: item.name, qty: item.qty, text: item.name + ': added (' + item.qty + ')' });
    }
    save();
    closeItem();
    render();
  }

  function deleteEditing() {
    const it = find(editingId);
    if (!it) return;
    if (!window.confirm('Delete "' + it.name + '"? You can undo this right after.')) return;
    const index = state.items.indexOf(it);
    state.items.splice(index, 1);
    record({ kind: 'delete', itemId: it.id, name: it.name, text: it.name + ': deleted' });
    save();
    closeItem();
    render();
    toast('Deleted "' + it.name + '"', 'Undo', function () {
      state.items.splice(Math.min(index, state.items.length), 0, it);
      record({ kind: 'restore', itemId: it.id, name: it.name, qty: it.qty, text: it.name + ': restored' });
      save();
      render();
    });
  }

  // ---------- history dialog ----------

  function openHistory() {
    const list = $('historyList');
    if (!state.log.length) {
      list.replaceChildren(h('li', {}, 'No activity yet.'));
    } else {
      list.replaceChildren.apply(list, state.log.map(function (e) {
        const when = new Date(e.t);
        return h('li', {},
          h('time', { datetime: e.t }, isNaN(when) ? e.t : when.toLocaleString()),
          e.text + (e.who ? ' — ' + e.who : '')
        );
      }));
    }
    $('historyDialog').showModal();
  }

  // ---------- export / import ----------

  function slug() {
    return (state.org || 'inventory').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'inventory';
  }

  function download(filename, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportCSV() {
    download(slug() + '-' + C.todayStr() + '.csv', '﻿' + C.toCSV(C.sortItems(state.items, 'name')), 'text/csv;charset=utf-8');
  }

  function exportBackup() {
    const data = { app: 'shelf', version: 1, exported: new Date().toISOString(), org: state.org, items: state.items, log: state.log };
    download(slug() + '-backup-' + C.todayStr() + '.json', JSON.stringify(data, null, 2), 'application/json');
  }

  function importFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast('That file is too large (5 MB limit).');
    const reader = new FileReader();
    reader.onerror = function () { toast("Couldn't read that file."); };
    reader.onload = function () {
      const text = String(reader.result);
      try {
        if (/\.json$/i.test(file.name) || /^\s*\{/.test(text)) importBackup(text);
        else importCSV(text);
      } catch (err) {
        toast(err.message || "Couldn't import that file.");
      }
    };
    reader.readAsText(file);
  }

  function importBackup(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('That file is not a valid backup.'); }
    if (!data || !Array.isArray(data.items)) throw new Error('That file is not a Shelf backup.');
    const next = clean(data);
    if (!window.confirm('Replace everything here with this backup (' + next.items.length + ' items)? This cannot be undone.')) return;
    state = next;
    record({ kind: 'import', text: 'Restored backup (' + next.items.length + ' items)' });
    save();
    syncOrg();
    render();
    toast('Backup restored.');
  }

  function importCSV(text) {
    const res = C.itemsFromCSV(text);
    if (!res.items.length) throw new Error('No usable rows found in that file.');
    if (!window.confirm('Import ' + res.items.length + ' items? Items with the same name and location are updated; the rest are added.')) return;
    const merged = C.mergeItems(state.items, res.items);
    state.items = merged.items;
    record({ kind: 'import', text: 'Imported CSV: ' + merged.added + ' added, ' + merged.updated + ' updated' });
    save();
    render();
    toast('Imported: ' + merged.added + ' added, ' + merged.updated + ' updated' + (res.skipped ? ', ' + res.skipped + ' skipped.' : '.'));
  }

  function clearAll() {
    if (!window.confirm('Delete ALL items and history in this browser? Download a backup first if you might need it. This cannot be undone.')) return;
    state = { org: state.org, items: [], log: [] };
    save();
    render();
  }

  // ---------- toast ----------

  function toast(message, actionLabel, action) {
    const el = $('toast');
    clearTimeout(toastTimer);
    el.replaceChildren(h('span', {}, message));
    if (actionLabel) {
      el.append(h('button', { type: 'button', onclick: function () { el.hidden = true; action(); } }, actionLabel));
    }
    el.hidden = false;
    toastTimer = setTimeout(function () { el.hidden = true; }, actionLabel ? 8000 : 5000);
  }

  // ---------- wiring ----------

  function syncOrg() {
    $('orgName').value = state.org;
    document.title = state.org ? state.org + ' – Inventory' : DEFAULT_TITLE;
  }

  function init() {
    syncOrg();
    $('who').value = who();

    $('orgName').addEventListener('input', function (e) {
      state.org = e.target.value.slice(0, 60);
      document.title = state.org ? state.org + ' – Inventory' : DEFAULT_TITLE;
      save();
    });
    $('who').addEventListener('input', function (e) {
      try { localStorage.setItem(WHO_KEY, e.target.value); } catch (err) { /* ignore */ }
    });

    $('search').addEventListener('input', function (e) { filters.query = e.target.value; renderList(); });
    $('category').addEventListener('change', function (e) { filters.category = e.target.value; renderList(); });
    $('sort').addEventListener('change', function (e) { filters.sort = e.target.value; renderList(); });
    document.querySelectorAll('.seg button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        filters.view = btn.getAttribute('data-view');
        document.querySelectorAll('.seg button').forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
        renderList();
      });
    });

    $('addBtn').addEventListener('click', function () { openItem(null); });
    $('itemForm').addEventListener('submit', submitItem);
    $('cancelBtn').addEventListener('click', closeItem);
    $('deleteBtn').addEventListener('click', deleteEditing);
    $('historyClose').addEventListener('click', function () { $('historyDialog').close(); });

    const menu = $('menu');
    menu.addEventListener('click', function (e) { if (e.target.closest('button')) menu.open = false; });
    document.addEventListener('click', function (e) { if (menu.open && !menu.contains(e.target)) menu.open = false; });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') menu.open = false; });

    $('historyBtn').addEventListener('click', openHistory);
    $('exportCsvBtn').addEventListener('click', exportCSV);
    $('backupBtn').addEventListener('click', exportBackup);
    $('printBtn').addEventListener('click', function () { window.print(); });
    $('clearBtn').addEventListener('click', clearAll);
    $('importBtn').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function (e) {
      importFile(e.target.files[0]);
      e.target.value = '';
    });

    // Keep several open tabs in sync.
    window.addEventListener('storage', function (e) {
      if (e.key === KEY) { state = load(); syncOrg(); render(); }
    });

    render();
  }

  init();
})();
