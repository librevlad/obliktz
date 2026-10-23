// Облік ТЗ ПС · сторінка · запуск.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // -------------------------------------------------------------------- запуск
  async function boot() {
    if (!D || (D.meta || {}).broken) return;          // база не читається: на екрані вже dataBroken
    await loadState();
    normalizeStore();
    const syncPack = syncTake();
    const after = afterTake();
    peopleInit();
    Object.assign(state, {
      accent: store.ui.accent || state.accent,
      density: store.ui.density || state.density,
      textSize: store.ui.textSize || 'normal',
      wrap: !!store.ui.wrap,
    });
    // Чернетки, відкладені в попередньому сеансі: keepDrafts їх записує в
    // store.ui, а тут вони повертаються — без цього вони «зберігалися», але
    // після перезапуску їх ніхто не показував.
    if (store.ui.drafts && typeof store.ui.drafts === 'object') {
      state.drafts = restoreDrafts(store.ui.drafts);
      draftsSaved = JSON.stringify(state.drafts);
    }
    mergeOwnItems();
    syncStart(syncPack);
    ledger = buildLedger();
    docs = buildDocs();
    applyPrices();
    allocateLots();
    if (native) document.body.classList.add('is-native');
    if (me.remote) document.body.classList.add('is-remote');
    // Відомість МТЗ: перший місяць, за поданням якого стежить програма, запам'ятовується одразу —
    // інакше після строку він зсунувся б на наступний, і прострочене подання зникло б із контролю.
    if (mtzInit() && !stateBroken) save();
    checkFiles();                              // тихо: результат з'явиться в «Потребує уваги»
    // Незавершені документи з минулого разу — назад у форму.
    const kept = store.ui.drafts || {};
    draftsSaved = JSON.stringify(kept);                // що записано: розбіжність із відновленим (старий запис) перепишеться першим keepDrafts
    state.drafts = restoreDrafts(kept);
    const nKept = Object.keys(state.drafts).length;
    window.addEventListener('beforeunload', (e) => {
      // Чернетка, що чекає на таймер, теж має піти в базу перед закриттям.
      if (sync.leaving) return;               // вікно саме оновлюється: правки відкладено
      clearTimeout(draftTimer);
      keepDrafts();
      if (stateConflict || (!saving.dirty && !saving.busy && !saving.failed)) return;
      flush();
      e.preventDefault();
      e.returnValue = '';
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && saving.dirty) flush();
    });
    syncWatch();
    $('#side-role').textContent = `${unitInfo().legalName}`;
    $('#unit-name').textContent =
      `ТЗ ПС — облік технічних засобів продовольчої служби · ${unitInfo().legalName}`;
    const dateInput = $('#as-of');
    dateInput.value = state.asOf;
    dateInput.addEventListener('change', () => {
      state.asOf = dateInput.value || today();
      dateInput.value = state.asOf;         // порожнє поле не має приховувати дату розрахунку
      balCache.key = null;
      render();
    });
    bindGlobal();
    applyTheme();
    try { history.replaceState(navSnap(), ''); } catch (e) { /* ignore */ }
    window.addEventListener('popstate', (e) => {
      if (!e.state || !e.state.view) return;
      pickClose();
      const { idx, ...snap } = e.state;
      Object.assign(state, snap);
      state.restoreScroll = true;
      render();
    });
    render();
    if (stateBroken) {
      saveBar(`База обліку не читається (${stateBroken}), зміни не записуються. `
        + 'Відновіть дані з копії: «Налаштування» → «Автоматичні копії…».');
    } else if (sync.note) {
      toast(sync.note);
    } else if (nKept && !sync.fresh && !after) {
      const list = Object.values(state.drafts);       // вид і книга — з чернетки: ключ комірки («in@ОП») видом документа не є
      const kinds = list.map((v) => v.kind);
      state.moveKind = kinds.includes(state.moveKind) ? state.moveKind : kinds[0];
      toast(`Відновлено незавершен${nKept > 1 ? 'і чернетки' : 'у чернетку'} `
        + `${draftsWord(list)}. Відкрийте «+ Новий документ».`);
    }
    if (after && !stateBroken) afterShow(after);
    if (syncPack && syncPack.act && !stateBroken) actRestore(syncPack.act);
    if (syncPack && syncPack.sp && !stateBroken) spRestore(syncPack.sp);
  }

  // Екрани за виглядом. Модулі екранів уже завантажені (цей — останній), тож посилання прямі.
  const app = {
    dash: renderDash, nomen: renderNomen, subs: renderSubs, supply: renderSupply,
    inv: renderInventory,
    item: renderItem, doc: renderDoc, moves: renderMoves, j14: renderJ14, j47: renderJ47,
    destroyed: renderDestroyed, recon: renderRecon, subst: renderSubst,
    stocktake: renderStocktake, people: renderPeople, sub: renderSubCard, mtz: renderMtz,
    purch: renderPurchases, purbud: renderBudget, purdocs: renderPurDocs, val: () => renderPapers('valuation'), yats: () => renderPapers('tech_act'),
    settings: renderSettings, form2: renderForm2, form11: renderForm11, opysy: renderOpysy, acts: renderActs,
    spsupply: renderSpSupply,
  };

  document.addEventListener('DOMContentLoaded', boot);
