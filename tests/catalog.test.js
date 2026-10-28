/* 도감 검색과 판정 규칙. 대회 전 도감 데이터를 손댈 때 규칙이 깨지는지 여기서 잡는다. */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var { loadCatalog } = require('./helpers');

test('판정: 지정 생물은 토종이어도 교란으로 간다', function () {
  var win = loadCatalog();
  var Catalog = win.BibimCatalog;
  var hop = Catalog.all().filter(function (p) { return p.nameKo === '환삼덩굴'; })[0];

  assert.ok(hop, '환삼덩굴이 도감에 있어야 한다');
  assert.equal(hop.isNative, true, '환삼덩굴은 토종이다');
  assert.equal(hop.isDesignatedInvasive, true, '그런데 법정 지정 생물이기도 하다');

  var verdict = Catalog.decide(hop);
  assert.equal(verdict.category, 'invasive-designated', '지정 여부가 토종 여부를 이겨야 한다');
  assert.match(verdict.reason, /지정/);
});

test('판정: 도감에 없는 이름은 절대 토종으로 떨어지지 않는다', function () {
  var win = loadCatalog();
  var verdict = win.BibimCatalog.decide(null);
  assert.equal(verdict.category, 'needs-check');
  assert.equal(verdict.needsReview, true);
  assert.notEqual(verdict.category, 'native');
});

test('판정: 지정되지 않은 외래는 alien-unlisted, 토종은 native', function () {
  var win = loadCatalog();
  var Catalog = win.BibimCatalog;
  var alien = Catalog.all().filter(function (p) {
    return !p.isDesignatedInvasive && !p.isNative && p.category !== 'needs-check';
  })[0];
  var native = Catalog.all().filter(function (p) {
    return !p.isDesignatedInvasive && p.isNative;
  })[0];

  assert.equal(Catalog.decide(alien).category, 'alien-unlisted');
  assert.equal(Catalog.decide(native).category, 'native');
});

test('exactMatch: 한글·학명·영문명·별칭을 모두 본다', function () {
  var win = loadCatalog();
  var Catalog = win.BibimCatalog;

  assert.equal(Catalog.exactMatch('가시박').id, 'sicyos-angulatus');
  assert.equal(Catalog.exactMatch('Sicyos angulatus').id, 'sicyos-angulatus');
  assert.equal(Catalog.exactMatch('bur cucumber').id, 'sicyos-angulatus');
  assert.equal(Catalog.exactMatch('안동오이').id, 'sicyos-angulatus');
  // 공백·대소문자는 무시한다
  assert.equal(Catalog.exactMatch('  sicyosangulatus  ').id, 'sicyos-angulatus');
});

test('exactMatch: 못 찾거나 여러 종이 걸리면 null', function () {
  var win = loadCatalog();
  assert.equal(win.BibimCatalog.exactMatch('있을리없는이름123'), null);
  assert.equal(win.BibimCatalog.exactMatch(''), null);
  assert.equal(win.BibimCatalog.exactMatch(null), null);
});

test('search: 부분 일치로 찾고, 같은 점수면 지정 생물이 먼저 온다', function () {
  var win = loadCatalog();
  var hits = win.BibimCatalog.search('돼지풀');
  assert.ok(hits.length >= 2, '돼지풀/단풍잎돼지풀이 함께 걸려야 한다');
  hits.forEach(function (hit) {
    assert.ok(hit.score > 0);
  });
  // 점수는 내림차순
  for (var i = 1; i < hits.length; i += 1) {
    assert.ok(hits[i - 1].score >= hits[i].score, '점수 내림차순이어야 한다');
  }
  assert.equal(win.BibimCatalog.search('돼지풀', 1).length, 1, 'limit 이 걸려야 한다');
  assert.deepEqual(win.BibimCatalog.search(''), []);
});

