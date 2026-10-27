/* 도감 검색과 판정 (PRD 3~4절 FR-02/FR-03, 7절 판정 규칙, 11절 FR-11 팀 임시 항목) */
(function (global) {
  'use strict';

  var CATEGORIES = {
    'invasive-designated': {
      id: 'invasive-designated',
      label: '생태계교란 생물',
      short: '교란',
      icon: '▲',          // ▲ 색을 못 봐도 구분되는 도형
      tone: 'red',
      action: '담당자에게 현장 확인·제거 검토를 요청한다. 학생이 직접 뽑지 않는다.',
      reason: '법으로 지정된 생태계교란 생물이다.'
    },
    'alien-unlisted': {
      id: 'alien-unlisted',
      label: '지정되지 않은 외래 식물',
      short: '외래',
      icon: '◆',          // ◆
      tone: 'yellow',
      action: '분포와 확산을 관찰해 기록을 늘린다.',
      reason: '바깥에서 들어온 식물이지만 법정 지정 생물은 아니다.'
    },
    native: {
      id: 'native',
      label: '토종 식물',
      short: '토종',
      icon: '●',          // ●
      tone: 'green',
      action: '서식지를 그대로 보호한다.',
      reason: '우리 땅에 원래 살던 식물이다.'
    },
    'needs-check': {
      id: 'needs-check',
      label: '확인 필요',
      short: '확인',
      icon: '■',          // ■
      tone: 'purple',
      action: '교사·전문가와 이름과 분류를 먼저 확인한다.',
      reason: '기준 도감에서 이름을 확정하지 못했다.'
    }
  };

  var REMOVAL_STATUS = {
    unresolved: { id: 'unresolved', label: '미처리' },
    reported: { id: 'reported', label: '전달함' },
    removed: { id: 'removed', label: '제거 완료' }
  };

  var basePlants = [];
  var teamPlants = [];
  var byId = {};

  function normalize(text) {
    return String(text == null ? '' : text)
      .toLowerCase()
      .replace(/[\s\-_.()]/g, '');
  }

  function searchFields(plant) {
    var fields = [plant.nameKo, plant.scientificName];
    (plant.englishNames || []).forEach(function (v) { fields.push(v); });
    (plant.aliases || []).forEach(function (v) { fields.push(v); });
    return fields.filter(function (v) { return v; });
  }

  function reindex() {
    byId = {};
    all().forEach(function (p) { byId[p.id] = p; });
  }

  function all() {
    return basePlants.concat(teamPlants);
  }

  /** 팀이 추가한 임시 항목은 검증 전까지 '확인 필요'를 유지한다(FR-11). */
  function normalizeTeamPlant(raw) {
    return {
      id: raw.id,
      nameKo: raw.nameKo || '',
      scientificName: raw.scientificName || '',
      englishNames: raw.englishNames || [],
      aliases: raw.aliases || [],
      origin: raw.origin || '',
      isNative: false,
      isDesignatedInvasive: false,
      category: 'needs-check',
      description: raw.description || '',
      lookAlikeNote: raw.lookAlikeNote || '',
      referenceImage: '',
      imageCredit: '',
      imageLicense: '',
      sourceUrl: raw.sourceUrl || '',
      reviewedAt: '',
      verificationStatus: 'team-added',
      isTeamEntry: true,
      createdAt: raw.createdAt || new Date().toISOString()
    };
  }

  function init(options) {
    var data = (options && options.data) || global.BibimPlants;
    basePlants = (data && data.PLANTS ? data.PLANTS : []).map(function (p) {
      var copy = {};
      Object.keys(p).forEach(function (k) { copy[k] = p[k]; });
      copy.isTeamEntry = false;
      return copy;
    });
    setTeamPlants((options && options.teamPlants) || []);
  }

  function setTeamPlants(list) {
    teamPlants = (list || []).map(normalizeTeamPlant);
    reindex();
  }

  function getTeamPlants() {
    return teamPlants.slice();
  }

  function catalogVersion() {
    var base = (global.BibimPlants && global.BibimPlants.CATALOG_VERSION) || 'unknown';
    return teamPlants.length ? base + '+team' + teamPlants.length : base;
  }

  function getById(id) {
    return id && byId[id] ? byId[id] : null;
  }

  /**
   * 이름 검색. 한글·학명·영문명·별칭의 부분 일치를 모두 지원한다(FR-02).
   * 점수가 높은 순으로 후보를 돌려주며, 자동 확정은 하지 않는다.
   */
  function search(query, limit) {
    var q = normalize(query);
    if (!q) return [];
    var results = [];
    all().forEach(function (plant) {
      var best = 0;
      var matched = '';
      searchFields(plant).forEach(function (field) {
        var f = normalize(field);
        var score = 0;
        if (f === q) score = 100;
        else if (f.indexOf(q) === 0) score = 75;
        else if (f.indexOf(q) !== -1) score = 50;
        else if (q.indexOf(f) === 0 && f.length >= 2) score = 35;
        if (score > best) { best = score; matched = field; }
      });
      if (best > 0) {
        // 생태계교란 생물을 같은 점수에서 먼저 보여 준다.
        var bonus = plant.isDesignatedInvasive ? 2 : 0;
        results.push({ plant: plant, score: best + bonus, matchedField: matched });
      }
    });
    results.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.plant.nameKo.localeCompare(b.plant.nameKo, 'ko');
    });
    return typeof limit === 'number' ? results.slice(0, limit) : results;
  }

  /** 입력 이름과 정확히 일치하는 한 종만 있을 때 돌려준다. 없으면 null. */
  function exactMatch(query) {
    var q = normalize(query);
    if (!q) return null;
    var hits = all().filter(function (plant) {
      return searchFields(plant).some(function (field) { return normalize(field) === q; });
    });
    return hits.length === 1 ? hits[0] : null;
  }

  /**
   * 판정. PRD 7절: 지정 생물이면 토종 여부와 무관하게 빨강이 우선한다.
   * 도감에서 찾지 못한 이름은 절대 토종으로 처리하지 않고 '확인 필요'로 둔다.
   */
  function decide(plant) {
    if (!plant) {
      return {
        category: 'needs-check',
        meta: CATEGORIES['needs-check'],
        reason: '기준 도감에 없는 이름이다. 자동으로 토종으로 처리하지 않는다.',
        needsReview: true
      };
    }
    var category;
    if (plant.isDesignatedInvasive) category = 'invasive-designated';
    else if (plant.category === 'needs-check') category = 'needs-check';
    else if (plant.isNative) category = 'native';
    else category = 'alien-unlisted';

    var meta = CATEGORIES[category];
    var reason = meta.reason;
    if (plant.isDesignatedInvasive && plant.isNative) {
      reason = '지정 생물이므로 토종 여부보다 지정 여부를 먼저 적용한다.';
    } else if (plant.origin) {
      reason = meta.reason + ' 원산지: ' + plant.origin + '.';
    }
    return {
      category: category,
      meta: meta,
      reason: reason,
      needsReview: plant.verificationStatus !== 'verified'
    };
  }

  function categoryMeta(category) {
    return CATEGORIES[category] || CATEGORIES['needs-check'];
  }

  function listByCategory(category) {
    var list = all();
    if (!category || category === 'all') return list.slice();
    return list.filter(function (p) { return decide(p).category === category; });
  }

  function counts() {
    var out = { 'invasive-designated': 0, 'alien-unlisted': 0, native: 0, 'needs-check': 0, total: 0 };
    all().forEach(function (p) {
      out[decide(p).category] += 1;
      out.total += 1;
    });
    return out;
  }

  /** 닮은 종: 같은 속이거나 구별법에 이름이 언급된 종을 모은다. */
  function lookAlikes(plant) {
    if (!plant) return [];
    var genus = (plant.scientificName || '').split(' ')[0];
    var note = plant.lookAlikeNote || '';
    return all().filter(function (other) {
      if (other.id === plant.id) return false;
      if (genus && (other.scientificName || '').indexOf(genus + ' ') === 0) return true;
      return other.nameKo && note.indexOf(other.nameKo) !== -1;
    });
  }

  global.BibimCatalog = {
    CATEGORIES: CATEGORIES,
    REMOVAL_STATUS: REMOVAL_STATUS,
    init: init,
    all: all,
    getById: getById,
    search: search,
    exactMatch: exactMatch,
    decide: decide,
    categoryMeta: categoryMeta,
    listByCategory: listByCategory,
    counts: counts,
    lookAlikes: lookAlikes,
    catalogVersion: catalogVersion,
    setTeamPlants: setTeamPlants,
    getTeamPlants: getTeamPlants,
    normalizeTeamPlant: normalizeTeamPlant
  };
})(window);
