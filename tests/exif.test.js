/* 사진에 박힌 촬영 위치(EXIF GPS) 읽기.
 *
 * 진짜 JPEG 바이트를 만들어 넣는다. 직접 쓴 파서라서, 휴대폰 사진으로 손으로 확인하기 전에
 * 적어도 바이트 수준에서는 맞는지 여기서 지킨다.
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var { load } = require('./helpers');

function loadExif() {
  return load(['location', 'exif']).BibimExif;
}

/* ── 시험용 JPEG 만들기 ─────────────────────────────────────── */

var TYPE_ASCII = 2;
var TYPE_LONG = 4;
var TYPE_RATIONAL = 5;

function rational(numerator, denominator, little) {
  var buf = Buffer.alloc(8);
  if (little) {
    buf.writeUInt32LE(numerator, 0);
    buf.writeUInt32LE(denominator, 4);
  } else {
    buf.writeUInt32BE(numerator, 0);
    buf.writeUInt32BE(denominator, 4);
  }
  return buf;
}

function dms(values, little) {
  return Buffer.concat(values.map(function (pair) {
    return rational(pair[0], pair[1], little);
  }));
}

function ascii(text) {
  return Buffer.from(text + '\0', 'ascii');
}

/**
 * IFD 하나를 쓴다. 값이 4바이트를 넘으면 data 영역에 넣고 그 위치를 적는다.
 * entries: [{ tag, type, count, value: Buffer }]
 */
function writeIfd(entries, ifdAt, dataAt, little) {
  var size = 2 + entries.length * 12 + 4;
  var ifd = Buffer.alloc(size);
  var extras = [];
  var dataCursor = dataAt;

  if (little) ifd.writeUInt16LE(entries.length, 0);
  else ifd.writeUInt16BE(entries.length, 0);

  entries.forEach(function (entry, index) {
    var at = 2 + index * 12;
    if (little) {
      ifd.writeUInt16LE(entry.tag, at);
      ifd.writeUInt16LE(entry.type, at + 2);
      ifd.writeUInt32LE(entry.count, at + 4);
    } else {
      ifd.writeUInt16BE(entry.tag, at);
      ifd.writeUInt16BE(entry.type, at + 2);
      ifd.writeUInt32BE(entry.count, at + 4);
    }
    if (entry.value.length <= 4) {
      entry.value.copy(ifd, at + 8);           // 4바이트 안에 그대로 들어간다
    } else {
      if (little) ifd.writeUInt32LE(dataCursor, at + 8);
      else ifd.writeUInt32BE(dataCursor, at + 8);
      extras.push(entry.value);
      dataCursor += entry.value.length;
    }
  });
  // 다음 IFD 없음 = 0 (Buffer.alloc 이 이미 0으로 채워 둔다)
  return { ifd: ifd, extras: extras, dataEnd: dataCursor };
}

function longValue(value, little) {
  var buf = Buffer.alloc(4);
  if (little) buf.writeUInt32LE(value, 0);
  else buf.writeUInt32BE(value, 0);
  return buf;
}

/**
 * EXIF 가 들어간 JPEG 한 장을 Blob 으로 만든다.
 * @param opts { little, lat, latRef, lng, lngRef, hError, date }
 *   lat/lng 는 [[도,분모],[분,분모],[초,분모]] 꼴. 없으면 GPS IFD 자체를 넣지 않는다.
 */
