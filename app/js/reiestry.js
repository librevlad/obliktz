// Облік ТЗ ПС · сторінка · сортування й реєстри.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ============================================================ СОРТУВАННЯ
  /** Клац по заголовку — сортування за колонкою; вдруге — у зворотному порядку;
   *  утретє — як було. Назви й коди спершу за абеткою, числа — від більшого. */
  const sortOf = (view) => ((state.sort || {})[view]) || null;
  const SORT_TEXT = new Set(['code', 'name', 'line', 'sub', 'asset', 'kind', 'status', 'no', 'route']);
  function sortHead(view, key, label, cls = '') {
    const s = sortOf(view);
    const on = s && s.k === key;
    return `<div class="tbl__h ${cls} is-sortable${on ? ' is-sorted' : ''}" data-act="sort" data-view="${view}"
      data-k="${key}" title="Сортувати">${label}${on ? (s.dir > 0 ? ' ▲' : ' ▼') : ''}</div>`;
  }
  function sortToggle(view, key, firstDir) {
    state.sort = state.sort || {};
    const s = state.sort[view];
    const first = firstDir ? (+firstDir > 0 ? 1 : -1) : SORT_TEXT.has(key) ? 1 : -1;
    if (!s || s.k !== key) state.sort[view] = { k: key, dir: first };
    else if (s.dir === first) state.sort[view] = { k: key, dir: -first };
    else delete state.sort[view];
    regRefresh(view);
  }
  function sortRows(view, rows, getters) {
    const s = sortOf(view);
    if (!s || !getters[s.k]) return rows;
    const get = getters[s.k];
    return rows.slice().sort((a, b) => {
      const x = get(a), y = get(b);
      const c = typeof x === 'string' || typeof y === 'string'
        ? String(x ?? '').localeCompare(String(y ?? ''), 'uk', { numeric: true }) : (x ?? -Infinity) - (y ?? -Infinity);
      return c * s.dir;
    });
  }

  // ============================================================ РЕЄСТРИ
  /** Реєстр: пошук, фільтри-чипи, сортування за будь-якою колонкою, підсумок.
   *  Фільтри живуть у state.tf[id], сортування — у state.sort[id], тож екран
   *  і його Excel бачать той самий відбір.
   *
   *  spec: { id, rows, headSearch?, search?(r) → [поля], placeholder?, filters?,
   *          columns, row?(r) → {attrs, cls, title}, total?(shown) → {колонка: html},
   *          count?(shown, all) → html, empty?, emptyFiltered?, allCount?, minWidth?,
   *          limit?, panelCls?, acts? (ширина графи дій, напр. '150px') }
   *  Колонка: { key, label, cls, style?, sort?(r), first? (1 — спершу за
   *          зростанням), title?, cell(r) → html, cellCls?(r), cellTitle?(r) }
   *  Фільтр:  seg { key, options: [[значення, підпис]], test(r, v) }
   *          select { key, label, all, options, test(r, v) }
   *          toggle { key, label, title?, test(r) }
   *          period { key, label, get(r) } */
  const REG_LIMIT = 300;
  const regRedraw = new Map();              // реєстр у вікні → як його перемалювати
  const regHeadIds = new Set(['dz', 'inv', 'pp']);   // пошук цих реєстрів — у шапці сторінки
  const tfOf = (id) => { state.tf = state.tf || {}; return (state.tf[id] = state.tf[id] || {}); };
  function regRefresh(id) {
    const fn = regRedraw.get(id);
    return fn ? fn() : render();
  }
  const regQuery = (spec) => (spec.headSearch ? state.q || '' : tfOf(spec.id).q || '');
  function regActive(spec) {
    const f = tfOf(spec.id);
    return !!regQuery(spec).trim() || (spec.filters || []).some((x) => (x.type === 'period'
      ? f[x.key + 'From'] || f[x.key + 'To'] : f[x.key]));
  }
  function regRows(spec) {
    const f = tfOf(spec.id);
    const words = spec.search ? qWords(regQuery(spec)) : [];
    const out = spec.rows.filter((r) => {
      if (words.length && !hitAll(words, ...spec.search(r))) return false;
      for (const x of spec.filters || []) {
        if (x.type === 'period') {
          const d = String(x.get(r) || '').slice(0, 10);
          if (f[x.key + 'From'] && (!d || d < f[x.key + 'From'])) return false;
          if (f[x.key + 'To'] && (!d || d > f[x.key + 'To'])) return false;
        } else if (f[x.key] && !x.test(r, f[x.key])) return false;
      }
      return true;
    });
    const getters = {};
    for (const c of spec.columns) if (c.sort) getters[c.key] = c.sort;
    return sortRows(spec.id, out, getters);
  }
  function regPanel(spec, shown) {
    const f = tfOf(spec.id);
    const id = esc(spec.id);
    const act = (k, v) => `data-act="tf" data-id="${id}" data-k="${esc(k)}" data-v="${esc(v)}"`;
    const parts = [];
    if (spec.search && !spec.headSearch) {
      parts.push(`<div class="search search--panel"><span>⌕</span><input type="search" data-tf-q="${id}"
        value="${esc(f.q || '')}" placeholder="${esc(spec.placeholder || 'Пошук')}" autocomplete="off"></div>`);
    }
    for (const x of spec.filters || []) {
      const v = f[x.key] || '';
      if (x.type === 'seg') {
        parts.push(`<div class="seg"${x.title ? ` title="${esc(x.title)}"` : ''}>${x.options.map(([val, label]) =>
          `<button type="button" ${act(x.key, val)}${v === val ? ' class="is-on"' : ''}>${esc(label)}</button>`).join('')}</div>`);
      } else if (x.type === 'select') {
        parts.push(`<label class="chip${v ? ' is-on' : ''}"><span class="chip__label">${esc(x.label)}</span>
          <select data-tf="${id}" data-k="${esc(x.key)}"><option value="">${esc(x.all || 'усі')}</option>${x.options.map(([val, label]) =>
            `<option value="${esc(val)}"${v === val ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`);
      } else if (x.type === 'toggle') {
        parts.push(`<button type="button" class="chip chip--btn${v ? ' is-on' : ''}" ${act(x.key, v ? '' : '1')}${
          x.title ? ` title="${esc(x.title)}"` : ''}>${v ? '✓ ' : ''}${esc(x.label)}</button>`);
      } else if (x.type === 'period') {
        const a = f[x.key + 'From'] || '', b = f[x.key + 'To'] || '';
        parts.push(`<label class="chip${a || b ? ' is-on' : ''}"><span class="chip__label">${esc(x.label)} з</span>
          <input type="date" data-tf="${id}" data-k="${esc(x.key)}From" value="${esc(a)}">
          <span class="chip__label">по</span><input type="date" data-tf="${id}" data-k="${esc(x.key)}To" value="${esc(b)}"></label>`);
      }
    }
    if (regActive(spec)) parts.push(`<button type="button" class="chip chip--btn" data-act="tf-reset" data-id="${id}">Скинути фільтри</button>`);
    const total = spec.allCount ?? spec.rows.length;
    const count = spec.count ? spec.count(shown, spec.rows) : shown.length === total ? String(total) : `${shown.length} із ${total}`;
    return `<div class="panel${spec.panelCls ? ' ' + spec.panelCls : ''}">${parts.join('')}
      <div class="panel__spacer"></div><div class="panel__count">${count}</div></div>`;
  }
  function regTable(spec, shown) {
    const srt = sortOf(spec.id);
    const st = (c) => (c.style ? ` style="${c.style}"` : '');
    const headCell = (c) => {
      if (!c.sort) return `<div class="tbl__h ${c.cls || ''}"${st(c)}${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.label || '')}</div>`;
      const on = srt && srt.k === c.key;
      return `<div class="tbl__h ${c.cls || ''} is-sortable${on ? ' is-sorted' : ''}"${st(c)} data-act="sort" data-view="${esc(spec.id)}"
        data-k="${esc(c.key)}" data-first="${c.first || -1}" title="${esc(c.title || 'Сортувати')}">${esc(c.label)}${on ? (srt.dir > 0 ? ' ▲' : ' ▼') : ''}</div>`;
    };
    const limit = spec.limit ? Math.max(spec.limit, tfOf(spec.id).limit || 0) : Infinity;
    const part = shown.slice(0, limit);
    const rows = part.map((r) => {
      const o = spec.row ? spec.row(r) : {};
      return `<div class="tbl__row${o.cls ? ' ' + o.cls : ''}"${o.attrs ? ' ' + o.attrs : ''}${o.title ? ` title="${esc(o.title)}"` : ''}>${
        spec.columns.map((c) => `<div class="${c.cls || ''}${c.cellCls ? ' ' + c.cellCls(r) : ''}"${st(c)}${
          c.cellTitle ? ` title="${esc(c.cellTitle(r))}"` : ''}>${c.cell(r)}</div>`).join('')}</div>`;
    }).join('');
    const more = shown.length > part.length ? `<div class="tbl__more">
        <button type="button" class="btn" data-act="tf-more" data-id="${esc(spec.id)}">Показати ще ${Math.min(shown.length - part.length, spec.limit)}</button>
        <span class="panel__count">показано ${part.length} із ${shown.length}</span></div>` : '';
    const hasAny = (spec.allCount ?? spec.rows.length) > 0;
    const empty = shown.length ? '' : `<div class="tbl__row tbl__row--plain"><div class="c-txt">${esc(hasAny
      ? spec.emptyFiltered || 'За цими фільтрами нічого немає.' : spec.empty || 'Записів немає.')}</div></div>`;
    const tot = spec.total && shown.length ? spec.total(shown) : null;
    const totalRow = tot ? `<div class="tbl__row tbl__row--plain tbl__row--total">${spec.columns.map((c) =>
      `<div class="${c.cls || ''}"${st(c)}>${tot[c.key] ?? ''}</div>`).join('')}</div>` : '';
    return `<div class="tbl" style="--tbl-min:${spec.minWidth || '900px'}${spec.acts ? `;--acts:${spec.acts}` : ''}"><div class="tbl__head">${
      spec.columns.map(headCell).join('')}</div>${rows}${empty}${more}${totalRow}</div>`;
  }
  /** Реєстр цілком: панель фільтрів і таблиця над тим самим відбором. */
  function registry(spec) {
    const shown = regRows(spec);
    return { shown, panel: regPanel(spec, shown), table: regTable(spec, shown) };
  }
  function regReset(id) {
    const f = tfOf(id);
    for (const k of Object.keys(f)) delete f[k];
    if (regHeadIds.has(id)) state.q = '';
  }
  /** Поля фільтрів живуть до наступного перемальовування — прив'язуємо щоразу. */
  function bindRegistry(root) {
    if (!root) return;
    root.querySelectorAll('select[data-tf], input[type="date"][data-tf]').forEach((el) => {
      el.addEventListener('change', () => {
        const fl = tfOf(el.dataset.tf);
        fl[el.dataset.k] = el.value;
        fl.limit = 0;
        regRefresh(el.dataset.tf);
      });
    });
    root.querySelectorAll('input[data-tf-q]').forEach((el) => {
      el.addEventListener('input', debounce(() => {
        const id = el.dataset.tfQ;
        const pos = el.selectionStart;
        const fl = tfOf(id);
        fl.q = el.value;
        fl.limit = 0;
        regRefresh(id);
        const again = document.querySelector(`input[data-tf-q="${id}"]`);
        if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      }, 200));
    });
  }
