/* 내보내기와 백업 복원 검증. 복원이 느슨해지면 기록이 조용히 망가진다. */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var { loadCatalog } = require('./helpers');

function app() {
  var win = loadCatalog(['location', 'export']);
  return win;
}

function observation(extra) {
  var base = {
    id: 'obs-1',
    surveyId: 'survey-1',
    plantId: 'sicyos-angulatus',
    enteredName: '가시박',
    confirmedName: '가시박',
    categorySnapshot: 'invasive-designated',
    catalogVersion: '2026-10-27.b',
    identificationMethod: 'photo-api',
    verificationStatus: 'verified',
    lat: 35.8242,
    lng: 127.148,
    accuracyMeters: 7,
    locationSource: 'gps',
    locationCapturedAt: '2026-10-27T00:15:30.000Z',
    photoIds: ['photo-1'],
    note: '둑길 옆',
    createdAt: '2026-10-27T00:16:00.000Z',
    updatedAt: '2026-10-27T00:16:00.000Z',
    removalStatus: 'unresolved',
    removedAt: null
  };
  Object.keys(extra || {}).forEach(function (key) { base[key] = extra[key]; });
  return base;
}

function backup(extra) {
  var base = {
    app: 'bibimbot-field-survey',
    schemaVersion: 1,
    catalogVersion: '2026-10-27.b',
    exportedAt: '2026-10-27T01:00:00.000Z',
    includesPhotos: false,
    surveys: [],
    observations: [observation()],
    teamPlants: [],
    photos: []
  };
  Object.keys(extra || {}).forEach(function (key) { base[key] = extra[key]; });
  return base;
}

/* ── CSV ────────────────────────────────────────────────────── */

test('csvCell: 엑셀이 수식으로 읽는 시작 문자를 막는다', function () {
  var Exp = app().BibimExport;
  assert.equal(Exp.csvCell('=1+1'), "'=1+1");
  assert.equal(Exp.csvCell('+1'), "'+1");
  assert.equal(Exp.csvCell('-1'), "'-1");
  assert.equal(Exp.csvCell('@SUM'), "'@SUM");
  assert.equal(Exp.csvCell('가시박'), '가시박');
});

test('csvCell: 쉼표·따옴표·줄바꿈은 따옴표로 감싸고 escape 한다', function () {
  var Exp = app().BibimExport;
  assert.equal(Exp.csvCell('가,나'), '"가,나"');
  assert.equal(Exp.csvCell('그는 "저기"라 했다'), '"그는 ""저기""라 했다"');
  assert.equal(Exp.csvCell('첫 줄\n둘째 줄'), '"첫 줄\n둘째 줄"');
  assert.equal(Exp.csvCell(null), '');
  assert.equal(Exp.csvCell(undefined), '');
});

test('toCsv: BOM·머리글·행 수가 맞는다', function () {
  var win = app();
  var csv = win.BibimExport.toCsv([observation(), observation({ id: 'obs-2' })], { survey: { title: '1차 조사', placeLabel: '전주천' } });

  assert.ok(csv.charCodeAt(0) === 0xFEFF, '엑셀 한글용 BOM 이 맨 앞에 있어야 한다');
  var lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines.length, 3, '머리글 1 + 기록 2');
  assert.equal(lines[0].split(',').length, win.BibimExport.CSV_COLUMNS.length);
  assert.ok(lines[0].indexOf('기록ID') !== -1);
  assert.ok(lines[1].indexOf('가시박') !== -1);
  assert.ok(lines[1].indexOf('1차 조사') !== -1);
  assert.ok(lines[1].indexOf('지정') !== -1, '법정지정 칸이 채워진다');
});

test('toCsv: 좌표는 소수점 6자리로 고정된다', function () {
  var win = app();
  var csv = win.BibimExport.toCsv([observation({ lat: 35.1, lng: 127.2 })], {});
  assert.ok(csv.indexOf('35.100000') !== -1, csv);
  assert.ok(csv.indexOf('127.200000') !== -1);
});

/* ── GeoJSON ────────────────────────────────────────────────── */

