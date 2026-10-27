/* 내보내기와 백업/복원 (PRD 10절 FR-08/FR-12) */
(function (global) {
  'use strict';

  var APP_ID = 'bibimbot-field-survey';
  var BACKUP_SCHEMA_VERSION = 1;

  var LOCATION_SOURCES = ['gps', 'manual', 'demo'];
  var REMOVAL_STATUSES = ['unresolved', 'reported', 'removed'];
  // 'photo-api' 는 Pl@ntNet 사진 식별. PRD 8절의 세 값에 더해 쓴다.
  var ID_METHODS = ['lens-manual', 'manual', 'team-model', 'photo-api'];

  /* ── CSV ────────────────────────────────────────────────────── */

  // 엑셀이 수식으로 읽을 수 있는 시작 문자를 막는다.
  function guardFormula(value) {
    var s = String(value == null ? '' : value);
    if (/^[=+\-@\t\r]/.test(s)) return "'" + s;
    return s;
  }

  function csvCell(value) {
    var s = guardFormula(value);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  var CSV_COLUMNS = [
    { key: 'id', label: '기록ID' },
    { key: 'surveyTitle', label: '조사명' },
    { key: 'placeLabel', label: '조사장소' },
    { key: 'enteredName', label: '입력이름' },
    { key: 'confirmedName', label: '확정이름' },
    { key: 'categoryLabel', label: '분류' },
    { key: 'designated', label: '법정지정' },
    { key: 'identificationMethod', label: '식별방법' },
    { key: 'verificationStatus', label: '검증상태' },
    { key: 'lat', label: '위도' },
    { key: 'lng', label: '경도' },
    { key: 'accuracyMeters', label: '정확도_m' },
    { key: 'locationSourceLabel', label: '좌표출처' },
    { key: 'isDemo', label: '시연기록' },
    { key: 'locationCapturedAt', label: '좌표획득시각' },
    { key: 'removalStatusLabel', label: '처리상태' },
    { key: 'removedAt', label: '제거시각' },
    { key: 'photoCount', label: '사진수' },
    { key: 'note', label: '메모' },
    { key: 'createdAt', label: '기록시각' },
    { key: 'updatedAt', label: '수정시각' },
    { key: 'catalogVersion', label: '도감버전' }
  ];

  function flatten(obs, context) {
    var catalog = global.BibimCatalog;
    var meta = catalog.categoryMeta(obs.categorySnapshot);
    var survey = (context && context.survey) || {};
    return {
      id: obs.id,
      surveyTitle: survey.title || '',
      placeLabel: survey.placeLabel || '',
      enteredName: obs.enteredName || '',
      confirmedName: obs.confirmedName || '',
      categoryLabel: meta.label,
      designated: obs.categorySnapshot === 'invasive-designated' ? '지정' : '비지정',
      identificationMethod: obs.identificationMethod || '',
      verificationStatus: obs.verificationStatus || '',
      lat: typeof obs.lat === 'number' ? obs.lat.toFixed(6) : '',
      lng: typeof obs.lng === 'number' ? obs.lng.toFixed(6) : '',
      accuracyMeters: typeof obs.accuracyMeters === 'number' ? obs.accuracyMeters : '',
      locationSourceLabel: global.BibimLocation.sourceLabel(obs.locationSource),
      isDemo: obs.locationSource === 'demo' ? '시연기록' : '',
      locationCapturedAt: obs.locationCapturedAt || '',
      removalStatusLabel: (catalog.REMOVAL_STATUS[obs.removalStatus] || { label: '' }).label,
      removedAt: obs.removedAt || '',
      photoCount: (obs.photoIds || []).length,
      note: obs.note || '',
      createdAt: obs.createdAt || '',
      updatedAt: obs.updatedAt || '',
      catalogVersion: obs.catalogVersion || ''
    };
  }

  function toCsv(observations, context) {
    var header = CSV_COLUMNS.map(function (c) { return csvCell(c.label); }).join(',');
    var rows = (observations || []).map(function (obs) {
      var flat = flatten(obs, context);
      return CSV_COLUMNS.map(function (c) { return csvCell(flat[c.key]); }).join(',');
    });
    // UTF-8 BOM: 엑셀에서 한글이 깨지지 않게 한다.
    return '﻿' + [header].concat(rows).join('\r\n') + '\r\n';
  }

  /* ── GeoJSON ────────────────────────────────────────────────── */

  function toGeoJson(observations, context) {
    var features = (observations || [])
      .filter(function (obs) { return global.BibimLocation.isValidCoord(obs.lat, obs.lng); })
      .map(function (obs) {
        var flat = flatten(obs, context);
        return {
          type: 'Feature',
          // GeoJSON 좌표 순서는 [경도, 위도]다.
          geometry: { type: 'Point', coordinates: [Number(obs.lng), Number(obs.lat)] },
          properties: {
            id: obs.id,
            name: flat.confirmedName,
            enteredName: flat.enteredName,
            category: obs.categorySnapshot,
            categoryLabel: flat.categoryLabel,
            designated: obs.categorySnapshot === 'invasive-designated',
            identificationMethod: flat.identificationMethod,
            verificationStatus: flat.verificationStatus,
            accuracyMeters: obs.accuracyMeters === null ? null : obs.accuracyMeters,
            locationSource: obs.locationSource,
            isDemoRecord: obs.locationSource === 'demo',
            locationCapturedAt: flat.locationCapturedAt,
            removalStatus: obs.removalStatus,
            removedAt: obs.removedAt || null,
            photoCount: flat.photoCount,
            note: flat.note,
            createdAt: flat.createdAt,
            catalogVersion: flat.catalogVersion,
            surveyTitle: flat.surveyTitle,
            placeLabel: flat.placeLabel
          }
        };
      });
    // 사진 바이너리와 지도 API 키는 넣지 않는다.
    return JSON.stringify({ type: 'FeatureCollection', features: features }, null, 2);
  }

  /* ── 보고문 ─────────────────────────────────────────────────── */

  function toReportText(observations, context) {
    var catalog = global.BibimCatalog;
    var survey = (context && context.survey) || {};
    var list = observations || [];
    var byCategory = {};
    list.forEach(function (obs) {
      var key = obs.categorySnapshot || 'needs-check';
      byCategory[key] = (byCategory[key] || 0) + 1;
    });

    var dates = list.map(function (o) { return o.createdAt; }).filter(Boolean).sort();
    var period = dates.length
      ? formatDate(dates[0]) + ' ~ ' + formatDate(dates[dates.length - 1])
      : '기록 없음';

    var lines = [];
    lines.push('[토종 지킴이 비빔봇 현장조사 결과]');
    lines.push('조사명: ' + (survey.title || '이름 없는 조사'));
    lines.push('조사 장소: ' + (survey.placeLabel || '미입력'));
    lines.push('조사 기간: ' + period);
    lines.push('총 기록: ' + list.length + '건');
    lines.push('');
    lines.push('분류별 건수');
    ['invasive-designated', 'alien-unlisted', 'native', 'needs-check'].forEach(function (key) {
      lines.push('- ' + catalog.categoryMeta(key).label + ': ' + (byCategory[key] || 0) + '건');
    });

    var demoCount = list.filter(function (o) { return o.locationSource === 'demo'; }).length;
    var manualCount = list.filter(function (o) { return o.locationSource === 'manual'; }).length;
    if (demoCount || manualCount) {
      lines.push('');
      lines.push('좌표 출처 참고');
      if (manualCount) lines.push('- 지도에서 직접 선택한 기록: ' + manualCount + '건');
      if (demoCount) lines.push('- 실내 시연 좌표 기록(실제 현장 아님): ' + demoCount + '건');
    }

    var invasive = list.filter(function (o) { return o.categorySnapshot === 'invasive-designated'; });
    if (invasive.length) {
      lines.push('');
      lines.push('현장 확인을 요청하는 생태계교란 생물 위치');
      invasive.slice(0, 30).forEach(function (obs, i) {
        lines.push(
          (i + 1) + '. ' + (obs.confirmedName || obs.enteredName) +
          ' / ' + Number(obs.lat).toFixed(6) + ', ' + Number(obs.lng).toFixed(6) +
          ' / ' + global.BibimLocation.sourceLabel(obs.locationSource) +
          (obs.locationSource === 'demo' ? ' (시연 기록)' : '') +
          ' / ' + formatDate(obs.createdAt)
        );
      });
      if (invasive.length > 30) lines.push('... 외 ' + (invasive.length - 30) + '건은 CSV를 확인해 주세요.');
    }

    lines.push('');
    lines.push('도감 버전: ' + catalog.catalogVersion() + ' (목록은 공식 자료로 재검토가 필요합니다)');
    lines.push('이 문서는 학생이 조사한 기록이며, 분류는 전문가 확인 전 참고 자료입니다.');
    return lines.join('\n');
  }

  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ── JSON 백업 / 복원 ───────────────────────────────────────── */

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new global.FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('사진을 읽지 못했습니다.')); };
      reader.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(dataUrl) {
    var match = /^data:([^;,]+)?(;base64)?,/.exec(dataUrl || '');
    if (!match) throw new Error('사진 데이터 형식이 올바르지 않습니다.');
    var mime = match[1] || 'application/octet-stream';
    var body = dataUrl.slice(match[0].length);
    if (match[2]) {
      var binary = global.atob(body);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new global.Blob([bytes], { type: mime });
    }
    return new global.Blob([decodeURIComponent(body)], { type: mime });
  }

  function buildBackup(payload, includePhotos) {
    var photosPromise = includePhotos
      ? Promise.all((payload.photos || []).map(function (photo) {
        return blobToDataUrl(photo.blob).then(function (dataUrl) {
          return {
            id: photo.id,
            observationId: photo.observationId,
            mimeType: photo.mimeType,
            width: photo.width,
            height: photo.height,
            createdAt: photo.createdAt,
            dataUrl: dataUrl
          };
        });
      }))
      : Promise.resolve([]);

    return photosPromise.then(function (photos) {
      return {
        app: APP_ID,
        schemaVersion: BACKUP_SCHEMA_VERSION,
        catalogVersion: global.BibimCatalog.catalogVersion(),
        exportedAt: new Date().toISOString(),
        includesPhotos: !!includePhotos,
        surveys: payload.surveys || [],
        observations: payload.observations || [],
        teamPlants: payload.teamPlants || [],
        photos: photos
      };
    });
  }

  /** 복원 전 형식·좌표·열거형 값을 검증한다. 하나라도 틀리면 복원하지 않는다. */
  function validateBackup(raw) {
    var errors = [];
    var data;
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
      void err;
      return { ok: false, errors: ['JSON 형식이 아닙니다.'] };
    }
    if (!data || typeof data !== 'object') return { ok: false, errors: ['백업 내용을 읽을 수 없습니다.'] };
    if (data.app !== APP_ID) errors.push('이 앱의 백업 파일이 아닙니다.');
    if (typeof data.schemaVersion !== 'number') errors.push('schemaVersion이 없습니다.');
    else if (data.schemaVersion > BACKUP_SCHEMA_VERSION) {
      errors.push('더 새로운 버전의 백업입니다(파일 ' + data.schemaVersion + ', 앱 ' + BACKUP_SCHEMA_VERSION + ').');
    }
    if (!Array.isArray(data.observations)) errors.push('기록 목록이 배열이 아닙니다.');
    if (data.photos && !Array.isArray(data.photos)) errors.push('사진 목록이 배열이 아닙니다.');

    if (Array.isArray(data.observations)) {
      data.observations.forEach(function (obs, i) {
        var where = '기록 ' + (i + 1) + '번: ';
        if (!obs || typeof obs.id !== 'string' || !obs.id) errors.push(where + 'id가 없습니다.');
        if (!global.BibimLocation.isValidCoord(obs && obs.lat, obs && obs.lng)) {
          errors.push(where + '좌표 범위가 올바르지 않습니다.');
        }
        if (obs && LOCATION_SOURCES.indexOf(obs.locationSource) === -1) {
          errors.push(where + '좌표 출처 값이 올바르지 않습니다.');
        }
        if (obs && REMOVAL_STATUSES.indexOf(obs.removalStatus) === -1) {
          errors.push(where + '처리 상태 값이 올바르지 않습니다.');
        }
        if (obs && obs.identificationMethod && ID_METHODS.indexOf(obs.identificationMethod) === -1) {
          errors.push(where + '식별 방법 값이 올바르지 않습니다.');
        }
        if (obs && !global.BibimCatalog.CATEGORIES[obs.categorySnapshot]) {
          errors.push(where + '분류 값이 올바르지 않습니다.');
        }
      });
    }
    if (errors.length > 12) errors = errors.slice(0, 12).concat(['... 그 밖에도 오류가 있습니다.']);
    return { ok: errors.length === 0, errors: errors, data: data };
  }

  /** 복원 결과를 저장소에 적용할 형태로 바꾼다. 사진은 Blob으로 되살린다. */
  function prepareRestore(data) {
    var photos = (data.photos || []).map(function (p) {
      return {
        id: p.id,
        observationId: p.observationId,
        blob: dataUrlToBlob(p.dataUrl),
        mimeType: p.mimeType || 'image/jpeg',
        width: p.width || null,
        height: p.height || null,
        createdAt: p.createdAt || new Date().toISOString()
      };
    });
    return {
      surveys: data.surveys || [],
      observations: data.observations || [],
      teamPlants: data.teamPlants || [],
      photos: photos
    };
  }

  /* ── 파일 저장 ──────────────────────────────────────────────── */

  function download(filename, text, mimeType) {
    var blob = new global.Blob([text], { type: (mimeType || 'text/plain') + ';charset=utf-8' });
    var url = global.URL.createObjectURL(blob);
    var link = global.document.createElement('a');
    link.href = url;
    link.download = filename;
    global.document.body.appendChild(link);
    link.click();
    global.document.body.removeChild(link);
    global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 2000);
  }

  function stamp() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function approximateSize(text) {
    var bytes = new global.Blob([text]).size;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  global.BibimExport = {
    APP_ID: APP_ID,
    BACKUP_SCHEMA_VERSION: BACKUP_SCHEMA_VERSION,
    CSV_COLUMNS: CSV_COLUMNS,
    csvCell: csvCell,
    toCsv: toCsv,
    toGeoJson: toGeoJson,
    toReportText: toReportText,
    buildBackup: buildBackup,
    validateBackup: validateBackup,
    prepareRestore: prepareRestore,
    blobToDataUrl: blobToDataUrl,
    dataUrlToBlob: dataUrlToBlob,
    download: download,
    stamp: stamp,
    approximateSize: approximateSize,
    formatDate: formatDate
  };
})(window);
