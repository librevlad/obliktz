// Облік ТЗ ПС · сторінка · події й переходи.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ------------------------------------------------------------------- події
  /** Усе похідне від журналів — проводки, стрічка, дерево підрозділів, ціни, партії, відповідь «Забезпеченості» — наново.
   *  Без перемальовування: імпорт історії проводить сотні документів поспіль і малює раз. */
  function recalc() {
    ledger = buildLedger();
    docs = buildDocs();
    // Підрозділ, доданий у програмі, вважається задіяним, щойно на нього
    // склали перший документ: тоді він з'являється й у фільтрах.
    // Задіяний — той, що згаданий хоч де-небудь в обліку, і рахується так від
    // першого показу: раніше лічильник «Підрозділи» зростав після першого ж
    // збереження, хоча нічого нового не з'явилося.
    rebuildSubs(Array.isArray(store.subs) ? store.subs : D.subs.map(baseSub), subMentions());
    applyPrices();
    allocateLots();
    balCache.key = null;
    dzCache = null;
    state.spSupply = null;                 // забезпеченість сухпаєм залежить від обліку: «назад» не бере відповідь, що лишилась від колишнього
  }
  function refresh() {
    recalc();
    render();
  }

  /** Поля, які перемальовування екрана не мусить загубити: вузол після нього новий, тож курсор повертають у поле з тими самими
   *  data-атрибутами — у картці документа (рапорт, наказ, «придатний до», «1прод», ФЕС) і в шапці «Забезпеченості» (дата, особи, доби), у «Описах 572» (конфіг). */
  const FOCUS_KEYS = ['data-dmeta', 'data-lx', 'data-sp', 'data-fes', 'data-ov'];
  const fieldAttr = (el, k) => (el.hasAttribute(k) ? `[${k}="${el.getAttribute(k).replace(/["\\]/g, '\\$&')}"]` : '');
  function fieldSelector(el) {
    const k = el && el.hasAttribute ? FOCUS_KEYS.find((x) => el.hasAttribute(x)) : '';
    return k ? fieldAttr(el, k) + fieldAttr(el, 'data-doc') + fieldAttr(el, 'data-key') : '';
  }
  /** Поле, де людина вже друкує: набране ще не записано (`change` чекає на вихід із поля), і нове поле його не мало б. Для поля, чию
   *  правку щойно записано (`changed`), набране — це друк понад записане (`committed`). */
  const typedIn = (el, changed, committed) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
    && el.value !== (el === changed ? committed : el.defaultValue);
  /** Дату друкують по частинах: поки складники не всі, поле недійсне, а цифра року дає дійсну дату з роком 0002, потім 0020, 0202.
   *  Це набір, а не правка: сервер такий рік відхиляє («рік уведено не повністю»), а перемальовування збило б набір. Правкою він стає,
   *  коли дата повна й рік у межах обліку; навмисно стерте поле (порожнє й не недійсне) — правка. */
  const datePartial = (el) => el.type === 'date' && (el.validity.badInput || !!dateYearOdd(el.value));
  /** Перемальовує екран і повертає курсор (з виділенням) у те саме поле нового екрана, якщо воно там є. Поле, де вже друкують,
   *  перемальовування обходить: воно настане з правкою цього поля. */
  function renderKeepFocus(changed, committed) {
    const at = document.activeElement;
    const sel = fieldSelector(at);
    if (typedIn(at, changed, committed)) return;
    let range = null;
    try { if (sel && at.selectionStart != null) range = [at.selectionStart, at.selectionEnd, at.selectionDirection]; } catch (e) { range = null; }
    render();
    const now = sel ? document.querySelector(sel) : null;
    if (!now) return;
    now.focus({ preventScroll: true });
    if (range) { try { now.setSelectionRange(...range); } catch (e) { /* поле без виділення, як дата */ } }
  }
  let fieldTimer = 0;
  /** Правка поля, що перемальовує екран: у `change` курсор ще в дорозі до наступного поля (Tab, клац), тож перемальовують через такт,
   *  коли він уже дійшов, — і він лишається там, куди пішла людина (чи в тому самому полі, якщо вона нікуди не йшла). */
  const renderAfterField = (el) => {
    const committed = el ? el.value : '';
    clearTimeout(fieldTimer);
    // Кожна дійсна дата — окрема правка, а друкують їх підряд: поки курсор у полі дати, перемальовування чекає паузи в друці.
    const wait = el && el.type === 'date' && document.activeElement === el ? 700 : 0;
    fieldTimer = setTimeout(() => renderKeepFocus(el, committed), wait);
  };

  /** Переходи йдуть в історію вікна: «назад» (кнопка на екрані, Alt+←, бічна
   *  кнопка миші) повертає туди, звідки прийшли, — з документа в картку засобу
   *  й назад у документ, а не завжди в перелік. */
  const navSnap = () => ({ view: state.view, book: state.book, itemCode: state.itemCode, docKey: state.docKey,
    reconId: state.reconId, docBack: state.docBack, stId: state.stId, stSub: state.stSub,
    peopleTab: state.peopleTab, personId: state.personId, subName: state.subName,
    paperId: state.paperId || null, paperVer: state.paperVer || 0,
    purId: state.purId || null, budId: state.budId || null, purDocId: state.purDocId || null,
    purYear: state.purYear || null, actsTab: state.actsTab || null, rationsMonth: state.rationsMonth || null,
    idx: (history.state && history.state.idx) || 0 });
  const canBack = () => !!(history.state && history.state.idx > 0);

  function go(view, patch = {}) {
    const before = screenKey();
    Object.assign(state, patch, { view });
    if (screenKey() !== before) {
      const snap = navSnap();
      snap.idx = ((history.state && history.state.idx) || 0) + 1;
      try { history.pushState(snap, ''); } catch (e) { /* без історії теж працює */ }
    }
    render();
  }

  /** Вкладка чи пункт меню: корінь розділу з чистим пошуком. Вкладка книги відкриває свою книгу;
   *  фільтри іншої книги до неї не переходять. */
  function navTo(view, book) {
    const b = book && book !== state.book
      ? Object.assign({ book }, BOOK_FILTERS_OFF) : book ? { book } : {};
    return go(view, Object.assign({ q: '' }, NAV_ROOT[view] || {}, b));
  }

  /** Рядок меню: розділ відкривається на вкладці, на якій його лишили в цьому вікні, інакше — на першій. */
  function hubOpen(id) {
    const hub = HUBS.find((h) => h.id === id);
    const tabs = hub ? hubTabs(hub) : [];
    if (!tabs.length) return null;
    const tab = tabs.find((t) => t.id === state.hubTab[id]) || tabs[0];
    return navTo(tab.id, hub.book);
  }

  /** «← Назад»: у межах програми — на попередній екран, інакше — на запасний. */
  function goBack(fallback, patch = {}) {
    if (canBack()) { history.back(); return; }
    go(fallback, patch);
  }

  /** Один делегований обробник на всю оболонку: пункти меню, рядки таблиць,
   *  кнопки дій. Так нічого не «відвалюється» після перемальовування. */
  function bindGlobal() {
    // Enter у полі норми переводить у наступне — заповнення штату йде колонкою.
    // Зміна норми перемальовує таблицю, тож наступне поле шукаємо вже після цього.
    // Обробник один на весь час роботи: #scroll не перестворюється, і прив'язка
    // в bindBody додавала б ще один дублікат на кожному перемальовуванні.
    // Рядки таблиць ходять із клавіатури: ↑↓ — між рядками, Enter — відкрити.
    // Рядок стає фокусованим у render() (tabindex), тут — лише рух.
    $('#scroll').addEventListener('keydown', (e) => {
      const row = e.target.closest && e.target.closest('.tbl__row[tabindex]');
      if (row && !e.target.matches('input, select, textarea, button')) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const rows = [...$('#scroll').querySelectorAll('.tbl__row[tabindex]')];
          const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
          if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ block: 'nearest' }); }
          return;
        }
        if (e.key === 'Enter') { e.preventDefault(); row.click(); return; }
      }
      if (e.key !== 'Enter' || !e.target.matches('.norm')) return;
      e.preventDefault();
      const all = [...$('#scroll').querySelectorAll('.norm')];
      const next = all[all.indexOf(e.target) + 1];
      const code = next && next.dataset.norm;
      e.target.blur();
      if (!code) return;
      const nx = $(`.norm[data-norm="${code}"]`);
      if (nx) { nx.focus(); nx.select(); nx.scrollIntoView({ block: 'nearest' }); }
    });
    $('#scroll').addEventListener('scroll', () => { if (pick.input) pickRender(); }, { passive: true });
    window.addEventListener('resize', () => { if (pick.input) pickRender(); });
    document.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && (state.view === 'j47' || state.view === 'j14')) {
        e.preventDefault();
        journalStep(e.key === 'ArrowDown' ? 1 : -1);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (state.viewer && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
        && !e.target.closest('input, textarea, select')) {
        e.preventDefault();
        state.viewer.idx += e.key === 'ArrowRight' ? 1 : -1;
        viewerRender();
        return;
      }
      // Ctrl+K — пошук по всьому з будь-якого екрана (і в українській розкладці: це клавіша, не літера).
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') { e.preventDefault(); paletteOpen(); return; }
      if (e.key !== 'Escape') return;
      if ($('#palette')) { paletteClose(); return; }
      if ($('#modal')) { modalDismiss(); return; }
      if (state.viewer) { viewerClose(); return; }
      const q = $('#q');
      if (q && q.value && document.activeElement === q) { q.value = ''; state.q = ''; render(); }
    });
    // Колесо миші над числовим полем у фокусі тихо змінювало кількість чи ціну.
    document.addEventListener('wheel', (e) => {
      if (e.target.matches && e.target.matches('input[type="number"]') && document.activeElement === e.target) e.target.blur();
    }, { passive: true });
    // Рік у полі дати, набраний не повністю («30.09.26» дає 0026 рік): поле приймає будь-який
    // рік, тож про описку кажемо одразу; база такої дати не запише.
    document.addEventListener('change', (e) => {
      const el = e.target;
      if (!el.matches || !el.matches('input[type="date"]') || !el.value) return;
      const bad = dateYearOdd(el.value);
      if (bad) toast(`У даті рік ${bad}: уведіть рік повністю, чотирма цифрами`, true);
    }, true);
    document.addEventListener('click', (e) => {
      if (e.target.closest('input, select, textarea, label')) return;
      const el = e.target.closest('[data-hub],[data-nav],[data-act],[data-item],[data-code],[data-open],'
        + '[data-sub],[data-kind],[data-page],[data-accent],[data-density],[data-textsize],[data-wrap],[data-vw]');
      // Корінь документа несе атрибути оформлення, а не дію: якщо пошук дійшов
      // до нього, клац був по порожньому місцю.
      if (!el || el === document.documentElement || el === document.body) return;
      // Людина виділяє номер у рядку, щоб скопіювати, — це не клац по рядку.
      // Лише для рядків і лише коли виділене лежить у самому рядку: кнопки й
      // меню працюють завжди — раніше будь-який виділений текст на сторінці
      // (навіть у полі вводу) мовчки глушив усі кнопки.
      const sel = window.getSelection ? window.getSelection() : null;
      if (sel && String(sel).trim() && !e.target.closest('button') && sel.anchorNode && el.contains(sel.anchorNode)) return;
      if (el.closest('#viewer')) return;
      const d = el.dataset;
      // Пункт меню відкриває корінь розділу, а не картку, що лишилась у ньому
      // відкритою: «Звірки» після підписаної відомості вели назад у відомість.
      // Пункт меню — новий екран із чистим пошуком: запит із «Руху й операцій»
      // інакше фільтрував реєстр знищеного, і той показував «записів немає».
      if (d.hub) return hubOpen(d.hub);
      if (d.nav) return navTo(d.nav, d.book);
      if (d.vw != null && !d.act) return openViewer(d.vwKey, d.vw);
      if (d.act === 'att') return attActs[+d.i] ? attActs[+d.i]() : null;
      if (d.act === 'sort') return sortToggle(d.view, d.k, d.first);
      if (d.act === 'tf') { const fl = tfOf(d.id); fl[d.k] = d.v || ''; fl.limit = 0; return regRefresh(d.id); }
      if (d.act === 'tf-reset') { regReset(d.id); return regRefresh(d.id); }
      if (d.act === 'tf-more') { const fl = tfOf(d.id); fl.limit = Math.max(fl.limit || 0, REG_LIMIT) + REG_LIMIT; return regRefresh(d.id); }
      if (d.act === 'rc-doc') return reconToDoc(d.v);
      if (d.act === 'doc-based') return docBasedOn(d.doc, d.v);
      if (d.act === 'sub-handover') return subHandOver(d.sub);
      if (d.act === 'staff-open') { state.staffOpen = state.staffOpen === d.line ? null : d.line; return render(); }
      if (d.act && d.act.startsWith('st-')) return stocktakeAction(d.act, d);
      if (d.act && d.act.startsWith('mtz-')) return mtzAction(d.act, d);
      if (d.act && d.act.startsWith('f2-')) return form2Action(d.act, d);
      if (d.act && d.act.startsWith('f11-')) return form11Action(d.act, d);
      if (d.act && d.act.startsWith('ov-')) return ovAction(d.act, d);
      if (d.act && d.act.startsWith('oa-')) return actsAction(d.act, d);
      if (d.act && d.act.startsWith('sa-')) return spAction(d.act, d);
      if (d.act && d.act.startsWith('pur-')) return purAction(d.act, d);
      if (d.act && d.act.startsWith('book-')) return bookAction(d.act, d);
      if (d.act && d.act.startsWith('bud-')) return budAction(d.act, d);
      if (d.act && d.act.startsWith('pd-')) return pdAction(d.act, d);
      if (d.act && d.act.startsWith('av-')) return avAction(d.act, d);
      if (d.act && /^(paper|val|yats)-/.test(d.act)) return paperAction(d.act, d);
      if (d.act && d.act.startsWith('imp-')) return impAction(d.act, d);
      if (d.act && /^(pp|ph|as|mvo|cmdr|off|loc)-|^file-add$/.test(d.act)) return peopleAction(d.act, d);
      if (d.act && /^(sd|nm)-/.test(d.act)) return subsAction(d.act, d);
      if (d.act === 'dz-del') return deleteDestroyed(d.id);
      if (d.act === 'dz-act') return actDestroyed(d.id);
      if (d.act === 'dz-wr') return writeoffFromAct(d.id);
      // Назад до записів «Знищене майно», уже відібраних за номером рапорту.
      if (d.act === 'dz-open') return go('destroyed', { q: d.v || '' });
      if (d.act === 'scan-del') return unlinkScan(d.path, d.folder || '');
      if (d.act === 'rc-new') return reconNew(d.sub);
      if (d.act === 'rc-open') return reconOpen(d.id);
      if (d.act === 'rc-xls') return reconExcel([reconById(d.id)]);
      if (d.act === 'rc-line-del') {
        const r = current();
        const l = r && editable(r) ? r.lines[+d.i] : null;
        if (!l || !confirm(`Прибрати рядок «${l.name || 'без назви'}» з відомості?`)) return null;
        r.lines.splice(+d.i, 1);
        logChange('відомість змінено', 'recon|' + r.id, `Відомість №${r.no || '—'} · ${r.sub}: прибрано рядок «${l.name || '—'}»`);
        save();
        return render();
      }
      if (d.act === 'doc-print') return docExcel(d.doc);
      if (d.act === 'doc-edit') return editDoc(d.doc);
      if (d.act === 'doc-del') return deleteDoc(d.doc);
      if (d.act === 'mk') { state.movesKindF = d.v || ''; state.movesLimit = 200; return render(); }
      if (d.act === 'sub-asset') { state.subAsset = d.v || ''; return render(); }
      if (d.act === 'op-apply') return opApply(d.sha, d.legacy === '1');
      if (d.act === 'sub-book') { state.subBook = ['ОП', 'СП', 'РП'].includes(d.v) ? d.v : 'ТЗ'; state.subAsset = ''; return render(); }
      if (d.act === 'j-prev' || d.act === 'j-next') return journalStep(d.act === 'j-next' ? 1 : -1);
      if (d.act === 'sf') { state.staffForm = d.v; state.substDraft = { from: '', to: [] }; return render(); }
      if (d.act === 'ws') { store.ui.withSubst = d.v === '1'; save(); return render(); }
      if (d.act === 'sb-del') return substDelete(d.id);
      if (d.act === 'dz-edit') return editReport(d.id);
      if (d.act === 'inv-move') {
        const [lo, hi, ...sub] = String(d.v).split('|');
        state.invMove = { code: d.code, lo: +lo, hi: +hi, from: +lo, to: +hi, was: sub.join('|'), sub: '', date: today(), note: '' };
        render();
        $('#scroll')?.scrollTo({ top: 0 });
        return null;
      }
      if (d.act === 'inv-go') return invMoveGo();
      if (d.act === 'inv-issue') return invIssueOpen();
      if (d.act === 'inv-issue-go') return invIssueGo();
      if (d.act === 'inv-cancel') { state.invMove = null; return render(); }
      if (d.act === 'staff-all') { state.staffAll = !state.staffAll; return render(); }
      if (d.act === 'lc-del') return lineCodesSet(d.line, (lineCodes.get(d.line) || []).filter((c) => c !== d.code));
      if (d.act === 'un-new') return unitEditOpen(null, d.code);
      if (d.act === 'un-edit') return unitEditOpen(d.id);
      if (d.act === 'un-save') return unitEditSave();
      if (d.act === 'un-cancel') { state.unitEdit = null; return render(); }
      if (d.act === 'ol-open') {
        state.ownLineOpen = true;
        render();
        return setTimeout(() => $('[data-ol="name"]')?.focus(), 0);
      }
      if (d.act === 'ol-cancel') { state.ownLineOpen = false; return render(); }
      if (d.act === 'ol-add') return ownLineAdd();
      if (d.act === 'ol-del') return ownLineDelete(d.line);
      if (d.act === 'sb-qt') return substTarget(d.v);
      if (d.act === 'sb-rm') return substTarget(d.v, false);
      if (d.act === 'sb-for') {
        state.substDraft = { from: '', to: [d.line] };
        go('subst');
        setTimeout(() => $('#sb-from')?.focus(), 0);
        return;
      }
      if (d.act === 'sb-up') return substMove(d.id, -1);
      if (d.act === 'sb-down') return substMove(d.id, 1);
      if (d.act === 'line-all') {
        const dr = draft(), ln = dr.lines[+d.i];
        if (!ln || !ln.code || state.moveKind === 'in') return;
        const have = lineHave(ln, dr.head.from, dr.head.date);
        if (have > 0) ln.qty = String(+have.toFixed(3));
        const q = $(`#doc-form [data-ln="qty"][data-i="${d.i}"]`);
        if (q) { q.value = ln.qty; q.focus(); }
        refreshLineHints();
        return;
      }
      if (d.act === 'line-code') return newCodeForLine(+d.i);
      if (d.act === 'line-del') {
        const dr = draft();
        if (dr.lines.length > 1) dr.lines.splice(+d.i, 1);
        return render();
      }
      if (d.act === 'intro-hide' || d.act === 'intro-show') {
        store.ui.hideIntro = d.act === 'intro-hide';
        save();
        if (d.act === 'intro-show' && state.view !== 'dash') return go('dash');
        return render();
      }
      if (d.act === 'doc-new') {
        if (!leaveEditing()) return null;
        state.formOpen = true;
        if (d.v) state.moveKind = d.v;
        if (d.book && d.book !== state.book) Object.assign(state, { book: d.book }, BOOK_FILTERS_OFF);   // «Дописати» чернетку іншої книги: її книга, а фільтри — як у меню
        if (state.view !== 'moves') return go('moves', { formOpen: true });
        render();
        $('#doc-form')?.scrollIntoView({ block: 'start' });
        $('#doc-form [name="no"]')?.focus();
        return null;
      }
      if (d.act) return act(d.act);
      if (d.kind) {
        // Вид документа при правці не міняється — і рапорту теж: інакше рапорт,
        // що виправлявся, лягав у чернетку нового й вносився вдруге.
        if (state.editing || state.editingReport) return;
        return go('moves', { moveKind: d.kind });
      }
      if (d.page) return go('j14', { j14page: +d.page });
      if (d.open) return openDoc(d.open);
      // Код позиції — рядок: у базі це текстове поле. Приведення до числа
      // розривало зв'язок із довідником, і картка засобу не відкривалася.
      if (d.item) return go('item', { itemCode: String(d.item) });
      if (d.code) return go('item', { itemCode: String(d.code) });
      // Підрозділ — картка підрозділу: майно, штат, звірка, МВО, документи.
      if (d.sub) return go('sub', { subName: d.sub });
      if (d.accent) {
        state.accent = d.accent; store.ui.accent = d.accent; save();
        applyTheme(); return render();
      }
      if (d.density) {
        state.density = d.density; store.ui.density = d.density; save();
        applyTheme(); return render();
      }
      if (d.textsize) {
        state.textSize = d.textsize; store.ui.textSize = d.textsize; save();
        applyTheme(); return render();
      }
      if (d.wrap != null) {
        state.wrap = d.wrap === '1'; store.ui.wrap = state.wrap; save();
        applyTheme(); return render();
      }
    });
  }

  /** Поля документа пишуться в чернетку одразу.
   *
   *  Найменування, дата й відправник міняють підказку про наявність, тому після
   *  них форма перемальовується. Кількість і примітки — ні: перемальовування на
   *  кожній натиснутій клавіші забирало б фокус.
   */
  function bindDraftFields() {
    const form = $('#doc-form');
    if (!form) return;
    const d = draft();
    form.querySelectorAll('[data-ln]').forEach((el) => {
      const i = +el.dataset.i, key = el.dataset.ln;
      const write = () => { d.lines[i][key] = el.value; };
      el.addEventListener('input', () => { write(); if (key === 'qty' || key === 'price') refreshLineHints(); keepDraftsSoon(); });
      el.addEventListener('change', () => { write(); refreshLineHints(); });
    });
    // Поле найменування: при вході порожніє, щоб одразу друкувати пошук, а
    // обране показує підказкою; вийшли без вибору — повертається як було.
    form.querySelectorAll('[data-pick]').forEach((el) => {
      el.addEventListener('focus', () => {
        const cur = el.value;
        el.value = '';
        if (cur) el.placeholder = cur;
        pickOpen(el);
      });
      el.addEventListener('input', () => {
        if (pick.input !== el) { pick.input = el; pick.i = +el.dataset.pick; }
        pick.active = 0;
        pickRender();
      });
      el.addEventListener('keydown', pickKey);
      el.addEventListener('blur', () => {
        if (pick.input === el) pickClose();
        pickRestore(el);
      });
    });
    // Enter не проводить документ: у шапці веде до наступного поля, у рядку —
    // до найменування наступного рядка. Провести — кнопкою або Ctrl+Enter.
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        pickClose();
        state.postNext = e.shiftKey && !state.editing && state.moveKind !== 'dz';
        form.requestSubmit();
        return;
      }
      const t = e.target;
      if (t.matches('textarea, button, [data-pick]')) return;
      e.preventDefault();
      if (t.dataset.ln) {
        const i = +t.dataset.i;
        if (t.dataset.ln === 'qty') {
          const p = $(`#doc-form [data-ln="price"][data-i="${i}"]`);
          if (p) { p.focus(); p.select(); return; }
        }
        if (i === d.lines.length - 1) { d.lines.push(emptyLine()); render(); }
        ($(`#doc-form [data-pick="${i + 1}"]`) || $(`#doc-form [data-ln="name"][data-i="${i + 1}"]`))?.focus();
        return;
      }
      const fields = [...form.querySelectorAll('.form__grid input, .form__grid select, .form__grid textarea')];
      const nx = fields[fields.indexOf(t) + 1];
      if (nx) nx.focus(); else $('#doc-form [data-pick="0"]')?.focus();
    });
    ['type', 'no', 'date', 'from', 'to', 'basis', 'note', 'report', 'reportDate', 'act']
      .forEach((name) => {
        const el = form.querySelector(`[name="${name}"]`);
        if (!el) return;
        el.addEventListener('input', () => {
          d.head[name] = el.value; d.head.auto = false; refreshSummary(); keepDraftsSoon();
        });
        el.addEventListener('change', () => {
          d.head[name] = el.value;
          d.head.auto = false;
          if (name === 'from' || name === 'date') refreshLineHints(); else refreshSummary();
        });
      });
  }

  /** Прив'язка полів вводу — вони живуть лише до наступного перемальовування. */
  function bindBody() {
    const q = $('#q');
    if (q) {
      q.addEventListener('input', debounce(() => {
        // Поле вже перемальовано (перейшли на інший екран, поки йшла затримка):
        // його текст — пошук того екрана, а не цього.
        if (!q.isConnected) return;
        // Фокус повертається в поле лише тоді, коли людина з нього не пішла:
        // Ctrl+K одразу після набору відкривав палітру, а за 200 мс фокус
        // повертався в пошук — далі текст ішов не туди, і Esc палітру не закривав.
        const had = document.activeElement === q;
        const pos = q.selectionStart;
        state.q = q.value;
        render();
        const nq = $('#q');
        if (nq && had && !$('#palette')) { nq.focus(); nq.setSelectionRange(pos, pos); }
      }, 200));
    }
    // Другий ярус шапки книги має прилипати рівно під першим, а висота першого
    // залежить від того, скільки рядків займуть назви ТМЦ. Міряємо, не вгадуємо.
    const top = $('.jr__head--top');
    if (top) top.parentElement.style.setProperty('--jr-top-h', top.offsetHeight + 'px');
    bindSelect('#f-group', (v) => { state.group = v; });
    bindSelect('#f-asset', (v) => { state.assetF = v; });
    bindSelect('#f-holder', (v) => { state.subHolder = v; });
    bindSelect('#f-sub', (v) => { state.sub = v; });
    bindSelect('#f-fes', (v) => { state.movesFes = v; });
    if (state.view === 'form2' || state.view === 'item') bindForm2Fields($('#scroll'));
    // Статус ФЕС у картці документа.
    $('#scroll').querySelectorAll('[data-fes]').forEach((el) => el.addEventListener('change', () => {
      fesSet(el.dataset.doc, { [el.dataset.fes]: el.value.trim() });
      renderAfterField(el);
    }));
    // Забезпеченість: дата, особи, доби — у шапці екрана.
    document.querySelectorAll('#head [data-sp]').forEach((el) => el.addEventListener('change', () => {
      if (datePartial(el)) return;
      const val = el.value.trim();
      state[el.dataset.sp] = el.dataset.sp === 'spDay' ? val : /^\d{1,5}$/.test(val) && Number(val) > 0 ? String(Number(val)) : '';
      renderAfterField(el);
    }));
    $('#scroll').querySelectorAll('[data-dmeta]').forEach((el) => el.addEventListener('change', () => {
      docMetaSet(el.dataset.doc, { [el.dataset.dmeta]: el.value.trim() });
      renderAfterField(el);
    }));
    $('#scroll').querySelectorAll('[data-lx]').forEach((el) => el.addEventListener('change', () => {
      if (datePartial(el)) return;
      lineExtraSet(el.dataset.doc, el.dataset.key, { [el.dataset.lx]: el.value.trim() });
      renderAfterField(el);
    }));
    // Описи 572: конфіг частини; перемальовує через такт (renderAfterField), як решта полів: у `change` курсор ще в дорозі.
    $('#scroll').querySelectorAll('[data-ov]').forEach((el) => el.addEventListener('change', () => {
      state.ovConfig = el.value.trim();
      renderAfterField(el);
    }));
    bindRegistry($('#scroll'));
    bindSelect('#mf-from', (v) => { state.movesFrom = v; state.movesLimit = 200; });
    bindSelect('#mf-to', (v) => { state.movesTo = v; state.movesLimit = 200; });
    // Код позиції — рядок, а не число: у базі це текстове поле, і серед кодів
    // трапляються такі, що з нуля починаються. Приведення до числа тихо ламало
    // пошук по `itemBy`, і журнал показував не ту позицію, що обрана у списку.
    bindCombo('#cb-j47', j47Options, (v) => { state.j47code = String(v); render(); }, 'Позиції з рухом');
    bindCombo('#cb-j14', j14Options, (v) => { state.j14sub = v; state.j14page = 1; render(); }, 'Підрозділи з рухом');
    $('#doc-form')?.addEventListener('submit', submitDoc);
    $('#item-form')?.addEventListener('submit', submitItem);
    bindNormPick();
    bindEllipsis();
    bindGlossary();
    bindScanDrop();
    bindRecon();
    bindSubst();
    bindDirs();
    bindPeople();
    bindStocktake();
    bindMtz();
    bindPurchases();
    bindPapers();
    bindActs();
    bindDraftFields();
    $('#scroll').querySelectorAll('[data-norm]').forEach((el) => {
      el.addEventListener('change', () => {
        const scope = state.sub || rootName();
        const v = parseFloat(String(el.value).replace(',', '.'));
        // Норма пишеться на звітну дату: попередній строк лишається за
        // попередніми документами й розрахунками.
        normSet({ sub: scope, code: el.dataset.norm }, v > 0 ? v : 0, state.asOf);
        save();
        // Потреба форми 21/Прод складається з рядків, а код без рядка у форму не потрапляє.
        if (v > 0 && !inForm21(el.dataset.norm)) {
          toast(`Код ${el.dataset.norm} не прив’язано до рядка форми 21/Прод: у потребу форми ця норма не піде. `
            + 'Прив’яжіть код: «Усі позиції форми» → рядок → «+ код служби».', true);
        }
        // Перемальовуємо після того, як фокус уже перейшов (Tab чи клац у сусіднє
        // поле), і повертаємо його в те саме поле нової таблиці.
        setTimeout(() => {
          const a = document.activeElement;
          const next = a && a.matches && a.matches('.norm') ? a.dataset.norm : null;
          render();
          if (next) { const n = $(`.norm[data-norm="${next}"]`); if (n) { n.focus(); n.select(); } }
        }, 0);
      });
    });
  }

  /** Обрізаний текст у комірці — повний у підказці. Колонки ширшими не робимо:
   *  довге найменування чи посада мають читатися на наведення, а не розсувати
   *  таблицю. Обрізання визначаємо по факту, після розкладки. */
  function bindEllipsis() {
    const scope = $('#scroll');
    if (!scope) return;
    // Текст вкладених елементів — через пробіл: «15» і «витяг із наказу».
    const textOf = (el) => {
      const parts = [];
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) { const t = walk.currentNode.nodeValue.trim(); if (t) parts.push(t); }
      return parts.join(' ');
    };
    // Своя підказка, в якій уже є всі слова комірки, лишається як є; інакше
    // повний текст стає перед нею.
    const covers = (title, text) => text.replace(/📎\d*/gu, ' ').split(/\s+/)
      .filter((w) => /[\p{L}\p{N}]/u.test(w)).every((w) => title.includes(w));
    let n = 0;
    for (const el of scope.querySelectorAll('.c-name b, .c-name small, .c-txt, .c-code, .tile__hint, .spec__v')) {
      if (n++ > 900) break;                  // довгі стрічки далі не міряємо
      if (el.querySelector('input, select, button')) continue;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      const text = textOf(el);
      if (!el.title) el.title = text;
      else if (!covers(el.title, text)) el.title = `${text} · ${el.title}`;
    }
  }

  /** Проставляє підказки до скорочень скрізь, де вони трапляються: заголовки
   *  колонок, підписи, назви підрозділів. Те, що вже має свій `title`, не
   *  чіпаємо — там пояснення конкретніше. */
  function bindGlossary() {
    const scope = $('#scroll');
    if (!scope) return;
    const sel = '.tbl__h, .card__title, .chip__label, .spec__k, label, .seg button,'
      + ' .c-name b, .c-name small, .c-txt, .att__text, .panel__note b,'
      + ' .tile__label, .tile__hint';
    let n = 0;
    for (const el of scope.querySelectorAll(sel)) {
      if (n++ > 400) break;                  // довгі стрічки не обходимо цілком
      if (el.querySelector('input, select')) continue;
      const text = el.textContent.trim();
      if (!text || text.length > 70) continue;
      const hint = hintFor(text);
      if (!hint) continue;
      // Комірка вже несе повний текст (бо обрізана) — скорочення дописуємо поруч.
      el.title = el.title && el.title !== hint ? `${el.title} · ${hint}` : hint;
    }
  }

  function bindSelect(sel, fn) {
    const el = $(sel);
    if (el) el.addEventListener('change', () => { fn(el.value); render(); });
  }

  function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