test('toGeoJson: 좌표 순서는 [경도, 위도]', function () {
  var win = app();
  var geo = JSON.parse(win.BibimExport.toGeoJson([observation()], {}));

  assert.equal(geo.type, 'FeatureCollection');
  assert.equal(geo.features.length, 1);
  assert.deepEqual(geo.features[0].geometry.coordinates, [127.148, 35.8242]);
  assert.equal(geo.features[0].properties.designated, true);
  assert.equal(geo.features[0].properties.isDemoRecord, false);
});

test('toGeoJson: 좌표가 깨진 기록은 통째로 빠진다', function () {
  var win = app();
  var geo = JSON.parse(win.BibimExport.toGeoJson([
    observation(),
    observation({ id: 'bad', lat: 999, lng: 0 })
  ], {}));
  assert.equal(geo.features.length, 1);
  assert.equal(geo.features[0].properties.id, 'obs-1');
});

test('toGeoJson: 사진 바이너리는 들어가지 않는다', function () {
  var win = app();
  var text = win.BibimExport.toGeoJson([observation()], {});
  assert.equal(text.indexOf('data:image'), -1);
  assert.ok(text.indexOf('"photoCount": 1') !== -1, '장수만 남긴다');
});

/* ── 보고문 ─────────────────────────────────────────────────── */

test('toReportText: 분류별 건수와 시연 기록 표시가 들어간다', function () {
  var win = app();
  var text = win.BibimExport.toReportText([
    observation(),
    observation({ id: 'obs-2', categorySnapshot: 'native', confirmedName: '쑥', locationSource: 'demo' })
  ], { survey: { title: '1차 조사', placeLabel: '전주천 둑길' } });

  assert.ok(text.indexOf('1차 조사') !== -1);
  assert.ok(text.indexOf('전주천 둑길') !== -1);
  assert.ok(text.indexOf('총 기록: 2건') !== -1);
  assert.ok(text.indexOf('생태계교란 생물: 1건') !== -1);
  assert.ok(text.indexOf('토종 식물: 1건') !== -1);
  assert.ok(/시연 좌표 기록.*1건/.test(text), '시연 기록은 반드시 드러낸다');
  assert.ok(text.indexOf('전문가 확인 전 참고 자료') !== -1, '단정하지 않는다는 문장이 남아야 한다');
});

test('toReportText: 기록이 없어도 터지지 않는다', function () {
  var win = app();
  var text = win.BibimExport.toReportText([], {});
  assert.ok(text.indexOf('총 기록: 0건') !== -1);
  assert.ok(text.indexOf('기록 없음') !== -1);
});

/* ── 백업 검증 ──────────────────────────────────────────────── */

test('validateBackup: 제대로 된 백업은 통과한다', function () {
  var win = app();
  var check = win.BibimExport.validateBackup(JSON.stringify(backup()));
  assert.equal(check.ok, true, JSON.stringify(check.errors));
});

test('validateBackup: JSON 이 아니거나 다른 앱 파일이면 막는다', function () {
  var Exp = app().BibimExport;
  assert.equal(Exp.validateBackup('이건 JSON 이 아니다').ok, false);
  assert.equal(Exp.validateBackup(JSON.stringify({ app: 'other-app', schemaVersion: 1, observations: [] })).ok, false);
  assert.equal(Exp.validateBackup(JSON.stringify(backup({ schemaVersion: 99 }))).ok, false, '더 새로운 스키마는 거부');
  assert.equal(Exp.validateBackup(JSON.stringify(backup({ observations: 'not-an-array' }))).ok, false);
});

