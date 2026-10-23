// Облік ТЗ ПС · сторінка · Номенклатура.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // -------------------------------------------------------------- Номенклатура
  /** Коди служби, чиї табельні позиції мають некомплект на звітну дату.
   *  Без цього «лише некомплект» бачив тільки норми на коди, а їх зазвичай
   *  немає — і список виходив порожнім за реального некомплекту в штаті. */
  function shortByStaff() {
    if (shortCache.key === state.asOf + '|' + ledger.length) return shortCache.set;
    const set = new Set();
    for (const g of staffRows(state.asOf)) if (g.short > 0) g.codes.forEach((c) => set.add(c));
    shortCache.key = state.asOf + '|' + ledger.length;
    shortCache.set = set;
    return set;
  }
  const shortCache = { key: null, set: new Set() };

  // Заводські номери й шасі примірників — теж предмет пошуку: писар шукає за
  // тим, що вибито на табличці.
  const serialsOf = new Map();
  for (const x of instances) {
    const t = [x.serial, x.chassis, x.inv].filter(Boolean).join(' ');
    if (t) serialsOf.set(x.code, (serialsOf.get(x.code) || '') + ' ' + t);
  }

  function filteredItems(opts = {}) {
    const words = qWords(state.q);
    const inv = invQuery(state.q);
    const book = opts.book || state.book;
    return items.filter((i) => {
      if (bookOfItem(i) !== book) return false;
      if (state.group && i.group !== state.group) return false;
      if (state.assetF === 'na' && !i.nonrev) return false;
      if (state.assetF === 'stock' && i.nonrev) return false;
      if (state.assetF === 'unsure' && assetSure(i)) return false;
      if (inv) { if (i.code !== inv[0]) return false; }
      else if (words.length && !hitAll(words, i.name, i.code, i.serial || '', i.chassis || '',
        serialsOf.get(i.code) || '', i.old || '', i.fes || '', i.note || '')) return false;
      // Підрозділ — із підлеглими: у батальйону власний залишок нуль, усе
      // числиться за його взводами, і фільтр показував «Нічого не знайдено».
      if (state.sub && !opts.keepEmpty && !haveRollup(state.sub, i.code) && !normOwn(state.sub, i.code)) return false;
      if (state.onlyShort && shortByStaff().has(i.code)) return true;
      if (state.onlyShort) {
        const need = state.sub ? normRollup(state.sub, i.code) : normRollup(rootName(), i.code);
        const have = state.sub ? haveRollup(state.sub, i.code) : balCode(i.code);
        if (need - have <= 0) return false;
      }
      return true;
    });
  }

  function filterBar(count, extra = '') {
    const tz = state.book === 'ТЗ';
    const groups = D.groups.filter(([g, , book]) => (book || 'ТЗ') === state.book && items.some((i) => i.group === g));
    return `<div class="panel">
      <label class="chip${state.group ? ' is-on' : ''}">
        <span class="chip__label">група</span>
        <select id="f-group"><option value="">${tz ? 'Усі 21.xx' : 'Усі групи'}</option>
          ${groups.map(([g, l]) => `<option value="${g}"${state.group === g ? ' selected' : ''}>${tz ? g + ' · ' : ''}${esc(l)}</option>`).join('')}
        </select></label>
      ${tz ? `<label class="chip${state.assetF ? ' is-on' : ''}"
        title="Вид обліку за ФЕС">
        <span class="chip__label">облік</span>
        <select id="f-asset"><option value="">усе майно</option>
          <option value="na"${state.assetF === 'na' ? ' selected' : ''}>необоротні активи</option>
          <option value="stock"${state.assetF === 'stock' ? ' selected' : ''}>запаси</option>
          <option value="unsure"${state.assetF === 'unsure' ? ' selected' : ''}>не підтверджено ФЕС</option>
        </select></label>` : ''}
      <label class="chip${state.sub ? ' is-on' : ''}">
        <span class="chip__label">підрозділ</span>
        <select id="f-sub"><option value="">Уся бригада</option>
          ${subs.filter((s) => s.used).map((s) => `<option value="${esc(s.name)}"${state.sub === s.name ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select></label>
      ${tz ? `<button class="chip${state.onlyShort ? ' is-on' : ''}" data-act="short">
        <span class="chip__label">стан</span>
        <span class="chip__value">${state.onlyShort ? 'Некомплект > 0' : 'Усі позиції'}</span>
      </button>` : ''}
      ${extra}
      <div class="panel__spacer"></div>
      <div class="panel__count">${count}</div>
    </div>`;
  }

  function renderNomen() {
    const list = filteredItems();
    const scope = state.sub || rootName();
    const groups = [...new Set(list.map((i) => i.group))].sort();
    // Колонки, які нема чим заповнити, не показуємо: сотні рядків прочерків
    // з'їдали 250px ширини й виштовхували «некомплект» за екран.
    const tz = state.book === 'ТЗ';
    const showNorm = tz && hasNorms();
    const showDestr = tz && destroyedTotal() > 0;
    // 254px фіксованих колонок + 300px мінімум на найменування, далі по колонках.
    const width = 554 + (showNorm ? 211 : 0) + (showDestr ? 158 : 0);
    let rows = '';
    const calc = (i) => {
      const have = state.sub ? balOf(i.code, state.sub) : balCode(i.code);
      const need = state.sub ? normRollup(state.sub, i.code) : normRollup(scope, i.code);
      const destr = destroyedOf(i.code, state.sub || null);
      const fact = have - destr;
      return { i, have, need, destr, fact, short: Math.max(0, need - fact), pct: need ? Math.min(1, fact / need) : 0 };
    };
    const tot = { have: 0, destr: 0, fact: 0, short: 0 };
    const data = list.map(calc);
    for (const x of data) { tot.have += x.have; tot.destr += x.destr; tot.fact += x.fact; tot.short += x.short; }
    // Відсортовано за колонкою — один суцільний перелік без поділу на групи.
    const sorted = sortOf('nomen');
    const blocks = sorted
      ? [[null, sortRows('nomen', data, { code: (x) => x.i.code, name: (x) => x.i.name, have: (x) => x.have,
          destr: (x) => x.destr, fact: (x) => x.fact, short: (x) => x.short })]]
      : groups.map((g) => [g, data.filter((x) => x.i.group === g)]);
    for (const [g, inG] of blocks) {
      if (g) {
        rows += `<div class="tbl__group"><b>${esc(groupName.get(g) || g)}</b><span>${esc(g)}</span>
          <div class="panel__spacer"></div><span>${cnt(inG.length, 'позиція', 'позиції', 'позицій')}</span></div>`;
      }
      for (const { i, have, need, destr, fact, short, pct } of inG) {
        const serialTag = i.serial || i.chassis
          ? `<span class="tag tag--ser" title="Пооб’єктний облік">№ ${esc(i.serial || i.chassis)}</span>` : '';
        rows += `<div class="tbl__row" data-item="${i.code}" title="${esc(i.name)}">
          <div class="c-code">${i.code}</div>
          <div class="c-name"><b>${esc(i.name)}</b>${serialTag}${i.own
            ? '<span class="tag tag--mine" title="Позицію заведено в програмі">моє</span>' : ''}</div>
          <div class="c-unit">${esc(i.unit)}</div>
          ${showNorm ? `<div class="c-num c-num--dim">${need ? fmtNum(need) : '—'}</div>` : ''}
          <div class="c-num c-num--wide">${fmtNum(have)}</div>
          ${showDestr ? `<div class="c-num ${destr ? 'num-bad' : 'c-num--dim'}">${destr ? fmtNum(destr) : '—'}</div>
          <div class="c-num c-num--wide">${fmtNum(fact)}</div>` : ''}
          ${showNorm ? `<div class="c-num c-num--wide ${short ? 'num-bad' : 'c-num--dim'}">${short ? fmtNum(short) : '—'}</div>
          <div class="bar${short ? '' : ' bar--ok'}">
            <i style="width:${need ? Math.round(pct * 100) : 0}%"></i></div>` : ''}
        </div>`;
      }
    }
    const form = itemForm();
    // У книзі ОП, СП чи РП до першої позиції чи перенесення старої книги позицій немає зовсім — фільтри тут ні до чого.
    const bookEmpty = !tz && !items.some((i) => bookOfItem(i) === state.book);
    const empty = bookEmpty && isSpRp(state.book) ? bookEmptyItems(state.book)
      : bookEmpty ? emptyBlock('◌', 'Позицій посуду й миючих ще немає',
      'Заведіть позицію або перенесіть стару книгу «Облік ОП».',
      '<button class="btn btn--primary" data-act="item-new">+ Нова позиція</button>'
      + (native ? '<button class="btn" data-act="op-legacy">Перенести стару книгу…</button>' : ''))
      : !list.length ? emptyBlock('⌕', 'Нічого не знайдено',
        'Змініть пошуковий запит або скиньте фільтри.',
        '<button class="btn btn--primary" data-act="reset">Скинути фільтри</button>') : '';

    return {
      fill: true,
      head: head(`${tz ? 'техзасоби' : isSpRp(state.book) ? BOOKS[state.book].crumb : 'посуд і миючі'} / ${state.sub ? state.sub : 'уся бригада'}`,
        tz ? 'Номенклатура за розділами 21/Прод' : isSpRp(state.book) ? BOOKS[state.book].title : 'Посуд, миючі засоби й серветки',
        searchBox() + '<button class="btn" data-act="item-new">+ Нова позиція</button>'
        + (state.book !== 'ОП' ? '' : '<button class="btn" data-act="op-request">Заявка на 30 днів…</button>')
        + (native && FES_BOOKS.includes(state.book) ? '<button class="btn" data-act="op-fes">Звірка з ФЕС…</button>' : '')
        + actions),
      body: form + filterBar(`${cnt(list.length, 'позиція', 'позиції', 'позицій')}
        · ${cnt(groups.length, 'група', 'групи', 'груп')}`) + (empty || `
        <div class="card card--scroll card--fill"><div class="tbl" style="--tbl-min:${width}px">
          <div class="tbl__head">
            ${sortHead('nomen', 'code', 'код', 'c-code')}
            ${sortHead('nomen', 'name', 'найменування, марка', 'c-name')}
            <div class="tbl__h c-unit">од.</div>
            ${showNorm ? '<div class="tbl__h c-num">штат</div>' : ''}
            ${sortHead('nomen', 'have', 'наявно', 'c-num c-num--wide')}
            ${showDestr ? `${sortHead('nomen', 'destr', 'знищ.', 'c-num')}
            ${sortHead('nomen', 'fact', 'фактично', 'c-num c-num--wide')}` : ''}
            ${showNorm ? `${sortHead('nomen', 'short', 'некомпл.', 'c-num c-num--wide')}
            <div class="tbl__h" style="width:53px"></div>` : ''}
          </div>${rows}
          <div class="tbl__row tbl__row--plain tbl__row--total">
            <div class="c-code"></div><div class="c-name"><b>Разом: ${cnt(list.length, 'позиція', 'позиції', 'позицій')}</b></div>
            <div class="c-unit"></div>${showNorm ? '<div class="c-num"></div>' : ''}
            <div class="c-num c-num--wide">${fmtNum(tot.have, '0')}</div>
            ${showDestr ? `<div class="c-num">${fmtNum(tot.destr, '—')}</div><div class="c-num c-num--wide">${fmtNum(tot.fact, '0')}</div>` : ''}
            ${showNorm ? `<div class="c-num c-num--wide">${fmtNum(tot.short, '—')}</div><div style="width:53px"></div>` : ''}
          </div></div></div>`),
    };
  }
