// Облік ТЗ ПС · сторінка · Підрозділи.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // --------------------------------------------------------------- Підрозділи
  function renderSubs() {
    peopleInit();
    const b = balances();
    // Глибокі вузли без руху з перенесеного довідника (взводи, відділення) перелік не засмічують;
    // підрозділ, заведений у програмі, видно завжди — інакше щойно створену їдальню батальйону
    // не було де знайти, щоб виправити чи видалити.
    const made = (sb) => !/^b\d+$/.test(String(sb.id || ''));
    const data = subs.filter((sb) => sb.used || sb.depth <= 1 || made(sb)).map((sb) => ({ s: sb,
      own: b.bySub.get(sb.name) || 0,
      roll: [...b.bySub.entries()].reduce((acc, [n, v]) => (inSubtree(sb.name, n) ? acc + v : acc), 0),
      kinds: tzItems().filter((i) => balOf(i.code, sb.name) !== 0).length }));
    const spec = {
      id: 'subs', rows: data, placeholder: 'Пошук: підрозділ',
      search: (x) => [x.s.name, x.s.type || '', x.s.note || ''],
      filters: [
        { type: 'seg', key: 'act', options: [['', 'усі'], ['open', 'чинні'], ['closed', 'закриті']],
          test: (x, v) => (v === 'open') === !!x.s.active },
        { type: 'toggle', key: 'has', label: 'з майном', test: (x) => Math.abs(x.roll) > 1e-9 },
      ],
      columns: [{ key: 'sub', sort: (x) => x.s.name }, { key: 'kinds', sort: (x) => x.kinds },
        { key: 'own', sort: (x) => x.own }, { key: 'roll', sort: (x) => x.roll }],
      count: (shown, all) => (shown.length === all.length
        ? `${cnt(all.length, 'підрозділ', 'підрозділи', 'підрозділів')}, закритих ${all.filter((x) => !x.s.active).length}`
        : `${shown.length} із ${all.length}`),
    };
    const shown = regRows(spec);
    const sorted = sortOf('subs');
    const rows = shown.map(({ s: sb, own, roll, kinds }) => `<div class="tbl__row${sb.active ? '' : ' tbl__row--closed'}${
        state.subEdit && state.subEdit === sb.id ? ' is-sel' : ''}" data-sub="${esc(sb.name)}"
        title="${esc(sb.name)}${sb.active ? '' : '\n' + esc(sb.note)}">
        <div class="c-name" style="padding-left:${sorted ? 7 : 7 + sb.depth * 16}px">
          <b>${esc(sb.name)}</b><small>${esc([sb.type, sb.active ? '' : 'закритий', sb.used ? '' : 'без руху'].filter(Boolean).join(', '))}</small></div>
        <div class="c-num c-num--dim">${kinds || '—'}</div>
        <div class="c-num">${fmtNum(own)}</div>
        <div class="c-num c-num--xwide">${fmtNum(roll)}</div>
        <div class="c-acts">${rowBtn('sd-edit', '✎ Виправити', `data-id="${esc(sb.id || '')}"`, { title: 'Змінити запис довідника' })}</div>
      </div>`).join('') || '<div class="tbl__row tbl__row--plain"><div class="c-txt">За цими фільтрами підрозділів немає.</div></div>';
    const totalRow = shown.length ? `<div class="tbl__row tbl__row--plain tbl__row--total"><div class="c-name"><b>Разом</b></div>
        <div class="c-num"></div><div class="c-num">${fmtNum(shown.reduce((a, x) => a + x.own, 0), '0')}</div>
        <div class="c-num c-num--xwide"></div><div class="c-acts"></div></div>` : '';

    return {
      fill: true,
      head: head('довідники / структура', 'Підрозділи та розподіл майна',
        '<button class="btn btn--primary" data-act="sd-new">+ Підрозділ</button>' + actions),
      body: `${flashBlock()}${subDirCard()}${regPanel(spec, shown)}
        <div class="card card--scroll card--fill"><div class="tbl" style="--tbl-min:760px;--acts:110px">
          <div class="tbl__head">
            ${sortHead('subs', 'sub', 'підрозділ', 'c-name')}
            ${sortHead('subs', 'kinds', 'позицій', 'c-num')}
            ${sortHead('subs', 'own', 'власний залишок', 'c-num')}
            ${sortHead('subs', 'roll', 'з підлеглими', 'c-num c-num--xwide')}
            <div class="tbl__h c-acts"></div>
          </div>${rows}${totalRow}</div></div>`,
    };
  }

  // ------------------------------------------------- довідник підрозділів
  /** Структура частини живе в довіднику: базове дерево прийшло з бази, а зміни
   *  служби вносять тут. Перейменування зроблено так, як його робить служба:
   *  стара назва не міняється — за нею лишилися документи, — а закривається з
   *  приміткою, поряд стає новий вузол, і майно переходить накладною. Так само
   *  проходить і переформування батальйону. */
  const subById = (id) => (store.subs || []).find((x) => x.id === id) || null;

  function subsChanged(backup = true) {
    rebuildSubs(store.subs, subMentions());
    save(true, backup);
    render();
  }

  /** Перелік для поля «підпорядкований»: без себе й без власного піддерева —
   *  інакше гілка від'єдналася б від дерева. */
  function parentOptions(sel, skip = '') {
    return '<option value="">— без підпорядкування —</option>' + subs
      .filter((x) => x.name !== skip && !(skip && inSubtree(skip, x.name)))
      .map((x) => `<option value="${esc(x.name)}"${x.name === sel ? ' selected' : ''}>${
        '  '.repeat(x.depth)}${esc(x.name)}${x.active ? '' : ' · закритий'}</option>`).join('');
  }
  const kindOptions = (sel) => SUB_KINDS.concat(SUB_KINDS.includes(sel) || !sel ? [] : [sel])
    .map((k) => `<option value="${esc(k)}"${k === sel ? ' selected' : ''}>${esc(k)}</option>`).join('');

  function subDirCard() {
    if (state.subNew) return subNewCard();
    if (state.subRen) return subRenCard();
    const r = subById(state.subEdit);
    return r ? subEditCard(r) : '';
  }

  function subEditCard(r) {
    const uses = subUses(r.name);
    const held = balSub(r.name);
    return `<div class="card form" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">${esc(r.name)}</div>
        <div class="panel__spacer"></div>
        <button class="btn" data-act="sd-cancel">Закрити</button></div>
      <div class="form__grid">
        <div class="field"><label>Назва</label>
          <input data-sd="name" data-id="${esc(r.id)}" value="${esc(r.name)}"${uses ? ' readonly' : ''} autocomplete="off">
          ${uses ? '<div class="field__hint">назву змінюють кнопками «Виправити назву» чи «Перейменувати»</div>' : ''}</div>
        <div class="field"><label>Підпорядкований</label>
          <select data-sd="parent" data-id="${esc(r.id)}">${parentOptions(r.parent, r.name)}</select></div>
        <div class="field"><label>Вид</label>
          <select data-sd="type" data-id="${esc(r.id)}">${kindOptions(r.type)}</select></div>
        <div class="field"><label>Примітка</label>
          <input data-sd="note" data-id="${esc(r.id)}" value="${esc(r.note || '')}" placeholder="наказ №, дата, куди передано майно"></div>
      </div>
      <div class="card__foot">
        ${uses ? `<button class="btn" data-act="sd-fix" data-id="${esc(r.id)}"
          title="Той самий підрозділ під правильною назвою, без накладної">Виправити назву…</button>` : ''}
        <button class="btn btn--primary" data-act="sd-ren" data-id="${esc(r.id)}"
          title="Новий підрозділ замість цього; майно переходить накладною">Перейменувати…</button>
        <button class="btn" data-act="sd-toggle" data-id="${esc(r.id)}">${
          r.active === false ? 'Відкрити знову' : 'Закрити підрозділ'}</button>
        <button class="btn btn--danger" data-act="sd-del" data-id="${esc(r.id)}"${uses ? ' disabled' : ''}>Видалити</button>
        <div class="panel__spacer"></div>
        <span class="panel__count">${uses ? cnt(uses, 'згадка', 'згадки', 'згадок') + ' в обліку' : 'в обліку не згадується'}${
          held ? ` · числиться ${fmtNum(held)} од.` : ''}</span>
      </div></div>`;
  }

  function subNewCard() {
    const n = state.subNew;
    return `<div class="card form" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">Новий підрозділ</div>
        <div class="panel__spacer"></div>
        <button class="btn" data-act="sd-cancel">Скасувати</button></div>
      <div class="form__grid">
        <div class="field"><label>Назва</label>
          <input data-sn="name" id="sd-name" value="${esc(n.name)}" placeholder="3 б БпС · ВМТЗ" autocomplete="off">
          <div class="field__hint">як її пишуть у накладних і описах; їдальня чи ВМТЗ батальйону — з його назвою: «3 б БпС їдальня», знак «·» програма поставить сама</div></div>
        <div class="field"><label>Підпорядкований</label>
          <select data-sn="parent">${parentOptions(n.parent)}</select></div>
        <div class="field"><label>Вид</label><select data-sn="type">${kindOptions(n.type)}</select></div>
        <div class="field"><label>Примітка</label>
          <input data-sn="note" value="${esc(n.note)}" placeholder="наказ №, дата"></div>
      </div>
      <div class="card__foot"><button class="btn btn--primary" data-act="sd-add">Додати в довідник</button>
        </div>
    </div>`;
  }

  function subRenCard() {
    const r = subById(state.subRen.id);
    if (!r) return '';
    if (state.subRen.fix) {
      return `<div class="card form" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">Виправити назву «${esc(r.name)}»</div>
        <div class="panel__spacer"></div>
        <button class="btn" data-act="sd-cancel">Скасувати</button></div>
      <div class="pad" style="padding-bottom:0"><div class="panel__note">Той самий підрозділ під правильною назвою:
        документи, рапорти, звірки, описи, норми й МВО перейдуть на неї, накладної не буде. Стара назва
        лишиться в базі іншою назвою підрозділу. Якщо майно передають новому підрозділу — «Перейменувати».</div></div>
      <div class="form__grid">
        <div class="field"><label>Правильна назва</label>
          <input data-sr="name" id="sd-newname" value="${esc(state.subRen.name || r.name)}" autocomplete="off"></div>
        <div class="field"><label>Підстава</label>
          <input data-sr="basis" value="${esc(state.subRen.basis)}" placeholder="наказ №, дата або «помилка в назві»"></div>
      </div>
      <div class="card__foot"><button class="btn btn--primary" data-act="sd-fix-go">Виправити назву</button></div>
    </div>`;
    }
    const held = balSub(r.name);
    return `<div class="card form" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">Перейменувати «${esc(r.name)}»</div>
        <div class="panel__spacer"></div>
        <button class="btn" data-act="sd-cancel">Скасувати</button></div>
      ${held ? `<div class="pad" style="padding-bottom:0"><div class="panel__note">За «${esc(r.name)}» числиться ${fmtNum(held)} од.
        Після перейменування майно треба передати накладною.</div></div>` : ''}
      <div class="form__grid">
        <div class="field"><label>Нова назва</label>
          <input data-sr="name" id="sd-newname" value="${esc(state.subRen.name)}" placeholder="2 б ТрО" autocomplete="off"></div>
        <div class="field"><label>З дати</label>
          <input data-sr="date" type="date" value="${esc(state.subRen.date)}"></div>
        <div class="field"><label>Підстава</label>
          <input data-sr="basis" value="${esc(state.subRen.basis)}" placeholder="наказ №, дата"></div>
      </div>
      <div class="card__foot"><button class="btn btn--primary" data-act="sd-ren-go">Перейменувати</button>
        <div class="panel__spacer"></div>
        <span class="panel__count">Стара назва лишиться в довіднику як закрита.</span></div>
    </div>`;
  }

  /** Власний залишок підрозділу на звітну дату (без підлеглих). */
  function balSub(name) {
    let total = 0;
    for (const [k, v] of balances().map) if (k.slice(k.indexOf('|') + 1) === name) total += v;
    return round3(total);
  }

  function subAdd() {
    const n = state.subNew || {};
    let name = String(n.name || '').trim();
    // Підрозділ батальйону зветься «3 б ТрО · їдальня»: за цим закінченням програма впізнає
    // їдальню й ВМТЗ батальйону. Знака «·» на клавіатурі немає — між назвою вищого підрозділу
    // й рештою його ставить програма, хоч би що там набрали: пробіл, дефіс чи крапку.
    const up = String(n.parent || '').trim();
    if (up && name.toLowerCase().startsWith(up.toLowerCase())) {
      const m = name.slice(up.length).match(/^\s*[-–—.·,:]?\s+(\S.*)$/) || name.slice(up.length).match(/^\s*[-–—.·,:]\s*(\S.*)$/);
      if (m) name = `${up} · ${m[1]}`;
    }
    if (!name) { toast('Впишіть назву підрозділу.', true); return; }
    if (subBy.has(name)) { toast(`Підрозділ «${name}» уже є в довіднику.`, true); return; }
    const rec = { id: uid(), name, parent: String(n.parent || '').trim(), type: n.type || 'рота',
      active: true, note: String(n.note || '').trim() };
    store.subs = (store.subs || []).concat([rec]);
    logChange('підрозділ додано', 'sub|' + name, `«${name}»${rec.parent ? ', у складі «' + rec.parent + '»' : ''}`);
    state.subNew = null;
    state.subEdit = rec.id;
    subsChanged();
    toast(`Підрозділ «${name}» додано в довідник.`);
  }

  function subToggle(id) {
    const r = subById(id);
    if (!r) return;
    if (r.active === false) {
      r.active = true;
      logChange('підрозділ відкрито', 'sub|' + r.name, `«${r.name}» знову чинний`);
      subsChanged();
      toast(`Підрозділ «${r.name}» відкрито знову.`);
      return;
    }
    // Пункт харчування на закритому підрозділі мовчки зупинив би свої акти (нагадування про них, склад для списання): тому, поки на
    // підрозділі є чинні пункти, його не закривають — спершу пункти переносять на інший підрозділ чи закривають.
    const points = (store.points || []).filter((p) => !p.closed && (pointSub(p) || {}).id === r.id);
    if (points.length) {
      toast(`На підрозділі є пункти харчування: ${points.map((p) => `«${p.name}»`).join(', ')}. `
        + 'Перенесіть їх на інший підрозділ чи закрийте пункти.', true);
      return;
    }
    const held = balSub(r.name);
    if (!confirm(`Закрити підрозділ «${r.name}»?\n\n`
      + (held ? `За ним числиться ${fmtNum(held)} од. майна, яке треба передати накладною.\n\n` : '')
      + 'Документи й звірки лишаться в історії, але нових на нього не складатимуть.')) return;
    r.active = false;
    if (!String(r.note || '').trim()) r.note = `закритий з ${fmtDate(state.asOf || today())}`;
    logChange('підрозділ закрито', 'sub|' + r.name, `«${r.name}»${held ? `, числилося ${fmtNum(held)} од.` : ''}`);
    subsChanged();
  }

  function subDelete(id) {
    const r = subById(id);
    if (!r) return;
    const uses = subUses(r.name);
    if (uses) {
      alert(`Підрозділ «${r.name}» не можна видалити: є ${cnt(uses, 'запис', 'записи', 'записів')} в обліку. `
        + 'Закрийте його замість видалення.');
      return;
    }
    if (!confirm(`Видалити «${r.name}» з довідника підрозділів?`)) return;
    store.subs = store.subs.filter((x) => x.id !== r.id);
    logChange('підрозділ видалено', 'sub|' + r.name, `«${r.name}»`);
    state.subEdit = null;
    subsChanged();
    toast(`Підрозділ «${r.name}» видалено з довідника.`);
  }

  function subRename() {
    const r = subById(state.subRen && state.subRen.id);
    if (!r) return;
    const name = String(state.subRen.name || '').trim();
    const basis = String(state.subRen.basis || '').trim();
    const date = state.subRen.date || today();
    if (!name) { toast('Впишіть нову назву.', true); return; }
    if (subBy.has(name)) { toast(`Підрозділ «${name}» уже є в довіднику.`, true); return; }
    const old = r.name;
    const rec = { id: uid(), name, parent: r.parent, type: r.type, active: true,
      note: `утворений замість «${old}»${basis ? ' — ' + basis : ''} (${fmtDate(date)})` };
    const at = store.subs.indexOf(r);
    store.subs.splice(at < 0 ? store.subs.length : at, 0, rec);
    r.active = false;
    r.parent = name;                             // закритий вузол — усередині свого наступника
    r.note = (String(r.note || '').trim() ? String(r.note).replace(/[;\s]+$/, '') + '; ' : '')
      + `перейменовано на «${name}»${basis ? ' — ' + basis : ''} з ${fmtDate(date)}`;
    // МВО й норми йдуть за підрозділом: людина та сама, штат той самий — просто
    // тепер за новою назвою. Строк за старою закривається наступним днем: МВО
    // мусить лишитися на самій накладній, якою він здає майно.
    const moved = subCarryOver(old, name, date, basis);
    logChange('підрозділ перейменовано', 'sub|' + old,
      `«${old}» → «${name}»${basis ? ', ' + basis : ''} з ${fmtDate(date)}`
      + (moved.mvo ? `; МВО перенесено (${moved.mvo})` : '') + (moved.norms ? `; норм перенесено ${moved.norms}` : '')
      + (moved.points ? `; пунктів харчування перенесено ${moved.points}` : ''));
    state.subRen = null;
    state.subEdit = null;
    subsChanged();
    subTransfer(old, name, date, moved);
  }

  /** Виправити назву на місці: той самий підрозділ (помилка в назві чи нова
   *  назва без передачі майна). Документи, рапорти, звірки, описи, норми й МВО
   *  переходять на нову назву; у базі це той самий запис, а стара назва лягає
   *  в інші назви підрозділу — за нею його знайдуть у старих паперах. */
  function subFixName() {
    const r = subById(state.subRen && state.subRen.id);
    if (!r) return;
    const name = String(($('#sd-newname') || {}).value ?? state.subRen.name ?? '').trim();
    const basis = String(state.subRen.basis || '').trim();
    const old = r.name;
    if (!name) { toast('Впишіть правильну назву.', true); return; }
    if (name === old) { toast('Назва та сама.', true); return; }
    if (name.includes('|')) { toast('У назві підрозділу не ставте «|»: за назвою програма знаходить документи.', true); return; }
    if (subBy.has(name)) { toast(`Підрозділ «${name}» уже є в довіднику.`, true); return; }
    if (!confirm(`Виправити назву «${old}» на «${name}»?\n\nДокументи, рапорти, звірки, описи, норми й МВО `
      + 'цього підрозділу будуть під новою назвою. Накладної на передачу майна не буде: це той самий підрозділ.')) return;
    renameEverywhere(old, name);
    logChange('назву підрозділу виправлено', 'sub|' + name, `«${old}» → «${name}»${basis ? ', ' + basis : ''}`);
    state.subRen = null;
    state.subEdit = r.id;
    save(true, true);
    refresh();
    toast(`Назву виправлено: «${name}».`);
  }

  /** Нова назва підрозділу скрізь, де застосунок тримає його за назвою: у
   *  рядках документів, рапортах, звірках, описах, нормах, МВО, ключах сканів і
   *  в тому, що прийшло з бази до перезапуску. */
  function renameEverywhere(old, name) {
    const sw = (x) => (x === old ? name : x);
    for (const s of store.subs || []) { s.name = sw(s.name); s.parent = sw(s.parent); }
    // У приході відправник — постачальник, а не підрозділ.
    for (const r of store.docs.incoming) r[4] = sw(r[4]);
    for (const r of store.docs.movement) { r[3] = sw(r[3]); r[4] = sw(r[4]); }
    for (const r of store.docs.writeoffs) r[3] = sw(r[3]);
    for (const x of store.destroyed || []) x.sub = sw(x.sub);
    for (const r of allRecon()) r.sub = sw(r.sub);
    const moveKey = (o) => {
      if (o && Object.prototype.hasOwnProperty.call(o, old)) { o[name] = o[old]; delete o[old]; }
    };
    for (const inv of allInv()) {
      moveKey(inv.mvo);
      moveKey(inv.where);
      moveKey(inv.cmdr);
      moveKey(inv.plan);
      // «фактично» й примітки описів — за ключем «підрозділ|код|ціна».
      for (const o of [inv.fact, inv.note]) {
        if (!o) continue;
        for (const k of Object.keys(o)) {
          if (k.startsWith(old + '|')) { o[name + k.slice(old.length)] = o[k]; delete o[k]; }
        }
      }
      if (Array.isArray(inv.scope)) inv.scope = inv.scope.map(sw);
      if (inv.frozen) { inv.frozen.subs = (inv.frozen.subs || []).map(sw); moveKey(inv.frozen.lines); }
    }
    for (const r of store.mvo || []) r.sub = sw(r.sub);
    for (const r of store.cmdrs || []) r.sub = sw(r.sub);
    for (const n of normsInit()) n.sub = sw(n.sub);
    // Скани документів, де підрозділ у маршруті: ключ документа несе назву.
    const docKeyOf = (k) => {
      const p = String(k).split('|');
      if (!/^(in|mv|wr)$/.test(p[0]) || (p[3] !== old && p[4] !== old)) return k;
      p[3] = sw(p[3]); p[4] = sw(p[4]);
      return p.join('|');
    };
    for (const x of store.scans || []) x.key = docKeyOf(x.key);
    // Позначка «виправлено» в документах тримається на ключі з журналу змін.
    for (const x of store.log || []) if (x.key) x.key = docKeyOf(x.key);
    for (const r of inventory) r.sub = sw(r.sub);
    for (const u of instances) u.holder = sw(u.holder);
    for (const m of [subTitles, responsible, baseOrder, baseUsed, baseRefs]) {
      if (m.has(old)) { m.set(name, m.get(old)); m.delete(old); }
    }
    if (state.sub === old) state.sub = name;
    if (state.subName === old) state.subName = name;
    if (state.docKey) state.docKey = docKeyOf(state.docKey);
    dzCache = null;
  }

  /** Наступний день: строки МВО закінчуються днем, що вже не входить у строк. */
  function dayAfter(d) {
    const [y, m, day] = String(d).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, day) + 864e5).toISOString().slice(0, 10);
  }

  /** Перенести на нову назву те, що прив'язане до підрозділу, а не до паперів:
   *  чинного МВО, норми, задані в програмі, і чинні пункти харчування (пункт на закритому підрозділі більше не мав би з чого
   *  списувати, і нагадування про акт мовчало б). Повертає, скільки чого перенесено. */
  function subCarryOver(old, name, date, basis) {
    peopleInit();
    const out = { mvo: '', norms: 0, points: 0 };
    const next = (store.subs || []).find((s) => s.name === name);
    for (const p of (store.points || []).filter((x) => !x.closed && pointPlace(x) === old)) {
      if (!next) break;
      p.subId = next.id;
      p.sub = name;
      out.points += 1;
    }
    for (const list of [store.mvo, store.cmdrs]) {
      for (const r of (list || []).filter((x) => x.sub === old && openOn(x, date))) {
        r.to = dayAfter(date);
        r.note = (String(r.note || '').trim() ? r.note.replace(/[;\s]+$/, '') + '; ' : '')
          + `підрозділ перейменовано на «${name}» з ${fmtDate(date)}`;
        list.push({ id: uid(), sub: name, person: r.person, from: date, to: '',
          note: `та сама особа за новою назвою підрозділу${basis ? ' — ' + basis : ''}` });
        if (list !== store.mvo) continue;
        const p = personBy(r.person);
        out.mvo = out.mvo ? `${out.mvo}, ${pFull(p)}` : pFull(p);
      }
    }
    for (const n of normList(date).filter((x) => x.sub === old)) {
      out.norms += 1;
      // Норма, що саме з цієї дати й почалась, переходить на нову назву цілком:
      // строк «з 18.03 по 18.03» база не прийняла б, і перейменування не записалось би.
      if ((n.from || '') === date) { n.sub = name; if (basis && !n.basis) n.basis = basis; continue; }
      const end = n.to || '';
      n.to = date;
      store.norms.push(Object.assign({}, n, { id: uid(), sub: name, from: date, to: end,
        basis: basis || n.basis || '' }));
    }
    return out;
  }

  /** Після перейменування — готова чернетка накладної на все, що лишилося за
   *  старою назвою: інакше майно «зависає» на закритому підрозділі. */
  /** Рядки накладної «усе майно підрозділу» для перейменування й передачі
   *  закритого: одиниці із заводськими номерами — своїми рядками, решта —
   *  кількістю. Знищене за рапортами лишається, де було: його закриває акт
   *  списання того підрозділу, а не передача (інакше рапорт уже не закрити). */
  function transferLines(from, date) {
    const lines = [];
    let kept = 0;
    const gone = destroyedUnitsAt(from, date);
    for (const it of tzItems()) {
      const units = unitsAt(it.code, from, date);
      for (const u of units) {
        if (gone.has(String(u.id))) { kept += 1; continue; }
        lines.push({ code: it.code, qty: '1', price: String(u.price), note: '', lot: u.d, unit: String(u.id) });
      }
      const dq = round3(destroyedAt(it.code, from, date) - units.filter((u) => gone.has(String(u.id))).length);
      const q = round3(bulkAt(it.code, from, date) - dq);
      kept = round3(kept + Math.max(0, dq));
      if (q > 1e-9) lines.push({ code: it.code, qty: String(q), price: '', note: '', lot: '', unit: '' });
    }
    return { lines, kept };
  }

  function subTransfer(from, to, date, moved = { mvo: '', norms: 0, points: 0 }) {
    const { lines, kept } = transferLines(from, date);
    const what = cnt(lines.length, 'позиція', 'позиції', 'позицій');
    const tail = (moved.mvo ? ` МВО за новою назвою — ${moved.mvo}.` : '')
      + (moved.norms ? ` Норми (${moved.norms}) перенесено з ${fmtDate(date)}.` : '')
      + (moved.points ? ` Пункти харчування (${moved.points}) тепер списують з «${to}».` : '');
    if (!lines.length) {
      state.flash = `«${from}» перейменовано на «${to}». Майна за старою назвою немає.${tail}`;
      render();
      return;
    }
    if (!confirm(`За «${from}» на ${fmtDate(date)} числиться ${what}.\n\nСкласти накладну на передачу «${to}»?`)) {
      state.flash = `«${from}» перейменовано на «${to}». За старою назвою лишилося ${what}. `
        + `Передайте майно накладною на вкладці «Документи».${tail}`;
      render();
      return;
    }
    if (!leaveEditing()) return;
    if (!freeDraftSlot('mv', 'ТЗ', 'Замінити незавершену чернетку накладної?\n\nНаписане в ній буде втрачено.')) return;
    state.editing = null;
    state.moveKind = 'mv';
    state.draft = { kind: 'mv', lines: lines.concat([emptyLine()]),
      head: { type: 'Накладна', no: suggestMvNo(), date, from, to,
        basis: `перейменування «${from}» на «${to}» з ${fmtDate(date)}`,
        report: '', reportDate: '', act: '', note: '' } };
    state.flash = `Чернетка накладної з «${from}» на «${to}»: ${what}. Перевірте номер і дату та проведіть.${tail}`
      + (kept ? ` Знищене за рапортами (${fmtNum(kept)} од.) лишилось за «${from}» до акта списання.` : '');
    go('moves', { q: '', formOpen: true });
    $('#doc-form')?.scrollIntoView({ block: 'start' });
  }

  /** Закритий підрозділ, за яким ще числиться майно: накладна на все, що
   *  лишилося, з ним як відправником — одержувача людина обирає у формі.
   *  Без цього майно «зависало»: закритого немає серед відправників, а
   *  «Передати майно» на Зведенні вело в картку без жодної накладної. */
  function subHandOver(from) {
    const date = today();
    const { lines, kept } = transferLines(from, date);
    if (!lines.length) {
      toast(kept ? `За «${from}» лишилось лише знищене за рапортами (${fmtNum(kept)} од.) — його закриває акт списання.`
        : `За «${from}» на ${fmtDate(date)} майна не числиться.`);
      return;
    }
    if (!leaveEditing()) return;
    if (!freeDraftSlot('mv', 'ТЗ', 'Замінити незавершену чернетку накладної?\n\nНаписане в ній буде втрачено.')) return;
    state.editing = null;
    state.moveKind = 'mv';
    const sb = subBy.get(from);
    state.draft = { kind: 'mv', lines: lines.concat([emptyLine()]),
      head: { type: 'Накладна', no: suggestMvNo(), date, from, to: (sb && sb.parent) || '',
        basis: `передача майна закритого підрозділу «${from}»`,
        report: '', reportDate: '', act: '', note: '' } };
    state.flash = `Чернетка накладної із закритого «${from}»: ${cnt(lines.length, 'позиція', 'позиції', 'позицій')}. `
      + 'Оберіть одержувача, перевірте номер і дату та проведіть.';
    go('moves', { q: '', formOpen: true });
    $('#doc-form')?.scrollIntoView({ block: 'start' });
  }

  /** Строки норм, заданих у програмі: з якої дати діє, по яку, чим підтверджено.
   *  Норма на код служби й норма на табельну позицію — в одному переліку: і те,
   *  і те задають у програмі, і те, і те має строк. */
  function normTermsCard(scope) {
    const list = normsInit().filter((n) => n.sub === scope || inSubtree(scope, n.sub)).slice()
      .sort((a, b) => String(a.sub).localeCompare(String(b.sub), 'uk')
        || String(a.code || a.line).localeCompare(String(b.code || b.line), 'uk')
        || String(a.from || '').localeCompare(String(b.from || '')));
    if (!list.length) {
      return `<div class="panel"><div class="panel__note">Норм, заданих у програмі, для «${esc(scope)}»
        ще немає. Впишіть штат у колонці «штат власний».</div></div>`;
    }
    const rows = list.map((n) => {
      const it = n.code ? itemBy.get(n.code) : null;
      const what = n.code ? `${n.code} · ${it ? cleanName(it.name) : 'позиція'}` : `${n.line}`;
      return `<div class="tbl__row tbl__row--plain${openOn(n, state.asOf) ? '' : ' tbl__row--closed'}">
        <div class="c-name"><b>${esc(what)}</b><small>${esc(n.sub)}${n.code ? '' : ' · табельна позиція ' + esc(n.form)}</small>${
          n.note ? `<small title="${esc(n.note)}">${esc(n.note)}</small>` : ''}</div>
        <div class="c-num c-num--input"><input class="rc-in" data-nm="${esc(n.id)}" data-k="qty"
          value="${esc(String(n.qty))}" inputmode="decimal" aria-label="кількість за штатом"></div>
        <div class="c-date" style="width:150px"><input class="rc-in" type="date" data-nm="${esc(n.id)}" data-k="from"
          value="${esc(n.from || '')}"></div>
        <div class="c-date" style="width:150px"><input class="rc-in" type="date" data-nm="${esc(n.id)}" data-k="to"
          value="${esc(n.to || '')}"></div>
        <div class="c-txt"><input class="rc-in rc-in--wide" data-nm="${esc(n.id)}" data-k="basis"
          value="${esc(n.basis || '')}" placeholder="наказ №, дата"></div>
        <div class="c-acts">${rowBtn('nm-del', '✕ Видалити', `data-id="${esc(n.id)}"`, { bad: true, title: 'Видалити норму' })}</div>
      </div>`;
    }).join('');
    return `<div class="panel"><div class="panel__note">Якщо штат змінився, не правте стару норму, а впишіть нову кількість на звітну дату.</div>
        <div class="panel__count">${cnt(list.length, 'норма', 'норми', 'норм')} · чинних на ${fmtDate(state.asOf)}:
          ${list.filter((n) => openOn(n, state.asOf)).length}</div></div>
      <div class="card card--scroll" style="margin-bottom:14px"><div class="tbl" style="--tbl-min:900px;--acts:110px">
        <div class="tbl__head"><div class="tbl__h c-name">позиція · підрозділ</div>
          <div class="tbl__h c-num c-num--input">штат</div>
          <div class="tbl__h c-date" style="width:150px">з дати</div>
          <div class="tbl__h c-date" style="width:150px">по дату</div>
          <div class="tbl__h c-txt">підстава</div><div class="tbl__h c-acts"></div></div>
        ${rows}</div></div>`;
  }

  function subsAction(what, d) {
    // Довідники мусять бути злиті з базою до першої правки: інакше наступне
    // злиття перетерло б щойно змінений запис своїм базовим.
    peopleInit();
    switch (what) {
      case 'sd-new':
        state.subEdit = null;
        state.subRen = null;
        state.subNew = { name: '', parent: state.sub || rootName(), type: 'рота', note: '' };
        render();
        $('#sd-name')?.focus();
        return null;
      case 'sd-edit':
        state.subNew = null;
        state.subRen = null;
        state.subEdit = state.subEdit === d.id ? null : d.id;
        render();
        return null;
      case 'sd-open': {
        const r = (store.subs || []).find((x) => x.name === d.sub);
        state.subNew = null;
        state.subRen = null;
        state.subEdit = r ? r.id : null;
        return go('subs');
      }
      case 'sd-cancel':
        state.subNew = null;
        state.subRen = null;
        state.subEdit = null;
        return render();
      case 'sd-add': return subAdd();
      case 'sd-toggle': return subToggle(d.id);
      case 'sd-del': return subDelete(d.id);
      case 'sd-ren': {
        if (!subById(d.id)) return null;
        state.subEdit = null;
        state.subRen = { id: d.id, name: '', basis: '', date: state.asOf || today() };
        render();
        $('#sd-newname')?.focus();
        return null;
      }
      case 'sd-ren-go': return subRename();
      case 'sd-fix': {
        if (!subById(d.id)) return null;
        state.subEdit = null;
        state.subRen = { id: d.id, name: '', basis: '', date: today(), fix: true };
        render();
        $('#sd-newname')?.focus();
        return null;
      }
      case 'sd-fix-go': return subFixName();
      case 'nm-del': {
        const n = normById(d.id);
        if (!n) return null;
        // Норма — частина штату з табеля: зникає й зі звітів минулих дат. Штат,
        // що змінився, закривають датою, а не видаляють.
        const it = n.code ? itemBy.get(n.code) : null;
        const what = n.code ? `${n.code} «${it ? cleanName(it.name) : 'позиція'}»` : `«${n.line}» (${n.form})`;
        const term = `${n.from ? 'з ' + fmtDate(n.from) : 'від початку обліку'}${n.to ? ' по ' + fmtDate(n.to) : ''}`;
        if (!confirm(`Видалити норму ${what} для «${n.sub}»: ${fmtNum(n.qty)}, ${term}?\n\n`
          + 'Штат зникне й із розрахунків минулих дат. Якщо штат змінився — закрийте норму датою «по».')) return null;
        store.norms = store.norms.filter((x) => x.id !== n.id);
        logChange('норму видалено', 'norm|' + n.id, `${what}, ${n.sub}: ${fmtNum(n.qty)}, ${term}`);
        save(true, true);
        return render();
      }
      case 'nm-terms':
        state.normTerms = !state.normTerms;
        return render();
      default: return null;
    }
  }
