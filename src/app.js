/* 화면 연결 (PRD 5~6절 사용자 흐름과 화면 요구사항) */
(function (global) {
  'use strict';

  var doc = global.document;
  var Catalog = global.BibimCatalog;
  var Storage = global.BibimStorage;
  var Loc = global.BibimLocation;
  var Photo = global.BibimPhoto;
  var MapMod = global.BibimMap;
  var Exp = global.BibimExport;
  var Identify = global.BibimIdentify;

  var state = {
    survey: null,
    observations: [],
    mapView: null,
    mapTried: false,
    filters: { category: 'all', status: 'all' },
    lensOpened: false,
    saving: false,
    quick: { count: 0 },
    draft: newDraft(),
    objectUrls: []
  };

  function newDraft() {
    return {
      editingId: null,
      createdAt: null,
      enteredName: '',
      plant: null,
      acceptedUnknown: false,
      photos: [],
      originalPhotoIds: [],
      fix: null,
      note: '',
      categorySnapshotOverride: null,
      idMethod: null          // 'photo-api' 면 Pl@ntNet 결과에서 고른 이름이다.
    };
  }

  /* ── 작은 도우미 ────────────────────────────────────────────── */

  function $(id) { return doc.getElementById(id); }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setStatus(id, message, kind) {
    var node = $(id);
    if (!node) return;
    node.textContent = message || '';
    node.className = 'status' + (kind ? ' is-' + kind : '');
  }

  var toastTimer = null;
  function toast(message, isError) {
    var node = $('toast');
    node.textContent = message;
    node.className = 'toast' + (isError ? ' is-error' : '');
    node.hidden = false;
    if (toastTimer) global.clearTimeout(toastTimer);
    toastTimer = global.setTimeout(function () { node.hidden = true; }, 3600);
  }

  /** 버튼이 여러 개인 확인 대화상자. 중복 기록 확인 등에 쓴다. */
  function askDialog(title, body, actions) {
    return new Promise(function (resolve) {
      var backdrop = $('dialog-backdrop');
      $('dialog-title').textContent = title;
      $('dialog-body').textContent = body;
      var holder = $('dialog-actions');
      holder.innerHTML = '';
      actions.forEach(function (action, index) {
        var btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'btn' + (index === 0 ? ' btn--primary' : '') + (action.danger ? ' btn--danger' : '');
        btn.textContent = action.label;
        btn.addEventListener('click', function () {
          backdrop.hidden = true;
          resolve(action.value);
        });
        holder.appendChild(btn);
      });
      backdrop.hidden = false;
      var first = holder.querySelector('button');
      if (first) first.focus();
    });
  }

  function trackUrl(url) {
    state.objectUrls.push(url);
    return url;
  }

  function releaseUrls() {
    state.objectUrls.forEach(function (url) {
      try { global.URL.revokeObjectURL(url); } catch (err) { void err; }
    });
    state.objectUrls = [];
  }

  function toneClass(tone) { return 'badge badge--' + tone; }

  function categoryBadge(category) {
    var meta = Catalog.categoryMeta(category);
    return '<span class="' + toneClass(meta.tone) + '">' + meta.icon + ' ' + esc(meta.label) + '</span>';
  }

  /* ── 탭 ─────────────────────────────────────────────────────── */

  function setupTabs() {
    var tabs = Array.prototype.slice.call(doc.querySelectorAll('.tab'));
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (other) {
          var panel = $(other.getAttribute('data-panel'));
          var active = other === tab;
          other.classList.toggle('is-active', active);
          other.setAttribute('aria-selected', active ? 'true' : 'false');
          if (panel) panel.hidden = !active;
        });
        if (tab.getAttribute('data-panel') === 'panel-map') onMapTabShown();
        if (tab.getAttribute('data-panel') === 'panel-results') renderResults();
      });
    });
  }

  function goToTab(panelId) {
    var tab = doc.querySelector('.tab[data-panel="' + panelId + '"]');
    if (tab) tab.click();
  }

  /* ── 렌즈 안내 (FR-01) ──────────────────────────────────────── */

  function platformName() {
    var ua = global.navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    return 'other';
  }

  function setupLens() {
    var os = platformName();
    var osText = {
      android: 'Android: Google 앱 또는 Chrome 검색창의 렌즈 아이콘을 사용한다.',
      ios: 'iPhone: Google 앱의 렌즈 아이콘을 사용한다. Safari에서는 Google 앱이 따로 필요하다.',
      other: '데스크톱: lens.google.com에서 사진을 올려 확인한다.'
    }[os];
    $('lens-help-os').textContent = osText;

    $('btn-open-lens').addEventListener('click', function () {
      state.lensOpened = true;
      var win = global.open('https://lens.google.com/', '_blank', 'noopener');
      if (!win) {
        $('lens-help').hidden = false;
        $('btn-lens-help').setAttribute('aria-expanded', 'true');
        toast('새 창이 막혔습니다. 아래 수동 실행 안내를 따라 주세요.', true);
      } else {
        toast('렌즈에서 이름을 확인한 뒤 이 화면으로 돌아와 이름을 입력하세요.');
      }
    });

    $('btn-lens-help').addEventListener('click', function () {
      var help = $('lens-help');
      help.hidden = !help.hidden;
      this.setAttribute('aria-expanded', help.hidden ? 'false' : 'true');
    });
  }

  /* ── 이름 검색과 판정 (FR-02/FR-03) ────────────────────────── */

  function setupNameSearch() {
    var input = $('name-input');
    var debounce = null;
    input.addEventListener('input', function () {
      if (debounce) global.clearTimeout(debounce);
      debounce = global.setTimeout(renderCandidates, 180);
    });
    $('btn-search-name').addEventListener('click', renderCandidates);
    $('btn-clear-name').addEventListener('click', function () {
      input.value = '';
      state.draft.plant = null;
      state.draft.enteredName = '';
      state.draft.acceptedUnknown = false;
      state.draft.categorySnapshotOverride = null;
      state.quick.count = 0;
      $('candidate-list').innerHTML = '';
      $('name-hint').textContent = '';
      $('verdict-card').hidden = true;
      $('quick-card').hidden = true;
      clearPersistedDraft();
      refreshSaveState();
    });

    // 렌즈에서 복사해 온 이름을 한 번에 넣는다. 길게 눌러 붙여넣기보다 장갑 낀 손에 쉽다.
    $('btn-paste-name').addEventListener('click', function () {
      var clip = global.navigator.clipboard;
      if (!clip || !clip.readText) {
        $('name-hint').textContent = '이 브라우저는 붙여넣기 버튼을 지원하지 않는다. 입력칸을 길게 눌러 붙여 넣는다.';
        return;
      }
      clip.readText().then(function (text) {
        var value = String(text || '').trim().split(/\r?\n/)[0].slice(0, 80);
        if (!value) {
          $('name-hint').textContent = '복사된 글자가 없다.';
          return;
        }
        input.value = value;
        state.draft.enteredName = value;
        renderCandidates();
      }).catch(function () {
        $('name-hint').textContent = '붙여넣기가 거부되었다. 입력칸을 길게 눌러 붙여 넣는다.';
      });
    });
    $('candidate-list').addEventListener('click', function (event) {
      var apiBtn = event.target.closest('button[data-api-index]');
      if (apiBtn) {
        selectApiCandidate(parseInt(apiBtn.getAttribute('data-api-index'), 10));
        return;
      }
      var btn = event.target.closest('button[data-plant-id]');
      if (!btn) return;
      var id = btn.getAttribute('data-plant-id');
      if (id === '__unknown__') acceptUnknownName();
      else selectPlant(id);
    });
  }

  function renderCandidates() {
    var query = $('name-input').value.trim();
    var list = $('candidate-list');
    state.draft.enteredName = query;
    if (!query) {
      list.innerHTML = '';
      $('name-hint').textContent = '';
      return;
    }
    var results = Catalog.search(query, 8);
    var html = results.map(function (hit) {
      var verdict = Catalog.decide(hit.plant);
      var meta = [hit.plant.scientificName, (hit.plant.aliases || []).join(', ')]
        .filter(Boolean).join(' · ');
      return '<li><button type="button" class="candidate" data-plant-id="' + esc(hit.plant.id) + '">' +
        '<span class="candidate__name">' + esc(hit.plant.nameKo) + ' ' +
        '<span class="' + toneClass(verdict.meta.tone) + '">' + verdict.meta.icon + ' ' + esc(verdict.meta.short) + '</span></span>' +
        '<span class="candidate__meta">' + esc(meta) + '</span>' +
        '</button></li>';
    });

    html.push('<li><button type="button" class="candidate" data-plant-id="__unknown__">' +
      '<span class="candidate__name">목록에 없는 이름으로 기록 ' +
      '<span class="badge badge--purple">■ 확인 필요</span></span>' +
      '<span class="candidate__meta">입력한 "' + esc(query) + '"을(를) 그대로 남기고 교사 검토 대상으로 표시한다</span>' +
      '</button></li>');

    list.innerHTML = html.join('');
    $('name-hint').textContent = results.length
      ? '후보 ' + results.length + '건. 하나를 눌러 이름을 확정한다.'
      : '도감에서 찾지 못했다. 토종으로 자동 처리하지 않고 확인 필요로 기록할 수 있다.';
  }

  function selectPlant(plantId, method) {
    var plant = Catalog.getById(plantId);
    if (!plant) return;
    state.draft.plant = plant;
    state.draft.acceptedUnknown = false;
    state.draft.categorySnapshotOverride = null;
    state.draft.idMethod = method || null;
    state.quick.count = 0;
    $('name-input').value = plant.nameKo;
    state.draft.enteredName = state.draft.enteredName || plant.nameKo;
    $('candidate-list').innerHTML = '';
    $('name-hint').textContent = '이름을 "' + plant.nameKo + '"으로 확정했다.';
    renderVerdict();
    persistDraft();
    refreshSaveState();
  }

  function acceptUnknownName() {
    var query = $('name-input').value.trim();
    if (!query) { toast('이름을 먼저 입력해 주세요.', true); return; }
    state.draft.plant = null;
    state.draft.acceptedUnknown = true;
    state.draft.enteredName = query;
    state.quick.count = 0;
    $('candidate-list').innerHTML = '';
    $('name-hint').textContent = '"' + query + '"을(를) 확인 필요로 기록한다.';
    renderVerdict();
    persistDraft();
    refreshSaveState();
  }

  /* ── 사진 자동 식별 (Pl@ntNet) ──────────────────────────────
   * 사진을 외부 서버로 보내는 동작이므로 반드시 버튼을 눌렀을 때만 실행한다.
   * 결과는 후보일 뿐이고, 이름 확정은 2단계에서 학생이 직접 한다.
   */

  function setupIdentify() {
    var select = $('organ-select');
    select.innerHTML = Identify.ORGANS.map(function (organ) {
      return '<option value="' + esc(organ.id) + '">' + esc(organ.label) + '</option>';
    }).join('');

    $('btn-identify-photo').addEventListener('click', function () {
      var btn = this;
      if (btn.disabled) return;
      if (!Identify.isConfigured()) {
        setStatus('identify-status', 'Pl@ntNet 키가 없습니다. 설정 탭에서 교사용 키를 넣어 주세요.', 'error');
        return;
      }
      if (!state.draft.photos.length) {
        setStatus('identify-status', '먼저 사진을 한 장 이상 첨부해 주세요.', 'error');
        return;
      }
      btn.disabled = true;
      btn.textContent = '식별하는 중...';
      setStatus('identify-status', '사진 ' + Math.min(state.draft.photos.length, Identify.MAX_IMAGES) +
        '장을 Pl@ntNet으로 보내는 중...', null);

      Identify.identify(state.draft.photos, select.value).then(function (result) {
        if (!result.candidates.length) {
          setStatus('identify-status', '후보를 찾지 못했습니다. 잎이나 꽃을 가까이에서 다시 찍어 보세요.', 'warn');
          return;
        }
        state.apiCandidates = result.candidates;
        renderApiCandidates(result);
        var quota = result.remaining == null ? '' : ' 오늘 남은 횟수 ' + result.remaining + '건.';
        setStatus('identify-status', '후보 ' + result.candidates.length + '건을 2단계에 올렸습니다.' + quota, 'ok');
        $('name-input').scrollIntoView({ block: 'center' });
      }).catch(function (err) {
        setStatus('identify-status', err.message, 'error');
      }).then(function () {
        btn.disabled = false;
        btn.textContent = '사진으로 이름 찾기';
      });
    });
  }

  function renderApiCandidates(result) {
    var html = result.candidates.map(function (hit, index) {
      var percent = Math.round(hit.score * 100);
      var weak = hit.score < Identify.LOW_SCORE;
      var name = hit.inCatalog ? hit.plant.nameKo : (hit.commonNames[0] || hit.scientificName);
      var badge = '<span class="' + toneClass(hit.meta.tone) + '">' + hit.meta.icon + ' ' + esc(hit.meta.short) + '</span>';
      var sub = [
        hit.scientificName,
        hit.inCatalog ? '도감에 있음' : '도감에 없음 · 확인 필요로 기록됨',
        '일치도 ' + percent + '%'
      ].filter(Boolean).join(' · ');
      return '<li><button type="button" class="candidate" data-api-index="' + index + '">' +
        '<span class="candidate__name">' + esc(name) + ' ' + badge +
        (weak ? ' <span class="badge badge--review">확신 낮음</span>' : '') + '</span>' +
        '<span class="candidate__meta">' + esc(sub) + '</span>' +
        '</button></li>';
    });
    html.push('<li><button type="button" class="candidate" data-plant-id="__unknown__">' +
      '<span class="candidate__name">모두 아니다 · 직접 입력 <span class="badge badge--purple">■ 확인 필요</span></span>' +
      '<span class="candidate__meta">위 칸에 이름을 적고 후보 찾기를 누른다</span>' +
      '</button></li>');

    $('candidate-list').innerHTML = html.join('');
    $('name-hint').textContent = '사진 식별 결과다. ' + Identify.ATTRIBUTION +
      '. 일치도는 참고값이며, 맞는 것을 학생이 골라 확정한다.';
  }

  function selectApiCandidate(index) {
    var hit = (state.apiCandidates || [])[index];
    if (!hit) return;
    if (hit.inCatalog) {
      state.draft.enteredName = hit.scientificName;
      selectPlant(hit.plant.id, 'photo-api');
      $('name-hint').textContent = '사진 식별로 "' + hit.plant.nameKo + '"을(를) 확정했다. ' +
        '일치도 ' + Math.round(hit.score * 100) + '%.';
      return;
    }
    // 도감에 없는 학명은 토종으로 단정하지 않는다. 확인 필요로 남긴다.
    var label = hit.commonNames[0] ? hit.commonNames[0] + ' (' + hit.scientificName + ')' : hit.scientificName;
    state.draft.plant = null;
    state.draft.acceptedUnknown = true;
    state.draft.enteredName = label;
    state.draft.categorySnapshotOverride = 'needs-check';
    state.draft.idMethod = 'photo-api';
    state.quick.count = 0;
    $('name-input').value = label;
    $('candidate-list').innerHTML = '';
    $('name-hint').textContent = '도감에 없는 종이다. 확인 필요로 기록하고 교사와 함께 확인한다.';
    renderVerdict();
    persistDraft();
    refreshSaveState();
  }

  function renderVerdict() {
    var card = $('verdict-card');
    var body = $('verdict-body');
    var plant = state.draft.plant;
    if (!plant && !state.draft.acceptedUnknown) {
      card.hidden = true;
      $('quick-card').hidden = true;
      return;
    }
    var verdict = Catalog.decide(plant);
    var rows = [];
    rows.push('<div class="verdict__row">' + categoryBadge(verdict.category) +
      (verdict.needsReview ? ' <span class="badge badge--review">도감 검토 필요</span>' : '') + '</div>');

    rows.push('<div class="verdict__row"><span class="verdict__label">확정 이름</span>' +
      esc(plant ? plant.nameKo : state.draft.enteredName) +
      (plant && plant.scientificName ? ' <em>(' + esc(plant.scientificName) + ')</em>' : '') + '</div>');

    rows.push('<div class="verdict__row"><span class="verdict__label">판정 근거</span>' + esc(verdict.reason) + '</div>');
    rows.push('<div class="verdict__row"><span class="verdict__label">추천 행동</span>' + esc(verdict.meta.action) + '</div>');

    if (plant && plant.description) {
      rows.push('<div class="verdict__row"><span class="verdict__label">특징</span>' + esc(plant.description) + '</div>');
    }
    if (plant && plant.lookAlikeNote) {
      rows.push('<div class="verdict__row"><span class="verdict__label">닮은 종 구별법</span>' + esc(plant.lookAlikeNote) + '</div>');
    }
    var similar = Catalog.lookAlikes(plant);
    if (similar.length) {
      rows.push('<div class="verdict__row"><span class="verdict__label">함께 확인할 종</span>' +
        similar.map(function (p) {
          var v = Catalog.decide(p);
          return esc(p.nameKo) + ' <span class="' + toneClass(v.meta.tone) + '">' + v.meta.icon + ' ' + esc(v.meta.short) + '</span>';
        }).join(' / ') + '</div>');
    }
    if (plant && plant.referenceImage) {
      rows.push('<div class="verdict__row"><span class="verdict__label">참고 그림</span>' +
        '<img class="verdict__photo" src="' + esc(plant.referenceImage) + '" alt="' + esc(plant.nameKo) + ' 참고 그림">' +
        '<p class="verdict__credit">' + esc(plant.imageCredit || '') + ' · ' + esc(plant.imageLicense || '') +
        ' · 식별 보조용이며 정답을 보장하지 않는다.</p></div>');
    }
    if (!plant) {
      rows.push('<div class="verdict__row"><span class="verdict__label">안내</span>' +
        '목록에 없는 이름은 자동으로 토종 처리하지 않는다. 교사·전문가 확인 후 분류를 고친다.</div>');
    }
    body.innerHTML = rows.join('');
    card.hidden = false;
    renderQuickCard();
  }

  /* ── 빠른 기록 ──────────────────────────────────────────────
   * 종을 한 번 고른 뒤에는 걸어다니며 버튼만 눌러 좌표를 잇따라 찍는다.
   * 가까운 곳에 같은 종이 이미 있으면 묻지 않고 건너뛴다.
   */

  function renderQuickCard() {
    var card = $('quick-card');
    var name = draftName();
    // 기록을 수정하는 중에는 숨긴다. 수정과 새 기록을 헷갈리지 않게 한다.
    if (!name || state.draft.editingId) { card.hidden = true; return; }
    card.hidden = false;
    $('quick-target').innerHTML = '지금 찍는 종: <strong>' + esc(name) + '</strong> ' +
      categoryBadge(draftCategory());
    $('quick-count').textContent = '이번 종 ' + state.quick.count + '건';
  }

  function setupQuickRecord() {
    $('btn-quick-record').addEventListener('click', function () {
      if (state.saving) return;
      var name = draftName();
      if (!name) {
        setStatus('quick-status', '식물 이름을 먼저 확정해 주세요.', 'error');
        return;
      }
      var btn = this;
      state.saving = true;
      btn.disabled = true;                // 연타로 두 건이 들어가지 않게 막는다.
      btn.textContent = '위치 측정 중...';
      setStatus('quick-status', '', null);
      refreshSaveState();

      Loc.acquire().then(function (fix) {
        var dupes = Loc.findNearbyDuplicates(fix, name, state.observations);
        if (dupes.length) {
          var gap = Math.round(Loc.distanceMeters(fix, { lat: dupes[0].lat, lng: dupes[0].lng }));
          var radius = Math.round(Loc.effectiveDuplicateRadius(fix));
          setStatus('quick-status',
            '건너뜀: 같은 종 기록이 약 ' + gap + 'm 거리에 이미 있습니다. 적용 반경 ' + radius + 'm' +
            (typeof fix.accuracyMeters === 'number' ? ' (이번 정확도 약 ' + fix.accuracyMeters + 'm)' : '') + '.',
            'warn');
          toast('이미 기록한 자리입니다');
          return null;
        }
        var observation = composeObservation(name, fix, { id: Photo.uuid() });
        return Storage.saveObservation(observation, []).then(function () {
          return Storage.listObservations();
        }).then(function (rows) {
          if (!rows.some(function (o) { return o.id === observation.id; })) {
            throw new Error('저장한 기록을 다시 읽지 못했습니다.');
          }
          state.observations = rows;
          state.quick.count += 1;
          persistDraft();
          renderAll();
          renderQuickCard();
          setStatus('quick-status',
            '기록했습니다. ' + fix.lat.toFixed(5) + ', ' + fix.lng.toFixed(5) +
            (typeof fix.accuracyMeters === 'number' ? ' · 정확도 약 ' + fix.accuracyMeters + 'm' : '') + '.',
            'ok');
          toast(name + ' ' + state.quick.count + '번째 기록');
          return observation;
        });
      }).catch(function (err) {
        var message = err && err.name === 'QuotaExceededError'
          ? err.message
          : (err && err.message ? err.message : '기록하지 못했습니다.');
        setStatus('quick-status', message, 'error');
        toast('기록 실패', true);
      }).then(function () {
        state.saving = false;
        btn.disabled = false;
        btn.textContent = '여기 있다 · 좌표 찍기';
        refreshSaveState();
      });
    });
  }

  /* ── 초안 유지 ──────────────────────────────────────────────
   * 렌즈를 쓰러 앱을 벗어났다 돌아와도 고른 종과 메모가 남아야 한다.
   * 사진은 용량이 커서 담지 않고, 좌표는 오래되면 위험하므로 되살리지 않는다.
   */

  var DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

  function persistDraft() {
    if (state.draft.editingId) return;      // 기록 수정 중에는 초안을 덮어쓰지 않는다.
    Storage.setSetting('draftState', {
      plantId: state.draft.plant ? state.draft.plant.id : null,
      enteredName: state.draft.enteredName,
      acceptedUnknown: state.draft.acceptedUnknown,
      categorySnapshotOverride: state.draft.categorySnapshotOverride,
      note: $('note-input').value,
      quickCount: state.quick.count,
      savedAt: new Date().toISOString()
    });
  }

  function clearPersistedDraft() {
    Storage.removeSetting('draftState');
  }

  function restoreDraft() {
    var saved = Storage.getSetting('draftState', null);
    if (!saved) return false;
    var age = Date.now() - new Date(saved.savedAt || 0).getTime();
    if (!isFinite(age) || age > DRAFT_MAX_AGE_MS) {
      clearPersistedDraft();
      return false;
    }
    if (saved.plantId) {
      var plant = Catalog.getById(saved.plantId);
      if (!plant) { clearPersistedDraft(); return false; }
      state.draft.plant = plant;
      $('name-input').value = plant.nameKo;
    } else if (saved.acceptedUnknown && saved.enteredName) {
      state.draft.acceptedUnknown = true;
      state.draft.categorySnapshotOverride = saved.categorySnapshotOverride || 'needs-check';
      $('name-input').value = saved.enteredName;
    } else {
      return false;
    }
    state.draft.enteredName = saved.enteredName || '';
    state.draft.note = saved.note || '';
    $('note-input').value = saved.note || '';
    state.quick.count = saved.quickCount || 0;
    renderVerdict();
    refreshSaveState();
    $('name-hint').textContent = '앱을 벗어나기 전에 고른 식물을 그대로 불러왔다. 위치는 다시 측정한다.';
    return true;
  }

  function composeObservation(name, fix, opts) {
    var now = new Date().toISOString();
    var plant = state.draft.plant;
    return {
      id: opts.id,
      surveyId: state.survey.id,
      plantId: plant ? plant.id : null,
      enteredName: state.draft.enteredName || name,
      confirmedName: name,
      categorySnapshot: draftCategory(),
      catalogVersion: Catalog.catalogVersion(),
      identificationMethod: state.draft.idMethod || (state.lensOpened ? 'lens-manual' : 'manual'),
      verificationStatus: plant ? plant.verificationStatus : 'needs-review',
      lat: fix.lat,
      lng: fix.lng,
      accuracyMeters: typeof fix.accuracyMeters === 'number' ? fix.accuracyMeters : null,
      locationSource: fix.locationSource,
      locationCapturedAt: fix.locationCapturedAt,
      photoIds: opts.photoIds || [],
      note: opts.note || '',
      createdAt: opts.createdAt || now,
      updatedAt: now,
      removalStatus: opts.removalStatus || 'unresolved',
      removedAt: opts.removedAt || null
    };
  }

  /* ── 사진 ───────────────────────────────────────────────────── */

  function setupPhotos() {
    $('photo-input').addEventListener('change', function (event) {
      var files = Array.prototype.slice.call(event.target.files || []);
      if (!files.length) return;
      setStatus('photo-hint', '사진을 줄이는 중...', null);
      var chain = Promise.resolve();
      var failures = [];
      files.forEach(function (file) {
        chain = chain.then(function () {
          return Photo.prepare(file, state.draft.editingId || 'draft')
            .then(function (photo) { state.draft.photos.push(photo); })
            .catch(function (err) { failures.push(file.name + ': ' + err.message); });
        });
      });
      chain.then(function () {
        event.target.value = '';
        renderThumbs();
        if (failures.length) {
          setStatus('photo-hint', '일부 사진을 첨부하지 못했습니다. ' + failures.join(' / '), 'error');
        } else {
          setStatus('photo-hint', '사진 ' + state.draft.photos.length + '장 준비. 저장을 눌러야 기기에 남는다.', 'ok');
        }
      });
    });

    $('photo-thumbs').addEventListener('click', function (event) {
      var btn = event.target.closest('button[data-photo-id]');
      if (!btn) return;
      var id = btn.getAttribute('data-photo-id');
      state.draft.photos = state.draft.photos.filter(function (p) { return p.id !== id; });
      renderThumbs();
    });
  }

  function renderThumbs() {
    var holder = $('photo-thumbs');
    holder.innerHTML = state.draft.photos.map(function (photo) {
      var url = trackUrl(Photo.objectUrl(photo));
      return '<div class="thumb"><img src="' + esc(url) + '" alt="첨부한 현장 사진">' +
        '<button type="button" data-photo-id="' + esc(photo.id) + '" aria-label="이 사진 빼기">×</button></div>';
    }).join('');
    refreshSaveState();
  }

  /* ── 위치 (FR-04) ──────────────────────────────────────────── */

  function setupLocation() {
    $('btn-get-location').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = '위치 측정 중...';
      setStatus('save-status', '', null);
      Loc.acquire().then(function (fix) {
        state.draft.fix = fix;
        renderFix();
        if (state.mapView) state.mapView.setCurrentPosition(fix);
      }).catch(function (err) {
        state.draft.fix = state.draft.fix || null;
        renderFix(err.message);
        if (err.kind === 'denied') {
          $('manual-coord-details').open = true;
        }
      }).then(function () {
        btn.disabled = false;
        btn.textContent = '조사 시작 · 위치 측정';
      });
    });

    $('btn-manual-location').addEventListener('click', function () {
      goToTab('panel-map');
      if (state.mapView) {
        state.mapView.setPickMode(true);
        $('btn-map-pick').setAttribute('aria-pressed', 'true');
      }
      setStatus('map-status', '지도를 눌러 위치를 고르면 조사 화면으로 돌아갑니다. 지도를 쓸 수 없으면 조사 화면의 좌표 직접 입력을 사용하세요.', 'warn');
    });

    $('btn-demo-location').addEventListener('click', function () {
      askDialog(
        '실내 시연 좌표를 쓸까요?',
        '시연 좌표로 저장한 기록은 모든 화면과 내보내기에서 "시연 기록"으로 표시됩니다. 실제 현장 GPS로 쓸 수 없습니다.',
        [{ label: '시연 좌표 사용', value: 'yes' }, { label: '취소', value: 'no' }]
      ).then(function (answer) {
        if (answer !== 'yes') return;
        state.draft.fix = Loc.demoFix();
        renderFix();
      });
    });

    $('btn-apply-manual-coord').addEventListener('click', function () {
      var lat = parseFloat($('manual-lat').value);
      var lng = parseFloat($('manual-lng').value);
      var fix = Loc.manualFix(lat, lng);
      if (!fix) {
        renderFix('좌표 범위를 확인해 주세요. 위도 -90~90, 경도 -180~180.');
        return;
      }
      state.draft.fix = fix;
      renderFix();
      if (state.mapView) state.mapView.setCurrentPosition(fix);
    });
  }

  function renderFix(errorMessage) {
    var box = $('fix-box');
    var fix = state.draft.fix;
    if (!fix) {
      box.innerHTML = '<p class="fix__empty">' +
        esc(errorMessage || '아직 위치를 측정하지 않았다.') + '</p>';
      refreshSaveState();
      return;
    }
    var review = Loc.review(fix);
    var parts = [];
    parts.push('<p class="fix__coord">' + fix.lat.toFixed(6) + ', ' + fix.lng.toFixed(6) + '</p>');
    parts.push('<p>출처: ' + esc(Loc.sourceLabel(fix.locationSource)) +
      (fix.locationSource === 'demo' ? ' <span class="badge badge--demo">시연 기록</span>' : '') + '</p>');
    parts.push('<p>정확도: ' + (typeof fix.accuracyMeters === 'number' ? '약 ' + fix.accuracyMeters + 'm' : '측정값 없음') + '</p>');
    parts.push('<p>획득 시각: ' + esc(Exp.formatDate(fix.locationCapturedAt)) + '</p>');
    review.warnings.forEach(function (w) {
      parts.push('<p class="fix__warn">주의: ' + esc(w) + '</p>');
    });
    if (errorMessage) parts.push('<p class="fix__warn">' + esc(errorMessage) + '</p>');
    box.innerHTML = parts.join('');
    refreshSaveState();
  }

  /* ── 저장 (FR-05) ──────────────────────────────────────────── */

  function draftName() {
    if (state.draft.plant) return state.draft.plant.nameKo;
    if (state.draft.acceptedUnknown) return state.draft.enteredName;
    return '';
  }

  function draftCategory() {
    if (state.draft.categorySnapshotOverride) return state.draft.categorySnapshotOverride;
    return Catalog.decide(state.draft.plant).category;
  }

  function refreshSaveState() {
    var btn = $('btn-save-observation');
    var name = draftName();
    var fix = state.draft.fix;
    var ready = !!name && !!fix && Loc.isValidCoord(fix.lat, fix.lng) && !state.saving;
    btn.disabled = !ready;
    btn.textContent = state.draft.editingId ? '기록 수정 저장' : '이 위치에 기록';

    var summary = $('save-summary');
    if (!name && !fix) {
      summary.innerHTML = '<p class="muted">이름을 확정하고 위치를 측정하면 저장할 수 있다.</p>';
      return;
    }
    var rows = [];
    rows.push('<dt>식물</dt><dd>' + (name ? esc(name) : '<span class="fix__warn">아직 확정하지 않음</span>') + '</dd>');
    rows.push('<dt>분류</dt><dd>' + (name ? categoryBadge(draftCategory()) : '-') + '</dd>');
    rows.push('<dt>좌표</dt><dd>' + (fix ? fix.lat.toFixed(6) + ', ' + fix.lng.toFixed(6) : '<span class="fix__warn">위치 확인이 필요하다</span>') + '</dd>');
    rows.push('<dt>좌표 출처</dt><dd>' + (fix ? esc(Loc.sourceLabel(fix.locationSource)) : '-') + '</dd>');
    rows.push('<dt>사진</dt><dd>' + state.draft.photos.length + '장</dd>');
    summary.innerHTML = '<dl>' + rows.join('') + '</dl>';
  }

  function setupSave() {
    $('note-input').addEventListener('input', function () {
      state.draft.note = this.value;
      persistDraft();
    });

    $('btn-save-observation').addEventListener('click', function () {
      if (state.saving) return;
      var name = draftName();
      var fix = state.draft.fix;
      if (!name) { setStatus('save-status', '식물 이름을 먼저 확정해 주세요.', 'error'); return; }
      if (!fix || !Loc.isValidCoord(fix.lat, fix.lng)) {
        setStatus('save-status', '좌표를 먼저 확인해 주세요. 위치 측정 또는 지도에서 직접 선택이 필요합니다.', 'error');
        return;
      }
      checkDuplicateThenSave(name, fix);
    });
  }

  function checkDuplicateThenSave(name, fix) {
    var others = state.observations.filter(function (o) { return o.id !== state.draft.editingId; });
    var dupes = Loc.findNearbyDuplicates(fix, name, others);
    if (!dupes.length) { performSave(name, fix); return; }
    var t = Loc.thresholds();
    askDialog(
      '같은 식물이 이미 기록되어 있습니다',
      '"' + name + '"이(가) 약 ' + t.duplicateRadiusM + 'm 안에 ' + dupes.length + '건 있습니다. 어떻게 할까요?',
      [
        { label: '새로 기록', value: 'new' },
        { label: '기존 기록 보기', value: 'open' },
        { label: '취소', value: 'cancel' }
      ]
    ).then(function (answer) {
      if (answer === 'new') performSave(name, fix);
      else if (answer === 'open') {
        goToTab('panel-map');
        showObservationDetail(dupes[0].id);
      }
    });
  }

  function performSave(name, fix) {
    state.saving = true;
    var btn = $('btn-save-observation');
    btn.disabled = true;                 // 연타로 이중 저장되지 않게 막는다.
    btn.textContent = '저장 중...';
    setStatus('save-status', '', null);

    var now = new Date().toISOString();
    var editing = state.draft.editingId;
    var id = editing || Photo.uuid();

    var photos = state.draft.photos.map(function (photo) {
      return {
        id: photo.id,
        observationId: id,
        blob: photo.blob,
        mimeType: photo.mimeType,
        width: photo.width,
        height: photo.height,
        createdAt: photo.createdAt
      };
    });

    var observation = composeObservation(name, fix, {
      id: id,
      photoIds: photos.map(function (p) { return p.id; }),
      note: $('note-input').value.trim(),
      createdAt: state.draft.createdAt || now,
      removalStatus: state.draft.removalStatus,
      removedAt: state.draft.removedAt
    });

    var removedPhotoIds = state.draft.originalPhotoIds.filter(function (pid) {
      return observation.photoIds.indexOf(pid) === -1;
    });

    Storage.saveObservation(observation, photos)
      .then(function () {
        return Promise.all(removedPhotoIds.map(function (pid) { return Storage.deletePhoto(pid); }));
      })
      .then(function () {
        return Storage.listObservations();
      })
      .then(function (rows) {
        // 저장이 끝난 뒤에만 성공을 알린다.
        var saved = rows.filter(function (o) { return o.id === id; })[0];
        if (!saved) throw new Error('저장한 기록을 다시 읽지 못했습니다.');
        state.observations = rows;
        resetDraft();
        renderAll();
        setStatus('save-status', editing ? '기록을 수정했습니다.' : '기록을 저장했습니다. 지도 탭에서 핀을 확인하세요.', 'ok');
        toast(editing ? '기록 수정 완료' : '기록 저장 완료');
      })
      .catch(function (err) {
        var message = err && err.name === 'QuotaExceededError'
          ? err.message + ' 사진 없이 다시 저장하거나 JSON 백업 후 기록을 정리해 주세요.'
          : '저장하지 못했습니다: ' + (err && err.message ? err.message : '알 수 없는 오류');
        setStatus('save-status', message, 'error');
        toast('저장 실패. 기록이 남지 않았습니다.', true);
      })
      .then(function () {
        state.saving = false;
        refreshSaveState();
      });
  }

  function resetDraft() {
    releaseUrls();
    state.draft = newDraft();
    state.quick.count = 0;
    clearPersistedDraft();
    $('name-input').value = '';
    $('note-input').value = '';
    $('candidate-list').innerHTML = '';
    $('name-hint').textContent = '';
    $('verdict-card').hidden = true;
    $('quick-card').hidden = true;
    $('photo-thumbs').innerHTML = '';
    setStatus('photo-hint', '', null);
    setStatus('quick-status', '', null);
    renderFix();
  }

  /* ── 지도 탭 ───────────────────────────────────────────────── */

  function setupMapTab() {
    state.mapView = MapMod.create({
      container: $('map-container'),
      colorOf: function (obs) {
        if (obs.removalStatus === 'removed') return MapMod.TONE_COLOR.gray;
        var meta = Catalog.categoryMeta(obs.categorySnapshot);
        return MapMod.TONE_COLOR[meta.tone] || MapMod.TONE_COLOR.gray;
      },
      labelOf: function (obs) {
        var meta = Catalog.categoryMeta(obs.categorySnapshot);
        return obs.confirmedName + ' · ' + meta.label +
          (obs.removalStatus === 'removed' ? ' · 제거 완료' : '') +
          (obs.locationSource === 'demo' ? ' · 시연 기록' : '');
      },
      onPickCoordinate: function (lat, lng) {
        var fix = Loc.manualFix(lat, lng);
        if (!fix) { toast('좌표 범위를 벗어났습니다.', true); return; }
        state.draft.fix = fix;
        state.mapView.setPickMode(false);
        $('btn-map-pick').setAttribute('aria-pressed', 'false');
        state.mapView.setCurrentPosition(fix);
        renderFix();
        goToTab('panel-survey');
        toast('지도에서 고른 위치를 조사 화면에 넣었습니다.');
      },
      onSelectObservation: showObservationDetail
    });

    $('btn-map-locate').addEventListener('click', function () {
      Loc.acquire().then(function (fix) {
        state.mapView.setCurrentPosition(fix);
        state.mapView.setFollow(true);
        $('btn-map-follow').setAttribute('aria-pressed', 'true');
        $('btn-map-follow').textContent = '따라가기 켬';
        state.mapView.focus(fix.lat, fix.lng, 17);
        setStatus('map-status', '현재 위치로 이동했습니다. 정확도 약 ' +
          (fix.accuracyMeters == null ? '측정값 없음' : fix.accuracyMeters + 'm') + '.', 'ok');
      }).catch(function (err) {
        setStatus('map-status', err.message, 'error');
      });
    });

    $('btn-map-follow').addEventListener('click', function () {
      var on = this.getAttribute('aria-pressed') !== 'true';
      this.setAttribute('aria-pressed', on ? 'true' : 'false');
      this.textContent = on ? '따라가기 켬' : '따라가기 끔';
      state.mapView.setFollow(on);
    });

    $('btn-map-pick').addEventListener('click', function () {
      var on = this.getAttribute('aria-pressed') !== 'true';
      this.setAttribute('aria-pressed', on ? 'true' : 'false');
      state.mapView.setPickMode(on);
      setStatus('map-status', on
        ? '지도를 눌러 좌표를 고르세요. Google 지도를 못 쓰는 경우 조사 화면의 좌표 직접 입력을 사용하세요.'
        : '좌표 지정 모드를 껐습니다.', on ? 'warn' : null);
    });

    $('map-filter-category').addEventListener('change', function () {
      state.filters.category = this.value;
      renderObservations();
    });
    $('map-filter-status').addEventListener('change', function () {
      state.filters.status = this.value;
      renderObservations();
    });

    $('obs-list').addEventListener('click', onObsListClick);
    $('obs-detail-body').addEventListener('click', onObsListClick);

    // 인터넷이 돌아오면 지도를 한 번 더 시도한다. 기록은 그동안에도 계속 쌓인다.
    global.addEventListener('online', function () {
      if (state.mapView.backend() !== 'fallback') return;
      setStatus('map-status', '인터넷이 돌아왔습니다. 지도를 다시 불러옵니다...', null);
      connectMap(Storage.getSetting('mapApiKey', ''), Storage.getSetting('mapId', ''));
    });
    global.addEventListener('offline', function () {
      if (state.mapView.backend() === 'fallback') return;
      setStatus('map-status', '인터넷이 끊겼습니다. 지도 그림은 멈추지만 GPS 기록은 그대로 됩니다.', 'warn');
    });
  }

  function onMapTabShown() {
    if (state.mapTried) return;
    state.mapTried = true;
    connectMap(Storage.getSetting('mapApiKey', ''), Storage.getSetting('mapId', ''));
  }

  /**
   * 키가 있으면 Google 지도, 없으면 OpenStreetMap으로 띄운다.
   * Google이 실패해도 OSM으로 내려가므로 지도 탭이 비는 일은 없다.
   */
  function connectMap(key, mapId) {
    setStatus('map-status', '지도를 불러오는 중...', null);
    return state.mapView.init(key, mapId).then(function (backend) {
      setStatus('map-status', backend === 'google'
        ? 'Google 지도에 연결했습니다.'
        : 'OpenStreetMap 지도를 쓰고 있습니다. API 키도 결제도 필요 없습니다.', 'ok');
      state.mapView.setObservations(filteredObservations());
      return true;
    }).catch(function (err) {
      var hints = (err.hints || []).map(function (h, i) { return (i + 1) + ') ' + h; }).join('  ');
      var detail = err.message + (hints ? ' 확인 순서: ' + hints : '');
      if (state.mapView.backend() === 'osm') {
        setStatus('map-status', 'Google 지도에 연결하지 못해 OpenStreetMap으로 표시합니다. ' + detail, 'warn');
      } else {
        setStatus('map-status', detail, 'error');
      }
      if (key) setStatus('key-status', detail, 'error');
      state.mapView.setObservations(filteredObservations());
      return false;
    });
  }

  function filteredObservations() {
    return state.observations.filter(function (obs) {
      if (state.filters.category !== 'all' && obs.categorySnapshot !== state.filters.category) return false;
      if (state.filters.status !== 'all' && obs.removalStatus !== state.filters.status) return false;
      return true;
    });
  }

  function renderObservations() {
    var rows = filteredObservations();
    $('obs-count').textContent = rows.length + '건 / 전체 ' + state.observations.length + '건';
    $('storage-badge').textContent = '기록 ' + state.observations.length + '건';
    if (state.mapView) state.mapView.setObservations(rows);

    if (!rows.length) {
      $('obs-list').innerHTML = '<li class="muted">조건에 맞는 기록이 없다.</li>';
      return;
    }
    $('obs-list').innerHTML = rows.map(function (obs) {
      return '<li class="obs-item" data-obs-row="' + esc(obs.id) + '">' + obsItemHtml(obs) + '</li>';
    }).join('');
  }

  function obsItemHtml(obs) {
    var removal = Catalog.REMOVAL_STATUS[obs.removalStatus] || { label: '미처리' };
    var meta = [
      Exp.formatDate(obs.createdAt),
      Loc.sourceLabel(obs.locationSource),
      obs.accuracyMeters == null ? '정확도 없음' : '약 ' + obs.accuracyMeters + 'm',
      obs.lat.toFixed(5) + ', ' + obs.lng.toFixed(5),
      '사진 ' + (obs.photoIds || []).length + '장'
    ].join(' · ');

    return '<div class="obs-item__head">' +
      '<span class="obs-item__name">' + esc(obs.confirmedName) + '</span>' +
      '<span>' + categoryBadge(obs.categorySnapshot) +
      (obs.removalStatus === 'removed' ? ' <span class="badge badge--gray">✓ 제거 완료</span>' : '') +
      (obs.removalStatus === 'reported' ? ' <span class="badge badge--gray">전달함</span>' : '') +
      (obs.locationSource === 'demo' ? ' <span class="badge badge--demo">시연 기록</span>' : '') +
      '</span></div>' +
      '<p class="obs-item__meta">' + esc(meta) + '</p>' +
      (obs.note ? '<p class="obs-item__meta">메모: ' + esc(obs.note) + '</p>' : '') +
      '<p class="obs-item__meta">처리 상태: ' + esc(removal.label) + '</p>' +
      '<div class="obs-item__actions">' +
      '<button type="button" class="btn" data-action="detail" data-id="' + esc(obs.id) + '">상세·사진</button>' +
      '<button type="button" class="btn" data-action="edit" data-id="' + esc(obs.id) + '">수정</button>' +
      '<button type="button" class="btn" data-action="status" data-id="' + esc(obs.id) + '">상태 변경</button>' +
      '<button type="button" class="btn" data-action="delete" data-id="' + esc(obs.id) + '">삭제</button>' +
      '</div>';
  }

  function onObsListClick(event) {
    var btn = event.target.closest('button[data-action]');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var action = btn.getAttribute('data-action');
    if (action === 'detail') showObservationDetail(id);
    else if (action === 'edit') startEdit(id);
    else if (action === 'status') changeStatus(id);
    else if (action === 'delete') confirmDelete(id);
    else if (action === 'focus') {
      var obs = findObs(id);
      if (obs && state.mapView) state.mapView.focus(obs.lat, obs.lng, 18);
    }
  }

  function findObs(id) {
    return state.observations.filter(function (o) { return o.id === id; })[0] || null;
  }

  function showObservationDetail(id) {
    var obs = findObs(id);
    var card = $('obs-detail-card');
    if (!obs) { card.hidden = true; return; }
    var plant = obs.plantId ? Catalog.getById(obs.plantId) : null;
    Storage.listPhotosFor(id).then(function (photos) {
      var photoHtml = photos.length
        ? '<div class="obs-photos">' + photos.map(function (p) {
          return '<img src="' + esc(trackUrl(Photo.objectUrl(p))) + '" alt="현장 사진">';
        }).join('') + '</div>'
        : '<p class="muted">저장된 사진이 없다.</p>';

      card.hidden = false;
      $('obs-detail-body').innerHTML =
        '<div class="obs-item__head"><span class="obs-item__name">' + esc(obs.confirmedName) + '</span>' +
        '<span>' + categoryBadge(obs.categorySnapshot) + '</span></div>' +
        '<p class="obs-item__meta">입력한 이름: ' + esc(obs.enteredName || '-') + '</p>' +
        (plant ? '<p class="obs-item__meta">학명: ' + esc(plant.scientificName || '-') + '</p>' : '') +
        '<p class="obs-item__meta">좌표: ' + obs.lat.toFixed(6) + ', ' + obs.lng.toFixed(6) +
        ' (' + esc(Loc.sourceLabel(obs.locationSource)) + ')</p>' +
        '<p class="obs-item__meta">획득 시각: ' + esc(Exp.formatDate(obs.locationCapturedAt)) + '</p>' +
        '<p class="obs-item__meta">기록 시각: ' + esc(Exp.formatDate(obs.createdAt)) + '</p>' +
        '<p class="obs-item__meta">식별 방법: ' + esc(obs.identificationMethod) +
        ' · 도감 버전 ' + esc(obs.catalogVersion || '-') + '</p>' +
        (obs.note ? '<p class="obs-item__meta">메모: ' + esc(obs.note) + '</p>' : '') +
        photoHtml +
        '<div class="obs-item__actions">' +
        '<button type="button" class="btn" data-action="focus" data-id="' + esc(obs.id) + '">지도에서 보기</button>' +
        // 휴대폰 Google 지도 앱으로 이 좌표를 넘긴다. API 키가 없어도 된다.
        '<a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=' +
        encodeURIComponent(obs.lat.toFixed(6) + ',' + obs.lng.toFixed(6)) + '">구글맵에서 열기</a>' +
        '<button type="button" class="btn" data-action="edit" data-id="' + esc(obs.id) + '">수정</button>' +
        '<button type="button" class="btn" data-action="status" data-id="' + esc(obs.id) + '">상태 변경</button>' +
        '<button type="button" class="btn" data-action="delete" data-id="' + esc(obs.id) + '">삭제</button>' +
        '</div>';
    }).catch(function (err) {
      card.hidden = false;
      $('obs-detail-body').innerHTML = '<p class="status is-error">사진을 읽지 못했습니다: ' + esc(err.message) + '</p>';
    });
  }

  function startEdit(id) {
    var obs = findObs(id);
    if (!obs) return;
    Storage.listPhotosFor(id).then(function (photos) {
      releaseUrls();
      state.draft = newDraft();
      state.draft.editingId = obs.id;
      state.draft.createdAt = obs.createdAt;
      state.draft.enteredName = obs.enteredName;
      state.draft.plant = obs.plantId ? Catalog.getById(obs.plantId) : null;
      state.draft.acceptedUnknown = !state.draft.plant;
      state.draft.categorySnapshotOverride = state.draft.plant ? null : obs.categorySnapshot;
      state.draft.photos = photos.slice();
      state.draft.originalPhotoIds = (obs.photoIds || []).slice();
      state.draft.fix = {
        lat: obs.lat,
        lng: obs.lng,
        accuracyMeters: obs.accuracyMeters,
        locationSource: obs.locationSource,
        locationCapturedAt: obs.locationCapturedAt
      };
      state.draft.note = obs.note || '';
      state.draft.removalStatus = obs.removalStatus;
      state.draft.removedAt = obs.removedAt;

      $('name-input').value = obs.confirmedName;
      $('note-input').value = obs.note || '';
      renderVerdict();
      renderThumbs();
      renderFix();
      goToTab('panel-survey');
      setStatus('save-status', '기록을 수정하는 중입니다. 저장을 누르면 같은 기록이 갱신됩니다.', 'warn');
    });
  }

  function changeStatus(id) {
    var obs = findObs(id);
    if (!obs) return;
    askDialog(
      '처리 상태 바꾸기',
      '"' + obs.confirmedName + '" 기록의 처리 상태를 고르세요. 처리 상태를 바꿔도 식물 분류는 그대로 남습니다.',
      [
        { label: '제거 완료', value: 'removed' },
        { label: '담당자에게 전달함', value: 'reported' },
        { label: '미처리로 되돌리기', value: 'unresolved' },
        { label: '취소', value: 'cancel' }
      ]
    ).then(function (answer) {
      if (!answer || answer === 'cancel') return;
      obs.removalStatus = answer;
      obs.removedAt = answer === 'removed' ? new Date().toISOString() : null;
      return Storage.updateObservation(obs).then(function () {
        return Storage.listObservations();
      }).then(function (rows) {
        state.observations = rows;
        renderAll();
        showObservationDetail(id);
        toast('처리 상태를 바꿨습니다.');
      }).catch(function (err) {
        toast('상태를 저장하지 못했습니다: ' + err.message, true);
      });
    });
  }

  function confirmDelete(id) {
    var obs = findObs(id);
    if (!obs) return;
    askDialog(
      '이 기록을 삭제할까요?',
      '"' + obs.confirmedName + '" (' + Exp.formatDate(obs.createdAt) + ') 기록과 첨부 사진이 함께 지워집니다. 되돌릴 수 없습니다.',
      [{ label: '취소', value: 'cancel' }, { label: '삭제', value: 'delete', danger: true }]
    ).then(function (answer) {
      if (answer !== 'delete') return;
      return Storage.deleteObservation(id).then(function () {
        return Storage.listObservations();
      }).then(function (rows) {
        state.observations = rows;
        $('obs-detail-card').hidden = true;
        renderAll();
        toast('기록을 삭제했습니다.');
      }).catch(function (err) {
        toast('삭제하지 못했습니다: ' + err.message, true);
      });
    });
  }

  /* ── 결과 탭 (FR-08) ───────────────────────────────────────── */

  function setupResults() {
    $('btn-save-survey').addEventListener('click', function () {
      state.survey.title = $('survey-title').value.trim();
      state.survey.placeLabel = $('survey-place').value.trim();
      Storage.saveSurvey(state.survey).then(function () {
        setStatus('survey-status', '조사 정보를 저장했습니다.', 'ok');
        renderResults();
      }).catch(function (err) {
        setStatus('survey-status', '저장하지 못했습니다: ' + err.message, 'error');
      });
    });

    $('btn-refresh-report').addEventListener('click', renderResults);

    $('btn-copy-report').addEventListener('click', function () {
      var text = $('report-text').value;
      var done = function () { setStatus('export-status', '보고문을 복사했습니다.', 'ok'); };
      if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
        global.navigator.clipboard.writeText(text).then(done).catch(function () {
          fallbackCopy(text, done);
        });
      } else {
        fallbackCopy(text, done);
      }
    });

    $('btn-export-csv').addEventListener('click', function () {
      if (!requireRecords()) return;
      var csv = Exp.toCsv(state.observations, { survey: state.survey });
      Exp.download('비빔봇-조사기록-' + Exp.stamp() + '.csv', csv, 'text/csv');
      markExported('CSV ' + state.observations.length + '건을 내려받았습니다. 사진은 포함되지 않습니다.');
    });

    $('btn-export-geojson').addEventListener('click', function () {
      if (!requireRecords()) return;
      var geo = Exp.toGeoJson(state.observations, { survey: state.survey });
      Exp.download('비빔봇-조사기록-' + Exp.stamp() + '.geojson', geo, 'application/geo+json');
      markExported('GeoJSON을 내려받았습니다. 좌표 순서는 [경도, 위도]입니다.');
    });

    $('btn-export-json').addEventListener('click', function () { exportBackup(true); });
    $('btn-export-json-light').addEventListener('click', function () { exportBackup(false); });

    $('restore-input').addEventListener('change', function (event) {
      var file = (event.target.files || [])[0];
      if (!file) return;
      var reader = new global.FileReader();
      reader.onload = function () {
        event.target.value = '';
        handleRestore(String(reader.result));
      };
      reader.onerror = function () {
        setStatus('restore-status', '파일을 읽지 못했습니다. 기존 기록은 그대로입니다.', 'error');
      };
      reader.readAsText(file);
    });
  }

  function fallbackCopy(text, done) {
    var area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    doc.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = doc.execCommand('copy'); } catch (err) { void err; }
    doc.body.removeChild(area);
    if (ok) done();
    else setStatus('export-status', '복사가 막혀 있습니다. 보고문을 길게 눌러 직접 복사해 주세요.', 'error');
  }

  function requireRecords() {
    if (state.observations.length) return true;
    setStatus('export-status', '내보낼 기록이 없습니다.', 'error');
    return false;
  }

  function markExported(message) {
    state.survey.lastExportedAt = new Date().toISOString();
    Storage.saveSurvey(state.survey).catch(function () { /* 내보내기 자체는 이미 끝났다 */ });
    setStatus('export-status', message, 'ok');
    renderResults();
  }

  function exportBackup(includePhotos) {
    if (!requireRecords()) return;
    setStatus('export-status', '백업을 만드는 중...', null);
    var photosPromise = includePhotos ? Storage.listAllPhotos() : Promise.resolve([]);
    Promise.all([Storage.listSurveys(), photosPromise, Storage.listTeamPlants()])
      .then(function (parts) {
        return Exp.buildBackup({
          surveys: parts[0],
          observations: state.observations,
          photos: parts[1],
          teamPlants: parts[2]
        }, includePhotos);
      })
      .then(function (backup) {
        var text = JSON.stringify(backup);
        var size = Exp.approximateSize(text);
        Exp.download('비빔봇-백업-' + Exp.stamp() + (includePhotos ? '-사진포함' : '-사진제외') + '.json',
          text, 'application/json');
        markExported('JSON 백업을 내려받았습니다. 용량 약 ' + size +
          (includePhotos ? ' (사진 포함)' : ' (사진 제외 — 사진은 보존되지 않습니다)') + '.');
      })
      .catch(function (err) {
        setStatus('export-status', '백업을 만들지 못했습니다: ' + err.message, 'error');
      });
  }

  function handleRestore(text) {
    var check = Exp.validateBackup(text);
    if (!check.ok) {
      setStatus('restore-status', '복원하지 않았습니다. ' + check.errors.join(' / '), 'error');
      return;
    }
    var prepared;
    try {
      prepared = Exp.prepareRestore(check.data);
    } catch (err) {
      setStatus('restore-status', '복원하지 않았습니다. ' + err.message, 'error');
      return;
    }
    var existingIds = {};
    state.observations.forEach(function (o) { existingIds[o.id] = true; });
    var overlap = prepared.observations.filter(function (o) { return existingIds[o.id]; }).length;

    askDialog(
      '백업을 복원할까요?',
      '기록 ' + prepared.observations.length + '건, 사진 ' + prepared.photos.length + '장.' +
      (overlap ? ' 같은 ID 기록 ' + overlap + '건이 이미 있습니다.' : ''),
      [
        { label: overlap ? '덮어쓰기(같은 ID 교체)' : '복원', value: 'overwrite' },
        { label: '새 기록만 추가', value: 'skip' },
        { label: '취소', value: 'cancel' }
      ]
    ).then(function (answer) {
      if (!answer || answer === 'cancel') return;
      var observations = answer === 'skip'
        ? prepared.observations.filter(function (o) { return !existingIds[o.id]; })
        : prepared.observations;
      var keepIds = {};
      observations.forEach(function (o) { keepIds[o.id] = true; });
      var photos = prepared.photos.filter(function (p) { return keepIds[p.observationId]; });

      var chain = Promise.resolve();
      (prepared.surveys || []).forEach(function (survey) {
        chain = chain.then(function () { return Storage.saveSurvey(survey); });
      });
      (prepared.teamPlants || []).forEach(function (plant) {
        chain = chain.then(function () { return Storage.saveTeamPlant(plant); });
      });
      observations.forEach(function (obs) {
        var own = photos.filter(function (p) { return p.observationId === obs.id; });
        chain = chain.then(function () { return Storage.saveObservation(obs, own); });
      });

      chain.then(function () { return reload(); }).then(function () {
        setStatus('restore-status', '기록 ' + observations.length + '건, 사진 ' + photos.length + '장을 복원했습니다.', 'ok');
        toast('복원 완료');
      }).catch(function (err) {
        setStatus('restore-status', '복원 중 오류가 났습니다: ' + err.message + ' 기존 기록은 지우지 않았습니다.', 'error');
      });
    });
  }

  function renderResults() {
    var counts = { 'invasive-designated': 0, 'alien-unlisted': 0, native: 0, 'needs-check': 0 };
    state.observations.forEach(function (obs) {
      if (counts[obs.categorySnapshot] != null) counts[obs.categorySnapshot] += 1;
    });
    var cards = [
      { label: '전체 기록', value: state.observations.length }
    ].concat(Object.keys(counts).map(function (key) {
      return { label: Catalog.categoryMeta(key).label, value: counts[key] };
    }));
    var demo = state.observations.filter(function (o) { return o.locationSource === 'demo'; }).length;
    var manual = state.observations.filter(function (o) { return o.locationSource === 'manual'; }).length;
    cards.push({ label: '시연 좌표 기록', value: demo });
    cards.push({ label: '수동 좌표 기록', value: manual });

    $('result-stats').innerHTML = cards.map(function (c) {
      return '<div class="stat"><span class="stat__label">' + esc(c.label) + '</span>' +
        '<span class="stat__value">' + c.value + '</span></div>';
    }).join('');

    var notice = [];
    if (!state.survey.lastExportedAt) {
      notice.push('아직 내보낸 적이 없습니다. 조사가 끝나면 CSV와 JSON 백업을 모두 저장해 주세요.');
    } else {
      notice.push('마지막 내보내기: ' + Exp.formatDate(state.survey.lastExportedAt) + '.');
    }
    if (demo) notice.push('시연 좌표 기록 ' + demo + '건은 실제 현장 기록이 아니라고 표시됩니다.');
    $('result-notice').textContent = notice.join(' ');

    $('report-text').value = Exp.toReportText(state.observations, { survey: state.survey });
  }

  /* ── 도감 탭 (FR-11) ───────────────────────────────────────── */

  function setupCatalogTab() {
    var search = $('catalog-search');
    var filter = $('catalog-filter');
    var debounce = null;
    search.addEventListener('input', function () {
      if (debounce) global.clearTimeout(debounce);
      debounce = global.setTimeout(renderCatalog, 180);
    });
    filter.addEventListener('change', renderCatalog);

    $('btn-add-team-plant').addEventListener('click', function () {
      var name = $('team-name').value.trim();
      if (!name) { setStatus('team-status', '이름을 입력해 주세요.', 'error'); return; }
      var plant = Catalog.normalizeTeamPlant({
        id: 'team-' + Photo.uuid(),
        nameKo: name,
        scientificName: $('team-sci').value.trim(),
        description: $('team-desc').value.trim()
      });
      Storage.saveTeamPlant(plant).then(function () {
        return Storage.listTeamPlants();
      }).then(function (list) {
        Catalog.setTeamPlants(list);
        $('team-name').value = '';
        $('team-sci').value = '';
        $('team-desc').value = '';
        setStatus('team-status', '"' + name + '"을(를) 임시 항목으로 추가했습니다. 검증 전까지 확인 필요로 남습니다.', 'ok');
        renderCatalog();
      }).catch(function (err) {
        setStatus('team-status', '추가하지 못했습니다: ' + err.message, 'error');
      });
    });

    $('catalog-list').addEventListener('click', function (event) {
      var btn = event.target.closest('button[data-team-remove]');
      if (!btn) return;
      var id = btn.getAttribute('data-team-remove');
      Storage.deleteTeamPlant(id).then(function () {
        return Storage.listTeamPlants();
      }).then(function (list) {
        Catalog.setTeamPlants(list);
        renderCatalog();
        toast('임시 항목을 지웠습니다.');
      });
    });
  }

  function renderCatalog() {
    var query = $('catalog-search').value.trim();
    var filter = $('catalog-filter').value;
    var plants = query
      ? Catalog.search(query).map(function (hit) { return hit.plant; })
      : Catalog.all().slice().sort(function (a, b) { return a.nameKo.localeCompare(b.nameKo, 'ko'); });
    if (filter !== 'all') {
      plants = plants.filter(function (p) { return Catalog.decide(p).category === filter; });
    }

    var counts = Catalog.counts();
    var pending = Catalog.all().filter(function (p) {
      return p.verificationStatus !== 'verified';
    }).length;
    $('catalog-meta').textContent = '도감 버전 ' + Catalog.catalogVersion() +
      ' · 전체 ' + counts.total + '종(교란 ' + counts['invasive-designated'] +
      ' / 외래 ' + counts['alien-unlisted'] + ' / 토종 ' + counts.native +
      ' / 확인 필요 ' + counts['needs-check'] + ') · 표시 ' + plants.length + '종' +
      ' · 지정 여부는 고시와 대조했고, ' + pending + '종은 토종/외래 구분이 아직 미검증이다.';

    if (!plants.length) {
      $('catalog-list').innerHTML = '<p class="muted">조건에 맞는 식물이 없다.</p>';
      return;
    }

    $('catalog-list').innerHTML = plants.map(function (plant) {
      var verdict = Catalog.decide(plant);
      var parts = [];
      parts.push('<div class="plant__head"><span><span class="plant__name">' + esc(plant.nameKo) + '</span>' +
        (plant.scientificName ? ' <span class="plant__sci">' + esc(plant.scientificName) + '</span>' : '') + '</span>' +
        '<span>' + categoryBadge(verdict.category) +
        (verdict.needsReview ? ' <span class="badge badge--review">검토 필요</span>' : '') + '</span></div>');
      parts.push('<div class="plant__body">');
      if (plant.origin) parts.push('<p class="plant__row"><b>원산지</b> ' + esc(plant.origin) + '</p>');
      if ((plant.englishNames || []).length) {
        parts.push('<p class="plant__row"><b>영문명</b> ' + esc(plant.englishNames.join(', ')) + '</p>');
      }
      if ((plant.aliases || []).length) {
        parts.push('<p class="plant__row"><b>별칭</b> ' + esc(plant.aliases.join(', ')) + '</p>');
      }
      if (plant.description) parts.push('<p class="plant__row">' + esc(plant.description) + '</p>');
      if (plant.lookAlikeNote) parts.push('<p class="plant__row"><b>구별법</b> ' + esc(plant.lookAlikeNote) + '</p>');
      parts.push('<p class="plant__row"><b>추천 행동</b> ' + esc(verdict.meta.action) + '</p>');
      if (plant.referenceImage) {
        parts.push('<img class="plant__img" src="' + esc(plant.referenceImage) + '" alt="' + esc(plant.nameKo) + ' 참고 그림">');
        parts.push('<p class="plant__src">' + esc(plant.imageCredit) + ' · ' + esc(plant.imageLicense) + '</p>');
      }
      parts.push('<p class="plant__src">출처: ' + (plant.sourceUrl
        ? '<a href="' + esc(plant.sourceUrl) + '" target="_blank" rel="noopener">' + esc(plant.sourceUrl) + '</a>'
        : '미기재') + ' · 기준일 ' + esc(plant.reviewedAt || '미기재') +
        ' · 검토 상태 ' + esc(plant.verificationStatus) + '</p>');
      if (plant.isTeamEntry) {
        parts.push('<button type="button" class="btn" data-team-remove="' + esc(plant.id) + '">임시 항목 지우기</button>');
      }
      parts.push('</div>');
      return '<div class="plant">' + parts.join('') + '</div>';
    }).join('');
  }

  /* ── 설정 탭 (FR-10) ───────────────────────────────────────── */

  function setupSettings() {
    $('map-key').value = Storage.getSetting('mapApiKey', '');
    $('map-id').value = Storage.getSetting('mapId', '');

    $('btn-save-key').addEventListener('click', function () {
      var key = $('map-key').value.trim();
      var mapId = $('map-id').value.trim();
      if (!key) { setStatus('key-status', '키를 입력해 주세요.', 'error'); return; }
      var ok = Storage.setSetting('mapApiKey', key) && Storage.setSetting('mapId', mapId);
      if (!ok) {
        setStatus('key-status', '이 브라우저에 키를 저장하지 못했습니다(사생활 보호 모드일 수 있음). 이번 조사 동안만 사용합니다.', 'warn');
      } else {
        setStatus('key-status', '키를 이 기기에 저장했습니다. 지도를 연결합니다...', null);
      }
      state.mapTried = true;
      connectMap(key, mapId).then(function (success) {
        if (success) setStatus('key-status', '지도 연결에 성공했습니다.', 'ok');
        goToTab('panel-map');
      });
    });

    $('btn-clear-key').addEventListener('click', function () {
      Storage.removeSetting('mapApiKey');
      Storage.removeSetting('mapId');
      $('map-key').value = '';
      $('map-id').value = '';
      setStatus('key-status', '키를 지웠습니다. 새로고침하면 OpenStreetMap 지도로 돌아갑니다. 기록은 지워지지 않습니다.', 'ok');
    });

    $('plantnet-key').value = Storage.getSetting('plantnetApiKey', '');

    $('btn-save-plantnet').addEventListener('click', function () {
      var key = $('plantnet-key').value.trim();
      if (!key) { setStatus('plantnet-status', '키를 입력해 주세요.', 'error'); return; }
      var ok = Storage.setSetting('plantnetApiKey', key);
      setStatus('plantnet-status', ok
        ? '키를 이 기기에 저장했습니다. 조사 탭 3단계에서 사진으로 이름 찾기를 쓸 수 있습니다.'
        : '이 브라우저에 키를 저장하지 못했습니다(사생활 보호 모드일 수 있음). 이번 조사 동안만 쓰입니다.',
        ok ? 'ok' : 'warn');
    });

    $('btn-clear-plantnet').addEventListener('click', function () {
      Storage.removeSetting('plantnetApiKey');
      $('plantnet-key').value = '';
      setStatus('plantnet-status', '키를 지웠습니다. 사진 식별은 꺼지고 이름 직접 입력은 그대로 됩니다.', 'ok');
    });

    var t = Loc.thresholds();
    $('thr-accuracy').value = t.accuracyWarnM;
    $('thr-stale').value = Math.round(t.staleMs / 1000);
    $('thr-duplicate').value = t.duplicateRadiusM;

    $('btn-save-thresholds').addEventListener('click', function () {
      var accuracy = parseFloat($('thr-accuracy').value);
      var stale = parseFloat($('thr-stale').value);
      var dup = parseFloat($('thr-duplicate').value);
      if (!(accuracy > 0) || !(stale > 0) || !(dup > 0)) {
        setStatus('threshold-status', '0보다 큰 숫자를 넣어 주세요.', 'error');
        return;
      }
      var ok = Storage.setSetting('locationThresholds', {
        accuracyWarnM: accuracy,
        staleMs: stale * 1000,
        duplicateRadiusM: dup
      });
      setStatus('threshold-status', ok ? '기준을 저장했습니다.' : '이 브라우저에 저장하지 못했습니다.', ok ? 'ok' : 'error');
      renderFix();
    });

    $('btn-check-storage').addEventListener('click', renderStorageInfo);

    $('btn-migrate-legacy').addEventListener('click', function () {
      var rows = Storage.readLegacy();
      if (!rows || !rows.length) {
        setStatus('storage-status', '가져올 기존 데이터(' + Storage.LEGACY_KEY + ')가 없습니다.', 'warn');
        return;
      }
      setStatus('storage-status', '기존 데이터 ' + rows.length + '건을 확인했습니다. 옮기는 중...', null);
      Storage.migrateLegacy(mapLegacyRow).then(function (result) {
        return reload().then(function () { return result; });
      }).then(function (result) {
        if (result.status === 'already-migrated') {
          setStatus('storage-status', '이미 옮긴 데이터입니다. 기존 localStorage 값은 그대로 남겨 두었습니다.', 'warn');
        } else {
          setStatus('storage-status', '기록 ' + result.migrated + '건을 옮겼습니다(건너뜀 ' + result.skipped +
            '건). 기존 localStorage 값은 지우지 않았습니다.', 'ok');
        }
      }).catch(function (err) {
        setStatus('storage-status', '옮기지 못했습니다: ' + err.message, 'error');
      });
    });

    $('btn-clear-all').addEventListener('click', function () {
      askDialog(
        '이 기기의 모든 기록을 지울까요?',
        '기록 ' + state.observations.length + '건과 모든 사진이 지워집니다. 되돌릴 수 없습니다. 먼저 JSON 백업을 내려받는 것을 권합니다.',
        [{ label: '취소', value: 'cancel' }, { label: '모두 삭제', value: 'clear', danger: true }]
      ).then(function (answer) {
        if (answer !== 'clear') return;
        Storage.clearAll().then(function () {
          Catalog.setTeamPlants([]);
          return reload();
        }).then(function () {
          setStatus('storage-status', '모든 기록을 지웠습니다.', 'ok');
        }).catch(function (err) {
          setStatus('storage-status', '지우지 못했습니다: ' + err.message, 'error');
        });
      });
    });
  }

  /** 기존 localStorage 기록을 현재 스키마로 바꾼다. 좌표가 없는 행은 버린다. */
  function mapLegacyRow(row) {
    if (!row) return null;
    var lat = Number(row.lat != null ? row.lat : row.latitude);
    var lng = Number(row.lng != null ? row.lng : row.longitude);
    if (!Loc.isValidCoord(lat, lng)) return null;
    var name = row.confirmedName || row.name || row.plant || row.n || '';
    var plant = name ? Catalog.exactMatch(name) : null;
    var created = row.createdAt || row.time || row.ts || new Date().toISOString();
    return {
      id: row.id || ('legacy-' + Photo.uuid()),
      surveyId: state.survey.id,
      plantId: plant ? plant.id : null,
      enteredName: name,
      confirmedName: name || '이름 미기재',
      categorySnapshot: plant ? Catalog.decide(plant).category : 'needs-check',
      catalogVersion: 'legacy',
      identificationMethod: 'manual',
      verificationStatus: 'needs-review',
      lat: lat,
      lng: lng,
      accuracyMeters: typeof row.accuracy === 'number' ? Math.round(row.accuracy) : null,
      locationSource: row.locationSource === 'manual' || row.locationSource === 'demo' ? row.locationSource : 'gps',
      locationCapturedAt: new Date(created).toISOString(),
      photoIds: [],
      note: row.note || row.memo || '',
      createdAt: new Date(created).toISOString(),
      updatedAt: new Date().toISOString(),
      removalStatus: row.removalStatus === 'removed' || row.removed ? 'removed' : 'unresolved',
      removedAt: row.removedAt || null
    };
  }

  function renderStorageInfo() {
    Promise.all([Storage.countPhotos(), Storage.estimateUsage()]).then(function (parts) {
      var photoCount = parts[0];
      var estimate = parts[1];
      var cards = [
        { label: '기록', value: state.observations.length + '건' },
        { label: '사진', value: photoCount + '장' }
      ];
      if (estimate && estimate.usage != null) {
        cards.push({ label: '사용 용량', value: (estimate.usage / 1024 / 1024).toFixed(1) + ' MB' });
      }
      if (estimate && estimate.quota) {
        cards.push({ label: '허용 용량', value: (estimate.quota / 1024 / 1024).toFixed(0) + ' MB' });
      }
      $('storage-info').innerHTML = cards.map(function (c) {
        return '<div class="stat"><span class="stat__label">' + esc(c.label) + '</span>' +
          '<span class="stat__value">' + esc(c.value) + '</span></div>';
      }).join('');
      setStatus('storage-status', '저장 상태를 확인했습니다. 용량 값은 브라우저가 알려 주는 추정치입니다.', 'ok');
    }).catch(function (err) {
      setStatus('storage-status', '저장 상태를 읽지 못했습니다: ' + err.message, 'error');
    });
  }

  /* ── 공통 렌더 / 부트 ──────────────────────────────────────── */

  function renderAll() {
    renderObservations();
    renderResults();
    refreshSaveState();
  }

  function reload() {
    return Promise.all([Storage.listObservations(), Storage.listTeamPlants()])
      .then(function (parts) {
        state.observations = parts[0];
        Catalog.setTeamPlants(parts[1]);
        renderAll();
        renderCatalog();
      });
  }

  function ensureSurvey() {
    return Storage.listSurveys().then(function (rows) {
      if (rows && rows.length) {
        rows.sort(function (a, b) { return String(b.startedAt).localeCompare(String(a.startedAt)); });
        return rows[0];
      }
      var survey = {
        id: Photo.uuid(),
        title: '비빔봇 1차 조사',
        placeLabel: '',
        startedAt: new Date().toISOString(),
        endedAt: null,
        lastExportedAt: null,
        schemaVersion: Storage.SCHEMA_VERSION
      };
      return Storage.saveSurvey(survey).then(function () { return survey; });
    });
  }

  function showFatal(message) {
    var holder = $('panel-survey');
    var box = doc.createElement('div');
    box.className = 'callout';
    box.innerHTML = '<p class="callout__title">저장소를 쓸 수 없습니다</p><p>' + esc(message) +
      '</p><p class="muted">사생활 보호 모드이거나 브라우저 저장이 막혀 있을 수 있습니다. ' +
      '이 상태에서는 기록이 남지 않으므로 일반 창에서 다시 열어 주세요.</p>';
    holder.insertBefore(box, holder.firstChild);
  }

  function boot() {
    Catalog.init({});
    setupTabs();
    setupLens();
    setupNameSearch();
    setupPhotos();
    setupLocation();
    setupSave();
    setupQuickRecord();
    setupIdentify();
    setupMapTab();
    setupResults();
    setupCatalogTab();
    setupSettings();
    renderCatalog();
    renderFix();

    Storage.openDb()
      .then(ensureSurvey)
      .then(function (survey) {
        state.survey = survey;
        $('survey-title').value = survey.title || '';
        $('survey-place').value = survey.placeLabel || '';
        return reload();
      })
      .then(function () {
        restoreDraft();
        var legacy = Storage.readLegacy();
        if (legacy && legacy.length) {
          setStatus('storage-status', '예전 형식 기록 ' + legacy.length +
            '건이 있습니다. 설정 탭의 "기존 데이터 가져오기"로 옮길 수 있습니다.', 'warn');
          toast('예전 기록 ' + legacy.length + '건을 발견했습니다. 설정 탭에서 가져오세요.');
        }
      })
      .catch(function (err) {
        showFatal(err && err.message ? err.message : String(err));
      });

    global.addEventListener('pagehide', releaseUrls);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 테스트와 디버깅용으로만 노출한다.
  global.BibimApp = { state: state, reload: reload };
})(window);
