// Облік ТЗ ПС · сторінка · картка засобу й скани.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // -------------------------------------------------------------- Картка засобу
  /** Реквізити позиції книги СП чи РП: група, ціна, дободач (сухпай) і вид у звіті 1/прод. */
  function bookItemSpec(i) {
    const b = BOOKS[bookOfItem(i)];
    return [
      ['Код номенклатури', i.code, true],
      ['Група', groupName.get(i.group) || i.group],
      ['Одиниця виміру', i.unit],
      ['Ціна', fmtMoney(i.price) + ' грн', true],
    ].concat(b.perRation ? [['Дободач', rationText(i.perRation) || '—', true]] : [])
      .concat([[b.typeLabel, i.kind1 || '—']])
      .concat(i.note ? [['Примітка', i.note]] : [])
      .concat(i.archived ? [['В архіві', `з ${fmtDate(i.archived)}: у нових приходах не пропонується`]] : [])
      .map(([k, v, mono]) => `<div><div class="spec__k">${esc(k)}</div>
        <div class="spec__v${mono ? ' spec__v--mono' : ''}">${esc(v)}</div></div>`).join('');
  }

  function renderItem() {
    const i = itemBy.get(state.itemCode) || items[0];
    if (!i) return renderNomen();
    const rows = subs.filter((s) => balOf(i.code, s.name) !== 0)
      .map((s) => `<div class="tbl__row" data-sub="${esc(s.name)}" title="${esc(s.name)}">
        <div class="c-name"><b>${esc(s.name)}</b><small>${esc(s.type)}</small></div>
        <div class="c-num c-num--dim">${fmtNum(normOwn(s.name, i.code))}</div>
        <div class="c-num">${fmtNum(balOf(i.code, s.name))}</div>
      </div>`).join('');
    const itemDocs = docs.filter((r) => r.code === i.code);
    const moves = docRows(itemDocs.slice(0, 40), true) + (itemDocs.length > 40 ? `
      <div class="tbl__more"><span class="panel__count">показано 40 останніх із ${itemDocs.length}</span>
        <button type="button" class="btn" data-act="open-j47">Показати всі в Журналі № 47</button></div>` : '');
    const total = balCode(i.code);
    const destr = destroyedOf(i.code, null);
    // Вартість — за партіями, а не «залишок × остання ціна»: одиниця давнього
    // приходу коштує 1 250,00, а не 980,00, за які приходили пізніші.
    let value = 0;
    const prices = new Set();
    for (const [k, arr] of lotsAt(state.asOf)) {
      if (k.slice(k.indexOf('|') + 1) !== i.code) continue;
      for (const l of arr) { value += l.q * l.price; if (Math.abs(l.q) > 1e-9) prices.add(l.price); }
    }

    const op = bookOfItem(i) === 'ОП';
    const spec = isSpRp(bookOfItem(i)) ? bookItemSpec(i) : op ? [
      ['Код номенклатури', i.code, true],
      ['Група', groupName.get(i.group) || i.group],
      ['Одиниця виміру', i.unit],
      ['Ціна', fmtMoney(i.price) + ' грн', true],
      ['Норма на д/д', fmtNorm(i.perRation), true],
    ].concat(opNormLine(i.normLine) ? [['Рядок норми', opNormLine(i.normLine)[1]]] : [])
      .concat(((t) => (t ? [['Надійшло', t]] : []))(itemPurText(i.code)))
      .concat(i.note ? [['Примітка', i.note]] : [])
      .concat(i.archived ? [['В архіві', `з ${fmtDate(i.archived)}: у нових приходах не пропонується`]] : [])
      .map(([k, v, mono]) => `<div><div class="spec__k">${esc(k)}</div>
        <div class="spec__v${mono ? ' spec__v--mono' : ''}">${esc(v)}</div></div>`).join('') : [
      ['Код номенклатури', i.code, true],
      ['Група', `${i.group} · ${groupName.get(i.group) || ''}`],
      ['Одиниця виміру', i.unit],
      ...(codePrices(i.code).length > 1 ? [
        ['Ціни партій на дату', lotPricesText(i.code, null, true) ? lotPricesText(i.code, null, true) + ' грн' : '—', true],
        ['Ціна за останнім приходом', fmtMoney(i.price) + ' грн', true],
      ] : [['Ціна', fmtMoney(i.price) + ' грн', true]]),
      ['Категорія стану', unitCatsText(i.code) || '—', true],
      ['Заводський номер', i.serial || '—', true],
      ['Номер шасі', i.chassis || '—', true],
      ['Рік випуску', i.year || '—', true],
      ['Вид обліку', ASSET[assetOf(i)][2]],
      ['Облік у ФЕС', i.fes ? `${i.nonrev ? 'інвентарний' : 'номенклатурний'} № ${i.fes}`
        : 'не підтверджено, звірте з бухгалтерією', !!i.fes],
      ['Спосіб обліку', i.serial || i.chassis ? "пооб'єктний" : 'кількісний'],
    ].concat(i.old ? [['Старі коди (облік 3.0)', i.old, true]] : [])
      .concat(((t) => (t ? [['Надійшло', t]] : []))(itemPurText(i.code)))
      .concat(i.note ? [['Примітка', i.note]] : [])
      .concat(i.archived ? [['В архіві', `з ${fmtDate(i.archived)}: у нових приходах не пропонується`]] : [])
      .map(([k, v, mono]) => `<div><div class="spec__k">${esc(k)}</div>
        <div class="spec__v${mono ? ' spec__v--mono' : ''}">${esc(v)}</div></div>`).join('');

    return {
      head: head(isSpRp(bookOfItem(i)) ? `${BOOKS[bookOfItem(i)].crumb} / ${groupName.get(i.group) || i.group}`
        : op ? `посуд і миючі / ${groupName.get(i.group) || i.group}` : `номенклатура / ${i.group}`, i.name, `
        <button class="btn" data-act="back">← Назад</button>
        <button class="btn" data-act="item-edit" title="${i.own ? 'Позицію заведено в програмі'
          : 'Код позиції не змінюється'}">Виправити позицію</button>${i.own ? `
        <button class="btn btn--danger" data-act="item-del">Видалити позицію</button>` : ''}
        <button class="btn" data-act="open-j47">Журнал № 47</button>
        <button class="btn btn--primary" data-act="new">+ Новий документ</button>`),
      body: `
      <div class="tiles">
        <div class="tile"><div class="tile__label">Обліковий залишок</div>
          <div class="tile__value">${fmtNum(total, '0')} <small>${esc(i.unit)}</small></div>
          <div class="tile__hint">на ${fmtDate(state.asOf)}</div></div>
        <div class="tile"><div class="tile__label">Знищене, не списане</div>
          <div class="tile__value ${destr ? 'num-bad' : ''}">${fmtNum(destr, '0')}</div>
          <div class="tile__hint">фактично: ${fmtNum(total - destr, '0')}</div></div>
        <div class="tile"><div class="tile__label">Балансова вартість</div>
          <div class="tile__value">${fmtMoney(value)} <small>грн</small></div>
          <div class="tile__hint">${prices.size > 1 ? `${cnt(prices.size, 'партія', 'партії', 'партій')} за різними цінами`
            : `${fmtMoney(prices.size ? [...prices][0] : i.price)} грн за одиницю`}</div></div>
        <div class="tile"><div class="tile__label">Операцій у журналах</div>
          <div class="tile__value">${docs.filter((r) => r.code === i.code).length}</div>
          <div class="tile__hint">останню проведено ${fmtDate((docs.find((r) => r.code === i.code) || {}).d)}</div></div>
      </div>

      <div class="card" style="margin-bottom:12px">
        <div class="card__head"><div class="card__title">Реквізити</div></div>
        <div style="padding:18px"><div class="spec">${spec}</div></div>
      </div>
      ${form2ItemCard(i)}
      ${filesCard('item|' + i.code, 'Фото й документи позиції', 'фото зразка, паспорт, інструкція')}
      ${bookOfItem(i) === 'ТЗ' ? unitsCard(i) : ''}
      ${docScansCard(i.code)}

      <div class="grid-2">
        <div class="card"><div class="card__head"><div class="card__title">Розподіл по підрозділах</div></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:auto">
            <div class="tbl__head"><div class="tbl__h c-name">підрозділ</div>
              <div class="tbl__h c-num">штат</div><div class="tbl__h c-num">наявно</div></div>
            ${rows || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Залишків немає</div></div>'}
          </div></div></div>
        <div class="card"><div class="card__head"><div class="card__title">Рух позиції</div>
            <div class="panel__spacer"></div>
            <span class="panel__count">${cnt(itemDocs.length, 'запис', 'записи', 'записів')}</span></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:560px">
            <div class="tbl__head"><div class="tbl__h c-date">дата</div>
              <div class="tbl__h c-tag">документ</div><div class="tbl__h c-status">стан</div>
              <div class="tbl__h c-code">№</div>
              <div class="tbl__h c-txt">маршрут</div><div class="tbl__h c-num">к-сть</div></div>
            ${moves || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Операцій немає</div></div>'}
          </div></div></div>
      </div>`,
    };
  }

  /** Скани первинних документів, у яких є ця позиція: прихід, накладні, акти.
   *  Паспорт позиції — це й її документи надходження, тож вони видні з картки. */
  function docScansCard(code) {
    const seen = new Set();
    const out = [];
    for (const r of chrono(docs.filter((x) => x.code === code))) {
      const k = keyOfRow(r);
      if (seen.has(k)) continue;
      seen.add(k);
      const list = filesOf(k);
      if (list.length) out.push({ r, k, list });
    }
    if (!out.length) return '';
    // Під одним документом буває кілька файлів (сторінки, накладна й акт) —
    // плитку називає сам файл, документ і маршрут ідуть підписом.
    const tiles = out.map(({ r, k, list }) => {
      const doc = `${r.t || KIND_NAME[r.kind]} ${numNo(r.no)} від ${fmtDate(r.d)}`;
      const route = r.kind === 'wr' && !r.to ? r.from : `${r.from} → ${r.to}`;
      return list.map((f, i) => `<div class="file" data-vw="${i}" data-vw-key="${esc(k)}"
        title="${esc(f.file)}&#10;${esc(doc)} · ${esc(route)}">
        ${native && IMG_EXT.test(f.path) ? `<img class="file__thumb" src="${fileUrl(f.path, f.folder)}?w=320" loading="lazy" alt="">`
          : `<span class="file__ico">${fileIcon(f.path)}</span>`}
        <span class="file__name">${esc(f.file)}</span>
        <span class="file__meta">${esc(doc)} · ${esc(route)}</span></div>`).join('');
    }).join('');
    return `<div class="card files" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">Скани документів із цією позицією</div><div class="panel__spacer"></div>
        <span class="panel__count">${cnt(out.length, 'документ', 'документи', 'документів')} зі сканами</span></div>
      <div class="files__grid">${tiles}</div></div>`;
  }

  /** Окремі одиниці позиції із заводськими номерами: кухні, причепи, цистерни.
   *  До кожної — свої фото (шильдик, стан), бо зав. № і стан у кожної свій. */
  function unitsCard(i) {
    const list = instances.filter((x) => x.code === i.code);
    const ed = state.unitEdit && state.unitEdit.code === i.code ? state.unitEdit : null;
    // Першу одиницю позиції теж заводять тут: без кнопки на порожній картці нова служба
    // не мала чим завести кухню чи причіп із заводським номером.
    if (!list.length && !ed) {
      return i.archived ? '' : `<div class="card" style="margin-bottom:12px" data-units-empty>
      <div class="card__head"><div class="card__title">Одиниці із заводськими номерами</div>
        <span class="panel__count">немає</span><div class="panel__spacer"></div>
        <button type="button" class="btn btn--sm" data-act="un-new" data-code="${esc(i.code)}"
          title="Кухня, причіп, цистерна: завести одиницю з номером, потім назвати її в приході">+ Одиниця</button></div></div>`;
    }
    const pctx = purCtx();
    const form = (x) => `<div class="tbl__row tbl__row--plain unit-form">
        <div class="c-code" style="width:110px">${esc(x.inv || '—')}</div>
        <div class="c-code" style="width:150px"><input class="rc-in rc-in--wide" data-ue="serial" value="${esc(ed.serial)}"
          placeholder="зав. №" autocomplete="off"></div>
        <div class="c-code" style="width:110px"><input class="rc-in rc-in--wide" data-ue="chassis" value="${esc(ed.chassis)}"
          placeholder="шасі" autocomplete="off"></div>
        <div class="c-num"><input class="rc-in" data-ue="year" value="${esc(ed.year || '')}" inputmode="numeric" placeholder="рік"></div>
        <div class="c-num"><select class="rc-in" data-ue="cat" title="Категорія стану">
          <option value="">—</option>${[1, 2, 3, 4, 5].map((c) => `<option${String(ed.cat) === String(c) ? ' selected' : ''}>${c}</option>`).join('')}
          </select></div>
        <div class="c-txt"><input class="rc-in" type="date" data-ue="catDate" value="${esc(ed.catDate || '')}"
          title="З якої дати ця категорія (акт технічного стану)">
          <input class="rc-in rc-in--wide" data-ue="note" value="${esc(ed.note || '')}" placeholder="примітка: паспорт, формуляр, стан"></div>
        <div class="c-acts" style="flex-basis:240px">
          <button type="button" class="btn btn--sm btn--primary" data-act="un-save">Зберегти</button>
          <button type="button" class="btn btn--sm" data-act="un-cancel">Скасувати</button></div>
      </div>`;
    const rows = list.map((x) => {
      if (ed && String(ed.id) === String(x.id)) return form(x);
      const id = x.serial || x.chassis || x.inv;
      const key = `unit|${i.code}|${id}`;
      const files = filesOf(key);
      const cat = catAt(x, state.asOf);
      return `<div class="tbl__row tbl__row--plain">
        <div class="c-code" style="width:110px">${esc(x.inv || '—')}</div>
        <div class="c-code" style="width:150px"><b>${esc(x.serial || '—')}</b></div>
        <div class="c-code" style="width:110px">${esc(x.chassis || '—')}</div>
        <div class="c-num">${x.year || '—'}</div>
        <div class="c-num" title="Категорія стану на ${fmtDate(state.asOf)}">${cat || '—'}</div>
        <div class="c-txt">${esc((x.id ? unitHolderAt(x.id, state.asOf, null) : '') || x.holder || 'ніде не числиться')}<small>${
  esc([x.note, x.id ? unitPurText(x, i.code, pctx) : ''].filter(Boolean).join(' · '))}</small></div>
        <div class="c-acts" style="flex-basis:240px">${files.length
          ? `<button type="button" class="btn btn--sm" data-vw="0" data-vw-key="${esc(key)}" title="Переглянути фото й файли">📷 ${files.length}</button>` : ''}
          ${native ? `<button type="button" class="btn btn--sm" data-act="file-add" data-key="${esc(key)}"
            title="Фото шильдика, стану, формуляр одиниці">+ Фото</button>` : ''}
          ${x.id ? rowBtn('un-edit', '✎ Виправити', `data-id="${esc(x.id)}"`, { title: 'Виправити номер, шасі, рік, категорію стану' }) : ''}</div>
      </div>`;
    }).join('') + (ed && ed.isNew ? form({ inv: '' }) : '');
    return `<div class="card" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">Одиниці із заводськими номерами</div>
        <div class="panel__spacer"></div>
        <button type="button" class="btn btn--sm" data-act="un-new" data-code="${esc(i.code)}"
          title="Завести одиницю з номером: потім її можна назвати в приході">+ Одиниця</button></div>
      <div class="card--scroll"><div class="tbl" style="--tbl-min:980px">
        <div class="tbl__head"><div class="tbl__h c-code" style="width:110px" title="Власний номер служби на одиниці">бирка</div>
          <div class="tbl__h c-code" style="width:150px">зав. №</div><div class="tbl__h c-code" style="width:110px">шасі</div>
          <div class="tbl__h c-num">рік</div><div class="tbl__h c-num">кат.</div>
          <div class="tbl__h c-txt">де числиться · примітка</div>
          <div class="tbl__h c-acts" style="flex-basis:240px"></div></div>
        ${rows}</div></div></div>`;
  }

  /** Категорія стану позиції — з одиниць на звітну дату: «2» або «1 — 2 од.; 2 — 3 од.». */
  function unitCatsText(code) {
    const by = new Map();
    for (const u of instances) {
      if (u.code !== code) continue;
      const c = catAt(u, state.asOf);
      if (c) by.set(c, (by.get(c) || 0) + 1);
    }
    if (!by.size) return '';
    if (by.size === 1) return String([...by.keys()][0]);
    return [...by].sort((a, b) => a[0] - b[0]).map(([c, n]) => `${c} — ${n} од.`).join('; ');
  }

  /** Правка одиниці реєстру й нова одиниця: номер, шасі, рік, категорія стану
   *  з датою, примітка. Пишеться в базу разом з усім станом. */
  function unitEditOpen(id, code) {
    const u = id ? unitBy.get(String(id)) : null;
    if (id && !u) return;
    state.unitEdit = u ? { id: String(u.id), code: u.code, serial: u.serial || '', chassis: u.chassis || '',
      year: u.year || '', cat: catAt(u, state.asOf) || '', catDate: state.asOf, note: u.note || '', isNew: false }
      : { id: uid(), code, serial: '', chassis: '', year: '', cat: '', catDate: state.asOf, note: '', isNew: true };
    render();
    $('.unit-form [data-ue="serial"]')?.focus();
  }

  function unitEditSave() {
    const e = state.unitEdit;
    if (!e) return;
    document.querySelectorAll('.unit-form [data-ue]').forEach((el) => { e[el.dataset.ue] = el.value.trim(); });
    const it = itemBy.get(e.code) || {};
    const bad = [];
    if (!e.serial && !e.chassis) bad.push('Вкажіть заводський номер або номер шасі: без номера одиницю не впізнати.');
    const twin = instances.find((x) => x.code === e.code && String(x.id) !== String(e.id)
      && ((e.serial && x.serial === e.serial) || (!e.serial && e.chassis && x.chassis === e.chassis)));
    if (twin) bad.push(`У «${cleanName(it.name || e.code)}» уже є одиниця ${unitLabel(twin)}.`);
    if (e.year && !(/^\d{4}$/.test(e.year) && +e.year >= 1940 && +e.year <= +today().slice(0, 4))) {
      bad.push('Рік випуску — чотири цифри, не пізніше за цей рік.');
    }
    if (e.cat && !e.catDate) bad.push('Вкажіть, з якої дати ця категорія стану.');
    if (bad.length) { alert(bad.join('\n')); return; }
    let u = unitBy.get(String(e.id));
    const before = u ? `${unitLabel(u)}${u.chassis && u.serial ? ', шасі ' + u.chassis : ''}${u.year ? ', ' + u.year : ''}` : '';
    if (!u) {
      u = { code: e.code, inv: '', serial: '', chassis: '', year: 0, cat: 0, holder: '', note: '', id: String(e.id) };
      instances.push(u);
      unitBy.set(String(e.id), u);
      if (!unitsOf.has(e.code)) unitsOf.set(e.code, []);
      unitsOf.get(e.code).push(u);
    }
    // Заводський номер виправили — фото й паспорт одиниці йдуть за ним.
    const oldKey = `unit|${e.code}|${u.serial || u.chassis || u.inv}`;
    Object.assign(u, { serial: e.serial, chassis: e.chassis, year: +e.year || 0, note: e.note });
    const newKey = `unit|${e.code}|${u.serial || u.chassis || u.inv}`;
    if (oldKey !== newKey) {
      if (scans.has(oldKey)) { scans.set(newKey, (scans.get(newKey) || []).concat(scans.get(oldKey))); scans.delete(oldKey); }
      for (const x of store.scans || []) if (x.key === oldKey) x.key = newKey;
    }
    const catNow = catAt(u, e.catDate || state.asOf);
    const catChanged = e.cat && String(e.cat) !== String(catNow);
    if (catChanged) {
      const h = (unitCats.get(String(u.id)) || []).filter(([d]) => d !== e.catDate);
      h.push([e.catDate, +e.cat]);
      h.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      unitCats.set(String(u.id), h);
    }
    store.units = (store.units || []).filter((r) => String(r.id) !== String(e.id));
    store.units.push({ id: String(e.id), code: e.code, serial: e.serial, chassis: e.chassis, year: e.year,
      note: e.note, ...(catChanged ? { cat: +e.cat, catDate: e.catDate } : {}) });
    logChange(e.isNew ? 'одиницю заведено' : 'одиницю виправлено', 'unit|' + e.code,
      `${cleanName(it.name || e.code)}: ${e.isNew ? '' : before + ' → '}${unitLabel(u)}${u.chassis && u.serial ? ', шасі ' + u.chassis : ''}`
      + `${u.year ? ', ' + u.year : ''}${catChanged ? `, категорія ${e.cat} з ${fmtDate(e.catDate)}` : ''}`);
    state.unitEdit = null;
    unitCache.key = null;
    save(true, true);
    render();
    toast(e.isNew ? `Одиницю ${unitLabel(u)} заведено. Її можна назвати в приході.` : `Одиницю ${unitLabel(u)} виправлено.`);
  }

  // ------------------------------------------------------------- скани
  /** Кнопки-посилання на скани; підшиті в програмі мають ✕ — відв'язати. */
  function scanButtons(list) {
    return list.map((x) => (native
      ? `<a class="btn" href="${fileUrl(x.path, x.folder)}" target="_blank" rel="noopener" title="Відкрити скан">&#128206; ${esc(x.file)}</a>${
        x.mine ? rowBtn('scan-del', '✕ Відв’язати', `data-path="${esc(x.path)}" data-folder="${esc(x.folder || '')}"`, { bad: true, title: 'Відв’язати скан від документа; файл лишиться в теці' }) : ''}`
      : `<span class="btn" title="Скан відкривається в програмі на комп’ютері">&#128206; ${esc(x.file)}</span>`)).join('');
  }

  /** До чого підшивається файл, перетягнутий на поточний екран: документ,
   *  відомість звірки, позиція номенклатури чи інвентаризація. */
  function scanTarget() {
    if (state.view === 'doc' && state.docKey) return fileTarget(state.docKey);
    if (state.view === 'recon' && state.reconId) return fileTarget('recon|' + state.reconId);
    if (PAPER_OF_VIEW[state.view] && state.paperId && !state.paperVer) return fileTarget('paper|' + state.paperId);
    if (state.view === 'item' && state.itemCode) return fileTarget('item|' + state.itemCode);
    if (state.view === 'stocktake' && state.stId && !state.stSub) return fileTarget('st|' + state.stId);
    return null;
  }

  /** Підшити файли (обрані у вікні чи перетягнуті) до документа. Файл
   *  зберігається в теці даних, а в обліку лишається посилання на нього. */
  async function attachScan(t, files) {
    if (!native) { alert('Підшивати скани можна в програмі на комп’ютері.'); return; }
    if (!files) {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = true;
      inp.accept = '.pdf,.jpg,.jpeg,.png,.gif,.bmp,.tif,.tiff,.webp,.heic,.doc,.docx,.xls,.xlsx,.odt,.ods,'
        + '.rtf,.txt,.csv,.zip,.rar,.7z,.p7s,.asice,.asics,.sig';
      inp.addEventListener('change', () => attachScan(t, [...(inp.files || [])]));
      inp.click();
      return;
    }
    let ok = 0;
    for (const f of files) {
      if (f.size > 40 * 1024 * 1024) { toast(`«${f.name}» не підшито: файл більший за 40 МБ.`, true); continue; }
      try {
        const r = await fetch('api/scan', {
          method: 'POST', body: f,
          headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name),
                     'X-Doc-Date': t.date || '', 'X-Doc-No': encodeURIComponent(t.no || ''),
                     'X-Doc-Label': encodeURIComponent(t.label || ''),
                     'X-Folder': encodeURIComponent(t.folder || ''),
                     // Файл служби (закупівлі) лягає в теку з налаштувань під іменем служби; розширення дописує сервер.
                     ...(t.folderKey ? { 'X-Folder-Key': encodeURIComponent(t.folderKey), 'X-Name': encodeURIComponent(t.name || '') } : {}) },
        });
        const text = await r.text();
        let j = {};
        try { j = JSON.parse(text); } catch (e) { /* відповідь — текст помилки */ }
        if (!r.ok || !j.ok) throw new Error(j.error || text || `помилка ${r.status}`);
        store.scans = store.scans || [];
        store.scans.push({ key: t.key, date: t.date, no: t.no, file: j.file, path: j.path,
                           mime: f.type || '', size: f.size, added: today(), folder: j.folder || '', sha: j.sha || '' });
        ok++;
      } catch (e) {
        toast(`«${f.name}» не підшито: ${e.message || e}`, true);
      }
    }
    if (ok) {
      logChange('файл підшито', t.key, store.scans.slice(-ok).map((x) => x.file).join('; '));
      save(true);
      toast(`Підшито ${cnt(ok, 'файл', 'файли', 'файлів')}.`);
      render();
    }
  }

  function unlinkScan(path, folder = '') {
    const same = (y) => y.path === path && (y.folder || '') === folder;       // той самий шлях у іншій теці — інший файл
    const x = (store.scans || []).find(same);
    if (!x) return;
    if (!confirm(`Відв'язати файл «${x.file}»? Сам файл лишиться в ${folder ? 'теці служби' : 'теці «Дані обліку/скани»'}.`)) return;
    store.scans = store.scans.filter((y) => !same(y));
    logChange('файл відв’язано', x.key, x.file);
    save(true, true);
    render();
    viewerRender();
  }

  /** Файл, перетягнутий на картку документа чи відомості, підшивається одразу. */
  function bindScanDrop() {
    const sc = $('#scroll');
    if (!sc || sc.dataset.drop || !native) return;
    sc.dataset.drop = '1';
    sc.addEventListener('dragover', (e) => {
      if (!scanTarget() || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      sc.classList.add('is-drop');
    });
    sc.addEventListener('dragleave', (e) => { if (e.target === sc) sc.classList.remove('is-drop'); });
    sc.addEventListener('drop', (e) => {
      sc.classList.remove('is-drop');
      const t = scanTarget();
      if (!t || !e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      attachScan(t, [...e.dataTransfer.files]);
    });
  }
