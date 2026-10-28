/* 좌표 검증·거리 계산·중복 판정. 중복 반경 규칙이 여기서 무너지면 현장 기록이 겹친다. */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var { load } = require('./helpers');

function loadLoc(overrides) {
  return load(['location'], overrides).BibimLocation;
}

test('isValidCoord: 범위 밖과 숫자가 아닌 값을 거른다', function () {
  var Loc = loadLoc();
  assert.equal(Loc.isValidCoord(35.8242, 127.148), true);
  assert.equal(Loc.isValidCoord(-90, -180), true);
  assert.equal(Loc.isValidCoord(90, 180), true);
  assert.equal(Loc.isValidCoord(90.1, 0), false);
  assert.equal(Loc.isValidCoord(0, 180.1), false);
  assert.equal(Loc.isValidCoord(NaN, 0), false);
  assert.equal(Loc.isValidCoord(Infinity, 0), false);
  assert.equal(Loc.isValidCoord('35.8', '127.1'), false, '문자열은 좌표가 아니다');
  assert.equal(Loc.isValidCoord(null, null), false);
  assert.equal(Loc.isValidCoord(undefined, undefined), false);
});

test('distanceMeters: 위도 1도는 약 111.2km', function () {
  var Loc = loadLoc();
  var d = Loc.distanceMeters({ lat: 35, lng: 127 }, { lat: 36, lng: 127 });
  assert.ok(Math.abs(d - 111194.9) < 1, '실제 ' + d);

  assert.equal(Loc.distanceMeters({ lat: 35, lng: 127 }, { lat: 35, lng: 127 }), 0);
  assert.equal(Loc.distanceMeters(null, { lat: 35, lng: 127 }), Infinity);
  assert.equal(Loc.distanceMeters({ lat: 999, lng: 0 }, { lat: 35, lng: 127 }), Infinity);
});

test('distanceMeters: 전주 근처 짧은 거리', function () {
  var Loc = loadLoc();
  // 경도 0.0001도 ≈ 위도 35.8에서 9.0m
  var d = Loc.distanceMeters({ lat: 35.8242, lng: 127.1480 }, { lat: 35.8242, lng: 127.1481 });
  assert.ok(d > 8 && d < 10, '실제 ' + d);
});

test('중복 반경: 설정값과 측정 정확도 중 큰 쪽을 쓴다', function () {
  var Loc = loadLoc();
  // 기본 설정값 8m
  assert.equal(Loc.effectiveDuplicateRadius({ accuracyMeters: 3 }), 8, '정확도가 좋으면 설정값');
  assert.equal(Loc.effectiveDuplicateRadius({ accuracyMeters: 25 }), 25, '정확도가 나쁘면 그 값');
  assert.equal(Loc.effectiveDuplicateRadius(null), 8);
  assert.equal(Loc.effectiveDuplicateRadius({ accuracyMeters: null }), 8);
});

test('중복 반경: 설정을 바꾸면 그 값이 바닥이 된다', function () {
  var win = load(['location']);
  win.__settings.locationThresholds = { duplicateRadiusM: 20, accuracyWarnM: 50, staleMs: 30000 };
  assert.equal(win.BibimLocation.effectiveDuplicateRadius({ accuracyMeters: 3 }), 20);
  assert.equal(win.BibimLocation.effectiveDuplicateRadius({ accuracyMeters: 40 }), 40);
});

test('중복 반경: 1m 처럼 오차보다 작게 두어도 정확도가 지켜 준다', function () {
  var win = load(['location']);
  win.__settings.locationThresholds = { duplicateRadiusM: 1 };
  // GPS 오차가 7m 인 날, 반경 1m 를 적용하면 같은 포기가 매번 새 기록이 된다.
  assert.equal(win.BibimLocation.effectiveDuplicateRadius({ accuracyMeters: 7 }), 7);
});