test('counts: 분류별 합이 전체와 같다', function () {
  var win = loadCatalog();
  var counts = win.BibimCatalog.counts();
  var sum = counts['invasive-designated'] + counts['alien-unlisted'] + counts.native + counts['needs-check'];
  assert.equal(sum, counts.total);
  assert.equal(counts.total, win.BibimCatalog.all().length);
  assert.ok(counts['invasive-designated'] > 0, '지정 생물이 한 종도 없을 리 없다');
});

test('지정 종은 모두 verified 이고 지정 분류로 떨어진다', function () {
  var win = loadCatalog();
  win.BibimCatalog.all().filter(function (p) { return p.isDesignatedInvasive; }).forEach(function (plant) {
    assert.equal(win.BibimCatalog.decide(plant).category, 'invasive-designated', plant.nameKo);
    assert.equal(plant.verificationStatus, 'verified', plant.nameKo + '는 고시 대조가 끝난 종이다');
  });
});

test('팀 임시 항목은 뭐라고 넣든 확인 필요로 고정된다', function () {
  var win = loadCatalog();
  var plant = win.BibimCatalog.normalizeTeamPlant({
    id: 'team-1',
    nameKo: '이름 모를 풀',
    isNative: true,                 // 거짓말을 해도
    isDesignatedInvasive: true,     // 받아들이지 않는다
    category: 'native'
  });

  assert.equal(plant.category, 'needs-check');
  assert.equal(plant.isNative, false);
  assert.equal(plant.isDesignatedInvasive, false);
  assert.equal(plant.isTeamEntry, true);
  assert.equal(win.BibimCatalog.decide(plant).category, 'needs-check');
});

test('팀 임시 항목의 출처 주소는 http(s) 만 통과한다', function () {
  var win = loadCatalog();
  var Catalog = win.BibimCatalog;

  assert.equal(Catalog.safeUrl('https://www.law.go.kr'), 'https://www.law.go.kr');
  assert.equal(Catalog.safeUrl('http://www.nature.go.kr'), 'http://www.nature.go.kr');
  assert.equal(Catalog.safeUrl('javascript:alert(1)'), '');
  assert.equal(Catalog.safeUrl('data:text/html,<script>'), '');
  assert.equal(Catalog.safeUrl(''), '');
  assert.equal(Catalog.safeUrl(null), '');

  // 조작된 백업으로 들어와도 링크로 걸리지 않아야 한다
  var evil = Catalog.normalizeTeamPlant({ id: 't', nameKo: '가짜', sourceUrl: 'javascript:alert(1)' });
  assert.equal(evil.sourceUrl, '');
});

test('setTeamPlants: 도감 버전에 팀 항목 수가 붙는다', function () {
  var win = loadCatalog();
  var base = win.BibimCatalog.catalogVersion();
  win.BibimCatalog.setTeamPlants([{ id: 'team-1', nameKo: '임시풀' }]);

  assert.equal(win.BibimCatalog.catalogVersion(), base + '+team1');
  assert.equal(win.BibimCatalog.getById('team-1').nameKo, '임시풀');
  assert.ok(win.BibimCatalog.search('임시풀').length, '임시 항목도 검색된다');

  win.BibimCatalog.setTeamPlants([]);
  assert.equal(win.BibimCatalog.catalogVersion(), base);
  assert.equal(win.BibimCatalog.getById('team-1'), null);
});

test('lookAlikes: 같은 속이면 함께 확인할 종으로 걸린다', function () {
  var win = loadCatalog();
  var ragweed = win.BibimCatalog.exactMatch('단풍잎돼지풀');
  var similar = win.BibimCatalog.lookAlikes(ragweed).map(function (p) { return p.nameKo; });

  assert.ok(similar.indexOf('돼지풀') !== -1, 'Ambrosia 속끼리 묶여야 한다');
  assert.equal(similar.indexOf('단풍잎돼지풀'), -1, '자기 자신은 빠진다');
  assert.deepEqual(win.BibimCatalog.lookAlikes(null), []);
});
