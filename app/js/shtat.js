// Облік ТЗ ПС · сторінка · штат, наявність і потреба.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ---------------------------------------------------- Штат / наявність / потреба
  /** Штат за табелем — таблиця, зведена з норм бази.
   *
   *  Норма стоїть на табельному рядку форми, а не на коді служби: «кухні
   *  причіпні КП-130(130М)» — один рядок штату й кілька кодів в обліку. Тому
   *  наявність під рядок збирається з усіх його кодів, а не з одного.
   */
  /** Табельні позиції: штат, наявність, знищене, некомплект — у межах
   *  підрозділу з підлеглими (порожній scope — уся бригада). Позиції без штату,
   *  але з майном теж у переліку (qty = 0): вони можуть іти за заміну. */
  function staffRows(date, scope = '', every = false) {
    const inScope = (sub) => !scope || inSubtree(scope, sub);
    const byLine = new Map();
    for (const n of staffAt(date)) {
      if (!inScope(n.sub)) continue;
      const key = n.form + '|' + n.line;
      if (!byLine.has(key)) byLine.set(key, { ...n, qty: 0, subs: [], codes: lineCodes.get(key) || n.codes || [] });
      const g = byLine.get(key);
      g.qty += n.qty;
      g.subs.push([n.sub, n.qty]);
    }
    // Норма на код служби — теж потреба рядка, до якого код прив'язано: так само, як наявність
    // рядка складається з його кодів (так рахує й форма 21/Прод). Табельна норма підрозділу на
    // рядок головніша: норми того самого підрозділу на коди цього рядка тоді не рахуються.
    const tabular = new Set(staffAt(date).map((n) => n.form + '|' + n.line + '|' + n.sub));
    for (const n of normList(date)) {
      if (!n.code || !(+n.qty > 0) || !inScope(n.sub)) continue;
      for (const l of reportLines) {
        const key = l.form + '|' + l.line;
        const codes = lineCodes.get(key) || l.codes;
        if (!staffForms.has(l.form) || !codes.includes(n.code) || tabular.has(key + '|' + n.sub)) continue;
        if (!byLine.has(key)) byLine.set(key, { form: l.form, line: l.line, qty: 0, subs: [], codes, basis: '' });
        const g = byLine.get(key);
        g.qty += +n.qty;
        let s = g.subs.find((x) => x[0] === n.sub && x[2]);
        if (!s) { s = [n.sub, 0, []]; g.subs.push(s); }
        s[1] += +n.qty;
        if (!s[2].includes(n.code)) s[2].push(n.code);
      }
    }
    for (const l of reportLines) {
      const key = l.form + '|' + l.line;
      if (!byLine.has(key) && staffForms.has(l.form)) {
        byLine.set(key, { form: l.form, line: l.line, qty: 0, subs: [], codes: l.codes, basis: '' });
      }
    }
    // Замінник-позиція, якої в табелі форми немає: окремий рядок без штату.
    for (const r of (store.subst || [])) {
      if (!isItemRef(r.from) || !staffForms.has(r.form)) continue;
      const code = r.from.slice(1);
      if (reportLines.some((l) => l.form === r.form && l.codes.includes(code))) continue;
      const key = r.form + '|' + r.from;
      if (!byLine.has(key)) {
        byLine.set(key, { form: r.form, line: substName(r.from), ref: r.from, qty: 0, subs: [], codes: [code], basis: '' });
      }
    }
    const byCode = new Map();
    for (const [k, v] of balances().map) {
      const i = k.indexOf('|');
      if (!inScope(k.slice(i + 1))) continue;
      const code = k.slice(0, i);
      byCode.set(code, (byCode.get(code) || 0) + v);
    }
    const gone = new Map();
    for (const r of allDestroyed()) {
      if (inScope(r.sub) && openAt(r, state.asOf)) gone.set(r.code, (gone.get(r.code) || 0) + (+r.qty || 0));
    }
    return [...byLine.values()]
      .map((g) => {
        const have = g.codes.reduce((acc, cc) => acc + (byCode.get(cc) || 0), 0);
        const destr = g.codes.reduce((acc, cc) => acc + (gone.get(cc) || 0), 0);
        const fact = have - destr;
        return { ...g, have, destr, fact, staffed: g.qty > 0, short: Math.max(0, g.qty - fact),
          over: Math.max(0, fact - g.qty), pct: g.qty ? fact / g.qty : null };
      })
      .filter((g) => every || g.qty > 0 || g.fact > 0)
      .sort((x, y) => x.form.localeCompare(y.form) || x.line.localeCompare(y.line));
  }

  // ------------------------------------------------ заміни табельних позицій
  /** Замінником може бути й окрема позиція номенклатури, якої в табелі форми
   *  немає зовсім, — єврокуб за цистерну ЦВ-4. У правилі вона записана як
   *  «#код», у таблицях — назвою й кодом. */
  const isItemRef = (x) => String(x || '').startsWith('#');
  function substName(x) {
    if (!isItemRef(x)) return x;
    const code = String(x).slice(1), it = itemBy.get(code);
    return `${it ? cleanName(it.name) : 'позиція'} · код ${code}`;
  }
  const substIndex = (rows) => {
    const by = new Map();
    for (const g of rows) { by.set(g.line, g); if (g.ref) by.set(g.ref, g); }
    return by;
  };
  /** Рядок-джерело правила. Код, який тим часом прив'язали до рядка форми,
   *  замінює вже як рядок: інакше його наявність рахувалася б двічі. */
  function substSource(r, rows, by) {
    const g = by.get(r.from);
    if (g || !isItemRef(r.from)) return g || null;
    const code = r.from.slice(1);
    return rows.find((x) => !x.ref && (x.codes || []).includes(code)) || null;
  }
  /** Правило заміни: позиція `from` понад свій власний штат закриває некомплект
   *  позицій `to` — у тому порядку, як їх перелічено. Правила застосовуються
   *  одне за одним у порядку списку; надлишок, уже відданий одним правилом,
   *  іншим не дістається. Власний штат позиції-замінника завжди першочерговий. */
  function applySubst(rows, form) {
    const by = substIndex(rows);
    for (const g of rows) Object.assign(g, { subIn: 0, subFrom: [], subOut: 0, subTo: [] });
    for (const r of (store.subst || []).filter((x) => x.form === form)) {
      const src = substSource(r, rows, by);
      if (!src) continue;
      for (const t of r.to) {
        const dst = by.get(t);
        const spare = Math.max(0, src.fact - src.qty - src.subOut);
        if (!dst || dst === src || spare <= 0) continue;
        const take = Math.min(spare, Math.max(0, dst.qty - dst.fact - dst.subIn));
        if (take <= 0) continue;
        dst.subIn += take;
        dst.subFrom.push([src.line, take]);
        src.subOut += take;
        src.subTo.push([dst.line, take]);
      }
    }
    for (const g of rows) {
      g.shortS = Math.max(0, g.qty - g.fact - g.subIn);
      g.overS = Math.max(0, g.fact - g.qty - g.subOut);
      // Відданий на заміну надлишок у позиції-замінника вже не рахується.
      g.pctS = g.qty ? (g.fact - g.subOut + g.subIn) / g.qty : null;
    }
    return rows;
  }

  /** Укомплектованість переліку: частка штату, закрита наявністю (надлишок однієї
   *  позиції не закриває некомплект іншої — хіба що за правилом заміни). */
  function coverage(rows, withSubst) {
    let need = 0, got = 0;
    for (const g of rows) {
      if (!g.qty) continue;
      need += g.qty;
      got += Math.min(g.qty, Math.max(0, g.fact) + (withSubst ? g.subIn || 0 : 0));
    }
    return need ? got / need : null;
  }
  /** Коротке ім'я позиції для підписів «за рахунок: КП-130 – 12»: марка, якщо
   *  вона є в назві, інакше назва повністю («Пічі польові переносні»). */
  const shortName = (line) => {
    const m = String(line).match(/[A-ZА-ЯІЇЄҐ]{2,}[A-ZА-ЯІЇЄҐ]*-?\s?\d+(?:[.,]\d+)?/);
    return m ? m[0] : line;
  };

  function staffBlock() {
    // «Усі позиції форми» — і ті, під які ще немає ні штату, ні кодів: інакше
    // штат на такий рядок табеля не було де вписати.
    const rows = staffRows(state.asOf, state.sub, !!state.staffAll);
    if (!rows.length) {
      // Перший штат вписують у рядок табеля, а рядків без штату й без майна перелік не показує:
      // без цієї кнопки нова служба не мала де почати.
      return `<div class="panel" data-staff-empty><div class="panel__note">
        Штату на ${fmtDate(state.asOf)} у базі немає.${state.staffAll ? ' Табельних форм теж.' : ' Щоб вписати його, відкрийте всі позиції форми.'}</div>
        ${state.staffAll ? '' : `<div class="panel__spacer"></div>
        <button type="button" class="btn btn--primary" data-act="staff-all">Усі позиції форми</button>`}</div>`;
    }
    const byForm = new Map();
    for (const g of rows) byForm.set(g.form, (byForm.get(g.form) || 0) + g.qty);
    // Дві форми описують той самий табель різними рядками: «термос ТВН-12» у
    // 21/Прод і «ТВН-12» у 3/Прод. Разом у списку вони виглядали як дублікати,
    // тож показуємо одну форму, а між ними — перемикач.
    const forms = [...byForm.keys()].sort();
    if (!forms.includes(state.staffForm)) state.staffForm = forms.includes('21/Прод') ? '21/Прод' : forms[0];
    const all = applySubst(rows.filter((g) => g.form === state.staffForm), state.staffForm);
    const rules = (store.subst || []).filter((x) => x.form === state.staffForm);
    const withS = !!(rules.length && store.ui.withSubst);
    // За табелем — лише позиції зі штатом; із замінами — ще й ті, що віддали надлишок.
    const list = sortRows('staff', all.filter((g) => state.staffAll || g.staffed || (withS && g.subOut)), {
      line: (g) => g.line, qty: (g) => g.qty, have: (g) => g.have,
      short: (g) => (withS ? g.shortS : g.short), over: (g) => (withS ? g.overS : g.over),
      pct: (g) => { const p = withS ? g.pctS : g.pct; return p == null ? -1 : p; } });
    const showDestr = list.some((g) => g.destr);
    const cols = 7 + (showDestr ? 1 : 0) + (withS ? 1 : 0);
    const body = list.map((g) => {
      const pct = withS ? g.pctS : g.pct;
      const short = withS ? g.shortS : g.short;
      const over = withS ? g.overS : g.over;
      const cls = pct == null ? 'c-num--dim' : pct >= 1 ? 'num-ok' : pct >= 0.5 ? 'num-warn' : 'num-bad';
      const where = g.subs.map(([sb, q]) => sb + ' ' + fmtNum(q)).join(' · ');
      const from = g.subFrom.map(([l, q]) => `${shortName(l)} – ${fmtNum(q)}`).join('; ');
      const to = g.subTo.map(([l, q]) => `${shortName(l)} – ${fmtNum(q)}`).join('; ');
      const key = g.form + '|' + g.line;
      const open = state.staffOpen === key;
      return `<div class="tbl__row${open ? ' is-sel' : ''}" data-act="staff-open" data-line="${esc(key)}"
          title="${esc(where)}${g.basis ? '&#10;' + esc(g.basis) : ''}">
        <div class="c-name"><b>${open ? '▾ ' : ''}${esc(g.line)}</b><small>${g.staffed
          ? cnt(g.subs.length, 'підрозділ', 'підрозділи', 'підрозділів') : 'без штату'}${
          withS && to ? ` · за заміну віддано: ${esc(to)}` : ''}</small></div>
        <div class="c-num">${g.staffed ? fmtNum(g.qty) : '—'}</div>
        <div class="c-num c-num--wide">${fmtNum(g.have)}</div>
        ${showDestr ? `<div class="c-num ${g.destr ? 'num-bad' : 'c-num--dim'}">${g.destr ? fmtNum(g.destr) : '—'}</div>` : ''}
        ${withS ? `<div class="c-num c-num--wide ${g.subIn ? 'num-ok' : 'c-num--dim'}" title="${esc(from)}">${g.subIn ? '+' + fmtNum(g.subIn) : '—'}</div>` : ''}
        <div class="c-num ${short ? 'num-bad' : 'c-num--dim'}">${short ? fmtNum(short) : '—'}</div>
        <div class="c-num ${over ? 'num-warn' : 'c-num--dim'}">${over ? fmtNum(over) : '—'}</div>
        <div class="c-num ${cls}">${pct == null ? '—' : Math.round(pct * 100) + '%'}</div>
        <div class="c-num c-num--dim">${g.codes.length || '—'}</div>
      </div>${open ? staffDetail(g, cols) : ''}`;
    }).join('');
    const sumOf = (f) => list.reduce((a, g) => a + (f(g) || 0), 0);
    const totalRow = `<div class="tbl__row tbl__row--plain tbl__row--total"><div class="c-name"><b>Разом</b></div>
      <div class="c-num">${fmtNum(sumOf((g) => (g.staffed ? g.qty : 0)), '0')}</div>
      <div class="c-num c-num--wide">${fmtNum(sumOf((g) => g.have), '0')}</div>
      ${showDestr ? `<div class="c-num">${fmtNum(sumOf((g) => g.destr))}</div>` : ''}
      ${withS ? `<div class="c-num c-num--wide">${fmtNum(sumOf((g) => g.subIn))}</div>` : ''}
      <div class="c-num">${fmtNum(sumOf((g) => (withS ? g.shortS : g.short)))}</div>
      <div class="c-num">${fmtNum(sumOf((g) => (withS ? g.overS : g.over)))}</div>
      <div class="c-num"></div><div class="c-num"></div></div>`;
    const cov = coverage(all, false), covS = coverage(all, true);
    const modeSeg = rules.length
      ? `<div class="seg" title="Розрахунок укомплектованості">
          <button type="button" data-act="ws" data-v="0"${withS ? '' : ' class="is-on"'}>за табелем</button>
          <button type="button" data-act="ws" data-v="1"${withS ? ' class="is-on"' : ''}>з урахуванням замін</button></div>`
      : '<button type="button" class="chip chip--btn" data-nav="subst">Задати заміни →</button>';
    const seg = forms.length > 1 ? `<div class="seg">${forms.map((f) =>
      `<button type="button" data-act="sf" data-v="${esc(f)}"${f === state.staffForm ? ' class="is-on"' : ''}>форма ${esc(f)}</button>`)
      .join('')}</div>` : '';
    return `<div class="panel">${seg}${modeSeg}<div class="panel__spacer"></div>
        <div class="panel__count">${cnt(list.filter((g) => g.staffed).length, 'позиція', 'позиції', 'позицій')} · за штатом ${fmtNum(byForm.get(state.staffForm))}
          · укомплектовано ${cov == null ? '—' : Math.round(cov * 100) + '%'}${rules.length && covS !== cov
            ? `, із замінами <b class="num-ok">${Math.round(covS * 100)}%</b>` : ''}</div>
        <button type="button" class="chip chip--btn${state.staffAll ? ' is-on' : ''}" data-act="staff-all"
          title="Показати й позиції форми без штату та без кодів служби">${state.staffAll ? '✓ ' : ''}усі позиції форми</button>
        <button type="button" class="btn btn--sm" data-act="ol-open"
          title="Рядок для майна, якому в бланку рядка немає: стане у вільний рядок свого розділу">+ Власний рядок</button>
        <div style="flex-basis:100%;height:0"></div><div class="panel__spacer"></div>
        <button type="button" class="btn" data-act="short-xls" title="Некомплект по підрозділах в Excel">Заявка на некомплект</button>
        <button type="button" class="btn" data-act="form21-xls" title="Форма 21/Прод у бланку вищого штабу на звітну дату">Форма 21/Прод</button>
        <button type="button" class="btn" data-act="form21-set"
          title="Зведена за частину, управління (усе поза батальйонами) і кожен батальйон: книга з аркушами, окремі файли й розшифровка до форми в одній теці">21/Прод: комплект</button>
      </div>${ownLineCard()}${list.length ? '' : `<div class="panel" data-staff-none><div class="panel__note">
        Штату за формою ${esc(state.staffForm)} на ${fmtDate(state.asOf)} немає. Потребу вписують у рядок табеля: відкрийте
        всі позиції форми, розгорніть рядок і додайте підрозділ у штат. Норма на код у колонці «штат власний» нижче теж
        іде в рядок, до якого код прив’язано.</div><div class="panel__spacer"></div>
        <button type="button" class="btn btn--primary" data-act="staff-all">Усі позиції форми</button></div>`}
      <div class="card card--scroll"${list.length ? '' : ' hidden'}><div class="tbl" style="--tbl-min:820px">
        <div class="tbl__head">
          ${sortHead('staff', 'line', 'табельна позиція', 'c-name')}
          ${sortHead('staff', 'qty', 'штат', 'c-num')}
          ${sortHead('staff', 'have', 'наявно', 'c-num c-num--wide')}
          ${showDestr ? '<div class="tbl__h c-num">знищ.</div>' : ''}
          ${withS ? '<div class="tbl__h c-num c-num--wide">по заміні</div>' : ''}
          ${sortHead('staff', 'short', 'некомплект', 'c-num')}
          ${sortHead('staff', 'over', 'понад штат', 'c-num')}
          ${sortHead('staff', 'pct', '%', 'c-num')}
          <div class="tbl__h c-num">кодів</div>
        </div>${body}${totalRow}</div></div>`;
  }

  /** Де саме бракує: штат і наявність по кожному підрозділу, що має цю позицію
   *  за штатом, і коди служби, з яких складається наявність. */
  /** Власний рядок форми — для майна, якому в бланку вищого штабу рядка немає (автоклави):
   *  так частина й робила в паперовій формі. Рядок стає останнім у своєму розділі, у бланку —
   *  у вільний рядок розділу; коди прив'язують «+ код служби», як до будь-якого рядка. */
  const ownLineKey = (x) => x.form + '|' + x.name;
  const isOwnLine = (key) => (store.ownLines || []).some((x) => ownLineKey(x) === key);
  function formSections(form) {
    return reportLines.filter((l) => l.form === form && !l.section).map((l) => l.line.replace(/:\s*$/, '').trim());
  }
  function ownLineCard() {
    if (!state.ownLineOpen) return '';
    const sections = formSections(state.staffForm);
    const pick = sections.includes('Інше майно') ? 'Інше майно' : sections[sections.length - 1];
    return `<div class="card form" style="margin-bottom:12px" data-own-line>
      <div class="card__head"><div class="card__title">Власний рядок форми ${esc(state.staffForm)}</div>
        <div class="panel__spacer"></div><button type="button" class="btn" data-act="ol-cancel">Скасувати</button></div>
      <div class="form__grid">
        <div class="field"><label for="ol-section">Розділ</label><select id="ol-section" data-ol="section">${sections.map((s) =>
          `<option value="${esc(s)}"${s === pick ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
        <div class="field field--span2"><label for="ol-name">Назва рядка</label><input id="ol-name" data-ol="name"
          placeholder="наприклад, Автоклави" autocomplete="off"></div>
      </div>
      <div class="card__foot"><button type="button" class="btn btn--primary" data-act="ol-add">Додати рядок</button></div></div>`;
  }
  function ownLineAdd() {
    const form = state.staffForm;
    const section = ($('[data-ol="section"]') || {}).value || '';
    const name = String(($('[data-ol="name"]') || {}).value || '').replace(/\s+/g, ' ').trim();
    if (!name) { toast('Впишіть назву рядка.', true); return; }
    const same = (a) => a.replace(/[’ʼ‘]/g, "'").replace(/\s+/g, ' ').trim().replace(/:$/, '').toLowerCase();
    const twin = reportLines.find((l) => l.form === form && same(l.line) === same(name));
    if (twin) { toast(`Рядок «${twin.line}» у формі ${form} уже є: прив’яжіть коди до нього.`, true); return; }
    if (!formSections(form).includes(section)) { toast('Оберіть розділ форми.', true); return; }
    store.ownLines = (store.ownLines || []).concat([{ form, section, name }]);
    // У переліку — одразу після останнього рядка свого розділу, як і в базі.
    const after = reportLines.reduce((at, l, i) => (l.form === form && l.section === section && !/^Всього/.test(l.line) ? i : at), -1);
    reportLines.splice(after >= 0 ? after + 1 : reportLines.length, 0, { form, line: name, section, codes: [] });
    lineCodes.set(form + '|' + name, []);
    logChange('рядок форми додано', 'line|' + form + '|' + name, `«${name}» у розділі «${section}» (${form})`);
    state.ownLineOpen = false;
    state.staffAll = true;
    state.staffOpen = form + '|' + name;
    save(true, true);
    render();
  }
  function ownLineDelete(key) {
    const i = key.indexOf('|');
    const form = key.slice(0, i), name = key.slice(i + 1);
    if ((lineCodes.get(key) || []).length || normsInit().some((n) => n.form === form && n.line === name)) {
      toast('До рядка прив’язано коди чи штат: спершу відв’яжіть їх.', true);
      return;
    }
    if (!confirm(`Видалити власний рядок «${name}» з форми ${form}?`)) return;
    store.ownLines = (store.ownLines || []).filter((x) => ownLineKey(x) !== key);
    const at = reportLines.findIndex((l) => l.form === form && l.line === name);
    if (at >= 0) reportLines.splice(at, 1);
    lineCodes.delete(key);
    if (store.lineCodes) delete store.lineCodes[key];
    logChange('рядок форми видалено', 'line|' + key, `«${name}» (${form})`);
    if (state.staffOpen === key) state.staffOpen = null;
    save(true, true);
    render();
  }

  function staffDetail(g, cols) {
    const date = state.asOf;
    const key = g.form + '|' + g.line;
    const subsRows = g.subs.map(([sb, q, byCodes]) => {
      const have = round3((g.codes || []).reduce((a, c) => a + haveRollup(sb, c), 0)
        - (g.codes || []).reduce((a, c) => a + destroyedIn(c, sb), 0));
      const short = Math.max(0, round3(q - have));
      // Штат, що прийшов із норм на коди, правлять там само — у «штат власний» переліку під таблицею.
      const qty = byCodes ? `<span title="Норма на код: змінюється в колонці «штат власний» переліку під таблицею">штат ${
        fmtNum(q, '0')} <small>норма на код ${esc(byCodes.join(', '))}</small></span>`
        : `<span>штат <input class="rc-in" style="width:64px" data-snorm="${esc(key + '|' + sb)}" value="${esc(String(q))}"
          inputmode="decimal" aria-label="штат «${esc(g.line)}» у «${esc(sb)}»"></span>`;
      return `<div class="st-detail__row${short ? ' num-bad' : ''}"><span class="lnk" data-sub="${esc(sb)}">${esc(sb)}</span>
        ${qty}<span>наявно ${fmtNum(have, '0')}</span><span>${short ? 'бракує ' + fmtNum(short) : 'укомплектовано'}</span></div>`;
    }).join('');
    // Штат міняється наказом: у програмі його правлять тут, на звітну дату.
    // Базовий табель лишається за минулими датами, а свої записи видно в
    // «Строки норм» унизу екрана.
    const free = pickableSubs('').filter((x) => !g.subs.some(([sb, , byCodes]) => sb === x.name && !byCodes)
      && (!state.sub || inSubtree(state.sub, x.name)) && x.type !== 'бригада');
    const addSub = `<div class="st-detail__row"><span>додати підрозділ у штат:</span>
      <span><select class="rc-in rc-in--wide" data-nmadd="${esc(key)}"><option value="">— оберіть —</option>
        ${free.map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('')}</select></span>
      <span>норма стане чинною з ${fmtDate(date)}</span><span></span></div>`;
    const own = normsInit().filter((n) => n.form === g.form && n.line === g.line)
      .sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
    const ownRows = own.length ? `<div class="st-detail__head" style="margin-top:6px">Задано в програмі:</div>`
      + own.map((n) => `<div class="st-detail__row"><span>${esc(n.sub)}</span>
        <span>${fmtNum(n.qty)}</span><span>${n.from ? 'з ' + fmtDate(n.from) : 'від початку'}${
          n.to ? ' по ' + fmtDate(n.to) : ''}</span>
        <span>${esc(n.basis || '')} ${rowBtn('nm-del', '✕ видалити', `data-id="${esc(n.id)}"`, { bad: true, title: 'Видалити цю норму' })}</span></div>`).join('') : '';
    const scope = state.sub;
    const codesRows = (g.codes || []).map((c) => {
      const it = itemBy.get(c);
      const q = scope ? haveRollup(scope, c) : balCode(c);
      return q ? `<span class="lnk" data-code="${esc(c)}">${esc(c)} ${esc(it ? cleanName(it.name) : '')} — ${fmtNum(q)}</span>` : '';
    }).filter(Boolean).join(' · ');
    return `<div class="st-detail" style="--cols:${cols}">
      <div class="st-detail__head">Штат по підрозділах (станом на ${fmtDate(date)}):</div>
      ${subsRows || '<div class="st-detail__row">Штату за підрозділами немає.</div>'}
      <div class="st-detail__head" style="margin-top:6px">Наявність складається з кодів:</div>
      <div class="st-detail__codes">${codesRows || 'жодного на обліку'}</div>
      ${g.ref ? '' : `<div class="st-detail__row"><span>коди служби рядка:</span>
        <span class="st-detail__codes">${(g.codes || []).map((c) => `${esc(c)}<button type="button" class="ico-btn ico-btn--bad"
          data-act="lc-del" data-line="${esc(key)}" data-code="${esc(c)}" title="Відв’язати код від рядка">✕</button>`).join(' ') || '—'}</span>
        <span><select class="rc-in rc-in--wide" data-lcadd="${esc(key)}"><option value="">+ код служби</option>${items
          .filter((it) => !(g.codes || []).includes(it.code)).map((it) =>
            `<option value="${esc(it.code)}">${esc(it.code)} ${esc(cleanName(it.name))}</option>`).join('')}</select></span>
        <span></span></div>`}
      ${g.ref ? '' : addSub}${ownRows}
      ${g.staffed && !g.ref ? `<div class="st-detail__acts"><button type="button" class="btn btn--sm" data-act="sb-for"
        data-line="${esc(g.line)}" title="Додати правило заміни">⇆ Чим замінити…</button></div>` : ''}${
      isOwnLine(key) && !(g.codes || []).length && !g.staffed ? `<div class="st-detail__acts">${rowBtn('ol-del', '✕ Видалити рядок',
        `data-line="${esc(key)}"`, { bad: true, title: 'Власний рядок без кодів і штату' })}</div>` : ''}</div>`;
  }


  /** Інвентарні номери діапазонами — так їх і наносять, пачкою на підрозділ.
   *  Номери свої, не з ФЕС: у 1С один інвентарний номер накриває кілька
   *  різних активів. Спільний для екрана, відомості й Excel. */
  function inventorySpec() {
    const words = qWords(state.q);
    const q = invQuery(state.q);
    const named = new Map(instances.filter((i) => i.inv).map((i) => [i.inv, i]));
    const nameOf = (r) => (itemBy.get(r.code) || {}).name || r.code;
    const units = (r) => r.to - r.from + 1;
    const serialsIn = (r) => {
      const out = [];
      for (let k = r.from; k <= r.to && out.length < 4; k++) {
        const x = named.get(invNo(r.code, k));
        if (x) out.push(`${invNo(r.code, k)}: зав. № ${x.serial || x.chassis}`);
      }
      return out;
    };
    // Номер із бирки «10201/057» — у який діапазон він потрапляє.
    const rows = inventory.filter((r) => {
      if (q) return r.code === q[0] && r.from <= q[1] && q[1] <= r.to;
      return !words.length || hitAll(words, r.code, nameOf(r), r.sub, serialsOf.get(r.code) || '');
    });
    const holders = subs.filter((sb) => sb.type !== 'бригада' && inventory.some((r) => inSubtree(sb.name, r.sub)));
    return {
      id: 'inv', rows, headSearch: true, allCount: inventory.length, minWidth: '860px',
      filters: [
        { type: 'select', key: 'sub', label: 'підрозділ', all: 'усі', options: holders.map((sb) => [sb.name, sb.name]),
          test: (r, v) => inSubtree(v, r.sub) },
        { type: 'seg', key: 'asset', options: [['', 'усе майно'], ['na', 'необоротні активи'], ['stock', 'запаси']],
          test: (r, v) => assetOf(itemBy.get(r.code) || {}) === v },
        { type: 'toggle', key: 'serial', label: 'із заводськими номерами', test: (r) => serialsIn(r).length > 0 },
      ],
      columns: [
        { key: 'code', label: 'код', cls: 'c-code', first: 1, sort: (r) => r.code, cell: (r) => esc(r.code) },
        { key: 'name', label: 'позиція', cls: 'c-name', first: 1, sort: nameOf,
          cell: (r) => { const m = serialsIn(r); return `<b>${esc(nameOf(r))}</b>${m.length ? `<small>${esc(m.join('; '))}</small>` : ''}`; } },
        { key: 'sub', label: 'підрозділ', cls: 'c-txt', style: 'flex:0 1 220px', first: 1, sort: (r) => r.sub, cell: (r) => esc(r.sub) },
        { key: 'range', label: 'номери', cls: 'c-code', style: 'width:210px;white-space:nowrap', first: 1, sort: (r) => `${r.code}/${String(r.from).padStart(5, '0')}`,
          cell: (r) => `<b>${invNo(r.code, r.from)}</b>${units(r) > 1 ? ` – ${invNo(r.code, r.to)}` : ''}` },
        { key: 'units', label: 'одиниць', cls: 'c-num', sort: units, cell: (r) => String(units(r)) },
        { key: 'acts', label: '', cls: 'c-acts', cell: (r) => `<button type="button" class="ico-btn" data-act="inv-move"
          data-code="${esc(r.code)}" data-v="${r.from}|${r.to}|${esc(r.sub)}" title="Перенести номери в інший підрозділ">⇄</button>` },
      ],
      row: (r) => ({ attrs: `data-code="${esc(r.code)}"`, title: nameOf(r) }),
      total: (shown) => ({ name: '<b>Разом</b>', units: fmtNum(shown.reduce((a, r) => a + units(r), 0), '0') }),
      count: (shown) => `${cnt(shown.reduce((a, r) => a + units(r), 0), 'номер', 'номери', 'номерів')}, ${
        cnt(shown.length, 'діапазон', 'діапазони', 'діапазонів')}`,
      empty: 'Інвентарних номерів ще немає.',
      emptyFiltered: 'За цими фільтрами номерів немає.',
    };
  }

  function renderInventory() {
    const reg = registry(inventorySpec());
    const off = invMismatch();
    const nameOf = (c) => cleanName((itemBy.get(c) || {}).name || c);
    const warn = off.length ? `<div class="flash flash--warn">Номери не там, де майно: накладна кількістю номерів не
      називає, тож після неї номери лишаються у відправника. Перенесіть їх кнопкою ⇄ у рядку діапазону.
      <br>${off.slice(0, 6).map((x) => `${esc(x.code)} ${esc(nameOf(x.code))}, «${esc(x.sub)}»: номерів ${x.n}, числиться ${fmtNum(x.q, '0')}`)
        .join('; ')}${off.length > 6 ? ` і ще ${off.length - 6}` : ''}</div>` : '';
    const need = invShortage();
    const issue = need.length ? `<div class="flash flash--warn" data-inv-need>Без інвентарного номера ${
      cnt(need.reduce((a, r) => a + r.to - r.from + 1, 0), 'одиниця', 'одиниці', 'одиниць')} у ${
      cnt(new Set(need.map((r) => r.code)).size, 'позиції', 'позиціях', 'позиціях')}.
      <button class="btn btn--sm" data-act="inv-issue">Видати номери…</button></div>` : '';
    return {
      fill: true,
      head: head('техзасоби / пооб’єктний', 'Інвентарні номери',
        searchBox('Пошук: код, назва, підрозділ, зав. № або номер 10201/057')
        + '<button class="btn" data-act="print">В Excel</button>'),
      body: `${warn}${issue}${invMoveCard()}${reg.panel}<div class="card card--scroll card--fill">${reg.table}</div>`,
    };
  }

  /** Одиниці на обліку, яким інвентарний номер ще не видано, — план видачі [{code, sub, from, to}].
   *  Номер — на цілу одиницю; нумерація позиції продовжується з останнього виданого. Позиція,
   *  чиї номери стоять не там, де майно, дістає лише те, чого бракує разом: решту переносять ⇄. */
  function invShortage(t = today()) {
    const nums = new Map(), last = new Map(), issued = new Map(), bal = new Map();
    for (const r of inventory) {
      const n = r.to - r.from + 1;
      nums.set(r.code + '|' + r.sub, (nums.get(r.code + '|' + r.sub) || 0) + n);
      issued.set(r.code, (issued.get(r.code) || 0) + n);
      last.set(r.code, Math.max(last.get(r.code) || 0, r.to));
    }
    for (const e of ledger) {
      if (e.d > t) break;
      bal.set(e.code + '|' + e.sub, (bal.get(e.code + '|' + e.sub) || 0) + e.sg * e.q);
    }
    const byCode = new Map();
    for (const [k, q] of bal) {
      const units = Math.floor(round3(q) + 1e-9);
      if (units <= 0) continue;
      const i = k.indexOf('|');
      const code = k.slice(0, i);
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push({ sub: k.slice(i + 1), units, n: nums.get(k) || 0 });
    }
    const order = new Map(subs.map((sb, i) => [sb.name, i]));
    const at = (name) => (order.has(name) ? order.get(name) : 1e9);
    const out = [];
    for (const code of [...byCode.keys()].sort((a, b) => a.localeCompare(b, 'uk', { numeric: true }))) {
      const rows = byCode.get(code).sort((a, b) => at(a.sub) - at(b.sub) || a.sub.localeCompare(b.sub, 'uk'));
      let left = rows.reduce((a, r) => a + r.units, 0) - (issued.get(code) || 0);
      let seq = last.get(code) || 0;
      for (const r of rows) {
        const take = Math.min(left, r.units - r.n);
        if (take <= 0) continue;
        out.push({ code, sub: r.sub, from: seq + 1, to: seq + take });
        seq += take;
        left -= take;
      }
    }
    return out;
  }

  function invIssueOpen() {
    const need = invShortage();
    if (!need.length) { toast('Усі одиниці мають інвентарні номери.'); return; }
    const n = need.reduce((a, r) => a + r.to - r.from + 1, 0);
    const rows = need.map((r) => `<div class="tbl__row tbl__row--plain"><div class="c-code">${esc(r.code)}</div>
      <div class="c-name"><b>${esc(cleanName((itemBy.get(r.code) || {}).name || r.code))}</b></div>
      <div class="c-txt" style="flex:0 1 220px">${esc(r.sub)}</div>
      <div class="c-code" style="width:210px;white-space:nowrap"><b>${invNo(r.code, r.from)}</b>${
        r.to > r.from ? ` – ${invNo(r.code, r.to)}` : ''}</div>
      <div class="c-num">${r.to - r.from + 1}</div></div>`).join('');
    modalOpen('Видати інвентарні номери', `<div class="panel"><div class="panel__note">Номер дістає кожна одиниця на обліку,
        яка його ще не має: ${cnt(n, 'номер', 'номери', 'номерів')}. Нумерація позиції продовжується з останнього виданого.
        Після видачі сформуйте відомість кнопкою «В Excel» і нанесіть номери на майно.</div>
        <div class="panel__spacer"></div><button class="btn btn--primary" data-act="inv-issue-go">Видати ${esc(String(n))}</button></div>
      <div class="tbl" style="--tbl-min:auto"><div class="tbl__head"><div class="tbl__h c-code">код</div><div class="tbl__h c-name">позиція</div>
        <div class="tbl__h c-txt" style="flex:0 1 220px">підрозділ</div><div class="tbl__h c-code" style="width:210px">номери</div>
        <div class="tbl__h c-num">одиниць</div></div>${rows}</div>`);
  }

  /** Видача: діапазони лягають на екран одразу, а в базу — переліком «код, підрозділ, з/по»;
   *  база заводить одиниці реєстру й призначає їм підрозділ. */
  function invIssueGo() {
    const need = invShortage();
    if (!need.length) { modalClose(); return; }
    const date = today();
    for (const r of need) invApplyMove(r.code, r.from, r.to, r.sub);
    store.invIssue = (store.invIssue || []).concat(need.map((r) => ({ code: r.code, sub: r.sub, from: r.from, to: r.to, date })));
    const n = need.reduce((a, r) => a + r.to - r.from + 1, 0);
    logChange('номери видано', 'inv|issue', `${cnt(n, 'номер', 'номери', 'номерів')}: `
      + need.slice(0, 12).map((r) => `${invNo(r.code, r.from)}${r.to > r.from ? ' – ' + invNo(r.code, r.to) : ''} «${r.sub}»`).join('; ')
      + (need.length > 12 ? ` і ще ${need.length - 12}` : ''));
    modalClose();
    save(true, true);
    render();
    toast(`Видано ${cnt(n, 'номер', 'номери', 'номерів')}.`);
  }

  /** Де інвентарних номерів позиції не стільки, скільки там числиться одиниць:
   *  [{code, sub, n, q}]. Лише позиції, яким номери видано. */
  function invMismatch() {
    const numbered = new Set(inventory.map((r) => r.code));
    if (!numbered.size) return [];
    const nums = new Map(), bal = new Map();
    for (const r of inventory) nums.set(r.code + '|' + r.sub, (nums.get(r.code + '|' + r.sub) || 0) + r.to - r.from + 1);
    const t = today();
    for (const e of ledger) {
      if (e.d > t) break;
      if (numbered.has(e.code)) bal.set(e.code + '|' + e.sub, (bal.get(e.code + '|' + e.sub) || 0) + e.sg * e.q);
    }
    const out = [];
    for (const k of new Set([...nums.keys(), ...bal.keys()])) {
      const n = nums.get(k) || 0, q = round3(bal.get(k) || 0);
      if (Math.abs(n - q) < 1e-9) continue;
      // Нові одиниці ще без номера — не розбіжність, а «номер ще не видано».
      if (n < q && ![...nums.keys()].some((x) => x.startsWith(k.slice(0, k.indexOf('|') + 1)) && (nums.get(x) || 0) > round3(bal.get(x) || 0))) continue;
      const i = k.indexOf('|');
      out.push({ code: k.slice(0, i), sub: k.slice(i + 1), n, q });
    }
    return out.sort((a, b) => a.code.localeCompare(b.code, 'uk', { numeric: true }) || a.sub.localeCompare(b.sub, 'uk'));
  }

  /** Перенести інвентарні номери в інший підрозділ: слідом за майном, яке
   *  пішло накладною кількістю. Номери — ті, що на бирках. */
  function invMoveCard() {
    const m = state.invMove;
    if (!m) return '';
    const opts = pickableSubs(m.sub).filter((x) => x.type !== 'бригада' && x.name !== m.was)
      .map((x) => `<option value="${esc(x.name)}"${x.name === m.sub ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    return `<div class="card form" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">Перенести номери ${esc(invNo(m.code, m.lo))} – ${esc(invNo(m.code, m.hi))}
        з «${esc(m.was)}»</div><div class="panel__spacer"></div>
        <button class="btn" data-act="inv-cancel">Скасувати</button></div>
      <div class="form__grid">
        <div class="field"><label>З номера</label><input data-im="from" inputmode="numeric" value="${esc(String(m.from))}"></div>
        <div class="field"><label>По номер</label><input data-im="to" inputmode="numeric" value="${esc(String(m.to))}"></div>
        <div class="field"><label>Куди</label><select data-im="sub"><option value="">— оберіть —</option>${opts}</select></div>
        <div class="field"><label>З дати</label><input type="date" data-im="date" value="${esc(m.date)}"></div>
        <div class="field field--span2"><label>Підстава</label><input data-im="note" value="${esc(m.note || '')}"
          placeholder="накладна №, дата"></div>
      </div>
      <div class="card__foot"><button class="btn btn--primary" data-act="inv-go">Перенести</button></div></div>`;
  }

  function invMoveGo() {
    const m = state.invMove;
    if (!m) return;
    document.querySelectorAll('[data-im]').forEach((el) => { m[el.dataset.im] = el.value.trim(); });
    const from = parseInt(m.from, 10), to = parseInt(m.to, 10);
    if (!(from >= m.lo && to <= m.hi && from <= to)) { toast(`Номери мають бути в межах ${m.lo}–${m.hi}.`, true); return; }
    if (!m.sub) { toast('Оберіть, куди перенести номери.', true); return; }
    const n = to - from + 1;
    if (!confirm(`Перенести ${cnt(n, 'номер', 'номери', 'номерів')} ${invNo(m.code, from)}${n > 1 ? ' – ' + invNo(m.code, to) : ''} `
      + `з «${m.was}» до «${m.sub}»?`)) return;
    invApplyMove(m.code, from, to, m.sub);
    store.invMoves = (store.invMoves || []).concat([{ code: m.code, from, to, sub: m.sub, date: m.date || today(), note: m.note || '' }]);
    logChange('номери перенесено', 'inv|' + m.code, `${invNo(m.code, from)}${n > 1 ? ' – ' + invNo(m.code, to) : ''}: `
      + `«${m.was}» → «${m.sub}»${m.note ? ', ' + m.note : ''}`);
    state.invMove = null;
    save(true, true);
    render();
  }

  /** Діапазони номерів після перенесення: вирізати з колишнього місця, додати
   *  в нове, сусідні діапазони того самого підрозділу злити. */
  function invApplyMove(code, from, to, sub) {
    const out = [];
    for (const r of inventory) {
      if (r.code !== code || r.to < from || r.from > to) { out.push(r); continue; }
      if (r.from < from) out.push({ code, sub: r.sub, from: r.from, to: from - 1 });
      if (r.to > to) out.push({ code, sub: r.sub, from: to + 1, to: r.to });
    }
    out.push({ code, sub, from, to });
    out.sort((a, b) => a.code.localeCompare(b.code, 'uk', { numeric: true }) || a.from - b.from);
    const merged = [];
    for (const r of out) {
      const last = merged[merged.length - 1];
      if (last && last.code === r.code && last.sub === r.sub && last.to + 1 === r.from) last.to = r.to;
      else merged.push(Object.assign({}, r));
    }
    inventory.length = 0;
    inventory.push(...merged);
  }

  /** Знищене, не списане, у підрозділі з підлеглими (без підрозділу — у бригаді). */
  function destroyedIn(code, scope) {
    return allDestroyed().reduce((a, r) => (r.code === code && (!scope || inSubtree(scope, r.sub))
      && openAt(r, state.asOf) ? a + (+r.qty || 0) : a), 0);
  }

  function renderSupply() {
    const scope = state.sub || rootName();
    // Для норм потрібні й позиції, яких у підрозділі ще немає: «норма 2, наявно 0»
    // — найтиповіший випадок, і ховати такий рядок не можна.
    const list = filteredItems({ keepEmpty: true, book: 'ТЗ' });
    const showDestr = destroyedTotal() > 0;
    const rows = list.map((i) => {
      const own = normOwn(scope, i.code);
      const need = normRollup(scope, i.code);
      const have = haveRollup(scope, i.code);
      const destr = destroyedIn(i.code, state.sub);
      const fact = have - destr;
      const short = Math.max(0, need - fact);
      const over = Math.max(0, fact - need);
      const pct = need ? fact / need : null;
      const cls = pct == null ? 'c-num--dim' : pct >= 1 ? 'num-ok' : pct >= 0.5 ? 'num-warn' : 'num-bad';
      return `<div class="tbl__row" data-item="${i.code}" title="${esc(i.name)}">
        <div class="c-code">${i.code}</div>
        <div class="c-name"><b>${esc(i.name)}</b></div>
        <div class="c-unit">${esc(i.unit)}</div>
        <div class="c-num c-num--input">
          <input class="norm" data-norm="${i.code}" value="${own || ''}" placeholder="—"
            inputmode="decimal" aria-label="штат власний, ${esc(i.name)}"></div>
        <div class="c-num c-num--dim">${fmtNum(need)}</div>
        <div class="c-num c-num--wide">${fmtNum(have)}</div>
        ${showDestr ? `<div class="c-num ${destr ? 'num-bad' : 'c-num--dim'}">${destr ? fmtNum(destr) : '—'}</div>
        <div class="c-num c-num--wide">${fmtNum(fact)}</div>` : ''}
        <div class="c-num c-num--wide ${short ? 'num-bad' : 'c-num--dim'}">${short ? fmtNum(short) : '—'}</div>
        <div class="c-num ${over ? 'num-warn' : 'c-num--dim'}">${over ? fmtNum(over) : '—'}</div>
        <div class="c-num c-num--pct ${cls}">${pct == null ? '—' : Math.round(pct * 100) + '%'}</div>
      </div>`;
    }).join('');

    return {
      fill: true,
      head: head(`техзасоби / ${esc(scope)}`, 'Штат і потреба',
        staffSeg('supply') + searchBox() + actions),
      body: `${filterBar(cnt(list.length, 'позиція', 'позиції', 'позицій'))}${staffBlock()}
        <div class="panel" style="margin-top:14px"><div class="panel__note">
          Нова норма в колонці «штат власний» діє для «${esc(scope)}» з ${fmtDate(state.asOf)}. Норма на код,
          прив’язаний до рядка форми, іде в потребу цього рядка.</div>
          <button class="btn" data-act="nm-terms">${state.normTerms ? 'Сховати строки' : 'Строки норм…'}</button>
          <button class="btn" data-act="norms-demo">Заповнити за наявністю</button>
          <button class="btn btn--danger" data-act="norms-clear">Очистити норми на коди</button></div>
        ${state.normTerms ? normTermsCard(scope) : ''}
        <div class="card card--scroll card--fill"><div class="tbl" style="--tbl-min:${950 + (showDestr ? 158 : 0)}px">
          <div class="tbl__head">
            <div class="tbl__h c-code">код</div>
            <div class="tbl__h c-name">найменування</div>
            <div class="tbl__h c-unit">од.</div>
            <div class="tbl__h c-num c-num--input">штат<br>власний</div>
            <div class="tbl__h c-num">штат<br>сум.</div>
            <div class="tbl__h c-num c-num--wide">наявно</div>
            ${showDestr ? `<div class="tbl__h c-num">знищ.</div>
            <div class="tbl__h c-num c-num--wide">фактично</div>` : ''}
            <div class="tbl__h c-num c-num--wide">некомпл.</div>
            <div class="tbl__h c-num">надлишок</div>
            <div class="tbl__h c-num c-num--pct">забезп.</div>
          </div>${rows}</div></div>`,
    };
  }