test('findNearbyDuplicates: 같은 이름이 반경 안에 있을 때만, 가까운 순으로', function () {
  var Loc = loadLoc();
  var fix = { lat: 35.8242, lng: 127.1480, accuracyMeters: 5 };   // 적용 반경 8m
  var observations = [
    { id: 'far', confirmedName: '가시박', lat: 35.8242, lng: 127.1485 },     // 약 45m
    { id: 'near', confirmedName: '가시박', lat: 35.82420, lng: 127.14802 },  // 약 2m
    { id: 'mid', confirmedName: '가시박', lat: 35.82420, lng: 127.14807 },   // 약 6m
    { id: 'other', confirmedName: '돼지풀', lat: 35.8242, lng: 127.1480 }    // 같은 자리, 다른 종
  ];

  var hits = Loc.findNearbyDuplicates(fix, '가시박', observations);
  assert.deepEqual(hits.map(function (o) { return o.id; }), ['near', 'mid'], '가까운 순');
  assert.deepEqual(Loc.findNearbyDuplicates(fix, '돼지풀', observations).map(function (o) { return o.id; }), ['other']);
  assert.deepEqual(Loc.findNearbyDuplicates(fix, '', observations), []);
  assert.deepEqual(Loc.findNearbyDuplicates(null, '가시박', observations), []);
  assert.deepEqual(Loc.findNearbyDuplicates(fix, '가시박', []), []);
});

test('findNearbyDuplicates: 정확도가 나쁘면 반경이 넓어져 더 많이 걸린다', function () {
  var Loc = loadLoc();
  var observations = [{ id: 'a', confirmedName: '가시박', lat: 35.82420, lng: 127.14820 }];  // 약 18m

  assert.equal(Loc.findNearbyDuplicates({ lat: 35.8242, lng: 127.148, accuracyMeters: 4 }, '가시박', observations).length, 0);
  assert.equal(Loc.findNearbyDuplicates({ lat: 35.8242, lng: 127.148, accuracyMeters: 30 }, '가시박', observations).length, 1);
});

test('manualFix / photoFix / demoFix: 출처가 그대로 남는다', function () {
  var Loc = loadLoc();

  var manual = Loc.manualFix(35.8242, 127.148);
  assert.equal(manual.locationSource, 'manual');
  assert.equal(manual.accuracyMeters, null);
  assert.equal(Loc.manualFix(999, 0), null, '범위 밖이면 좌표를 만들지 않는다');

  var photo = Loc.photoFix(35.8242, 127.148, 12, '2026-10-27T00:15:30.000Z');
  assert.equal(photo.locationSource, 'photo-exif');
  assert.equal(photo.accuracyMeters, 12);
  assert.equal(photo.locationCapturedAt, '2026-10-27T00:15:30.000Z', '찍은 시각을 그대로 쓴다');
  assert.equal(Loc.photoFix(null, null), null);

  var demo = Loc.demoFix();
  assert.equal(demo.locationSource, 'demo');
  assert.equal(demo.lat, Loc.JEONJU_CENTER.lat);
});

test('sourceLabel: 네 가지 출처에 모두 이름이 있다', function () {
  var Loc = loadLoc();
  ['gps', 'photo-exif', 'manual', 'demo'].forEach(function (source) {
    assert.notEqual(Loc.sourceLabel(source), '알 수 없음', source);
  });
  assert.equal(Loc.sourceLabel('없는출처'), '알 수 없음');
});

test('review: 좌표가 없거나 틀리면 저장을 막는다', function () {
  var Loc = loadLoc();
  assert.equal(Loc.review(null).ok, false);
  assert.equal(Loc.review({ lat: 999, lng: 0, locationCapturedAt: new Date().toISOString() }).ok, false);
});

