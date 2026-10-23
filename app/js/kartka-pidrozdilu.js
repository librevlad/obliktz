// Облік ТЗ ПС · сторінка · картка підрозділу.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ============================================================ КАРТКА ПІДРОЗДІЛУ
  /** Усе про підрозділ на одній сторінці: що числиться й на яку суму, штат і
   *  некомплект, остання звірка, МВО, документи, знищене. */
  function renderSubCard() {
    const sub = state.subName;
    const sb = subBy.get(sub);
    if (!sb) { state.view = 'subs'; renderNav(); return renderSubs(); }
    const date = state.asOf;
    const hasKids = subs.some((x) => x.parent === sub);
    if (state.subFilterFor !== sub) { state.subFilterFor = sub; state.subAsset = ''; state.subHolder = ''; }
    // Майно — за утримувачами. У батальйону власного майна зазвичай немає:
    // воно числиться за його їдальнею й ВМТЗ, тому картка показує і сам
    // підрозділ, і кожного підлеглого окремо. Вид обліку — необоротний актив
    // чи запаси — за ФЕС; фільтр лишає лише один вид або одного утримувача.
    const holders = subs.filter((x) => inSubtree(sub, x.name)).sort((a, b) => a.order - b.order);
    const held = new Map();                       // «утримувач|код» → рядок
    const all = { n: 0, q: 0, value: 0, na: 0, stock: 0, holders: new Set(), ownN: 0, ownQ: 0 };
    for (const [k, arr] of lotsAt(date)) {
      const i = k.indexOf('|');
      const s = k.slice(0, i), code = k.slice(i + 1);
      if (!inSubtree(sub, s)) continue;
      if (bookOf(code) !== (state.subBook || 'ТЗ')) continue;
      let q = 0, value = 0;
      for (const l of arr) { q += l.q; value += l.q * l.price; }
      if (Math.abs(q) <= 1e-9) continue;
      const it = itemBy.get(code) || {};
      all.n++; all.q += q; all.value += value; all[assetOf(it)] += q; all.holders.add(s);
      if (s === sub) { all.ownN++; all.ownQ += q; }
      if (state.subHolder && !inSubtree(state.subHolder, s)) continue;
      if (state.subAsset && assetOf(it) !== state.subAsset) continue;
      // Рядок — на партію: давній прихід за 1 250,00 і пізніший за 980,00
      // стоять окремо, як в Excel цієї картки й у відомості звірки.
      for (const l of arr) {
        if (Math.abs(l.q) <= 1e-9) continue;
        const key = s + '|' + code + '|' + l.price;
        const h = held.get(key) || { holder: s, code, name: it.name || code, unit: it.unit || '',
          asset: assetOf(it), price: l.price, q: 0, value: 0 };
        h.q += l.q; h.value += l.q * l.price;
        held.set(key, h);
      }
    }
    const getters = { code: (r) => r.code, name: (r) => r.name, asset: (r) => ASSET[r.asset][1],
      price: (r) => r.price, q: (r) => r.q, value: (r) => r.value };
    const byCode = (a, b) => a.code.localeCompare(b.code, 'uk', { numeric: true }) || b.price - a.price;
    const groups = holders
      .map((h) => ({ sub: h, rows: sortRows('sub', [...held.values()].filter((r) => r.holder === h.name).sort(byCode), getters) }))
      .filter((g) => g.rows.length);
    const rows = groups.flatMap((g) => g.rows);
    const tot = rows.reduce((a, r) => ({ q: a.q + r.q, value: a.value + r.value }), { q: 0, value: 0 });
    const filtered = !!(state.subAsset || state.subHolder);
    const staffR = staffRows(date, sub);
    const cov = coverage(staffR, false);
    const shortR = staffR.filter((g) => g.staffed && g.short > 0);
    const st = reconStatus(sub);
    const mvo = mvoAt(sub, date);
    const subDocs = docs.filter((r) => inSubtree(sub, r.from) || inSubtree(sub, r.to));
    const gone = allDestroyed().filter((x) => inSubtree(sub, x.sub) && openAt(x, date));
    // Одиниці із заводськими номерами — під назвою: опис і відомість закріплення
    // називають кожну кухню її номером, а не «3 к-т».
    const unitNote = (r) => {
      const us = unitsAt(r.code, r.holder, date).filter((u) => Math.abs(u.price - r.price) < 0.005);
      return us.length ? `<small>${esc(us.map((u) => u.label).join(', '))}</small>` : '';
    };
    const itemRow = (r) => `<div class="tbl__row" data-code="${esc(r.code)}" title="Відкрити картку позиції">
        <div class="c-code">${esc(r.code)}</div><div class="c-name"><b>${esc(r.name)}</b>${unitNote(r)}</div>
        <div class="c-tag">${assetTag(itemBy.get(r.code) || {})}</div>
        <div class="c-unit">${esc(r.unit)}</div>
        <div class="c-num c-num--wide">${fmtMoney(r.price)}</div>
        <div class="c-num c-num--wide">${fmtNum(r.q)}</div>
        <div class="c-num c-num--xwide">${fmtMoney(r.value)}</div></div>`;
    const groupHead = (g) => `<div class="tbl__group"><b class="lnk" data-sub="${esc(g.sub.name)}" title="Відкрити картку підрозділу">${esc(g.sub.name)}</b>
        <span>${esc(g.sub.type)}</span><div class="panel__spacer"></div>
        <span>${cnt(g.rows.length, 'позиція', 'позиції', 'позицій')} · ${fmtNum(g.rows.reduce((a, r) => a + r.q, 0), '0')} од. · ${fmtMoney(g.rows.reduce((a, r) => a + r.value, 0))} грн</span></div>`;
    const itemRows = groups.map((g) => (hasKids ? groupHead(g) : '') + g.rows.map(itemRow).join('')).join('');
    // У батальйону власного майна не буває — воно за їдальнею чи ВМТЗ. Якщо
    // документ виписано на сам батальйон, картка пропонує перенести майно
    // підрозділу; за замовчуванням — їдальні, як його тримає ФЕС.
    const hall = holders.find((h) => h.parent === sub && / · їдальня$/i.test(h.name)) || holders.find((h) => h.parent === sub);
    const ownDocs = docs.filter((r) => r.from === sub || r.to === sub);
    const rehold = hasKids && all.ownQ > 1e-9 && hall ? `<div class="callout" style="margin-bottom:12px">
        <b>Майно, виписане на «${esc(sub)}»:</b> ${cnt(all.ownN, 'позиція', 'позиції', 'позицій')}, ${fmtNum(all.ownQ, '0')} од.
        у ${cnt(docCount(ownDocs), 'документі', 'документах', 'документах')}. У батальйону власного майна не буває.
        <label class="chip" style="margin-left:8px"><span class="chip__label">перенести на</span>
          <select id="f-rehold">${holders.filter((h) => h.name !== sub).map((h) =>
            `<option value="${esc(h.name)}"${h.name === hall.name ? ' selected' : ''}>${esc(h.name)}</option>`).join('')}</select></label>
        <button type="button" class="btn btn--primary btn--sm" data-act="sub-rehold"
          title="Замінити батальйон у документах">Перенести</button></div>` : '';
    const kidMvo = !hasKids ? '' : holders.filter((h) => h.name !== sub && (all.holders.has(h.name) || mvoAt(h.name, date))).map((h) => {
      const m = mvoAt(h.name, date);
      return `<div><b class="lnk" data-sub="${esc(h.name)}" title="Відкрити картку підрозділу">${esc(h.name)}</b>: ${m
        ? `<b class="lnk" data-act="pp-open" data-id="${esc(m.id)}">${esc(pFull(m))}</b>${[personAt(m, date).rank, personAt(m, date).pos].filter(Boolean).map((x) => ', ' + esc(x)).join('')}`
        : '<span class="num-bad">МВО не призначено</span>'}</div>`;
    }).join('');
    return {
      head: head(`підрозділи / ${sb.type}`, sub, `
        <button class="btn" data-act="back">← Назад</button>
        <button class="btn" data-act="sd-open" data-sub="${esc(sub)}"
          title="Змінити запис у довіднику">✎ Довідник</button>
        <button class="btn" data-act="sub-nomen" title="Відкрити з фільтром цього підрозділу">Номенклатура</button>
        <button class="btn" data-act="sub-j14">Журнал № 14</button>
        <button class="btn" data-act="sub-xls">В Excel</button>
        ${!sb.active && Math.abs(balSub(sub)) > 1e-9
          ? `<button class="btn btn--primary" data-act="sub-handover" data-sub="${esc(sub)}"
              title="Накладна на все майно закритого підрозділу">Передати майно накладною</button>` : ''}
        ${!sb.active || (st.last && reconOf(sub).some((r) => r.to === today())) ? ''
          : `<button class="btn btn--primary" data-act="rc-new" data-sub="${esc(sub)}">Скласти відомість звірки</button>`}`),
      body: `${flashBlock()}
        ${sb.active ? '' : `<div class="callout" style="margin-bottom:12px"><b>Підрозділ закритий.</b> ${esc(sb.note)}</div>`}
        <div class="tiles">
          <div class="tile"><div class="tile__label">Позицій · одиниць</div><div class="tile__value">${all.n}
            <small>/ ${fmtNum(all.q, '0')}</small></div><div class="tile__hint">${hasKids ? 'з підлеглими, ' : ''}необоротні
            ${fmtNum(all.na, '0')}, запаси ${fmtNum(all.stock, '0')} од.</div></div>
          <div class="tile"><div class="tile__label">Вартість</div><div class="tile__value">${fmtMoney(all.value)} <small>грн</small></div>
            <div class="tile__hint">за цінами партій</div></div>
          <div class="tile"><div class="tile__label">Укомплектованість</div>
            <div class="tile__value ${cov == null ? '' : cov >= 1 ? 'num-ok' : cov >= 0.5 ? 'num-warn' : 'num-bad'}">${cov == null ? '—' : Math.round(cov * 100) + '%'}</div>
            <div class="tile__hint">${shortR.length ? `некомплект за ${cnt(shortR.length, 'позицією', 'позиціями', 'позиціями')}` : 'за штатом 21/Прод'}</div></div>
          <div class="tile"${st.last ? ` data-act="rc-open" data-id="${esc(st.last.id)}" style="cursor:pointer"` : ''}>
            <div class="tile__label">Остання звірка</div>
            <div class="tile__value ${st.kind === 'ok' ? '' : 'num-bad'}" style="font-size:18px">${st.last ? fmtDate(st.last.to) : 'не було'}</div>
            <div class="tile__hint">${st.last ? `№${esc(st.last.no || '—')} · ${esc(st.last.status)} · ${st.days} дн. тому` : 'складіть відомість'}</div></div>
        </div>
        <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Матеріально відповідальна особа</div>
            <div class="panel__spacer"></div><button class="btn btn--sm" data-act="sub-mvo">Змінити →</button></div>
          <div class="pad">${mvo ? `<b class="lnk" data-act="pp-open" data-id="${esc(mvo.id)}">${esc(pFull(mvo))}</b>${
            [personAt(mvo, date).rank, personAt(mvo, date).pos].filter(Boolean).map((x) => ', ' + esc(x)).join('')}`
            : !sb.active || !all.q ? '<span class="c-num--dim">Не призначено: майна немає.</span>'
              : hasKids && all.holders.size && !all.holders.has(sub)
                ? '<span class="c-num--dim">Не призначено: майно числиться за підлеглими підрозділами.</span>'
                : '<span class="num-bad">Не призначено.</span>'}</div>
          ${kidMvo ? `<div class="pad" style="padding-top:0"><div class="c-num--dim" style="margin-bottom:4px">МВО підлеглих підрозділів</div>${kidMvo}</div>` : ''}</div>
        ${shortR.length ? `<div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Некомплект за штатом</div>
            <div class="panel__spacer"></div><button class="btn btn--sm" data-nav="supply">Відкрити штат</button></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:700px">
            <div class="tbl__head"><div class="tbl__h c-name">табельна позиція</div><div class="tbl__h c-num">штат</div>
              <div class="tbl__h c-num">наявно</div><div class="tbl__h c-num">некомплект</div></div>
            ${shortR.map((g) => `<div class="tbl__row tbl__row--plain"><div class="c-name"><b>${esc(g.line)}</b><small>${esc(g.form)}</small></div>
              <div class="c-num">${fmtNum(g.qty)}</div><div class="c-num">${fmtNum(g.fact, '0')}</div>
              <div class="c-num num-bad">${fmtNum(g.short)}</div></div>`).join('')}
          </div></div></div>` : ''}
        ${rehold}
        <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Майно на ${fmtDate(date)}</div>
            <div class="panel__spacer"></div>
            <div class="seg">${[['ТЗ', 'Техзасоби'], ['ОП', 'Посуд і миючі'], ['СП', 'Сухпай'], ['РП', 'Реторт-пакети']].map(([v, l]) =>
              `<button type="button" data-act="sub-book" data-v="${v}"${(state.subBook || 'ТЗ') === v ? ' class="is-on"' : ''}>${l}</button>`).join('')}</div>
            </div>
          <div class="panel sub-filter">
            ${(state.subBook || 'ТЗ') === 'ТЗ' ? `<div class="seg" title="Вид обліку за ФЕС">${[['', 'усе майно'], ['na', 'необоротні активи'], ['stock', 'запаси']]
              .map(([v, l]) => `<button type="button" data-act="sub-asset" data-v="${v}"${state.subAsset === v ? ' class="is-on"' : ''}>${l}</button>`).join('')}</div>` : ''}
            ${hasKids ? `<label class="chip${state.subHolder ? ' is-on' : ''}"><span class="chip__label">підрозділ</span>
              <select id="f-holder"><option value="">${esc(sub)} і всі підлеглі</option>${holders
                .filter((h) => h.name !== sub && [...all.holders].some((n) => inSubtree(h.name, n)))
                .map((h) => `<option value="${esc(h.name)}"${state.subHolder === h.name ? ' selected' : ''}>${'\u00a0\u00a0'.repeat(Math.max(0, h.depth - sb.depth - 1))}${esc(h.name)}</option>`).join('')}</select></label>` : ''}
            <div class="panel__spacer"></div>
            <span class="panel__count">${cnt(new Set(rows.map((r) => r.code)).size, 'позиція', 'позиції', 'позицій')} · ${fmtNum(tot.q, '0')} од.${filtered
              ? ' · <b class="lnk" data-act="sub-filter-reset">показати все</b>' : ''}</span>
          </div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:860px">
            <div class="tbl__head">${sortHead('sub', 'code', 'код', 'c-code')}${sortHead('sub', 'name', 'найменування', 'c-name')}
              ${sortHead('sub', 'asset', 'облік', 'c-tag')}<div class="tbl__h c-unit">од.</div>
              ${sortHead('sub', 'price', 'ціна партії, грн', 'c-num c-num--wide')}
              ${sortHead('sub', 'q', 'кількість', 'c-num c-num--wide')}${sortHead('sub', 'value', 'вартість, грн', 'c-num c-num--xwide')}</div>
            ${itemRows || `<div class="tbl__row tbl__row--plain"><div class="c-txt">${filtered ? 'За цим фільтром майна немає.' : 'Майна немає.'}</div></div>`}
            ${rows.length ? `<div class="tbl__row tbl__row--plain tbl__row--total"><div class="c-code"></div><div class="c-name"><b>Разом${filtered ? ' за фільтром' : ''}</b></div>
              <div class="c-tag"></div><div class="c-unit"></div><div class="c-num c-num--wide"></div>
              <div class="c-num c-num--wide">${fmtNum(tot.q, '0')}</div><div class="c-num c-num--xwide">${fmtMoney(tot.value)}</div></div>` : ''}
          </div></div></div>
        ${gone.length ? `<div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Знищене, не списане</div>
            <div class="panel__spacer"></div><button class="btn btn--sm" data-nav="destroyed">Відкрити знищене майно</button></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:700px">
            ${gone.map((x) => `<div class="tbl__row" data-code="${esc(x.code)}"><div class="c-date">${fmtDate(x.date)}</div>
              <div class="c-name"><b>${esc((itemBy.get(x.code) || {}).name || x.code)}</b><small>${esc(x.sub)}</small></div>
              <div class="c-num">${fmtNum(x.qty)}</div><div class="c-code">${esc(x.report ? 'рапорт ' + numNo(x.report) : '')}</div></div>`).join('')}
          </div></div></div>` : ''}
        <div class="card"><div class="card__head"><div class="card__title">Документи</div><div class="panel__spacer"></div>
            <button class="btn btn--sm" data-act="sub-moves">Усі документи ${subDocs.length ? '(' + docCount(subDocs) + ')' : ''}</button></div>
          <div class="card--scroll"><div class="tbl" style="--tbl-min:1000px;--acts:230px">
            <div class="tbl__head"><div class="tbl__h c-date">дата</div><div class="tbl__h c-tag">тип</div><div class="tbl__h c-status">стан</div>
              <div class="tbl__h c-code">№</div><div class="tbl__h c-name">найменування</div>
              <div class="tbl__h c-txt">маршрут</div><div class="tbl__h c-num">к-сть</div><div class="tbl__h c-acts"></div></div>
            ${docRows(subDocs.slice(0, 25)) || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Документів немає.</div></div>'}
          </div></div></div>`,
    };
  }

  /** Наявність підрозділу в Excel — як на картці: за утримувачами, з видом
   *  обліку й тими самими фільтрами (вид обліку, підлеглий підрозділ). */
  function subExcel() {
    const sub = state.subName;
    const date = state.asOf;
    const held = new Map();
    for (const [k, arr] of lotsAt(date)) {
      const i = k.indexOf('|');
      const s = k.slice(0, i), code = k.slice(i + 1);
      if (!inSubtree(sub, s)) continue;
      if (state.subHolder && !inSubtree(state.subHolder, s)) continue;
      const it = itemBy.get(code) || {};
      if (state.subAsset && assetOf(it) !== state.subAsset) continue;
      for (const l of arr) {
        const key = s + '|' + code + '|' + l.price;
        held.set(key, (held.get(key) || 0) + l.q);
      }
    }
    const order = (name) => (subBy.get(name) || {}).order ?? 1e9;
    const rows = [...held.entries()].filter(([, q]) => Math.abs(q) > 1e-9).map(([key, q]) => {
      const [s, code, price] = key.split('|');
      const it = itemBy.get(code) || {};
      const us = unitsAt(code, s, date).filter((u) => Math.abs(u.price - (+price || 0)) < 0.005);
      const name = (it.name || code) + (us.length ? ` (${us.map((u) => u.label).join(', ')})` : '');
      return [s, code, name, ASSET[assetOf(it)][1], it.unit || '', round3(q), +price || '', round2(q * (+price || 0))];
    }).sort((a, b) => order(a[0]) - order(b[0]) || String(a[1]).localeCompare(String(b[1]), 'uk', { numeric: true }));
    const who = state.subHolder || sub;
    const what = state.subAsset ? ASSET[state.subAsset][2] : 'технічних засобів';
    toExcel({ file: `Наявність ${who} на ${date}`, sheets: [{
      name: 'Наявність', orientation: 'landscape', top: [unitInfo().legalName, unitInfo().serviceFull],
      title: `Наявність ${what}: ${who}`, subtitle: `станом на ${fmtDate(date)}`,
      head: [['Підрозділ', 'Код', 'Найменування', 'Облік', 'Од.', 'Кількість', 'Ціна, грн', 'Сума, грн']],
      widths: [26, 9, 46, 12, 7, 11, 13, 15], rows, num: [5], money: [6, 7],
      total: ['', '', 'Разом', '', '', round3(rows.reduce((a, r) => a + r[5], 0)), '', round2(rows.reduce((a, r) => a + r[7], 0))],
    }] });
  }

  /** Майно, виписане на батальйон, переходить його підрозділу: у документах
   *  батальйон як сторона замінюється на підрозділ (їдальню), записи про
   *  знищення — так само. Це виправлення документів із записом у журнал змін
   *  по кожному: у батальйону власного майна не буває, воно завжди чиєсь. */
  function reholdToChild(sub, child) {
    if (!child || !subBy.get(child) || child === sub) return;
    const touched = new Map();                      // старий ключ → новий
    const fix = (kind, arr, fi, ti) => {
      for (const r of arr) {
        const from = String(r[fi] ?? '').trim(), to = ti == null ? '' : String(r[ti] ?? '').trim();
        if (from !== sub && to !== sub) continue;
        const oldKey = docKey(kind, r[0], r[2], from, to);
        if (from === sub) r[fi] = child;
        if (ti != null && to === sub) r[ti] = child;
        touched.set(oldKey, docKey(kind, r[0], r[2], r[fi], ti == null ? '' : r[ti]));
      }
    };
    fix('in', store.docs.incoming, 3, 4);
    fix('mv', store.docs.movement, 3, 4);
    fix('wr', store.docs.writeoffs, 3, null);             // «кому» у вибутті — не підрозділ
    let dz = 0;
    for (const x of (store.destroyed || [])) if (x.sub === sub) { x.sub = child; dz++; }
    if (!touched.size && !dz) { toast(`Документів, виписаних на «${sub}», немає.`); return; }
    for (const [oldKey, newKey] of touched) {
      const [k, d, no] = newKey.split('|');
      const text = `${KIND_NAME[k]} ${numNo(no)} від ${fmtDate(d)}: утримувач «${sub}» → «${child}»`;
      logChange('виправлено', newKey, text);
      if (oldKey !== newKey) logChange('виправлено', oldKey, `тепер ${text}`);
    }
    save(true, true);
    refresh();
    toast(`Майно «${sub}» перенесено на «${child}»: ${cnt(touched.size, 'документ', 'документи', 'документів')}`
      + (dz ? `, ${cnt(dz, 'запис про знищення', 'записи про знищення', 'записів про знищення')}` : '') + '.');
  }
