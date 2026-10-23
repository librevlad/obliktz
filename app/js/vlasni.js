// Облік ТЗ ПС · сторінка · власні позиції, записи про знищення, дії.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ------------------------------------------------ власні позиції номенклатури
  /** Позиції, заведені в програмі. Прийшло нове обладнання — його треба мати в
   *  довіднику до того, як оприбуткувати: інакше в накладній його просто нема
   *  чого обрати. Зберігаються разом з іншими внесеними даними.
   *  Позиція будується із запису цілою: що він несе (номер ФЕС, примітка, старі коди,
   *  архів, норма на д/д, заводські дані й будь-яке майбутнє поле), те й лишається; вибраний
   *  перелік полів губив решту, а правка картки записала б утрачене порожнім. */
  const ownItem = (r) => Object.assign({ cat: 0, serial: '', chassis: '', year: 0, perRation: null, normLine: '' }, r, {
    code: String(r.code), price: +r.price || 0, nonrev: r.nonrev ? 1 : 0, own: true,
    fes: r.fes || '', note: r.note || '', old: r.old || '', archived: r.archived || '' });

  /** Запис стану з позиції програми, що прийшла з довідником: усі її поля, крім службових полів сторінки
   *  (`own`, `basePrice`); ціна — довідникова, а не обчислена з останнього приходу. */
  const ownRecord = (i) => {
    const rec = Object.assign({}, i, { price: i.basePrice ?? i.price, nonrev: !!i.nonrev });
    delete rec.own;
    delete rec.basePrice;
    return rec;
  };

  /** Позиції, заведені в програмі, приходять із бази разом з усіма іншими; тут
   *  лише підтримується робочий перелік між збереженнями — щойно заведену
   *  позицію треба бачити одразу, не чекаючи перезапуску. */
  const itemsReady = new WeakSet();
  function mergeOwnItems() {
    // Позиції, заведені в програмі, живуть у базі й після перезапуску приходять
    // із довідником (D.items, own), а не зі стану. Раніше порожній стартовий
    // перелік їх відкидав: картка зникала, наступна нова позиція брала той самий
    // код, а позиція, що вже була в документах, зупиняла всі збереження.
    if (!itemsReady.has(store)) {
      itemsReady.add(store);
      const had = new Map((Array.isArray(store.items) ? store.items : []).map((r) => [String(r.code), r]));
      // Запис береться з довідника цілим: номер ФЕС, примітка, старі коди, архів і норма на д/д не губляться.
      for (const i of items) {
        if (i.own && !had.has(i.code)) had.set(i.code, ownRecord(i));
      }
      store.items = [...had.values()];
    }
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].own) { itemBy.delete(items[i].code); items.splice(i, 1); }
    }
    for (const r of store.items || []) {
      const base = itemBy.get(String(r.code));
      if (base && !base.own) {
        // Правка позиції з паперів служби: міняється те, що правили; код,
        // заводські номери, партії й номер ФЕС лишаються базовими.
        Object.assign(base, { name: r.name, group: r.group, unit: r.unit, nonrev: r.nonrev ? 1 : 0 });
        for (const k of ['fes', 'note', 'old', 'archived']) if (k in r) base[k] = r[k] || '';
        if ('kind1' in r) base.kind1 = r.kind1 || '';                         // вид у звіті 1/прод (книга СП)
        // Норма на д/д позиції книги ОП і рядок норми наказу 390: правка в картці доходить до позиції зразу, а не після перезапуску.
        if ('perRation' in r) base.perRation = r.perRation ?? null;
        if ('normLine' in r) base.normLine = r.normLine || '';
        // Ціна з картки важить, доки позицію не оприбуткували з ціною.
        if ('price' in r) base.basePrice = +r.price || 0;
        continue;
      }
      const it = ownItem(r);
      items.push(it);
      itemBy.set(it.code, it);
    }
    items.sort((a, b) => a.code.localeCompare(b.code, 'uk', { numeric: true }));
  }

  /** Наступний вільний код: служба нумерує позиції підряд, тож новий — на
   *  одиницю більший за найбільший числовий код довідника. */
  function nextCode(book = 'ТЗ') {
    const nums = items.filter((i) => bookOfItem(i) === book).map((i) => +i.code).filter((n) => Number.isFinite(n) && n < 1e6);
    return String((nums.length ? Math.max(...nums) : isSpRp(book) ? BOOKS[book].codeBase : book === 'ОП' ? 6000 : 10000) + 1);
  }

  const normName = (x) => String(x || '').toLowerCase().replace(/[\s"'«»,.]+/g, '');

  /** Де вже вжито код позиції: документи, знищене, звірки, норми, чернетки.
   *  Позицію, на яку щось посилається, не можна ні видалити, ні перекодувати —
   *  інакше ці записи вказуватимуть у порожнечу. */
  function itemUses(code) {
    const c = String(code);
    const out = [];
    const n = docs.filter((r) => r.code === c).length;
    if (n) out.push(cnt(n, 'рядок документів', 'рядки документів', 'рядків документів'));
    if ((store.destroyed || []).some((r) => r.code === c)) out.push('записи про знищення');
    if ((store.recon || []).some((r) => r.lines.some((l) => l.code === c))) out.push('відомості звірки');
    if (normsInit().some((n) => n.code === c)) out.push('норми');
    const inDrafts = [state.draft, ...Object.values(state.drafts || {})]
      .some((dr) => dr && dr.lines.some((l) => l.code === c));
    if (inDrafts) out.push('незавершена чернетка документа');
    return out;
  }

  /** Рядок норми, який картка записує: лише разом з його числом і лише рядок групи позиції (посуд — ОП.1, серветки — ОП.2, миючі —
   *  ОП.3); інакше — порожній. */
  const normLineToSave = (key, group, per) => { const l = opNormLine(key); return l && per != null && l[5] === group && Math.abs(per - l[3]) < 1e-9 ? l[0] : ''; };

  /** «Норма на д/д» у картці позиції ОП. Норма наказу 390 зі списку лягає в поле, а її рядок — у картку (normLine); сам список
   *  вертається на «за наказом 390…». Число, виправлене руками на інше, рядка вже не тримає; так само група: рядок норми — рядок
   *  групи позиції, і рядок іншої групи зі зміною групи знімається. Підказка під списком (normLineHint) йде за карткою: набране
   *  число, одиниця й група міняють її, поки картка відкрита. */
  function bindNormPick() {
    document.querySelectorAll('[data-norm-pick]').forEach((sel) => {
      const box = sel.closest('.field');
      const form = sel.closest('form');
      const inp = box.querySelector('input[name="perRation"]');
      const line = box.querySelector('input[name="normLine"]');
      const hint = box.querySelector('[data-norm-line]');
      const group = form && form.querySelector('[name="group"]');
      const unit = form && form.querySelector('[name="unit"]');
      const show = () => {
        if (hint) hint.textContent = normLineHint(line ? line.value : '',
          { group: group && group.value, unit: unit && unit.value.trim(), per: inp ? inp.value : '' });
      };
      sel.addEventListener('change', () => {
        const opt = sel.selectedOptions[0];
        if (sel.value && inp && opt) {
          inp.value = opt.dataset.per;
          if (line) line.value = sel.value;
          show();
        }
        sel.value = '';
      });
      inp?.addEventListener('input', () => {
        const l = line ? opNormLine(line.value) : null;
        if (l && Math.abs((+inp.value || 0) - l[3]) > 1e-9) line.value = '';
        show();
      });
      unit?.addEventListener('input', show);
      group?.addEventListener('change', () => {
        const l = line ? opNormLine(line.value) : null;
        if (l && l[5] !== group.value) line.value = '';
        show();
      });
    });
  }

  function itemForm() {
    if (!state.newItem) return '';
    const d = state.newItem;
    const editing = !!d.editCode;
    const lockCode = editing && (d.base || itemUses(d.editCode).length > 0);
    // Позиція несе одну ціну — її й правлять тут; кілька цін мають лише коди,
    // оприбутковані до правила «інша ціна — інший код».
    const prices = editing ? codePrices(d.editCode) : [];
    const units = [...new Set(items.map((i) => i.unit).filter(Boolean))].sort();
    const book = BOOK_OF_GROUP.get(d.group) || 'ТЗ';
    const op = book === 'ОП', tz = book === 'ТЗ';
    return `<form class="card form" id="item-form" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">${editing ? `Виправлення позиції ${esc(d.editCode)}`
        : d.like ? `Нова позиція за зразком ${esc(d.like)}` : 'Нова позиція номенклатури'}</div></div>
      <div class="form__grid">
        <div class="field"><label>Код <span class="req">*</span></label>
          <input name="code" value="${esc(d.code)}" required autocomplete="off"${lockCode
            ? ` readonly title="${d.base ? 'Код із паперів служби не змінюється' : 'Використаний код не змінюється'}"` : ''}></div>
        <div class="field field--span2"><label>Найменування <span class="req">*</span></label>
          <input name="name" value="${esc(d.name)}" required placeholder="як у накладній постачальника"></div>
        <div class="field"><label>Одиниця виміру <span class="req">*</span></label>
          <input name="unit" value="${esc(d.unit)}" list="units-list" required placeholder="шт">
          <datalist id="units-list">${units.map((u) => `<option value="${esc(u)}">`).join('')}</datalist></div>
        <div class="field field--span2"><label>${tz ? 'Розділ 21/Прод' : 'Група'}</label>
          <select name="group">${D.groups.filter(([, , b]) => (b || 'ТЗ') === book).map(([c, l]) =>
            `<option value="${c}"${c === d.group ? ' selected' : ''}>${tz ? c + ' · ' : ''}${esc(l)}</option>`).join('')}</select></div>
        ${prices.length > 1 ? `<div class="field"><label>Ціна, грн</label>
          <input value="${esc(prices.map(fmtMoney).join('; '))}" disabled title="Оприбутковано за різними цінами"></div>` : `<div class="field"><label>Ціна, грн</label>
          <input name="price" type="number" min="0" step="0.01" value="${esc(+d.price > 0 ? (+d.price).toFixed(2) : '')}"${prices.length
            ? ' required title="Зміниться в усіх документах коду"' : ''}></div>`}
        ${op ? `<div class="field"><label>Норма на д/д</label>
          <input name="perRation" type="number" min="0" step="any" value="${esc(d.perRation ?? '')}"
            title="Норма на одну добову видачу">
          <input type="hidden" name="normLine" value="${esc(opNormLine(d.normLine) ? d.normLine : '')}">
          <select data-norm-pick aria-label="Норма наказу 390" style="margin-top:6px"><option value="">за наказом 390…</option>${
            ((D.opNorms || {}).perRation || []).map(([key, n, u, per, basis]) =>
              `<option value="${esc(key)}" data-per="${per}" title="${esc(basis)}">${esc(n)} — ${fmtNorm(per)} ${esc(u)}</option>`).join('')}</select>
          <small class="field__hint" data-norm-line>${esc(normLineHint(d.normLine,
            { group: d.group, unit: String(d.unit || '').trim(), per: d.perRation }))}</small></div>` : !tz ? bookItemFields(d, book) : `<div class="field"><label>Номер у ФЕС</label>
          <input name="fes" value="${esc(d.fes || '')}" inputmode="numeric" autocomplete="off"
            placeholder="інвентарний чи номенклатурний"
            title="Десять цифр із класом 10 чи 11 — необоротний актив, інший номер — запаси"></div>
        <div class="field field--span2"><label><input type="checkbox" name="nonrev"${d.nonrev ? ' checked' : ''}>
          Необоротний актив (субрахунки 10/11)</label>
          <small class="field__hint">${d.fes ? 'вид обліку — за номером ФЕС'
            : 'номера ФЕС немає, звірте з бухгалтерією'}</small></div>
        <div class="field"><label>Старі коди (облік 3.0)</label>
          <input name="old" value="${esc(d.old || '')}" placeholder="10102, 10103" autocomplete="off"
            title="Коди з книги 3.0, згорнуті в цю позицію: за ними її знайде пошук"></div>`}
        <div class="field field--span2"><label>Примітка</label>
          <input name="note" value="${esc(d.note || '')}" placeholder="паспорт, формуляр, звідки позиція"></div>
        <div class="field"><label><input type="checkbox" name="archived"${d.archived ? ' checked' : ''}>
          В архіві</label>
          <small class="field__hint">у нових приходах не пропонується</small></div>
      </div>
      <div class="card__foot">
        <button class="btn btn--primary" type="submit">${editing ? 'Зберегти зміни' : 'Додати позицію'}</button>
        <button class="btn" type="button" data-act="item-cancel">Скасувати</button>
        <div class="panel__spacer"></div>
        <span class="panel__count" id="item-msg"></span>
      </div>
    </form>`;
  }

  /** Поля позиції книги СП чи РП: дободач — скільки добових дач покриває одиниця (добовий пайок — 1,
   *  раціон на одне приймання їжі — 1/3) і вид рядка звіту 1/прод (у книзі — колонка «тип»). */
  function bookItemFields(d, book) {
    const b = BOOKS[book];
    if (!b) return '';
    return (b.perRation ? `<div class="field"><label>Дободач</label>
          <input name="perRation" value="${esc(rationText(d.perRation))}" inputmode="decimal" placeholder="1 чи 1/3"
            title="Скільки добових дач покриває одиниця: добовий пайок — 1, раціон на одне приймання їжі — 1/3"></div>` : '')
      + `<div class="field"><label>${esc(b.typeLabel)}</label>
          <select name="kind1"><option value="">—</option>${b.types.map((t) =>
            `<option${t === d.kind1 ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;
  }

  function submitItem(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const g = (k) => (f.get(k) || '').toString().trim();
    const code = g('code'), name = g('name'), unit = g('unit');
    const editing = state.newItem && state.newItem.editCode ? String(state.newItem.editCode) : null;
    const was = editing ? itemBy.get(editing) : null;
    const bad = [];
    if (!code) bad.push('Вкажіть код.');
    else if (code !== editing && itemBy.has(code)) bad.push(`Код ${code} уже зайнятий: «${itemBy.get(code).name}».`);
    if (!name) bad.push('Вкажіть найменування.');
    if (!unit) bad.push('Вкажіть одиницю виміру.');
    const fes = g('fes').replace(/\s+/g, '');
    if (fes && !/^\d+$/.test(fes)) bad.push('Номер ФЕС — лише цифри.');
    // Дободач книги СП пишуть текстом («1», «0,5», «1/3»): що не число й не дріб більше нуля, стерло б поле мовчки (NaN у JSON — null).
    if (f.has('perRation') && isSpRp(BOOK_OF_GROUP.get(g('group'))) && perRationBad(g('perRation'))) {
      bad.push('Дободач — число чи дріб: 1, 0,5, 1/3.');
    }
    if (editing && code !== editing && itemUses(editing).length) {
      bad.push(`Код ${editing} змінити не можна: його вжито (${itemUses(editing).join(', ')}).`);
    }
    // Ціна позиції — ціна її приходів: виправлена тут, вона міняється в усіх
    // документах коду. Код із кількома цінами ціну тут не править.
    const prices = editing ? codePrices(editing) : [];
    const price = Math.round((+g('price') || 0) * 100) / 100;
    const fix = prices.length === 1 && Math.abs(price - prices[0]) >= 0.005 ? { was: prices[0], now: price } : null;
    if (fix && !(price > 0)) bad.push('Вкажіть ціну: позицію оприбутковано з ціною.');
    if (bad.length) {
      const m = $('#item-msg');
      if (m) { m.innerHTML = bad.map(esc).join('<br>'); m.style.color = 'var(--bad)'; }
      return;
    }
    // Та сама назва буває законно (п'ять причепів ЦВ-1,2 — п'ять карток): не
    // забороняємо, лише перепитуємо.
    const like = state.newItem && !editing ? state.newItem.like : null;
    const likeIt = like ? itemBy.get(String(like)) : null;
    if (name && !(was && normName(was.name) === normName(name))
      && !(likeIt && normName(likeIt.name) === normName(name))) {
      const same = items.find((i) => i.code !== editing && normName(i.name) === normName(name));
      if (same && !confirm(`Позиція з такою назвою вже є: ${same.code} «${same.name}».\n\n`
        + 'Завести ще одну картку з тією самою назвою?')) return;
    }
    // Одиниця виміру — у кожному документі позиції й у журналі 47: зміна
    // переписує й минулі папери, тож лише за згодою.
    const used = editing ? docs.filter((r) => r.code === editing).length : 0;
    if (was && unit !== was.unit && used && !confirm(`Одиниця виміру «${was.unit}» → «${unit}» зміниться в усіх `
      + `${cnt(used, 'рядку документів', 'рядках документів', 'рядках документів')} і в журналі № 47. Змінити?`)) return;
    let lock = '';
    if (fix) {
      const hit = docs.filter((r) => r.code === editing && Math.abs((+r.price || 0) - fix.was) < 0.005);
      if (!confirm(`Ціна коду ${editing} зміниться з ${fmtMoney(fix.was)} на ${fmtMoney(fix.now)} грн `
        + `у ${cnt(docCount(hit), 'документі', 'документах', 'документах')}. Змінити?`)) return;
      // Підписана звірка чи завершена інвентаризація рахували суми за старою ціною.
      lock = periodLock(hit.map((r) => r.d), hit.flatMap((r) => [r.from, r.kind === 'wr' ? '' : r.to]));
      if (lock && !histOn() && !confirm(lock.replace(/^Документ від \S+ потрапляє/, 'Зміна ціни потрапляє')
        .replace(/\n\nДля внесення старих документів[^\n]*/, '').replace('Провести все одно?', 'Змінити все одно?'))) return;
    }
    store.items = store.items || [];
    const base = state.newItem && state.newItem.base ? was : null;
    // Щойно вписаний номер ФЕС вирішує вид обліку: десять цифр із класом 10 чи 11 —
    // необоротний актив, інший номер — запаси (як правило бази asset_class.sql).
    // Номер той самий — вид обліку лишається таким, як позначила людина.
    const byFes = fes && fes !== String((was && was.fes) || '') ? fes.length === 10 && /^1[01]/.test(fes) : null;
    const fields = { code, name, unit, group: g('group'),
                     price: prices.length > 1 ? +(was.basePrice ?? was.price) || 0 : price,
                     nonrev: byFes ?? f.get('nonrev') === 'on',
                     fes, note: g('note'), old: g('old'),
                     archived: f.get('archived') === 'on' ? (was && was.archived) || today() : '' };
    if (f.has('perRation')) fields.perRation = rationOf(g('perRation'));       // «1/3» — так, як пише книга
    if (f.has('kind1')) fields.kind1 = g('kind1');
    // Рядок норми наказу 390 — лише разом з його числом (норма, вписана руками інша, рядка не має) і лише рядок групи позиції.
    if (f.has('normLine')) fields.normLine = normLineToSave(g('normLine'), fields.group, fields.perRation);
    if (editing) {
      const rec = store.items.find((x) => String(x.code) === editing);
      if (rec) Object.assign(rec, fields);
      else store.items.push(fields);                    // правка позиції з паперів служби
      const cls = was && !!was.nonrev !== fields.nonrev ? ` — тепер ${ASSET[fields.nonrev ? 'na' : 'stock'][1]}` : '';
      // Виправили саму лише ціну — у журналі змін один запис, про ціну.
      const onlyPrice = fix && was && ['name', 'unit', 'group', 'fes', 'note', 'old'].every((k) =>
        String(was[k] || '') === String(fields[k] || '')) && !!was.nonrev === !!fields.nonrev
        && !!was.archived === !!fields.archived;
      if (!onlyPrice) logChange('позицію виправлено', 'item|' + code, `${code} «${name}», ${unit}${base || fix || !fields.price ? '' : ', ' + fmtMoney(fields.price) + ' грн'}${cls}`);
      state.newItem = null;
      if (fix) {
        const hit = repriceRows(editing, fix.was, fix.now);
        logChange('ціну виправлено', 'item|' + code, `${code} «${name}»: ${fmtMoney(fix.was)} → ${fmtMoney(fix.now)} грн, `
          + cnt(hit.length, 'документ', 'документи', 'документів') + (lock ? ' — у закритому періоді' : ''));
        mergeOwnItems();
        save(true, true);
        refresh();
      } else {
        mergeOwnItems();
        applyPrices();
        save();
      }
      toast(fix ? `Ціну коду ${code} виправлено: ${fmtMoney(fix.now)} грн.` : `Позицію ${code} «${name}» виправлено.`);
      go('item', { itemCode: code });
      return;
    }
    store.items.push(fields);
    logChange('позицію заведено', 'item|' + code, `${code} «${name}», ${unit}${fields.price ? ', ' + fmtMoney(fields.price) + ' грн' : ''}`
      + (like ? `, як ${like}` : ''));
    mergeOwnItems();
    applyPrices();
    if (like) followLines(code, String(like));
    save();
    const back = state.newItem ? state.newItem.forLine : null;
    state.newItem = null;
    state.flash = null;
    toast(`Позицію ${code} «${name}» додано.`);
    if (back != null && state.draft && state.draft.lines[back]) {
      // Позицію заводили з накладної — ставимо її в той рядок і повертаємось.
      const dr = state.draft;
      dr.lines[back].code = code;
      if (like) dr.lines[back].unit = '';               // одиниця із заводським номером лишається в зразка
      if (back === dr.lines.length - 1) dr.lines.push(emptyLine());
      go('moves');
      const q = $(`#doc-form [data-ln="qty"][data-i="${back}"]`);
      if (q) { q.focus(); q.select(); }
      return;
    }
    render();
  }

  // ------------------------------------------------ записи про знищення
  /** Рядок рапорту про знищення: у рапорту свій життєвий цикл — рапорт, потім
   *  акт. Останній рядок забирає з бази й сам рапорт. */
  function deleteDestroyed(id) {
    const i = store.destroyed.findIndex((r) => r.id === id);
    if (i < 0) return;
    const r = store.destroyed[i];
    const it = itemBy.get(r.code);
    if (!confirm(`Видалити запис про знищення?

${r.other ? r.name : it ? it.name : r.code} — ${fmtNum(r.qty)}, `
      + `${r.sub}, ${fmtDate(r.date)}${r.report ? ', рапорт ' + numNo(r.report) : ''}`)) return;
    // Знищене, не списане, входить у «фактично» звірки й інвентаризації.
    const lock = periodLock([r.date], [r.sub]);
    if (lock && !histOn() && !confirm(lock.replace('Документ від', 'Рапорт від')
      .replace('Провести все одно?', 'Видалити все одно?'))) return;
    store.destroyed.splice(i, 1);
    logChange('знищення видалено', `dz|${r.date}|${r.report || ''}`,
      `${r.other ? r.name : it ? cleanName(it.name) : r.code} — ${fmtNum(r.qty)}, ${r.sub}, ${fmtDate(r.date)}${r.report ? ', рапорт ' + numNo(r.report) : ''}`
      + (lock ? ' — у закритому періоді' : ''));
    save(true, true);
    refresh();
    state.flash = 'Запис про знищення видалено.';
    render();
  }

  /** Ключ рапорту для файлів: за документом бази, а поки рапорт ще не
   *  записано — за підрозділом, номером і датою події. */
  const reportKey = (r) => (r.docId ? `dz|${r.docId}` : `dz|${r.sub}|${r.report || ''}|${r.date}`);
  function reportFilesBtn(r) {
    const key = reportKey(r);
    const n = filesOf(key).length;
    return (n ? `<button type="button" class="ico-btn" data-vw="0" data-vw-key="${esc(key)}" title="Відкрити скан рапорту">📎 скан${n > 1 ? ' · ' + n : ''}</button>` : '')
      + (native ? rowBtn('file-add', '+ скан', `data-key="${esc(key)}"`, { title: 'Підшити скан рапорту' }) : '');
  }

  /** Рапорт у форму: усі його рядки — за документом бази, а поки рапорт ще не
   *  записано — за номером, підрозділом і датою події. Проведення замінює рядки. */
  function editReport(id) {
    const r = allDestroyed().find((x) => x.id === id);
    if (!r || !leaveEditing()) return;
    const mine = (x) => (r.docId ? x.docId === r.docId
      : !x.docId && x.sub === r.sub && x.date === r.date && normNo(x.report) === normNo(r.report));
    // Частина запису, уже списана актом, — та сама одиниця запису.
    const recs = [];
    for (const x of allDestroyed()) {
      if (!mine(x)) continue;
      const id0 = String(x.id).replace(/~w$/, '');
      const had = recs.find((y) => String(y.id).replace(/~w$/, '') === id0);
      if (had) had.qty = round3(+had.qty + (+x.qty || 0)); else recs.push(Object.assign({}, x, { qty: x.part ? x.whole : x.qty }));
    }
    const acts = [...new Set(recs.map((x) => x.act).filter(Boolean))];
    const act0 = acts.length === 1 ? acts[0] : '';
    // Підстава й обставини — спільні для всього рапорту; у записів старих версій
    // є лише примітка рядка, і вона лишається в рядку.
    const own = recs.every((x) => x.circ != null);
    const circ = own ? String(recs[0].circ || '') : '';
    const basis = circ.startsWith('підстава: ') ? circ.split('; ')[0].slice(10) : '';
    if (!freeDraftSlot('dz', 'ТЗ', 'Замінити незавершену чернетку рапорту?\n\nНаписане в ній буде втрачено.')) return;
    state.moveKind = 'dz';
    state.editing = null;
    state.editingReport = { docId: r.docId || 0, origin: r.origin || 'program', no: r.report || '', act0,
      ids: recs.map((x) => String(x.id).replace(/~w$/, '')), old: recs.map((x) => Object.assign({}, x)) };
    state.draft = { kind: 'dz', book: 'ТЗ',
      head: { type: 'Рапорт', no: r.report || '', date: r.date, from: r.sub, to: '', basis,
              note: basis ? circ.split('; ').slice(1).join('; ') : circ,
              report: '', reportDate: r.reportDate || '', act: act0 },
      lines: recs.map((x) => (x.other
        ? { other: true, oid: String(x.id), name: x.name || '', qty: String(x.qty), uom: x.uom || '',
            price: x.price != null ? String(x.price) : '', note: own ? x.lnote || '' : x.note || '',
            offNo: x.offNo || '', offDate: x.offDate || '' }
        : { code: x.code, qty: String(x.qty), price: x.price != null ? String(x.price) : '',
            note: own ? x.lnote || '' : x.note || '', lot: '', unit: x.unit ? String(x.unit) : '' })).concat([emptyLine()]) };
    go('moves', { q: '', formOpen: true, book: 'ТЗ' });
    $('#doc-form')?.scrollIntoView({ block: 'start' });
  }

  /** Замінити рядки рапорту новою редакцією. Рядок, що лишився тією самою
   *  позицією (й одиницею), — той самий рядок бази: до нього прив'язані номер
   *  акта й скани. Номер акта в шапці змінили — він для всіх рядків (порожній
   *  знімає акт); не чіпали — у кожного рядка лишається свій. */
  function replaceReport(rep, h, lines) {
    const old = store.destroyed.filter((x) => rep.ids.includes(String(x.id)));
    const at = store.destroyed.indexOf(old[0]);
    const circ = reportCirc(h);
    const actSet = normNo(h.act) !== normNo(rep.act0);
    const used = new Set();
    const fresh = lines.map((ln) => {
      // Рядок іншого майна — свій за id запису, інакше за назвою.
      const was = old.find((o) => !used.has(o) && (ln.other
        ? o.other && (ln.oid ? String(o.id) === String(ln.oid) : o.name === String(ln.name || '').trim())
        : !o.other && o.code === ln.code && String(o.unit || '') === String(ln.unit || '')));
      if (was) used.add(was);
      const act = ln.other ? '' : (actSet || !was ? h.act : was.act) || '';
      return Object.assign(dzRecord(h, ln, was ? was.id : uid(), rep.origin || 'program'),
        ln.other ? {} : { act },
        rep.docId ? { docId: rep.docId } : {},
        was && was.lineId ? { lineId: was.lineId } : {},
        was && was.otherId ? { otherId: was.otherId } : {},
        was && !ln.other && was.actId && normNo(act) === normNo(was.act) ? { actId: was.actId } : {});
    });
    store.destroyed = store.destroyed.filter((x) => !rep.ids.includes(String(x.id)));
    store.destroyed.splice(at < 0 ? store.destroyed.length : at, 0, ...fresh);
    logChange('рапорт виправлено', `dz|${h.date}|${h.no}`, `${numNo(rep.no)} → ${numNo(h.no)} від ${fmtDate(h.date)}, «${h.from}»: `
      + lines.map((ln) => `${ln.other ? ln.name : cleanName((itemBy.get(ln.code) || {}).name || ln.code)} — ${fmtNum(+ln.qty)}`).join('; '));
    dzCache = null;
  }

  /** «Списати актом…» — одна дія замість двох («включити до акта», потім «провести
   *  акт»): питає номер акта, записує його на запис (і на решту рядків рапорту, за
   *  згодою), а далі одразу відкриває чернетку акта списання — лишається перевірити
   *  й провести. Проміжний стан «акт не проведений» лишається технічним: він
   *  видно, коли чернетку закрили, не провівши. Консиліум 01.10.2026, п'ятеро з п'яти. */
  function actDestroyed(id) {
    const r = allDestroyed().find((x) => x.id === id);
    if (!r) return;
    // Номер — з журналу актів служби; підказка — наступний після останнього проведеного акта.
    const lastAct = docs.filter((x) => x.kind === 'wr' && /\d/.test(String(x.no))).sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0))[0];
    const no = prompt('Номер акта списання, яким списується це майно (з журналу актів служби).\n\n'
      + 'Далі відкриється чернетка акта — перевірити й провести.', r.act || (lastAct ? nextDocNo(lastAct.no) : ''));
    if (no == null) return;
    const act = no.trim();
    if (!act) { alert('Номер акта не вказано. Запис не змінено.'); return; }
    let target = r.id;
    // Частину запису акт уже списав, а решта йде до іншого акта: запис ділиться —
    // списане лишається за першим актом, решта стає окремим записом.
    if (r.part && normNo(act) !== normNo(r.act)) {
      const own = store.destroyed.find((y) => y.id === r.id);
      if (!own) return;
      // Решта — окремим рядком того самого рапорту, зі своїм актом.
      const copy = Object.assign({}, own, { id: uid(), qty: r.qty, act });
      delete copy.lineId;
      delete copy.actId;
      store.destroyed.push(copy);
      own.qty = round3((+own.qty || 0) - r.qty);
      target = copy.id;
    } else {
      // Акт із цим номером уже проведено, але для іншого підрозділу чи раніше за
      // подію: цього запису він не закриє, запис чекатиме свого акта.
      const fits = docs.some((x) => x.kind === 'wr' && normNo(x.no) === normNo(act) && x.from === r.sub && x.d >= r.date);
      const other = fits ? null : docs.find((x) => x.kind === 'wr' && normNo(x.no) === normNo(act));
      if (other && !confirm(`Акт ${numNo(act)} уже проведено: «${other.from}», ${fmtDate(other.d)}. Цього запису `
        + `(«${r.sub}», подія ${fmtDate(r.date)}) він не закриє: буде складено новий акт ${numNo(act)} від «${r.sub}».\n\nПродовжити?`)) return;
      // Рапорт іде до акта цілком, як у папері: решту його рядків, ще не включених
      // до акта, включаємо разом — інакше кожен рядок вимагав окремого вікна.
      const rest = allDestroyed().filter((x) => x.id !== r.id && x.status !== 'списано' && !x.act
        && x.sub === r.sub && x.date === r.date && normNo(x.report) === normNo(r.report));
      const all = rest.length && confirm(`Списати тим самим актом ${numNo(act)} і решту рапорту ${numNo(r.report)}: `
        + `${cnt(rest.length, 'рядок', 'рядки', 'рядків')}?`);
      for (const x of [r].concat(all ? rest : [])) {
        const own = store.destroyed.find((y) => y.id === x.id);
        if (!own) continue;
        if (normNo(own.act) !== normNo(act)) { delete own.actId; delete own.actSub; }
        own.act = act;
      }
    }
    dzCache = null;
    save();
    recalc();
    // Проведений акт із цим номером уже закрив запис — чернетка не потрібна.
    const base = String(target).replace(/~w$/, '');
    const left = allDestroyed().filter((x) => String(x.id).replace(/~w$/, '') === base && x.status !== 'списано');
    if (!left.length) {
      const done = allDestroyed().find((x) => String(x.id).replace(/~w$/, '') === base);
      state.flash = `Запис закрито актом ${numNo(act)}${done && done.actDate ? ` від ${fmtDate(done.actDate)}` : ''}: майно вже списане.`;
      render();
      return;
    }
    writeoffFromAct(left[0].id);
  }

  /** Виправили номер акта списання — записи про знищення, закриті ним, ідуть за
   *  ним. Зв'язок тримається на номері, і без цього знищене поверталося в «не
   *  списане»: акт уже зменшив залишок, а знищене віднімалося від нього вдруге.
   *  Лише записи цього акта: тезка з тим самим номером (торішній акт того
   *  самого підрозділу) своїх записів не віддає. */
  function relinkActs(list, newNo) {
    for (const x of list) {
      if (normNo(x.act) === normNo(newNo)) continue;
      const own = store.destroyed.find((y) => y.id === String(x.id).replace(/~w$/, ''));
      if (own) own.act = newNo;
    }
    dzCache = null;
  }

  /** Де майно запису числиться зараз: сам підрозділ запису, а коли той закритий або
   *  позиції там уже немає (передали накладною разом зі знищеним — так термоси
   *  2 б БпС опинилися не там, де їх знищили, 01.10.2026) — чинний підрозділ із цією
   *  позицією: спершу з того самого батальйону, далі з найбільшим залишком.
   *  Повертає { sub, why }, де why — чому не підрозділ запису (порожньо — свій). */
  function holderOf(code, sub, qty, unit = '') {
    const date = today();
    const sb = subBy.get(sub);
    // Одиниця із заводським номером числиться там, куди її востаннє передали.
    if (unit) {
      const at = unitHolderAt(unit, date, null);
      return at && at !== sub ? { sub: at, why: `одиниця на ${fmtDate(date)} числиться за «${at}»` } : { sub, why: '' };
    }
    const have = (s) => availableAt(code, s, date);
    if (sb && sb.active && have(sub) >= qty - 1e-9) return { sub, why: '' };
    const parent = sb ? sb.parent : '';
    const cands = subs.filter((s) => s.active && s.type !== 'бригада' && s.name !== sub && have(s.name) >= qty - 1e-9)
      .sort((a, b) => ((b.parent === parent) - (a.parent === parent)) || (have(b.name) - have(a.name)));
    const why = sb && !sb.active ? 'підрозділ закрито' : `на ${fmtDate(date)} цієї позиції там уже не числиться`;
    // Ніде не числиться стільки — акт лишається від підрозділу запису, але людина має це бачити.
    if (!cands.length) return { sub, why: `${why}, а в інших підрозділах такої кількості теж немає` };
    return { sub: cands[0].name, why };
  }

  /** Акт списання із записів про знищення: номер акта, підрозділ і позиції з
   *  кількостями переносяться в чернетку — лишається перевірити дату й провести.
   *  Чернетка пам'ятає, звідки вона (src): форма показує рядок-джерело, а після
   *  проведення записи йдуть за актом. Щойно акт проведено, записи самі стають
   *  «списано». */
  function writeoffFromAct(id) {
    const r = allDestroyed().find((x) => x.id === id);
    if (!r || !r.act) return;
    const same = allDestroyed().filter((x) => x.status !== 'списано'
      && normNo(x.act) === normNo(r.act) && x.sub === r.sub);
    // Рядок акта — позиція, а знищена кухня з номером — своїм рядком: акт
    // списує саме її, зі своєю партією.
    const byCode = new Map();
    for (const x of same) {
      const key = x.code + '|' + (x.unit || '');
      const had = byCode.get(key) || { code: x.code, unit: String(x.unit || ''), qty: 0 };
      had.qty = round3(had.qty + (+x.qty || 0));
      byCode.set(key, had);
    }
    const reports = [...new Set(same.map((x) => x.report).filter(Boolean))];
    const total = round3([...byCode.values()].reduce((a, x) => a + x.qty, 0));
    // Від кого акт: від підрозділу запису, а якщо майна там уже немає — від того, де воно є.
    const mine = byCode.get(r.code + '|' + (r.unit || '')) || { qty: +r.qty || 0 };
    const holder = holderOf(r.code, r.sub, mine.qty, r.unit ? String(r.unit) : '');
    if (!leaveEditing()) return;
    if (!freeDraftSlot('wr', 'ТЗ', `Замінити незавершену чернетку «${KIND_NAME.wr}»?\n\nНаписане в ній буде втрачено.`)) return;
    state.moveKind = 'wr';
    state.editing = null;
    state.draft = {
      kind: 'wr',
      book: 'ТЗ',
      head: {
        no: r.act, date: today(), from: holder.sub, to: '',
        basis: reports.length ? (reports.length > 1 ? 'рапорти №' : 'рапорт №') + reports.join(', №') : '',
        report: '', reportDate: '', act: '', note: '',
      },
      lines: [...byCode.values()].map(({ code, unit, qty }) => {
        const ln = { code, qty: String(qty), price: '', note: '', lot: '', unit: '' };
        const came = unit ? unitArrival(unit, today(), null) : null;
        if (came) Object.assign(ln, { unit, qty: '1', lot: came.lot || came.d, price: String(+came.price || 0) });
        return ln;
      }).concat([emptyLine()]),
      src: { kind: 'dz', ids: [...new Set(same.map((x) => String(x.id).replace(/~w$/, '')))],
        report: r.report || '', reportDate: r.reportDate || '', date: r.date, sub: r.sub, qty: total, n: same.length,
        moved: holder.why ? { was: r.sub, to: holder.sub, why: holder.why, stayed: holder.sub === r.sub } : null },
    };
    go('moves', { q: '', formOpen: true, book: 'ТЗ' });
    $('#doc-form')?.scrollIntoView({ block: 'start' });
  }

  /** Акт проведено з чернетки «Списати актом…»: записи «Знищене майно» ідуть за ним
   *  так, як його провели, — з номером із форми й від підрозділу, від якого він
   *  складений (той буває не підрозділом запису: майно вже передали). */
  function linkDraftRecords(src, h) {
    const ids = new Set((src.ids || []).map(String));
    for (const own of store.destroyed || []) {
      if (!ids.has(String(own.id)) || own.other) continue;
      if (normNo(own.act) !== normNo(h.no)) delete own.actId;
      own.act = h.no;
      if (h.from && h.from !== own.sub) own.actSub = h.from; else delete own.actSub;
    }
    dzCache = null;
  }

  /** Після такого акта: чи все списано — і кнопка назад до записів. */
  function dzFlash(src, said) {
    const ids = new Set((src.ids || []).map(String));
    const left = allDestroyed().filter((x) => ids.has(String(x.id).replace(/~w$/, '')) && x.status !== 'списано');
    const text = left.length
      ? `${said} Знищене за рапортом ${numNo(src.report || '—')} списано не все: ${fmtNum(left.reduce((a, x) => a + (+x.qty || 0), 0))} од. ще чекає акта.`
      : `${said} Знищене за рапортом ${numNo(src.report || '—')} списано: ${cnt(src.n, 'запис', 'записи', 'записів')}.`;
    return { text, btn: { label: 'До знищеного майна', act: 'dz-open', v: src.report || '' } };
  }

  /** Перевіряє чернетку й повертає перелік зауважень. Порожній — можна проводити.
   *
   *  Перевіряється те, що справді псує облік: документ без номера й дати, видача
   *  того, чого в підрозділі немає, маршрут «сам собі», повтор номера, два рядки
   *  на одне й те саме найменування. Решту хай вирішує людина.
   */
  function checkDraft(d, h, k) {
    const bad = [];
    const warn = [];
    d.warn = warn;
    // Батальйон майна не тримає — воно за його підрозділами (їдальня, ВМТЗ).
    for (const side of [h.from, h.to]) {
      if (side && subBy.get(side) && subs.some((x) => x.parent === side && / · їдальня$/i.test(x.name))) {
        warn.push(`Майно батальйону «${side}» числиться за його підрозділами (їдальня, ВМТЗ). `
          + 'Оберіть підрозділ або пізніше перенесіть майно з картки батальйону.');
      }
    }
    const no = h.no.trim();
    // Номер і сторони — частина ключа документа: із «|» у номері програма
    // більше не знаходила б його ні для виправлення, ні для видалення.
    if (no.includes('|')) bad.push('У номері документа не ставте «|» — за ним програма знаходить документ.');
    if (!no) bad.push(k === 'dz' ? 'Вкажіть номер рапорту.' : 'Вкажіть номер документа.');
    // Той самий вид, дата й номер — це той самий документ: такий блокуємо. Той
    // самий номер в іншому виді чи іншої дати буває законно (номер накладної
    // постачальника збігся з нашим актом) — про нього лише попереджаємо.
    else if (k !== 'dz') {
      const same = docs.filter((r) => normNo(r.no) === normNo(no) && keyOfRow(r) !== state.editing);
      const sameRoute = (r) => r.from === h.from && (k === 'wr' ? (r.to || '') === (h.to || '') : r.to === h.to);
      if (same.some((r) => r.kind === k && r.d === h.date && sameRoute(r))) {
        bad.push(`Документ «${kindName({ kind: k, to: k === 'wr' ? h.to : '' })}» ${numNo(no)} від ${fmtDate(h.date)} на цей маршрут уже є в обліку. Виправте номер або дату.`);
      } else if (same.some((r) => r.kind === k && r.d === h.date)) {
        const r0 = same.find((r) => r.kind === k && r.d === h.date);
        warn.push(`${numNo(no)} від ${fmtDate(h.date)} уже є на інший маршрут (${r0.from}${r0.to ? ' → ' + r0.to : ''}). Документи лишаться окремими.`);
      } else if (same.length) {
        const r0 = same[0];
        warn.push(`${numNo(no)} уже є в обліку: ${kindName(r0).toLowerCase()} від ${fmtDate(r0.d)}.`);
      }
    } else {
      const twice = allDestroyed().filter((x) => normNo(x.report) === normNo(no) && x.sub === h.from
        && !inEditedReport(x) && d.lines.some((l) => l.code && l.code === x.code));
      if (twice.length) warn.push(`Рапорт ${numNo(no)} по «${h.from}» на ці позиції вже внесено. Перевірте, чи це не повтор.`);
    }
    if (!h.date) bad.push('Вкажіть дату документа.');
    else if (h.date > today()) bad.push('Дата документа в майбутньому.');
    else if (firstDay() && h.date < firstDay()) {
      bad.push(`Дата раніша за початок обліку (${fmtDate(firstDay())}). Початок обліку — у реквізитах частини.`);
    }
    if (k === 'in' && !h.from.trim()) bad.push('Вкажіть, від кого надійшло майно.');
    if (k === 'in' && h.from.includes('|')) bad.push('У назві постачальника не ставте «|».');
    if (k === 'wr' && (h.to || '').includes('|')) bad.push('У назві одержувача не ставте «|».');
    if (k === 'wr' && h.to && subBy.get(h.to)) {
      bad.push(`«${h.to}» — підрозділ частини: майно між підрозділами передають накладною (переміщенням).`);
    }
    if (k !== 'in' && !h.from) bad.push('Вкажіть підрозділ-відправника.');
    if (k === 'mv') {
      if (!h.to) bad.push('Вкажіть одержувача.');
      else if (h.from === h.to) bad.push('Відправник і одержувач збігаються.');
    }

    const filled = d.lines.filter((x) => (x.other ? String(x.name || '').trim() : x.code) && +x.qty > 0);
    if (!filled.length) bad.push('Додайте хоча б одне найменування з кількістю.');
    const nameOf = (code) => { const it = itemBy.get(code); return it ? it.name : code; };
    const at = (ln) => {
      const u = ln.unit ? unitBy.get(String(ln.unit)) : null;
      return u ? `, ${unitLabel(u)},` : (byLot(k) && ln.lot ? ` за ${fmtMoney(+ln.price || 0)} грн` : '');
    };
    const seen = new Set(), seenUnits = new Set(), perCode = new Map(), perLot = new Map();
    for (const ln of filled) {
      if (ln.other) continue;
      // Повтор — це та сама позиція за тією самою ціною, тією самою одиницею й
      // приміткою; за іншою ціною чи з іншою одиницею це окремий рядок паперу.
      const key = JSON.stringify([ln.code, linePrice(ln, k).toFixed(2), String(ln.unit || ''),
                                  String(ln.note || '').trim()]);
      // У рапорті та сама позиція буває двома рядками паперу (різні обставини):
      // лише попереджаємо, а в документах руху це повтор, який треба об'єднати.
      if (seen.has(key)) {
        if (k === 'dz') warn.push(`«${nameOf(ln.code)}»${at(ln)} указано двічі.`);
        else bad.push(`«${nameOf(ln.code)}»${at(ln)} указано двічі. Об’єднайте в один рядок.`);
      }
      seen.add(key);
      perCode.set(ln.code, (perCode.get(ln.code) || []).concat([ln]));
      // Прихід одиниці з реєстру: одна штука, один рядок і не та, що вже десь числиться.
      if (ln.unit && k === 'in') {
        const u = unitBy.get(String(ln.unit));
        if (seenUnits.has(String(ln.unit))) bad.push(`«${nameOf(ln.code)}», ${unitLabel(u)}: одна одиниця — один рядок.`);
        seenUnits.add(String(ln.unit));
        if (round3(+ln.qty) !== 1) {
          bad.push(`«${nameOf(ln.code)}», ${unitLabel(u)}: одиниця із заводським номером — одна, а в рядку ${fmtNum(ln.qty)}.`);
        }
        const held = unitHolderAt(ln.unit, h.date);
        if (held) {
          bad.push(`«${nameOf(ln.code)}», ${unitLabel(u)}: на ${fmtDate(h.date)} уже числиться в «${held}». `
            + 'Одну одиницю двічі не оприбутковують.');
        }
        continue;
      }
      if (ln.unit && byUnit(k)) {
        const u = unitBy.get(String(ln.unit));
        if (seenUnits.has(String(ln.unit))) {
          bad.push(`«${nameOf(ln.code)}», ${unitLabel(u)}: одна одиниця — один рядок.`);
        }
        seenUnits.add(String(ln.unit));
        if (round3(+ln.qty) !== 1) {
          bad.push(`«${nameOf(ln.code)}», ${unitLabel(u)}: одиниця із заводським номером — одна, `
            + `а в рядку ${fmtNum(ln.qty)}.`);
        }
        const where = unitHolderAt(ln.unit, h.date);
        if (where !== h.from) {
          bad.push(`«${nameOf(ln.code)}», ${unitLabel(u)}: на ${fmtDate(h.date)} `
            + (where ? `числиться в «${where}»` : 'ніде не числиться') + `, а не в «${h.from}».`);
        } else if (k === 'dz' && destroyedUnitsAt(h.from, h.date).has(String(ln.unit))) {
          bad.push(`«${nameOf(ln.code)}», ${unitLabel(u)}: уже внесена в рапорт про знищення.`);
        }
        continue;
      }
      if (!byLot(k)) continue;
      if (ln.lot) {
        const lk = ln.code + '|' + (+ln.price || 0).toFixed(2);
        perLot.set(lk, (perLot.get(lk) || []).concat([ln]));
      }
    }
    // Рядки однієї партії разом — не більше, ніж у ній лишилося. Коли перевищено
    // й позицію загалом, лишається лише повідомлення про позицію: воно каже, де
    // майно числиться, а два повідомлення про одне й те саме лише плутали.
    const lotBad = new Map();
    for (const mine of perLot.values()) {
      const have = lineHave(mine[0], h.from, h.date);
      const qty = round3(mine.reduce((a, x) => a + (+x.qty || 0), 0));
      if (qty > have + 1e-9) {
        lotBad.set(mine[0].code, (lotBad.get(mine[0].code) || []).concat([
          `«${nameOf(mine[0].code)}»${at(mine[0])}: у «${h.from}» на ${fmtDate(h.date)} такої партії `
          + `${fmtNum(have, '0')}, а в документі ${fmtNum(qty)}.`]));
      }
    }
    // Усі рядки позиції разом (з різних партій теж) — не більше, ніж числиться;
    // одиниці із заводськими номерами рахуються своїми рядками окремо.
    for (const [code, mine] of perCode) {
      if (k === 'in') continue;
      const qty = round3(mine.filter((x) => !x.unit).reduce((a, x) => a + (+x.qty || 0), 0));
      if (!qty) continue;
      const units = byUnit(k) ? unitsAt(code, h.from, h.date).length : 0;
      const have = lineHave({ code, lot: '', unit: '' }, h.from, h.date);
      // Виправлення рапорту не блокується тим, що вже було в ньому: рапорт із
      // паперу буває більшим за облік (річ числилась в іншому підрозділі).
      const was = k === 'dz' && state.editingReport ? state.editingReport.old
        .filter((o) => o.code === code && !o.unit).reduce((a, o) => a + (+o.qty || 0), 0) : 0;
      if (qty > Math.max(have, round3(was)) + 1e-9) {
        const where = holdersAt(code, h.date, h.from).slice(0, 3);
        lotBad.delete(code);
        bad.push(`«${nameOf(code)}»: у «${h.from}» на ${fmtDate(h.date)} числиться ${fmtNum(have, '0')}`
          + (units ? ` без номерних (${fmtNum(units, '0')} із заводськими номерами — окремими рядками)` : '')
          + `, а в документі ${fmtNum(qty)}.`
          + (where.length ? ` На цю дату числиться: ${where.map(([sub, q]) => `${sub} — ${fmtNum(q)}`).join(', ')}`
            + '. Спершу проведіть переміщення звідти.' : ''));
      }
    }
    for (const msgs of lotBad.values()) bad.push(...msgs);
    // Інша ціна — інший код: прихід несе ціну, з якою код уже в обліку, а код, якого
    // ще не приходували, — одну ціну на весь документ.
    if (k === 'in') {
      for (const [code, mine] of perCode) {
        const asked = [...new Set(mine.map((ln) => linePrice(ln, k)).filter((p) => p > 0).map((p) => p.toFixed(2)))].map(Number);
        const added = newPrices(code, asked, state.editing);
        if (!added.length) continue;
        const have = codePrices(code);
        const text = (list) => list.map((p) => fmtMoney(p)).join('; ');
        if (have.length) {
          bad.push(`Код ${code} оприбутковано за ${text(have)} грн, а в документі ${text(added)} грн. `
            + 'Для іншої ціни заведіть новий код, помилкову виправте в картці позиції.');
        } else {
          bad.push(`Код ${code} у документі за різними цінами: ${text(asked)} грн. Для іншої ціни заведіть новий код.`);
        }
      }
    }
    d.lines.forEach((ln, n) => {
      if (!ln.other && !ln.code && String(ln.qty ?? '').trim() !== '' && +ln.qty > 0) {
        bad.push(`Рядок ${n + 1}: не обрано найменування.`);
      }
    });
    // Інше майно: назва й кількість, ціна — число або порожньо, списання не
    // раніше за подію. Порожній рядок нікому не заважає.
    d.lines.forEach((ln, n) => {
      if (!ln.other) return;
      const name = String(ln.name || '').trim();
      if (!name && String(ln.qty ?? '').trim() === '' && String(ln.price ?? '').trim() === '') return;
      const who = name ? `«${name}»` : `Рядок ${n + 1}`;
      if (!name) bad.push(`Рядок ${n + 1}: вкажіть, що за інше майно.`);
      if (!(+ln.qty > 0)) bad.push(`${who}: не вказано кількість.`);
      if (String(ln.price ?? '').trim() !== '' && !(+ln.price >= 0)) bad.push(`${who}: ціна має бути невід'ємним числом.`);
      if (ln.offDate && h.date && ln.offDate < h.date) {
        bad.push(`${who}: списано ${fmtDate(ln.offDate)} — раніше за подію ${fmtDate(h.date)}.`);
      }
    });
    for (const ln of d.lines) {
      if (k === 'in' && ln.code) {
        if (String(ln.price ?? '').trim() !== '' && !(+ln.price >= 0)) {
          bad.push(`«${nameOf(ln.code)}»: ціна має бути невід'ємним числом.`);
        } else if (!(linePrice(ln, k) > 0)) {
          // Порожня ціна означає облікову ціну довідника; немає й там — питаємо.
          bad.push(`«${nameOf(ln.code)}»: вкажіть ціну — у довіднику її немає.`);
        }
      }
      if (ln.code && !(+ln.qty > 0)) {
        bad.push(`«${nameOf(ln.code)}»: не вказано кількість.`);
      }
      if (k === 'dz' && ln.code && String(ln.price ?? '').trim() !== '' && !(+ln.price >= 0)) {
        bad.push(`«${nameOf(ln.code)}»: ціна за документом має бути невід'ємним числом.`);
      }
    }
    return bad;
  }

  function showFormMsg(text, ok) {
    const m = $('#form-msg');
    if (!m) return;
    m.innerHTML = text;
    m.style.color = ok ? 'var(--ok)' : 'var(--bad)';
  }

  /** Запис у журнал змін: що проведено, а для виправлення — що саме змінилося. */
  function logDoc(k, h, lines, oldRows, editedKey, lock) {
    const nameOf = (code) => { const it = itemBy.get(code); return it ? cleanName(it.name) : code; };
    const key = k === 'dz' ? `dz|${h.date}|${h.no}` : docKey(k, h.date, h.no, h.from, h.to);
    const tail = lock ? ' — у закритому періоді' : '';
    if (!editedKey) {
      logChange(k === 'dz' ? 'рапорт внесено' : 'проведено', key, `${kindName({ kind: k, to: k === 'wr' ? h.to : '' }) || 'Рапорт про знищення'} ${numNo(h.no)}`
        + ` від ${fmtDate(h.date)}: ${lines.map((ln) => `${ln.other ? ln.name : nameOf(ln.code)} — ${fmtNum(+ln.qty)}`).join('; ')}${tail}`);
      return;
    }
    const ch = editChanges(k, h, lines, oldRows);
    const text = `${numNo(h.no)} від ${fmtDate(h.date)}: ${ch.join('; ') || 'змінено примітки чи підставу'}${tail}`;
    logChange('виправлено', key, text);
    if (editedKey !== key) logChange('виправлено', editedKey, `тепер ${text}`);
  }

  /** Виправлений документ: «придатний до» й «1прод» ідуть за своїми рядками, навіть коли змінилась примітка
   *  (ключ поля — код і примітка рядка). Спершу рядки з тим самим ключем, що й були: незмінений рядок лишає своє поле, хоч би що
   *  сталося з іншим рядком цього коду. Решта шукає за кодом, той самий код удруге — за порядком. */
  function rekeyLineExtra(id, oldRows, lines, h) {
    const was = (store.lineExtra || {})[id];
    if (!was) return;
    const olds = oldRows.map((r) => `${r[5]}|${r[7] || ''}`);
    const keys = lines.map((ln) => `${ln.code}|${composeNote(h, ln)}`);
    const out = {};
    const used = new Set();
    const rest = [];
    keys.forEach((key, i) => {
      if (was[key] && !used.has(key)) { out[key] = was[key]; used.add(key); } else rest.push(i);
    });
    for (const i of rest) {
      if (keys[i] in out) continue;                      // два рядки з однаковим ключем — це одне поле
      const from = olds.find((k) => !used.has(k) && was[k] && k.split('|')[0] === String(lines[i].code));
      if (!from) continue;
      out[keys[i]] = was[from];
      used.add(from);
    }
    if (Object.keys(out).length) store.lineExtra[id] = out;
    else delete store.lineExtra[id];
  }

  function submitDoc(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const g = (key) => (f.get(key) || '').toString().trim();
    const k = state.moveKind;
    const d = draft();
    // Шапка читається з форми, а не зі стану: користувач міг правити поля, не
    // залишаючи жодного з них, і подія `change` для останнього ще не пройшла.
    const h = Object.assign(d.head, {
      type: g('type'), no: g('no'), date: g('date'), from: g('from'), to: g('to'),
      basis: g('basis'), note: g('note'), report: g('report'),
      reportDate: g('reportDate'), act: g('act'),
    });

    const bad = checkDraft(d, h, k);
    if (bad.length) {
      state.postNext = false;
      showFormMsg(bad.map((x) => esc(x)).join('<br>'), false);
      $('#doc-form')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    // Номери в старих паперах повторюються законно (один номер рапорту на
    // кілька маршрутів), тому в режимі історії не перепитуємо — але й не мовчимо:
    // попередження їде в повідомлення про проведений документ.
    const warned = (d.warn || []).slice();
    if (warned.length && !histOn() && !confirm(warned.join('\n') + (k === 'dz' ? '\n\nВнести все одно?' : '\n\nПровести все одно?'))) return;

    // Закритий період: документ заднім числом після підписаної звірки чи
    // завершеної інвентаризації — лише з явної згоди. Для виправлення важить і
    // стара дата, і стара пара підрозділів.
    const lockDates = [h.date], lockSubs = [h.from, h.to];
    const oldRows = [];
    if (state.editing) {
      const o = storeRowsOf(state.editing);
      lockDates.push(o.d);
      for (const i of o.idx) { oldRows.push(o.arr[i]); lockSubs.push(o.arr[i][3], o.kind === 'wr' ? '' : o.arr[i][4]); }  // одержувач вибуття — не підрозділ
    }
    // Рапорт про знищення теж: знищене, не списане, міняє «фактично» у звірці й
    // інвентаризації на цю дату.
    const lock = periodLock(lockDates, lockSubs);
    if (lock && !histOn() && !confirm(k === 'dz' ? lock.replace('Документ від', 'Рапорт від')
      .replace('Провести все одно?', 'Внести все одно?') : lock)) return;

    const lines = d.lines.filter((x) => (x.other ? String(x.name || '').trim() : x.code) && +x.qty > 0);
    if (state.editing && state.editing.split('|')[0] !== k) {
      showFormMsg(esc('Вид документа не збігається з тим, що виправляється. Скасуйте виправлення й почніть знову.'), false);
      return;
    }
    // Знімок стрічки до змін: після проведення порівнюємо, чи не з'явився мінус.
    const saved = { incoming: store.docs.incoming.slice(), movement: store.docs.movement.slice(),
                    writeoffs: store.docs.writeoffs.slice() };
    let backup = null;
    let touched = lines.filter((x) => !x.other).map((x) => x.code);
    // Одиниці із заводськими номерами, яких торкається документ: і ті, що в новій
    // редакції, і ті, що були в старій, — ланцюжок кожної має лишитися цілим.
    const unitIds = new Set(lines.filter((x) => x.unit).map((x) => String(x.unit)));
    if (state.editing) {
      const old = storeRowsOf(state.editing);
      backup = { kind: old.kind, rows: old.arr.slice() };
      touched = touched.concat(old.idx.map((i) => old.arr[i][5]));
      for (const i of old.idx) {
        const u = rowUnit(old.kind, old.arr[i]);
        if (u) unitIds.add(String(u));
      }
    }
    const before = k === 'dz' ? null : negProfile(new Set(touched));
    // Знищене не переміщують: і переміщення з підрозділу, і рапорт заднім числом
    // не мають лишати знищеного більше, ніж там числиться.
    const dzBefore = k === 'mv' || k === 'dz' ? dzProfile(new Set(touched)) : null;
    const savedDz = store.destroyed.slice();
    // Записи про знищення, закриті актом, що виправляється: після зміни номера
    // вони йдуть саме за ним, а не за тезкою з тим самим старим номером.
    const actLinked = k === 'wr' && state.editing ? allDestroyed().filter((x) => !x.actId && x.act
      && actDocsOf(x).some((w) => keyOfRow(w) === state.editing)) : [];
    // Виправлений документ лишається тим самим записом бази: id і походження з
    // його рядків переходять на нові рядки, тож скани, зв'язок із рапортом і
    // партії, з яких видавали пізніше, не рвуться.
    let tail = [];
    if (state.editing) {
      const old = storeRowsOf(state.editing);
      const first = old.arr[old.idx[0]];
      if (first && rowId(old.kind, first)) tail = ['', rowId(old.kind, first), rowOrigin(old.kind, first)];
      store.docs[STORE_OF[old.kind]] = old.arr.filter((_, i) => !old.idx.includes(i));
    }
    const rep = k === 'dz' ? state.editingReport : null;
    if (rep) replaceReport(rep, h, lines);
    else if (k === 'dz') {
      for (const ln of lines) store.destroyed.push(dzRecord(h, ln, uid(), 'program'));
    } else {
      // Ціна з накладної постачальника, названа партія та одиниця із заводським
      // номером ідуть у рядок: без них облік узяв би найдавнішу партію й не знав
      // би, яка саме кухня поїхала.
      for (const row of rowsFromDraft(k, h, lines, tail)) store.docs[STORE_OF[k]].push(row);
    }

    if (before) {
      // Ні нова редакція, ні новий документ заднім числом не мають залишати
      // мінусів ніде далі по стрічці — і не мають рвати ланцюжок одиниці.
      const neg = newNegative(new Set(touched), before);
      const broke = neg ? null : unitBreak(unitIds);
      if (neg || broke) {
        Object.assign(store.docs, saved);
        ledger = buildLedger();
        showFormMsg(esc((backup ? 'Виправлення не проведено: ' : 'Документ не проведено: ')
          + (neg ? negMessage(neg, backup ? 'edit' : 'new') : unitMessage(broke))), false);
        $('#doc-form')?.scrollIntoView({ block: 'nearest' });
        return;
      }
    }
    if (dzBefore) {
      dzCache = null;
      const over = newDzOver(new Set(touched), dzBefore);
      if (over && histOn()) warned.push(dzOverMessage(over));
      else if (over && !confirm(dzOverMessage(over) + (k === 'dz' ? '\n\nВнести все одно?' : '\n\nПровести все одно?'))) {
        Object.assign(store.docs, saved);
        store.destroyed = savedDz;
        ledger = buildLedger();
        dzCache = null;
        return;
      }
    }
    // Акт із чернетки «Списати актом…»: записи «Знищене майно» — за ним, як його провели.
    const src = k === 'wr' && !state.editing && d.src && d.src.kind === 'dz' ? d.src : null;
    if (src) linkDraftRecords(src, h);
    // Акт приймання з «Прийняти поставку»: прихід пов'язується з ВН, а через неї — із закупівлею. Id документа прийде з відповіді сервера,
    // тож зв'язок — за ключем документа (сервер знайде id сам).
    const pur = k === 'in' && !state.editing && d.src && d.src.kind === 'pur' ? pdById(d.src.doc) : null;
    if (pur) {
      pur.receipts = (pur.receipts || []).concat([{ doc: 0, key: docKey('in', h.date, h.no, h.from, h.to || 'склад') }]);
      logChange('поставку прийнято', `purdoc|${pur.id}`, `${h.no} від ${fmtDate(h.date)}`);
    }
    const wasEditing = !!state.editing;
    const editedKey = state.editing;
    state.editing = null;
    // Ціну коду виправили в його приході: накладні й акти, що назвали партію за
    // старою ціною, несуть нову — партія та сама.
    if (k === 'in' && wasEditing) {
      for (const [code, was, now] of priceFixes(oldRows, lines, editedKey)) repriceRows(code, was, now, ['movement', 'writeoffs']);
      // Позицію з надходження прибрали: її бюджетні реквізити не лишаються чекати іншої під тим самим кодом.
      if (tail[1]) mtzForget(tail[1], new Set(lines.map((x) => String(x.code))));
    }
    logDoc(k, h, lines, oldRows, editedKey, lock);
    if (editedKey && k !== 'dz') rekeyScans(editedKey, docKey(k, h.date, h.no, h.from, h.to || ''));
    if (editedKey && tail[1]) rekeyLineExtra(tail[1], oldRows, lines, h);
    if (editedKey && k === 'in') rekeyPurLinks(editedKey, docKey('in', h.date, h.no, h.from, h.to || 'склад'));
    if (actLinked.length) relinkActs(actLinked, h.no);
    const kinds = cnt(lines.length, 'найменування', 'найменування', 'найменувань');
    const units = fmtNum(lines.reduce((a, x) => a + (x.other ? 0 : +x.qty || 0), 0));
    state.draft = null;
    save();
    refresh();
    // Пропозиція закрити знищене цим актом — уже з проведеним актом в обліку:
    // лише так видно, скільки він іще може закрити.
    if (k === 'wr') offerDestroyedLink(h);
    state.formOpen = false;                // документ проведено — бланк прибираємо
    if (k === 'dz') {
      state.flash = `Рапорт ${numNo(h.no)} від ${fmtDate(h.date)} ${rep ? 'виправлено' : 'внесено'}: ${kinds}, ${units} од.`
        + (warned.length ? ' ' + warned.join(' ') : '');
      state.editingReport = null;
      go('destroyed');
      return;
    }
    if (state.postNext && !wasEditing) {
      // Пачка документів: наступний — того самого виду, з тією самою датою й
      // маршрутом, номер — наступний після щойно проведеного.
      state.postNext = false;
      state.formOpen = true;                // пачка документів: бланк лишається
      const posted = docKey(k, h.date, h.no, h.from, h.to);
      state.draft = {
        kind: k,
        book: state.book,
        head: { type: h.type || '', no: nextDocNo(h.no), date: h.date, from: h.from, to: h.to,
                basis: h.basis, report: '', reportDate: '', act: '', note: '', auto: true },
        lines: [emptyLine()],
      };
      toast(`Документ ${numNo(h.no)} проведено: ${kinds}, ${units} од.`
        + (warned.length ? ' ' + warned.join(' ') : ''));
      go('moves');
      $('#doc-form')?.scrollIntoView({ block: 'start' });
      $('#doc-form [data-pick="0"]')?.focus();
      pickClose();                          // курсор — у першому рядку, а перелік позицій відкриє друк: сам він лягав на кнопки форми
      state.lastPosted = posted;
      return;
    }
    state.postNext = false;
    const said = `Документ ${numNo(h.no)} від ${fmtDate(h.date)} ${wasEditing ? 'виправлено' : 'проведено'}: ${kinds}, ${units} од.`
      + (warned.length ? ' ' + warned.join(' ') : '');
    state.flash = src ? dzFlash(src, said) : said;
    state.docBack = 'moves';
    state.docKey = docKey(k, h.date, h.no, h.from, h.to);
    go('doc');
    // Поставка з ВН: картка «Закупівля» з'являється, щойно база дала id приходу (до того в картки приходу його нема); слово про проведення
    // повертається разом із нею: перший показ його вже зняв.
    if (pur) {
      const shown = state.docKey;
      flush().then(() => { if (state.view === 'doc' && state.docKey === shown) { state.flash = said; render(); } });
    }
  }

  /** Наступний номер: остання група цифр +1 зі збереженням нулів попереду —
   *  «ТЗ №17» → «ТЗ №18», «АКТ-2026-009» → «АКТ-2026-010». Без цифр — порожньо. */
  function nextDocNo(no) {
    const m = String(no || '').match(/^(.*?)(\d+)(\D*)$/);
    if (!m) return '';
    const n = String(+m[2] + 1).padStart(m[2].length, '0');
    return m[1] + n + m[3];
  }

  function act(name) {
    switch (name) {
      case 'new':
        if (!leaveEditing()) break;
        go('moves', { formOpen: true });
        $('#doc-form')?.scrollIntoView({ block: 'start' });
        break;
      case 'item-new':
        state.newItem = state.book === 'ОП'
          ? { code: nextCode('ОП'), name: '', unit: 'шт', group: 'ОП.1', price: '', nonrev: false, perRation: '', normLine: '' }
          : isSpRp(state.book) ? { code: nextCode(state.book), name: '', unit: 'шт', group: BOOKS[state.book].group,
            price: '', nonrev: false, perRation: '', kind1: '' }
          : { code: nextCode(), name: '', unit: 'шт', group: '21.18', price: '', nonrev: false };
        go('nomen');
        break;
      case 'item-edit': {
        const it = itemBy.get(state.itemCode);
        if (!it) break;
        state.newItem = { code: it.code, name: it.name, unit: it.unit, group: it.group,
                          price: it.price || it.basePrice || '', nonrev: !!it.nonrev, editCode: it.code,
                          base: !it.own, fes: it.fes || '', note: it.note || '', old: it.old || '',
                          archived: it.archived || '', perRation: it.perRation ?? '', normLine: it.normLine || '', kind1: it.kind1 || '' };
        go('nomen', { book: bookOfItem(it) });
        $('#item-form [name="name"]')?.focus();
        break;
      }
      case 'item-del': {
        const it = itemBy.get(state.itemCode);
        if (!it || !it.own) break;
        const uses = itemUses(it.code);
        if (uses.length) {
          alert(`Позицію ${it.code} «${it.name}» видалити не можна: її вжито (${uses.join(', ')}).\n\n`
            + 'Спершу виправте або видаліть ці записи.');
          break;
        }
        if (!confirm(`Видалити позицію ${it.code} «${it.name}» з довідника?`)) break;
        store.items = (store.items || []).filter((x) => String(x.code) !== it.code);
        logChange('позицію видалено', 'item|' + it.code, `${it.code} «${it.name}»`);
        mergeOwnItems();
        save(true, true);
        toast(`Позицію ${it.code} «${it.name}» видалено з довідника.`);
        go('nomen');
        break;
      }
      case 'item-cancel': {
        const back = state.newItem ? state.newItem.forLine : null;
        state.newItem = null;
        if (back != null && state.draft) go('moves'); else render();
        break;
      }
      case 'doc-later': draftLater(); break;
      case 'only-mine': state.onlyMine = !state.onlyMine; state.movesLimit = 200; render(); break;
      case 'no-scan': state.noScan = !state.noScan; state.movesLimit = 200; render(); break;
      case 'more': state.movesLimit = (state.movesLimit || 200) + 200; render(); break;
      case 'edit-cancel': state.editing = null; state.editingReport = null; state.draft = null; render(); break;
      case 'line-add': {
        const dr = draft();
        dr.lines.push({ code: '', qty: '', price: '', note: '' });
        render();
        $(`#doc-form [data-pick="${dr.lines.length - 1}"]`)?.focus();
        break;
      }
      case 'line-other': {
        const dr = draft();
        dr.lines.push({ other: true, name: '', qty: '', uom: '', price: '', note: '', offNo: '', offDate: '' });
        render();
        $(`#doc-form [data-ln="name"][data-i="${dr.lines.length - 1}"]`)?.focus();
        break;
      }
      case 'draft-clear':
        if (hasContent(state.draft) && !confirm('Очистити форму? Усе, що в ній уписано, пропаде.')) break;
        state.draft = null;
        render();
        break;
      case 'journals-open': journalsDialog(); break;
      case 'op-export': opExport(); break;
      case 'folders-save': foldersSave(); break;
      case 'op-request': opRequestDialog(); break;
      case 'op-fes': pickFile('.xlsx', opFes); break;
      case 'fes-map-save': opFesSave(); break;
      case 'op-request-make': opRequestMake(); break;
      case 'op-import': pickFile('.xlsx', (f) => opImport(f, false)); break;
      case 'op-legacy': pickFile('.xlsx', (f) => opImport(f, true)); break;
      case 'journals-make': journalsMake(); break;
      case 'new-dz':
        if (!leaveEditing()) break;
        go('moves', { moveKind: 'dz', formOpen: true });
        $('#doc-form')?.scrollIntoView({ block: 'start' });
        break;
      case 'open-j47': go('j47', { j47code: state.itemCode, book: bookOf(state.itemCode) }); break;
      case 'j47-book': j47Excel(true); break;
      case 'doc-back': goBack(state.docBack && state.docBack !== 'doc' ? state.docBack : 'moves'); break;
      case 'back': goBack('nomen'); break;
      case 'short': state.onlyShort = !state.onlyShort; render(); break;
      case 'reset':
        Object.assign(state, { q: '', group: '', sub: '', onlyShort: false, onlyMine: false, noScan: false, assetF: '',
                               movesKindF: '', movesFrom: '', movesTo: '', movesLimit: 200, movesFes: '' });
        render();
        break;
      case 'print':
        if (state.view === 'j47') j47Excel();
        else if (state.view === 'j14') j14Excel();
        else if (state.view === 'inv') invExcel();
        else if (state.view === 'doc') docExcel(state.docKey);
        else if (state.view === 'recon') reconExcelDate();
        else listExcel();
        break;
      case 'export':
        if (state.view === 'doc') docExcel(state.docKey);
        else if (state.view === 'recon') reconExcelDate();
        else listExcel();
        break;

      case 'norms-demo': seedNormsFromBalance(); break;
      case 'norms-clear': {
        const scope = state.sub || rootName();
        const mine = normsInit().filter((n) => n.code && n.sub === scope);
        if (!mine.length) { toast(`Норм на коди для «${scope}» немає.`); break; }
        if (confirm(`Очистити ${cnt(mine.length, 'норму', 'норми', 'норм')} на коди для «${scope}» `
          + 'разом з усіма строками дії?\n\nНорми інших підрозділів лишаться.')) {
          store.norms = store.norms.filter((n) => !mine.includes(n));
          save(true, true); render();
        }
        break;
      }
      case 'clear-dz':
        if (confirm('Видалити рапорти про знищення, внесені в програмі?\n\nРапорти з паперових журналів лишаться.')) {
          store.destroyed = (store.destroyed || []).filter((x) => x.origin === 'seed'); save(true, true); refresh();
        }
        break;
      case 'state-export': copyAway(); break;
      case 'verify': openVerify(); break;
      case 'memo': openMemo(); break;
      case 'memo-print': printMemo(); break;
      case 'backups': openBackups(); break;
      case 'log': openLog(); break;
      case 'net-open': netOpen(); break;
      case 'net-save': netSave(); break;
      case 'net-logout': netLogout(); break;
      case 'search': paletteOpen(); break;
      case 'lines-all': linesAll(); break;
      case 'short-xls': shortageExcel(); break;
      case 'form21-xls': form21Excel(); break;
      case 'form21-set': form21SetExcel(); break;
      case 'losses-xls': lossesExcel(); break;
      case 'sub-nomen': go('nomen', { sub: state.subName, q: '', book: state.subBook || 'ТЗ', group: '' }); break;
      case 'sub-j14': go('j14', { j14sub: state.subName, j14page: 1, book: state.subBook || 'ТЗ' }); break;
      case 'sub-xls': subExcel(); break;
      case 'sub-filter-reset': state.subAsset = ''; state.subHolder = ''; render(); break;
      case 'first-unit': go('people', { peopleTab: 'unit', personId: null, assign: null }); break;
      case 'sub-rehold': {
        const child = ($('#f-rehold') || {}).value || '';
        if (!child) break;
        if (confirm(`Перенести майно, виписане на «${state.subName}», на «${child}»?\n\n`
          + 'У документах і записах про знищення батальйон буде замінено на цей підрозділ.')) {
          reholdToChild(state.subName, child);
        }
        break;
      }
      case 'sub-moves': go('moves', { sub: state.subName, q: '', movesLimit: 200, book: state.subBook || 'ТЗ' }); break;
      case 'sub-mvo': go('people', { peopleTab: 'resp', personId: null, assign: { kind: 'mvo', sub: state.subName } }); break;
      case 'scan-add': {
        const t = scanTarget();
        if (t) attachScan(t);
        break;
      }
      case 'post-next': {
        const form = $('#doc-form');
        if (!form) break;
        state.postNext = true;
        form.requestSubmit();
        break;
      }
      case 'hist':
        store.ui.hist = !store.ui.hist;
        save();
        render();
        toast(store.ui.hist
          ? 'Режим «вношу історію»: документи в закритому періоді проводяться без підтвердження.'
          : 'Режим «поточна робота»: документи в закритому періоді проводяться з підтвердженням.');
        break;
      case 'asof-today': {
        state.asOf = today();
        const el = $('#as-of');
        if (el) el.value = state.asOf;
        balCache.key = null;
        render();
        break;
      }
      case 'sb-add': substAdd(); break;
      case 'sb-clear': state.substDraft = { from: '', to: [] }; render(); break;
      case 'rc-back': if (canBack()) history.back(); else { state.reconId = null; go('recon'); } break;
      case 'rc-all': reconAll(); break;
      case 'rc-all-xls': reconExcelDate(); break;
      case 'rc-journal': reconJournalExcel(); break;
      case 'rc-fin': reconFill('fin'); break;
      case 'rc-fact': reconFill('fact'); break;
      case 'rc-line-add': {
        const r = current();
        if (!editable(r)) break;
        r.lines.push({ code: '', name: '', uom: 'шт', price: 0, fin: null, acc: 0, fact: null, note: '', extra: true });
        logChange('відомість доповнено', 'recon|' + r.id, `Відомість №${r.no || '—'} · ${r.sub}: дописано рядок`);
        save();
        render();
        document.querySelector(`[data-rl="${r.lines.length - 1}"][data-k="name"]`)?.focus();
        break;
      }
      case 'rc-sync': reconSync(); break;
      case 'rc-result': reconAutoResult(); break;
      case 'rc-sign': reconSign(true); break;
      case 'rc-unsign': reconSign(false); break;
      case 'rc-del': reconDelete(); break;
      case 'rc-print': reconExcel([reconById(state.reconId)]); break;
      case 'state-import': importState(); break;
      case 'reset-all':
        // Скидається лише те, що має позначку «внесено в програмі». Норми штату,
        // люди, МВО, дислокація й підрозділи такої позначки не мають (це і є
        // довідники бази), тож лишаються: раніше скидання видаляло всі норми,
        // разом із табелями 21/Прод і 3/Прод із паперів.
        if (confirm('Видалити все внесене в програмі: документи, рапорти про знищення, нові позиції номенклатури, '
          + 'звірки, інвентаризації, заміни в штаті, відомості залишкової вартості, акти ЯТС, акти списання за нормами, '
          + 'закупівлі з коштами й документами та підшиті скани?\n\n'
          + 'Документи й рапорти з паперових журналів служби (разом із виправленнями), норми штату, люди, МВО, '
          + 'дислокація, підрозділи, пункти харчування й дободачі лишаться як є. Поточний стан перед цим ляже в копії.')) {
          const base = (kind, arr) => (arr || []).filter((r) => rowOrigin(kind, r) === 'seed');
          store.docs = { incoming: base('in', store.docs.incoming), movement: base('mv', store.docs.movement),
                         writeoffs: base('wr', store.docs.writeoffs) };
          store.destroyed = (store.destroyed || []).filter((x) => x.origin === 'seed');
          store.items = []; store.recon = []; store.subst = [];
          store.scans = []; store.inventories = []; store.papers = [];
          store.budget = []; store.purchases = []; store.purDocs = [];
          mtzPrune();
          logChange('скинуто', '', 'внесене в програмі: документи, знищення, нові позиції, звірки, '
            + 'інвентаризації, заміни, закупівлі й скани');
          mergeOwnItems(); save(true, true); refresh();
        }
        break;
    }
  }

  /** Копія того, що внесено в програмі: документи, норми, знищення, вигляд. */
  function exportState() {
    const blob = new Blob([JSON.stringify(store, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `облік-тз-мої-дані-${today()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /** Відновлення з копії. Файл перевіряється на форму до того, як щось буде
   *  замінено: чужий чи зіпсований JSON не має стерти поточні дані. */
  function importState() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = native ? '.sqlite,.json,application/json' : '.json,application/json';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (native && /\.sqlite$/i.test(f.name)) { restoreFile(f); return; }
      let j;
      try { j = JSON.parse(await f.text()); } catch (e) {
        alert('Файл не прочитано: це не копія даних програми.');
        return;
      }
      const ok = j && typeof j === 'object' && j.docs && Array.isArray(j.docs.incoming)
        && Array.isArray(j.docs.movement) && Array.isArray(j.docs.writeoffs)
        && Array.isArray(j.destroyed || []) && typeof (j.norms || []) === 'object';
      if (!ok) { alert('У файлі немає даних обліку. Нічого не змінено.'); return; }
      const n = j.docs.incoming.length + j.docs.movement.length + j.docs.writeoffs.length;
      if (!confirm(`Відновити дані з «${f.name}»?

У копії: ${n} рядків документів, `
        + `${(Array.isArray(j.norms) ? j.norms : Object.keys(j.norms || {})).length} норм, `
        + `${(j.destroyed || []).length} записів знищення, `
        + `${(Array.isArray(j.items) ? j.items : []).length} нових позицій, `
        + `${(Array.isArray(j.recon) ? j.recon : []).length} звірок.
`
        + 'Поточні дані буде замінено, попередній стан лишиться в копіях.')) return;
      // Чого в копії немає (давній формат без норм чи позицій), те лишається
      // як є: порожній розділ означав би «видалити все», а не «не було в копії».
      if (j.norms) store.norms = j.norms;
      // Копія попередніх версій несе лише внесене в програмі: документи й рапорти
      // з паперових журналів жили окремо. Тоді вони лишаються, а внесене з копії
      // лягає поряд; номери актів до рапортів із паперів та копія тримала мапою.
      const oldCopy = !copyHasOrigin(j);
      const seed = (kind, arr) => (arr || []).filter((r) => rowOrigin(kind, r) === 'seed');
      const wrs = j.docs.writeoffs.map(wrRow);
      store.docs = oldCopy
        ? { incoming: seed('in', store.docs.incoming).concat(j.docs.incoming),
            movement: seed('mv', store.docs.movement).concat(j.docs.movement),
            writeoffs: seed('wr', store.docs.writeoffs).concat(wrs) }
        : { incoming: j.docs.incoming, movement: j.docs.movement, writeoffs: wrs };
      const dz = Array.isArray(j.destroyed) ? j.destroyed : [];
      store.destroyed = oldCopy ? (store.destroyed || []).filter((x) => x.origin === 'seed').concat(dz) : dz;
      if (oldCopy && j.dzActs && typeof j.dzActs === 'object') {
        for (const x of store.destroyed) {
          const a = x.origin === 'seed' && !x.act && j.dzActs[[x.date, x.sub, x.code, x.report].join('|')];
          if (a) x.act = String(a);
        }
      }
      if (Array.isArray(j.items)) store.items = j.items;
      store.recon = Array.isArray(j.recon) ? j.recon : [];
      store.subst = Array.isArray(j.subst) ? j.subst : [];
      // Копія попередніх версій не знає закупівель (і лишає їх, див. нижче), а з ними — записів про їхні файли: самі файли
      // лежать у теках служби й нікуди не ділися.
      const copyScans = Array.isArray(j.scans) ? j.scans : [];
      const knowsPurchases = ['budget', 'purchases', 'purDocs'].some((k) => Array.isArray(j[k]));
      const kept = knowsPurchases ? [] : (store.scans || []).filter((f) => PUR_FILE_KEY.test(f.key)
        && !copyScans.some((c) => c.key === f.key && c.path === f.path && (c.folder || '') === (f.folder || '')));
      store.scans = copyScans.concat(kept);
      store.inventories = Array.isArray(j.inventories) ? j.inventories : [];
      // Відомості й акти: копія, що їх знає, повертає їх разом із затвердженими версіями; копія
      // попередніх версій програми їх не має — тоді теперішні лишаються як є.
      if (Array.isArray(j.papers)) { store.papers = j.papers; saving.papers = true; }
      // Закупівлі так само: копія, що їх знає, повертає їх такими, якими вони були; копія попередніх версій їх не має —
      // тоді теперішні лишаються (прибраний розділ порожнім зник би з бази за першим же записом).
      for (const k of ['budget', 'purchases', 'purDocs']) if (Array.isArray(j[k])) store[k] = j[k];
      mtzPrune();
      for (const k of ['people', 'mvo', 'officials', 'locations', 'subs']) {
        if (Array.isArray(j[k])) store[k] = j[k]; else delete store[k];
      }
      // Довідники з копії лягають як є: вони й самі з бази, а не «поверх» неї.
      peopleReady.delete(store);
      peopleInit();
      store.ui = j.ui || store.ui;
      mergeOwnItems();
      stateBroken = null;
      saveBar('');
      save(true, true);
      refresh();
      state.flash = `Дані відновлено з «${f.name}».`;
      go('moves');
    });
    inp.click();
  }

  /** Стартова заготовка норм: поточна наявність по підрозділах як відправна точка. */
  /** Заготовка норм за наявністю — лише там, де норми ще немає: уписане руками
   *  не перезаписується. */
  function seedNormsFromBalance() {
    const scope = state.sub || rootName();
    const todo = tzItems().filter((i) => {
      const have = state.sub ? haveRollup(scope, i.code) : balCode(i.code);
      return have > 0 && !normOwn(scope, i.code);
    });
    if (!todo.length) { toast('Порожніх норм для наявних позицій немає.'); return; }
    if (!confirm(`Заповнити ${cnt(todo.length, 'порожню норму', 'порожні норми', 'порожніх норм')} для «${scope}» `
      + 'поточною наявністю? Уже вписані норми не зміняться. Норми на коди, прив’язані до рядків форми, '
      + 'підуть і в потребу форми 21/Прод.')) return;
    for (const i of todo) {
      normSet({ sub: scope, code: i.code }, state.sub ? haveRollup(scope, i.code) : balCode(i.code), state.asOf, false, true);
    }
    logChange('штат змінено', 'norm|' + scope, `${scope}: ${cnt(todo.length, 'норму', 'норми', 'норм')} заповнено `
      + `наявністю на ${fmtDate(state.asOf)}`);
    save(); render();
    toast(`Заповнено ${cnt(todo.length, 'норму', 'норми', 'норм')}. Перевірте цифри за штатом.`);
  }

  /** Експорт того, що на екрані, у CSV для Excel.
   *
   *  Раніше кнопка на будь-якому екрані вивантажувала номенклатуру — навіть
   *  зі стрічки документів, де людина чекає саме документи. Тепер кожен вигляд
   *  віддає свою таблицю з тими самими фільтрами, що й на екрані.
   */
  function exportRows() {
    const q = state.q.trim().toLowerCase();
    if (state.view === 'moves') {
      const head = ['дата', 'вид', 'номер', 'звідки', 'куди', 'код', 'найменування', 'кількість', 'примітка', 'стан'];
      const list = movesSorted();
      return ['документи', [head, ...list.map((r) => {
        const it = itemBy.get(r.code);
        return [r.d, KIND_TAG[r.kind][1], r.no, r.from, r.to, r.code, it ? it.name : '', r.q, r.note || '', DOC_STATUS[docStatus(r)][0]];
      })]];
    }
    if (state.view === 'supply' || state.view === 'subst') {
      const form = state.staffForm;
      const rows = applySubst(staffRows(state.asOf, state.sub).filter((g) => g.form === form), form);
      const withS = !!((store.subst || []).some((x) => x.form === form) && store.ui.withSubst);
      const head = ['табельна позиція', 'штат', 'наявно', 'знищено'].concat(withS ? ['по заміні', 'за рахунок'] : [])
        .concat(['некомплект', 'понад штат', '%']);
      return [`штат-${state.sub || 'бригада'}-${form.replace('/', '-')}${withS ? '-з-замінами' : ''}`,
        [head, ...rows.filter((g) => g.staffed || (withS && g.subOut)).map((g) => {
          const pct = withS ? g.pctS : g.pct;
          return [g.line, g.qty || '', g.have, g.destr || '']
            .concat(withS ? [g.subIn || '', g.subFrom.map(([l, q]) => `${l} – ${q}`).join('; ')] : [])
            .concat([(withS ? g.shortS : g.short) || '', (withS ? g.overS : g.over) || '',
              pct == null ? '' : Math.round(pct * 100) + '%']);
        })]];
    }
    if (state.view === 'destroyed') {
      const head = ['дата', 'підрозділ', 'код', 'найменування', 'кількість', 'ціна', 'сума', 'рапорт', 'дата рапорту',
        'чим списано', 'дата акта', 'статус'];
      const vals = lossValues();
      return ['знищене', [head, ...regRows(destroyedSpec()).map((r) => {
        const it = itemBy.get(r.code);
        const v = vals.get(r.id) || {};
        return [r.date, r.sub, r.code, r.other ? r.name || '' : it ? it.name : '', r.qty, v.qty ? v.price : '', v.qty ? v.sum : '',
          r.report || '', r.reportDate || '', r.other ? r.offNo || '' : actLabel(r), r.status === 'списано' ? r.actDate || '' : '', r.status];
      })]];
    }
    if (state.view === 'inv') {
      const head = ['код', 'найменування', 'підрозділ', 'перший номер', 'останній номер', 'одиниць'];
      return ['інвентарні-номери', [head, ...regRows(inventorySpec()).map((r) => {
        const it = itemBy.get(r.code);
        return [r.code, it ? it.name : '', r.sub, invNo(r.code, r.from), invNo(r.code, r.to), r.to - r.from + 1];
      })]];
    }
    if (state.view === 'acts' && (state.actsTab || 'acts') === 'acts') {
      const list = regRows(actsSpec());
      return ['акти списання', [['номер', 'дата', 'серія', 'пункт', 'з', 'по', 'д/д', 'позицій', 'сума, грн', 'ФЕС'],
        ...list.map((r) => [r.no, r.d, r.series, r.pointName, r.from, r.to, r.rations, r.n, r.sum, r.fes])]];
    }
    if (state.view === 'subs') {
      const b = balances();
      const head = ['підрозділ', 'тип', 'власний залишок', 'з підлеглими'];
      return ['підрозділи', [head, ...subs.map((sb) => {
        const own = b.bySub.get(sb.name) || 0;
        const roll = [...b.bySub.entries()].reduce((a, [n, v]) => (inSubtree(sb.name, n) ? a + v : a), 0);
        return [sb.name, sb.type, own, roll];
      })]];
    }
    const head = ['код', 'найменування', 'група', 'од.вим.', 'облік', '№ ФЕС', 'остання ціна', 'ціни партій',
      'вартість, грн', 'наявно', 'знищено', 'фактично'];
    return ['номенклатура', [head, ...filteredItems().map((i) => {
      const have = state.sub ? balOf(i.code, state.sub) : balCode(i.code);
      const d = destroyedOf(i.code, state.sub || null);
      const lots = lotBreakdown(i.code, state.sub || null);
      return [i.code, i.name, i.group, i.unit, ASSET[assetOf(i)][1], i.fes || '', i.price,
        lotPricesText(i.code, state.sub || null, true), lots.value, have, d, have - d];
    })]];
  }