function makeJpeg(opts) {
  var little = opts.little !== false;
  var hasGps = !!opts.lat;
  var hasDate = !!opts.date;

  // 자리를 먼저 잡는다: 헤더(8) → IFD0 → EXIF IFD → GPS IFD → 값 데이터
  var ifd0Count = (hasDate ? 1 : 0) + (hasGps ? 1 : 0);
  var ifd0Size = 2 + ifd0Count * 12 + 4;
  var exifSize = hasDate ? 2 + 1 * 12 + 4 : 0;

  var gpsEntryCount = hasGps ? (opts.hError == null ? 4 : 5) : 0;
  var gpsSize = hasGps ? 2 + gpsEntryCount * 12 + 4 : 0;

  var ifd0At = 8;
  var exifAt = ifd0At + ifd0Size;
  var gpsAt = exifAt + exifSize;
  var dataAt = gpsAt + gpsSize;

  var exifBlock = { ifd: Buffer.alloc(0), extras: [], dataEnd: dataAt };
  if (hasDate) {
    exifBlock = writeIfd([
      { tag: 0x9003, type: TYPE_ASCII, count: opts.date.length + 1, value: ascii(opts.date) }
    ], exifAt, dataAt, little);
  }

  var gpsBlock = { ifd: Buffer.alloc(0), extras: [], dataEnd: exifBlock.dataEnd };
  if (hasGps) {
    var gpsEntries = [
      { tag: 0x0001, type: TYPE_ASCII, count: 2, value: ascii(opts.latRef || 'N') },
      { tag: 0x0002, type: TYPE_RATIONAL, count: 3, value: dms(opts.lat, little) },
      { tag: 0x0003, type: TYPE_ASCII, count: 2, value: ascii(opts.lngRef || 'E') },
      { tag: 0x0004, type: TYPE_RATIONAL, count: 3, value: dms(opts.lng, little) }
    ];
    if (opts.hError != null) {
      gpsEntries.push({ tag: 0x001F, type: TYPE_RATIONAL, count: 1, value: rational(opts.hError, 1, little) });
    }
    gpsBlock = writeIfd(gpsEntries, gpsAt, exifBlock.dataEnd, little);
  }

  var ifd0Entries = [];
  if (hasDate) ifd0Entries.push({ tag: 0x8769, type: TYPE_LONG, count: 1, value: longValue(exifAt, little) });
  if (hasGps) ifd0Entries.push({ tag: 0x8825, type: TYPE_LONG, count: 1, value: longValue(gpsAt, little) });
  var ifd0Block = writeIfd(ifd0Entries, ifd0At, dataAt, little);

  var header = Buffer.alloc(8);
  header.write(little ? 'II' : 'MM', 0, 'ascii');
  if (little) {
    header.writeUInt16LE(0x002A, 2);
    header.writeUInt32LE(ifd0At, 4);
  } else {
    header.writeUInt16BE(0x002A, 2);
    header.writeUInt32BE(ifd0At, 4);
  }

  var tiff = Buffer.concat(
    [header, ifd0Block.ifd, exifBlock.ifd, gpsBlock.ifd]
      .concat(exifBlock.extras)
      .concat(gpsBlock.extras)
  );

  var app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  var app1Header = Buffer.alloc(4);
  app1Header.writeUInt16BE(0xFFE1, 0);
  app1Header.writeUInt16BE(app1Body.length + 2, 2);   // 길이에는 길이 칸 2바이트도 들어간다

  return new Blob([Buffer.concat([
    Buffer.from([0xFF, 0xD8]),       // SOI
    app1Header,
    app1Body,
    Buffer.from([0xFF, 0xD9])        // EOI
  ])], { type: 'image/jpeg' });
}

// 전주 부근: 35.8242, 127.148
var JEONJU_LAT = [[35, 1], [49, 1], [2712, 100]];
var JEONJU_LNG = [[127, 1], [8, 1], [528, 10]];

/* ── 테스트 ─────────────────────────────────────────────────── */

test('GPS 와 촬영 시각을 읽는다 (리틀엔디언)', async function () {
  var Exif = loadExif();
  var meta = await Exif.read(makeJpeg({
    lat: JEONJU_LAT, lng: JEONJU_LNG, hError: 12, date: '2026:10:27 09:15:30'
  }));

  assert.ok(Math.abs(meta.lat - 35.8242) < 0.00001, '위도 ' + meta.lat);
  assert.ok(Math.abs(meta.lng - 127.148) < 0.00001, '경도 ' + meta.lng);
  assert.equal(meta.accuracyMeters, 12);
  // EXIF 촬영 시각은 시간대가 없어서 읽는 기기의 현지 시각으로 해석한다.
  assert.equal(meta.takenAt, new Date(2026, 9, 27, 9, 15, 30).toISOString());
});