test('review: 오래된 좌표와 나쁜 정확도에 경고가 붙는다', function () {
  var Loc = loadLoc();
  var old = new Date(Date.now() - 60 * 1000).toISOString();       // 기본 staleMs 30초

  var stale = Loc.review({ lat: 35.8242, lng: 127.148, locationSource: 'gps', accuracyMeters: 5, locationCapturedAt: old });
  assert.equal(stale.ok, true, '경고가 있어도 저장 자체는 막지 않는다');
  assert.equal(stale.stale, true);
  assert.ok(stale.warnings.some(function (w) { return /다시 측정/.test(w); }));

  var rough = Loc.review({
    lat: 35.8242, lng: 127.148, locationSource: 'gps',
    accuracyMeters: 120, locationCapturedAt: new Date().toISOString()
  });
  assert.ok(rough.warnings.some(function (w) { return /정확도/.test(w); }));

  var good = Loc.review({
    lat: 35.8242, lng: 127.148, locationSource: 'gps',
    accuracyMeters: 5, locationCapturedAt: new Date().toISOString()
  });
  assert.deepEqual(good.warnings, [], '좋은 좌표에는 경고가 없다');
});

test('review: 시연·수동 좌표는 반드시 표시된다', function () {
  var Loc = loadLoc();
  var now = new Date().toISOString();

  var demo = Loc.review({ lat: 35.8242, lng: 127.148, locationSource: 'demo', locationCapturedAt: now });
  assert.ok(demo.warnings.some(function (w) { return /시연/.test(w); }));

  var manual = Loc.review({ lat: 35.8242, lng: 127.148, locationSource: 'manual', locationCapturedAt: now });
  assert.ok(manual.warnings.some(function (w) { return /직접 고른/.test(w); }));
});

/* ── acquire: 실패를 종류별로 구분해야 화면이 알맞은 안내를 낸다 ── */

function withGeolocation(impl) {
  return load(['location'], {
    navigator: { geolocation: { getCurrentPosition: impl } }
  }).BibimLocation;
}

test('acquire: 성공하면 gps 출처로 돌려준다', async function () {
  var Loc = withGeolocation(function (ok) {
    ok({ coords: { latitude: 35.8242, longitude: 127.148, accuracy: 7.4 }, timestamp: Date.parse('2026-10-27T00:15:30Z') });
  });
  var fix = await Loc.acquire();
  assert.equal(fix.lat, 35.8242);
  assert.equal(fix.locationSource, 'gps');
  assert.equal(fix.accuracyMeters, 7, '정확도는 반올림해서 넣는다');
  assert.equal(fix.locationCapturedAt, '2026-10-27T00:15:30.000Z');
});

test('acquire: 권한 거부와 타임아웃을 구분한다', async function () {
  var denied = withGeolocation(function (ok, fail) { fail({ code: 1 }); });
  await assert.rejects(denied.acquire(), function (err) {
    assert.equal(err.kind, 'denied');
    return true;
  });

  var timeout = withGeolocation(function (ok, fail) { fail({ code: 3 }); });
  await assert.rejects(timeout.acquire(), function (err) {
    assert.equal(err.kind, 'timeout');
    return true;
  });

  var other = withGeolocation(function (ok, fail) { fail({ code: 2 }); });
  await assert.rejects(other.acquire(), function (err) {
    assert.equal(err.kind, 'unavailable');
    return true;
  });
});

test('acquire: 기기가 위치를 지원하지 않으면 좌표를 만들어내지 않는다', async function () {
  var Loc = load(['location'], { navigator: {} }).BibimLocation;
  await assert.rejects(Loc.acquire(), function (err) {
    assert.equal(err.kind, 'unsupported');
    return true;
  });
});

test('acquire: 말이 안 되는 좌표가 오면 거부한다', async function () {
  var Loc = withGeolocation(function (ok) {
    ok({ coords: { latitude: 999, longitude: 0, accuracy: 5 }, timestamp: Date.now() });
  });
  await assert.rejects(Loc.acquire(), function (err) {
    assert.equal(err.kind, 'invalid');
    return true;
  });
});
