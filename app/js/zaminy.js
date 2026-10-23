// Облік ТЗ ПС · сторінка · заміни в штаті.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ---------------------------------------------------------- Заміни в штаті
  function substAdd() {
    const d = state.substDraft;
    if (!d.from || !d.to.length) { toast('Оберіть замінник і позицію, яку він замінює.', true); return; }
    store.subst = store.subst || [];
    const same = store.subst.find((r) => r.form === state.staffForm && r.from === d.from);
    const text = `«${substName(d.from)}» замість ${d.to.map((t) => `«${t}»`).join(', ')} (${state.staffForm})`;
    if (same) {
      // Друге правило на той самий замінник — це доповнення першого, а не дубль.
      for (const t of d.to) if (!same.to.includes(t)) same.to.push(t);
      toast(`Правило для «${substName(d.from)}» доповнено.`);
      logChange('заміну доповнено', 'subst|' + same.id, text);
    } else {
      const r = { id: uid(), form: state.staffForm, from: d.from, to: d.to.slice() };
      store.subst.push(r);
      toast(`Правило додано: «${substName(d.from)}» замість ${d.to.map((t) => `«${t}»`).join(', ')}.`);
      logChange('заміну додано', 'subst|' + r.id, text);
    }
    state.substDraft = { from: '', to: [] };
    save();
    render();
  }

  function substDelete(id) {
    const r = (store.subst || []).find((x) => x.id === id);
    if (!r || !confirm(`Видалити правило заміни для «${substName(r.from)}» (${r.to.join(', ')})?`)) return;
    store.subst = store.subst.filter((x) => x.id !== id);
    logChange('заміну видалено', 'subst|' + r.id, `«${substName(r.from)}» замість ${r.to.map((t) => `«${t}»`).join(', ')} (${r.form})`);
    save(true, true);
    render();
  }

  /** Черга правил — у межах своєї форми: сусід у загальному переліку буває
   *  правилом іншої форми, і стрілка тоді нічого видимого не робила. */
  function substMove(id, by) {
    const list = store.subst || [];
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    const mine = list.map((x, n) => [x, n]).filter(([x]) => x.form === list[i].form).map(([, n]) => n);
    const at = mine.indexOf(i);
    const j = mine[at + by];
    if (j == null) return;
    [list[i], list[j]] = [list[j], list[i]];
    logChange('черга замін', 'subst|' + list[j].id, `«${substName(list[j].from)}» ${by < 0 ? 'вище' : 'нижче'} (${list[j].form})`);
    save();
    render();
  }

  function bindSubst() {
    const form = state.staffForm;
    bindCombo('#sb-from', () => substSrcOpts(form), (v) => {
      const d = state.substDraft;
      state.substDraft = { from: v, to: d.to.filter((t) => t !== v) };
      render();
      if (!state.substDraft.to.length) setTimeout(() => $('#sb-to')?.focus(), 0);
    }, 'Чим замінюють', 'Enter — обрати');
    bindCombo('#sb-to', () => substTgtOpts(form), (v) => substTarget(v), 'Замість чого', 'Enter — додати');
  }

  /** Додати (чи прибрати) позицію, яку замінник закриває. Порядок додавання —
   *  це черговість, у якій він їх закриває. */
  function substTarget(line, on = true) {
    const d = state.substDraft;
    if (!on) d.to = d.to.filter((t) => t !== line);
    else if (line && line !== d.from && !d.to.includes(line)) d.to.push(line);
    render();
  }

  const substWho = (codes) => (codes || []).map((c) => {
    const it = itemBy.get(c);
    return c + ' ' + (it ? it.name : '');
  }).join(' ');
  const substSubs = (codes) => (codes || []).map((c) => {
    const it = itemBy.get(c);
    return `${it ? cleanName(it.name) : ''} (${c})`;
  });

  /** Що може йти за заміну: рядки форми з наявністю (надлишок — угорі) і
   *  позиції номенклатури, яких у табелі форми немає зовсім. Шукається й за
   *  назвою рядка, і за кодами та назвами позицій під ним: «єврокуб» знаходить
   *  рядок бланка, хоч у ньому написано «Ємність харчова 1000 л.». */
  function substSrcOpts(form) {
    const d = state.substDraft;
    const rows = staffRows(state.asOf, '').filter((g) => g.form === form && !g.ref);
    const lines = rows.filter((g) => g.fact > 0)
      .sort((a, b) => (b.fact - b.qty) - (a.fact - a.qty) || a.line.localeCompare(b.line, 'uk'))
      .map((g) => ({ value: g.line, label: g.line, search: substWho(g.codes), subs: substSubs(g.codes), current: g.line === d.from,
        meta: `наявно ${fmtNum(g.fact)}${g.staffed ? ` · штат ${fmtNum(g.qty)}` : ' · без штату'}${
          g.fact > g.qty ? ` · понад штат ${fmtNum(g.fact - g.qty)}` : ''}` }));
    const inForm = new Set(reportLines.filter((l) => l.form === form).flatMap((l) => l.codes));
    const loose = tzItems().filter((it) => !inForm.has(it.code))
      .map((it) => ({ it, q: balCode(it.code) }))
      .sort((a, b) => b.q - a.q || a.it.code.localeCompare(b.it.code, 'uk', { numeric: true }))
      .map(({ it, q }) => ({ value: '#' + it.code, label: `${cleanName(it.name)} · код ${it.code}`, search: it.name,
        current: '#' + it.code === d.from, meta: `${q ? 'наявно ' + fmtNum(q) : 'немає'} · поза табелем форми` }));
    return lines.concat(loose);
  }

  /** Що замінник закриває: позиції зі штатом, найбільший некомплект — угорі. */
  function substTgtOpts(form) {
    const d = state.substDraft;
    const all = staffRows(state.asOf, '').filter((g) => g.form === form && g.staffed);
    const here = new Map(staffRows(state.asOf, state.sub).filter((g) => g.form === form).map((g) => [g.line, g]));
    return all.filter((g) => g.line !== d.from && !d.to.includes(g.line))
      .map((g) => here.get(g.line) || Object.assign({}, g, { short: 0, qty: 0 }))
      .sort((a, b) => b.short - a.short || a.line.localeCompare(b.line, 'uk'))
      .map((g) => ({ value: g.line, label: g.line, search: substWho(g.codes), subs: substSubs(g.codes),
        meta: !g.qty ? `штату в «${state.sub}» немає` : `штат ${fmtNum(g.qty)} · ${g.short ? 'бракує ' + fmtNum(g.short) : 'укомплектовано'}` }));
  }

  function renderSubst() {
    const form = state.staffForm;
    const rows = applySubst(staffRows(state.asOf, state.sub).filter((g) => g.form === form), form);
    const by = substIndex(rows);
    const rules = (store.subst || []).filter((x) => x.form === form);
    const forms = [...staffForms].sort();
    const d = state.substDraft;
    const scopeName = state.sub || 'уся бригада';

    // Замінник обраний — під полем видно, скільки його є і скільки піде за заміну.
    let srcHint = 'Рядок форми або будь-яка позиція номенклатури.';
    if (d.from) {
      const g = substSource({ from: d.from }, rows, by);
      const code = isItemRef(d.from) ? d.from.slice(1) : '';
      const have = g ? g.fact : code ? (state.sub ? haveRollup(state.sub, code) : balCode(code)) : 0;
      srcHint = `${esc(scopeName)}: наявно ${fmtNum(have, '0')}${g && g.staffed ? `, власний штат ${fmtNum(g.qty)}. За заміну йде лише надлишок`
        : ', штату немає. За заміну йде вся наявність'}.`;
    }
    const lineOf = new Map(rows.map((g) => [g.line, g]));
    const chips = d.to.map((t, i) => {
      const g = lineOf.get(t);
      return `<span class="sb-chip"><b>${i + 1}</b>${esc(t)}${g ? `<small>${g.short ? 'бракує ' + fmtNum(g.short) : 'укомплектовано'}</small>` : ''}
        <button type="button" class="sb-chip__x" data-act="sb-rm" data-v="${esc(t)}" title="Прибрати">✕</button></span>`;
    }).join('');
    const quick = rows.filter((g) => g.staffed && g.short > 0 && g.line !== d.from && !d.to.includes(g.line))
      .sort((a, b) => b.short - a.short).slice(0, 8)
      .map((g) => `<button type="button" class="chip chip--btn" data-act="sb-qt" data-v="${esc(g.line)}" title="${esc(g.line)}">+ ${
        esc(shortName(g.line))} <b class="num-bad">−${fmtNum(g.short)}</b></button>`).join('');
    const fromLabel = d.from ? substName(d.from) : '';

    const ruleRows = rules.map((r, n) => {
      const src = substSource(r, rows, by);
      const got = src ? src.subTo : [];
      const spare = src ? Math.max(0, src.fact - src.qty) : 0;
      const effect = !src ? 'цієї позиції на дату немає'
        : got.length ? `закрито: ${got.map(([l, q]) => `${shortName(l)} – ${fmtNum(q)}`).join('; ')}`
          : spare ? 'некомплекту в цих позиціях немає' : 'надлишку понад власний штат немає';
      return `<div class="tbl__row tbl__row--plain">
        <div class="c-num c-num--dim" style="width:34px">${n + 1}</div>
        <div class="c-name" style="flex:2 1 0"><b>${esc(substName(r.from))}</b><small>замість: ${r.to.map(esc).join(', ')}</small></div>
        <div class="c-num">${src ? fmtNum(spare, '0') : '—'}</div>
        <div class="c-txt" style="flex:1.4 1 0" title="${esc(effect)}">${esc(effect)}</div>
        <div class="c-acts" style="flex-basis:150px">
          ${rowBtn('sb-up', '▲', `data-id="${esc(r.id)}"`, { title: 'Підняти в черзі', off: !n })}
          ${rowBtn('sb-down', '▼', `data-id="${esc(r.id)}"`, { title: 'Опустити в черзі', off: n >= rules.length - 1 })}
          ${rowBtn('sb-del', '✕ Видалити', `data-id="${esc(r.id)}"`, { bad: true, title: 'Видалити правило' })}</div>
      </div>`;
    }).join('');

    const touched = rows.filter((g) => g.staffed && (g.subIn || g.subOut || rules.some((r) => r.to.includes(g.line))));
    const effRows = touched.map((g) => `<div class="tbl__row tbl__row--plain">
        <div class="c-name"><b>${esc(g.line)}</b>${g.subFrom.length ? `<small>за рахунок: ${esc(g.subFrom.map(([l, q]) => `${shortName(l)} – ${fmtNum(q)}`).join('; '))}</small>` : ''}${
          g.subTo.length ? `<small>віддано на заміну: ${esc(g.subTo.map(([l, q]) => `${shortName(l)} – ${fmtNum(q)}`).join('; '))}</small>` : ''}</div>
        <div class="c-num">${fmtNum(g.qty)}</div>
        <div class="c-num">${fmtNum(g.fact, '0')}</div>
        <div class="c-num c-num--wide ${g.subIn ? 'num-ok' : 'c-num--dim'}">${g.subIn ? '+' + fmtNum(g.subIn) : '—'}</div>
        <div class="c-num c-num--wide">${g.short ? fmtNum(g.short) : '—'} → <b class="${g.shortS ? 'num-bad' : 'num-ok'}">${g.shortS ? fmtNum(g.shortS) : '0'}</b></div>
        <div class="c-num c-num--wide">${Math.round(g.pct * 100)}% → <b>${Math.round(g.pctS * 100)}%</b></div>
      </div>`).join('');
    const cov = coverage(rows, false), covS = coverage(rows, true);

    return {
      head: head('техзасоби / заміни', 'Заміни в штаті', `${staffSeg('subst')}
        ${forms.length > 1 ? `<div class="seg">${forms.map((f) => `<button type="button" data-act="sf" data-v="${esc(f)}"${f === form ? ' class="is-on"' : ''}>форма ${esc(f)}</button>`).join('')}</div>` : ''}`),
      body: `<div class="panel"><div class="panel__note">
          Укомплектованість на ${fmtDate(state.asOf)} (${esc(scopeName)}):
          ${cov == null ? '—' : Math.round(cov * 100) + '%'}${rules.length ? `, із замінами <b class="num-ok">${Math.round(covS * 100)}%</b>` : ''}.</div></div>

      <div class="card form" style="margin-bottom:12px">
        <div class="card__head"><div class="card__title">Нове правило · форма ${esc(form)}</div></div>
        <div class="sb-new">
          <div class="field"><label>Чим замінюють</label>
            <input id="sb-from" value="${esc(fromLabel)}" data-cur="${esc(fromLabel)}" autocomplete="off" spellcheck="false"
              placeholder="Назва або код: єврокуб, КП-130">
            <div class="field__hint">${srcHint}</div></div>
          <div class="sb-new__arrow" aria-hidden="true">→</div>
          <div class="field"><label>Замість чого (по черзі)</label>
            ${chips ? `<div class="sb-chips">${chips}</div>` : ''}
            <input id="sb-to" value="" data-cur="" autocomplete="off" spellcheck="false"
              placeholder="${d.to.length ? 'Наступна позиція' : 'Назва або код: ЦВ-4, термос'}">
            ${quick ? `<div class="sb-quick"><span>найбільший некомплект:</span>${quick}</div>` : ''}</div>
        </div>
        <div class="card__foot">
          <button class="btn btn--primary" type="button" data-act="sb-add"${d.from && d.to.length ? '' : ' disabled'}>Додати правило</button>
          ${d.from || d.to.length ? '<button class="btn" type="button" data-act="sb-clear">Скасувати</button>' : ''}
        </div>
      </div>

      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Правила заміни</div>
          <div class="panel__spacer"></div><span class="panel__count">${cnt(rules.length, 'правило', 'правила', 'правил')}</span></div>
        <div class="card--scroll"><div class="tbl" style="--tbl-min:860px">
          <div class="tbl__head"><div class="tbl__h c-num" style="width:34px">№</div>
            <div class="tbl__h c-name" style="flex:2 1 0">замінник</div>
            <div class="tbl__h c-num">надлишок</div><div class="tbl__h c-txt" style="flex:1.4 1 0">результат</div>
            <div class="tbl__h c-acts" style="flex-basis:96px"></div></div>
          ${ruleRows || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Правил ще немає.</div></div>'}
        </div></div></div>

      ${touched.length ? `<div class="card"><div class="card__head"><div class="card__title">Укомплектованість із замінами · ${esc(scopeName)}</div></div>
        <div class="card--scroll"><div class="tbl" style="--tbl-min:860px">
          <div class="tbl__head"><div class="tbl__h c-name">табельна позиція</div><div class="tbl__h c-num">штат</div>
            <div class="tbl__h c-num">наявно</div><div class="tbl__h c-num c-num--wide">по заміні</div>
            <div class="tbl__h c-num c-num--wide">некомплект</div><div class="tbl__h c-num c-num--wide">укомплект.</div></div>
          ${effRows}</div></div></div>` : ''}`,
    };
  }