test('빅엔디언(MM) 사진도 똑같이 읽는다', async function () {
  var Exif = loadExif();
  var meta = await Exif.read(makeJpeg({
    little: false, lat: JEONJU_LAT, lng: JEONJU_LNG, hError: 9, date: '2026:10:27 09:15:30'
  }));

  assert.ok(Math.abs(meta.lat - 35.8242) < 0.00001, '위도 ' + meta.lat);
  assert.ok(Math.abs(meta.lng - 127.148) < 0.00001, '경도 ' + meta.lng);
  assert.equal(meta.accuracyMeters, 9);
});

test('남반구·서반구 표시(S/W)는 음수로 뒤집는다', async function () {
  var Exif = loadExif();
  var meta = await Exif.read(makeJpeg({
    lat: JEONJU_LAT, latRef: 'S', lng: JEONJU_LNG, lngRef: 'W', date: '2026:10:27 09:15:30'
  }));

  assert.ok(Math.abs(meta.lat + 35.8242) < 0.00001, '위도 ' + meta.lat);
  assert.ok(Math.abs(meta.lng + 127.148) < 0.00001, '경도 ' + meta.lng);
});

test('수평 오차 태그가 없으면 정확도는 null (오류가 아니다)', async function () {
  var Exif = loadExif();
  var meta = await Exif.read(makeJpeg({ lat: JEONJU_LAT, lng: JEONJU_LNG, date: '2026:10:27 09:15:30' }));

  assert.ok(Math.abs(meta.lat - 35.8242) < 0.00001);
  assert.equal(meta.accuracyMeters, null);
});

test('위치 태그가 꺼진 사진: 좌표는 null, 촬영 시각은 그대로', async function () {
  var Exif = loadExif();
  var meta = await Exif.read(makeJpeg({ date: '2026:10:27 09:15:30' }));

  assert.equal(meta.lat, null);
  assert.equal(meta.lng, null);
  assert.equal(meta.accuracyMeters, null);
  assert.ok(meta.takenAt, '시각은 읽혀야 한다');
});

test('0, 0 좌표는 "위치 없음"으로 본다', async function () {
  var Exif = loadExif();
  var zero = [[0, 1], [0, 1], [0, 1]];
  var meta = await Exif.read(makeJpeg({ lat: zero, lng: zero, date: '2026:10:27 09:15:30' }));

  assert.equal(meta.lat, null, '기니만 한복판을 전주 기록으로 만들지 않는다');
  assert.equal(meta.lng, null);
});

test('EXIF 가 아예 없는 JPEG 도 오류 없이 넘어간다', async function () {
  var Exif = loadExif();
  var plain = new Blob([Buffer.from([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9])], { type: 'image/jpeg' });
  var meta = await Exif.read(plain);

  assert.deepEqual(meta, { lat: null, lng: null, accuracyMeters: null, takenAt: null, altitude: null });
});

test('JPEG 이 아닌 파일도 오류 없이 넘어간다', async function () {
  var Exif = loadExif();
  var png = new Blob([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])], { type: 'image/png' });
  var meta = await Exif.read(png);

  assert.equal(meta.lat, null);
  assert.equal(meta.takenAt, null);
});

test('빈 파일에도 버틴다', async function () {
  var Exif = loadExif();
  var meta = await Exif.read(new Blob([], { type: 'image/jpeg' }));
  assert.equal(meta.lat, null);
});

test('읽은 좌표가 그대로 photoFix 로 이어진다', async function () {
  var win = load(['location', 'exif']);
  var meta = await win.BibimExif.read(makeJpeg({
    lat: JEONJU_LAT, lng: JEONJU_LNG, hError: 12, date: '2026:10:27 09:15:30'
  }));
  var fix = win.BibimLocation.photoFix(meta.lat, meta.lng, meta.accuracyMeters, meta.takenAt);

  assert.equal(fix.locationSource, 'photo-exif', 'GPS 실측과 구분되어야 한다');
  assert.equal(fix.accuracyMeters, 12);
  assert.equal(fix.locationCapturedAt, meta.takenAt);
});