test('validateBackup: 기록 하나하나의 좌표와 열거형 값을 본다', function () {
  var Exp = app().BibimExport;

  function reject(extra, hint) {
    var check = Exp.validateBackup(JSON.stringify(backup({ observations: [observation(extra)] })));
    assert.equal(check.ok, false, hint + ' 는 막아야 한다');
    return check.errors.join(' ');
  }

  assert.match(reject({ lat: 999 }, '범위 밖 좌표'), /좌표/);
  assert.match(reject({ id: '' }, '빈 id'), /id/);
  assert.match(reject({ locationSource: 'made-up' }, '없는 좌표 출처'), /좌표 출처/);
  assert.match(reject({ removalStatus: 'made-up' }, '없는 처리 상태'), /처리 상태/);
  assert.match(reject({ categorySnapshot: 'made-up' }, '없는 분류'), /분류/);
  assert.match(reject({ identificationMethod: 'made-up' }, '없는 식별 방법'), /식별 방법/);
});

test('validateBackup: 네 가지 식별 방법은 모두 받아들인다', function () {
  var Exp = app().BibimExport;
  ['lens-manual', 'manual', 'team-model', 'photo-api'].forEach(function (method) {
    var check = Exp.validateBackup(JSON.stringify(backup({ observations: [observation({ identificationMethod: method })] })));
    assert.equal(check.ok, true, method + ' 는 통과해야 한다: ' + check.errors.join(' '));
  });
});

test('validateBackup: 팀 임시 항목의 모양과 출처 주소를 검사한다', function () {
  var Exp = app().BibimExport;

  assert.equal(Exp.validateBackup(JSON.stringify(backup({ teamPlants: 'not-an-array' }))).ok, false);

  var noName = Exp.validateBackup(JSON.stringify(backup({ teamPlants: [{ id: 't1', nameKo: '  ' }] })));
  assert.equal(noName.ok, false);
  assert.match(noName.errors.join(' '), /이름/);

  var evil = Exp.validateBackup(JSON.stringify(backup({
    teamPlants: [{ id: 't1', nameKo: '가짜풀', sourceUrl: 'javascript:alert(1)' }]
  })));
  assert.equal(evil.ok, false, '링크로 걸릴 수 없는 주소는 복원 전에 막는다');
  assert.match(evil.errors.join(' '), /출처 주소/);

  var fine = Exp.validateBackup(JSON.stringify(backup({
    teamPlants: [{ id: 't1', nameKo: '가짜풀', sourceUrl: 'https://www.nie.re.kr' }]
  })));
  assert.equal(fine.ok, true, fine.errors.join(' '));
});

test('validateBackup: 오류가 많아도 목록이 끝없이 길어지지 않는다', function () {
  var Exp = app().BibimExport;
  var many = [];
  for (var i = 0; i < 40; i += 1) many.push(observation({ id: 'bad-' + i, lat: 999 }));
  var check = Exp.validateBackup(JSON.stringify(backup({ observations: many })));
  assert.equal(check.ok, false);
  assert.ok(check.errors.length <= 13, '실제 ' + check.errors.length);
});

test('prepareRestore: 사진 dataUrl 을 Blob 으로 되살린다', function () {
  var win = app();
  // 1x1 투명 GIF
  var dataUrl = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  var prepared = win.BibimExport.prepareRestore(backup({
    photos: [{ id: 'photo-1', observationId: 'obs-1', mimeType: 'image/gif', width: 1, height: 1, dataUrl: dataUrl }]
  }));

  assert.equal(prepared.photos.length, 1);
  assert.equal(prepared.photos[0].blob.type, 'image/gif');
  assert.ok(prepared.photos[0].blob.size > 0);
  assert.equal(prepared.observations.length, 1);
});

test('prepareRestore: 망가진 사진 데이터는 조용히 넘어가지 않고 터진다', function () {
  var win = app();
  assert.throws(function () {
    win.BibimExport.prepareRestore(backup({
      photos: [{ id: 'p', observationId: 'obs-1', dataUrl: '이건 dataUrl 이 아니다' }]
    }));
  }, /사진 데이터 형식/);
});

test('formatDate: 비어 있거나 이상한 값에도 버틴다', function () {
  var Exp = app().BibimExport;
  assert.equal(Exp.formatDate(''), '');
  assert.equal(Exp.formatDate(null), '');
  assert.equal(Exp.formatDate('말도 안 되는 값'), '말도 안 되는 값');
  assert.match(Exp.formatDate('2026-10-27T00:15:30.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});
