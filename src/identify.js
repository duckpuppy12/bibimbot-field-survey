/* 사진 자동 식별 (Pl@ntNet API)
 *
 * POST https://my-api.plantnet.org/v2/identify/all?api-key=...
 *   images: 사진 1~5장(합계 50MB 이하), organs: 사진마다 하나씩
 * 응답: results[].species.scientificNameWithoutAuthor + score(0~1) + commonNames
 *
 * Pl@ntNet은 학명을 돌려준다. 우리 도감이 scientificName을 갖고 있으므로 그대로 이어 붙여
 * 판정까지 간다. 도감에서 찾지 못한 학명은 절대 토종으로 처리하지 않고 '확인 필요'로 둔다.
 *
 * 주의: 이 호출은 사진을 외부 서버로 보낸다. 반드시 학생이 버튼을 눌렀을 때만 실행한다.
 */
(function (global) {
  'use strict';

  var ENDPOINT = 'https://my-api.plantnet.org/v2/identify/';
  var PROJECT = 'all';          // 전 세계 식물상. /v2/projects 로 좁힐 수 있다.
  var MAX_IMAGES = 5;
  var MAX_TOTAL_BYTES = 50 * 1024 * 1024;
  var ATTRIBUTION = 'powered by Pl@ntNet';

  var ORGANS = [
    { id: 'auto', label: '자동으로 판단' },
    { id: 'leaf', label: '잎' },
    { id: 'flower', label: '꽃' },
    { id: 'fruit', label: '열매' },
    { id: 'bark', label: '줄기·껍질' }
  ];

  // 이 점수 아래면 화면에서 '확신이 낮다'고 경고한다. 현장 시험으로 조정한다.
  var LOW_SCORE = 0.3;

  function getKey() {
    return global.BibimStorage ? global.BibimStorage.getSetting('plantnetApiKey', '') : '';
  }

  function isConfigured() {
    return !!getKey();
  }

  function fail(kind, message) {
    var err = new Error(message);
    err.kind = kind;
    return err;
  }

  /** 응답 한 건을 우리 도감에 연결한다. 못 찾으면 plant = null 로 둔다. */
  function mapResult(raw) {
    var species = raw.species || {};
    var sci = species.scientificNameWithoutAuthor || '';
    // 별칭·학명까지 보는 정확 일치만 쓴다. 느슨하게 맞추면 엉뚱한 종으로 이어질 수 있다.
    var plant = sci && global.BibimCatalog ? global.BibimCatalog.exactMatch(sci) : null;
    var verdict = global.BibimCatalog.decide(plant);
    return {
      scientificName: sci,
      authorship: species.scientificNameAuthorship || '',
      commonNames: species.commonNames || [],
      family: (species.family && species.family.scientificNameWithoutAuthor) || '',
      score: typeof raw.score === 'number' ? raw.score : 0,
      plant: plant,
      category: verdict.category,
      meta: verdict.meta,
      inCatalog: !!plant
    };
  }

  /**
   * 사진으로 후보를 받아온다.
   * @param photos [{ blob, mimeType }] — 저장용으로 줄인 사본을 그대로 쓴다.
   * @param organ  'auto' | 'leaf' | 'flower' | 'fruit' | 'bark'
   */
  function identify(photos, organ) {
    var key = getKey();
    if (!key) {
      return Promise.reject(fail('no-key', 'Pl@ntNet 키가 없습니다. 설정 탭에서 교사용 키를 넣어 주세요.'));
    }
    var list = (photos || []).slice(0, MAX_IMAGES);
    if (!list.length) {
      return Promise.reject(fail('no-photo', '먼저 사진을 한 장 이상 첨부해 주세요.'));
    }
    var total = list.reduce(function (sum, p) { return sum + ((p.blob && p.blob.size) || 0); }, 0);
    if (total > MAX_TOTAL_BYTES) {
      return Promise.reject(fail('too-large', '사진 용량이 너무 큽니다. 장수를 줄여 주세요.'));
    }

    var form = new global.FormData();
    list.forEach(function (photo, index) {
      form.append('images', photo.blob, 'photo-' + index + '.jpg');
      form.append('organs', organ || 'auto');       // 사진 수와 개수를 맞춘다.
    });

    var url = ENDPOINT + PROJECT +
      '?api-key=' + encodeURIComponent(key) +
      '&lang=ko&nb-results=5&include-related-images=false';

    return global.fetch(url, { method: 'POST', body: form })
      .catch(function () {
        throw fail('network', '식별 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.');
      })
      .then(function (response) {
        return response.text().then(function (text) {
          var data = null;
          try { data = JSON.parse(text); } catch (err) { void err; }
          if (!response.ok) throw httpError(response.status, data);
          return normalize(data);
        });
      });
  }

  function httpError(status, data) {
    if (status === 401 || status === 403) {
      // 키 오타 말고도, 브라우저 호출 허용("expose my API key")이나 허용 도메인 누락이 흔한 원인이다.
      return fail('bad-key',
        'Pl@ntNet 키가 거부되었습니다. my.plantnet.org/settings/api-key 에서 ' +
        '키가 맞는지, "expose my API key"가 켜져 있는지, Authorized domains에 이 앱 주소(' +
        global.location.hostname + ')가 들어 있는지 확인해 주세요.');
    }
    if (status === 404) {
      return fail('no-match', 'Pl@ntNet이 이 사진에서 후보를 찾지 못했습니다. 잎이나 꽃을 가까이에서 다시 찍어 보세요.');
    }
    if (status === 429) {
      return fail('quota', '오늘 쓸 수 있는 식별 횟수(무료 1일 500건)를 다 썼습니다. 이름을 직접 입력해 주세요.');
    }
    if (status === 413) {
      return fail('too-large', '사진 용량이 너무 큽니다. 장수를 줄여 주세요.');
    }
    var detail = data && data.message ? ' (' + data.message + ')' : '';
    return fail('http-' + status, '식별에 실패했습니다. 응답 코드 ' + status + detail);
  }

  function normalize(data) {
    var results = (data && data.results) || [];
    return {
      candidates: results.map(mapResult),
      remaining: data && typeof data.remainingIdentificationRequests === 'number'
        ? data.remainingIdentificationRequests
        : null,
      bestMatch: (data && data.bestMatch) || ''
    };
  }

  global.BibimIdentify = {
    ORGANS: ORGANS,
    LOW_SCORE: LOW_SCORE,
    ATTRIBUTION: ATTRIBUTION,
    MAX_IMAGES: MAX_IMAGES,
    isConfigured: isConfigured,
    identify: identify
  };
})(window);
