/* 위치 획득과 검증 (PRD 9절) */
(function (global) {
  'use strict';

  // PRD 9절의 '제안 기본값'. 현장 시험 후 설정에서 조정한다.
  var DEFAULTS = {
    timeoutMs: 15000,
    staleMs: 30000,          // 30초보다 오래된 좌표는 재측정을 안내
    accuracyWarnM: 50,       // 50m 초과면 재측정/수동 선택을 안내
    duplicateRadiusM: 8      // 같은 이름을 8m 안에서 다시 저장하면 중복 확인
  };

  var JEONJU_CENTER = { lat: 35.8242, lng: 127.1480 };

  function thresholds() {
    var saved = global.BibimStorage ? global.BibimStorage.getSetting('locationThresholds', null) : null;
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = DEFAULTS[k]; });
    if (saved) {
      Object.keys(DEFAULTS).forEach(function (k) {
        if (typeof saved[k] === 'number' && isFinite(saved[k]) && saved[k] > 0) out[k] = saved[k];
      });
    }
    return out;
  }

  function isValidLat(lat) {
    return typeof lat === 'number' && isFinite(lat) && lat >= -90 && lat <= 90;
  }

  function isValidLng(lng) {
    return typeof lng === 'number' && isFinite(lng) && lng >= -180 && lng <= 180;
  }

  function isValidCoord(lat, lng) {
    return isValidLat(lat) && isValidLng(lng);
  }

  /** 두 좌표 사이 거리(m). 중복 확인에 쓴다. */
  function distanceMeters(a, b) {
    if (!a || !b) return Infinity;
    if (!isValidCoord(a.lat, a.lng) || !isValidCoord(b.lat, b.lng)) return Infinity;
    var R = 6371000;
    var toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad;
    var dLng = (b.lng - a.lng) * toRad;
    var lat1 = a.lat * toRad;
    var lat2 = b.lat * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /**
   * 현재 위치를 한 번 측정한다. 거부·타임아웃·실패를 구분해 돌려준다(FR-04).
   * 성공하지 못하면 좌표를 만들어내지 않는다.
   */
  function acquire(options) {
    var opts = options || {};
    var t = thresholds();
    return new Promise(function (resolve, reject) {
      if (!global.navigator || !global.navigator.geolocation) {
        reject(makeError('unsupported', '이 브라우저에서는 위치 기능을 쓸 수 없습니다. 지도에서 직접 위치를 선택해 주세요.'));
        return;
      }
      var settled = false;
      var timer = global.setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(makeError('timeout', '위치를 찾는 데 시간이 너무 걸립니다. 하늘이 보이는 곳에서 다시 시도하거나 지도에서 직접 선택해 주세요.'));
      }, opts.timeoutMs || t.timeoutMs);

      global.navigator.geolocation.getCurrentPosition(
        function (position) {
          if (settled) return;
          settled = true;
          global.clearTimeout(timer);
          var lat = position.coords.latitude;
          var lng = position.coords.longitude;
          if (!isValidCoord(lat, lng)) {
            reject(makeError('invalid', '받아온 좌표가 올바른 범위가 아닙니다. 다시 측정해 주세요.'));
            return;
          }
          resolve({
            lat: lat,
            lng: lng,
            accuracyMeters: typeof position.coords.accuracy === 'number' ? Math.round(position.coords.accuracy) : null,
            locationSource: 'gps',
            locationCapturedAt: new Date(position.timestamp || Date.now()).toISOString()
          });
        },
        function (err) {
          if (settled) return;
          settled = true;
          global.clearTimeout(timer);
          if (err && err.code === 1) {
            reject(makeError('denied', '위치 권한이 거부되었습니다. 지도에서 직접 위치를 선택할 수 있습니다.'));
          } else if (err && err.code === 3) {
            reject(makeError('timeout', '위치를 찾는 데 시간이 너무 걸립니다. 지도에서 직접 선택해 주세요.'));
          } else {
            reject(makeError('unavailable', '위치를 가져오지 못했습니다. 다시 시도하거나 지도에서 직접 선택해 주세요.'));
          }
        },
        {
          enableHighAccuracy: opts.enableHighAccuracy !== false,
          timeout: opts.timeoutMs || t.timeoutMs,
          maximumAge: 0
        }
      );
    });
  }

  function makeError(kind, message) {
    var err = new Error(message);
    err.kind = kind;
    return err;
  }

  function manualFix(lat, lng, label) {
    if (!isValidCoord(lat, lng)) return null;
    return {
      lat: lat,
      lng: lng,
      accuracyMeters: null,
      locationSource: 'manual',
      locationCapturedAt: new Date().toISOString(),
      manualLabel: label || ''
    };
  }

  /** 실내 시연용 좌표. 모든 화면과 내보내기에서 '시연 기록'으로 표시된다. */
  function demoFix(lat, lng) {
    var useLat = isValidLat(lat) ? lat : JEONJU_CENTER.lat;
    var useLng = isValidLng(lng) ? lng : JEONJU_CENTER.lng;
    return {
      lat: useLat,
      lng: useLng,
      accuracyMeters: null,
      locationSource: 'demo',
      locationCapturedAt: new Date().toISOString()
    };
  }

  /** 저장 직전 좌표 품질 점검. 경고가 있어도 학생이 확인하면 저장은 허용한다. */
  function review(fix) {
    var t = thresholds();
    var warnings = [];
    if (!fix) {
      return { ok: false, warnings: ['위치가 아직 확정되지 않았습니다.'], stale: false };
    }
    if (!isValidCoord(fix.lat, fix.lng)) {
      return { ok: false, warnings: ['좌표 값이 올바르지 않습니다.'], stale: false };
    }
    var age = Date.now() - new Date(fix.locationCapturedAt).getTime();
    var stale = isFinite(age) && age > t.staleMs;
    if (stale) {
      warnings.push('좌표를 받은 지 ' + Math.round(age / 1000) + '초가 지났습니다. 다시 측정하기를 권합니다.');
    }
    if (fix.locationSource === 'gps' && typeof fix.accuracyMeters === 'number' && fix.accuracyMeters > t.accuracyWarnM) {
      warnings.push('정확도가 약 ' + fix.accuracyMeters + 'm입니다. 더 열린 곳에서 다시 측정하거나 지도에서 직접 선택해 주세요.');
    }
    if (fix.locationSource === 'manual') {
      warnings.push('지도에서 직접 고른 위치입니다. 내보내기에도 수동으로 표시됩니다.');
    }
    if (fix.locationSource === 'demo') {
      warnings.push('실내 시연용 좌표입니다. 실제 현장 기록이 아니라고 표시됩니다.');
    }
    return { ok: true, warnings: warnings, stale: stale, thresholds: t };
  }

  function sourceLabel(source) {
    if (source === 'gps') return 'GPS 측정';
    if (source === 'manual') return '지도에서 직접 선택';
    if (source === 'demo') return '실내 시연 좌표';
    return '알 수 없음';
  }

  /**
   * 실제로 적용할 중복 판정 반경(m).
   * 고정값만 쓰면 안 된다. 휴대폰 GPS 오차가 보통 3~10m이고 하천변·나무 밑에서는 더 커지므로,
   * 설정값이 오차보다 작으면 같은 포기를 다시 찍어도 '다른 자리'로 들어온다.
   * 그래서 설정값과 이번 측정 정확도 중 큰 값을 쓴다.
   */
  function effectiveDuplicateRadius(fix) {
    var t = thresholds();
    var accuracy = fix && typeof fix.accuracyMeters === 'number' ? fix.accuracyMeters : 0;
    return Math.max(t.duplicateRadiusM, accuracy);
  }

  /** 같은 이름을 가까운 거리에서 다시 저장하려는지 확인한다. 자동 삭제는 하지 않는다. */
  function findNearbyDuplicates(fix, name, observations) {
    if (!fix || !name) return [];
    var radius = effectiveDuplicateRadius(fix);
    return (observations || []).filter(function (obs) {
      if (!obs || obs.confirmedName !== name) return false;
      return distanceMeters(fix, { lat: obs.lat, lng: obs.lng }) <= radius;
    }).sort(function (a, b) {
      return distanceMeters(fix, { lat: a.lat, lng: a.lng }) - distanceMeters(fix, { lat: b.lat, lng: b.lng });
    });
  }

  global.BibimLocation = {
    DEFAULTS: DEFAULTS,
    JEONJU_CENTER: JEONJU_CENTER,
    thresholds: thresholds,
    isValidCoord: isValidCoord,
    distanceMeters: distanceMeters,
    effectiveDuplicateRadius: effectiveDuplicateRadius,
    acquire: acquire,
    manualFix: manualFix,
    demoFix: demoFix,
    review: review,
    sourceLabel: sourceLabel,
    findNearbyDuplicates: findNearbyDuplicates
  };
})(window);
