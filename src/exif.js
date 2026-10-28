/* 사진에 박힌 촬영 위치(EXIF GPS) 읽기
 *
 * 휴대폰 기본 카메라로 찍은 사진에는 찍은 자리의 좌표와 시각이 들어 있다.
 * 그걸 그대로 읽어 기록으로 만들면, 현장에서는 찍기만 하고 돌아와서 한 번에 올릴 수 있다.
 *
 * 외부 라이브러리를 쓰지 않는다. 필요한 태그가 몇 개뿐이고, JPEG 앞부분만 읽으면 된다.
 * 읽는 것은 GPS 위도·경도·고도·오차, 그리고 촬영 시각뿐이다. 다른 개인정보는 보지 않는다.
 */
(function (global) {
  'use strict';

  var HEAD_BYTES = 256 * 1024;   // EXIF는 파일 앞부분에 있다. 통째로 읽지 않는다.

  var TAG = {
    EXIF_IFD: 0x8769,
    GPS_IFD: 0x8825,
    DATE_TIME_ORIGINAL: 0x9003,
    GPS_LAT_REF: 0x0001,
    GPS_LAT: 0x0002,
    GPS_LNG_REF: 0x0003,
    GPS_LNG: 0x0004,
    GPS_ALT_REF: 0x0005,
    GPS_ALT: 0x0006,
    GPS_H_ERROR: 0x001F        // GPSHPositioningError: 수평 오차(m). 기기에 따라 없다.
  };

  function readHead(file) {
    var slice = file.slice(0, Math.min(HEAD_BYTES, file.size));
    if (slice.arrayBuffer) return slice.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var reader = new global.FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('사진을 읽지 못했습니다.')); };
      reader.readAsArrayBuffer(slice);
    });
  }

  /** JPEG 마커를 훑어 APP1(Exif) 구간의 시작 위치를 찾는다. */
  function findExif(view) {
    if (view.byteLength < 4 || view.getUint16(0, false) !== 0xFFD8) return -1;   // SOI 아님
    var offset = 2;
    while (offset + 4 <= view.byteLength) {
      var marker = view.getUint16(offset, false);
      if ((marker & 0xFF00) !== 0xFF00) return -1;
      var size = view.getUint16(offset + 2, false);
      if (marker === 0xFFE1) {
        var start = offset + 4;
        if (start + 6 > view.byteLength) return -1;
        // "Exif\0\0"
        if (view.getUint32(start, false) === 0x45786966 && view.getUint16(start + 4, false) === 0x0000) {
          return start + 6;
        }
      }
      if (marker === 0xFFDA) return -1;      // 이미지 데이터 시작. 더 볼 필요 없다.
      offset += 2 + size;
    }
    return -1;
  }

  function readIfd(view, tiffStart, ifdOffset, little, wanted) {
    var out = {};
    var base = tiffStart + ifdOffset;
    if (base + 2 > view.byteLength) return out;
    var count = view.getUint16(base, little);
    for (var i = 0; i < count; i += 1) {
      var entry = base + 2 + i * 12;
      if (entry + 12 > view.byteLength) break;
      var tag = view.getUint16(entry, little);
      if (wanted.indexOf(tag) === -1) continue;
      var type = view.getUint16(entry + 2, little);
      var num = view.getUint32(entry + 4, little);
      out[tag] = readValue(view, tiffStart, entry + 8, type, num, little);
    }
    return out;
  }

  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  function readValue(view, tiffStart, valueAt, type, count, little) {
    var size = (TYPE_SIZE[type] || 1) * count;
    var at = size > 4 ? tiffStart + view.getUint32(valueAt, little) : valueAt;
    if (at < 0 || at + size > view.byteLength) return null;

    if (type === 2) {                       // ASCII
      var chars = [];
      for (var i = 0; i < count; i += 1) {
        var code = view.getUint8(at + i);
        if (code === 0) break;
        chars.push(String.fromCharCode(code));
      }
      return chars.join('');
    }
    if (type === 5 || type === 10) {        // RATIONAL / SRATIONAL
      var values = [];
      for (var r = 0; r < count; r += 1) {
        var numerator = type === 5 ? view.getUint32(at + r * 8, little) : view.getInt32(at + r * 8, little);
        var denominator = type === 5 ? view.getUint32(at + r * 8 + 4, little) : view.getInt32(at + r * 8 + 4, little);
        values.push(denominator ? numerator / denominator : 0);
      }
      return count === 1 ? values[0] : values;
    }
    if (type === 3) return view.getUint16(at, little);
    if (type === 4) return view.getUint32(at, little);
    if (type === 1 || type === 7) return view.getUint8(at);
    return null;
  }

  /** 도·분·초 세 값을 십진수 도로 바꾼다. */
  function toDegrees(dms, ref) {
    if (!dms || dms.length !== 3) return null;
    var value = dms[0] + dms[1] / 60 + dms[2] / 3600;
    if (!isFinite(value)) return null;
    if (ref === 'S' || ref === 'W') value = -value;
    return value;
  }

  function parseExifDate(text) {
    // "YYYY:MM:DD HH:MM:SS" — 찍은 기기의 현지 시각이다.
    var m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || ''));
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  /**
   * 사진 한 장에서 위치와 촬영 시각을 읽는다.
   * 좌표가 없으면 lat/lng 가 null 인 결과를 돌려준다(오류가 아니다).
   */
  function read(file) {
    return readHead(file).then(function (buffer) {
      var empty = { lat: null, lng: null, accuracyMeters: null, takenAt: null, altitude: null };
      var view = new DataView(buffer);
      var tiffStart = findExif(view);
      if (tiffStart < 0 || tiffStart + 8 > view.byteLength) return empty;

      var order = view.getUint16(tiffStart, false);
      if (order !== 0x4949 && order !== 0x4D4D) return empty;
      var little = order === 0x4949;
      if (view.getUint16(tiffStart + 2, little) !== 0x002A) return empty;

      var ifd0At = view.getUint32(tiffStart + 4, little);
      var ifd0 = readIfd(view, tiffStart, ifd0At, little, [TAG.GPS_IFD, TAG.EXIF_IFD]);

      var takenAt = null;
      if (ifd0[TAG.EXIF_IFD]) {
        var exifIfd = readIfd(view, tiffStart, ifd0[TAG.EXIF_IFD], little, [TAG.DATE_TIME_ORIGINAL]);
        takenAt = parseExifDate(exifIfd[TAG.DATE_TIME_ORIGINAL]);
      }

      if (!ifd0[TAG.GPS_IFD]) return { lat: null, lng: null, accuracyMeters: null, takenAt: takenAt, altitude: null };

      var gps = readIfd(view, tiffStart, ifd0[TAG.GPS_IFD], little, [
        TAG.GPS_LAT_REF, TAG.GPS_LAT, TAG.GPS_LNG_REF, TAG.GPS_LNG,
        TAG.GPS_ALT_REF, TAG.GPS_ALT, TAG.GPS_H_ERROR
      ]);

      var lat = toDegrees(gps[TAG.GPS_LAT], gps[TAG.GPS_LAT_REF]);
      var lng = toDegrees(gps[TAG.GPS_LNG], gps[TAG.GPS_LNG_REF]);
      var altitude = typeof gps[TAG.GPS_ALT] === 'number'
        ? (gps[TAG.GPS_ALT_REF] === 1 ? -gps[TAG.GPS_ALT] : gps[TAG.GPS_ALT])
        : null;
      var accuracy = typeof gps[TAG.GPS_H_ERROR] === 'number' && isFinite(gps[TAG.GPS_H_ERROR])
        ? Math.round(gps[TAG.GPS_H_ERROR])
        : null;

      var valid = global.BibimLocation.isValidCoord(lat, lng) && !(lat === 0 && lng === 0);
      return {
        lat: valid ? lat : null,
        lng: valid ? lng : null,
        accuracyMeters: valid ? accuracy : null,
        altitude: valid ? altitude : null,
        takenAt: takenAt
      };
    }).catch(function () {
      return { lat: null, lng: null, accuracyMeters: null, takenAt: null, altitude: null };
    });
  }

  global.BibimExif = { read: read };
})(window);
