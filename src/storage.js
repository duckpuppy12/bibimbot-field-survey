/* 저장소 (PRD 10절) — 기록·사진은 IndexedDB, 작은 설정만 localStorage.
 * 저장 실패를 성공으로 표시하지 않는 것이 이 모듈의 가장 중요한 약속이다(PRD 13절).
 */
(function (global) {
  'use strict';

  var DB_NAME = 'bibimbot-field';
  var DB_VERSION = 1;
  var SCHEMA_VERSION = 1;
  var LEGACY_KEY = 'bibimbot-field-v2';
  var SETTINGS_PREFIX = 'bibimbot.setting.';

  var STORE = {
    surveys: 'surveys',
    observations: 'observations',
    photos: 'photos',
    teamPlants: 'teamPlants',
    meta: 'meta'
  };

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error('이 브라우저에서 IndexedDB를 쓸 수 없습니다.'));
        return;
      }
      var req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (event) {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE.surveys)) {
          db.createObjectStore(STORE.surveys, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE.observations)) {
          var obs = db.createObjectStore(STORE.observations, { keyPath: 'id' });
          obs.createIndex('surveyId', 'surveyId', { unique: false });
          obs.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE.photos)) {
          var photos = db.createObjectStore(STORE.photos, { keyPath: 'id' });
          photos.createIndex('observationId', 'observationId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE.teamPlants)) {
          db.createObjectStore(STORE.teamPlants, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE.meta)) {
          db.createObjectStore(STORE.meta, { keyPath: 'key' });
        }
        void event;
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('데이터베이스를 열 수 없습니다.')); };
      req.onblocked = function () { reject(new Error('다른 탭이 이 앱을 열고 있어 저장소를 갱신할 수 없습니다.')); };
    });
    return dbPromise;
  }

  function tx(storeNames, mode, work) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction;
        try {
          transaction = db.transaction(storeNames, mode);
        } catch (err) {
          reject(err);
          return;
        }
        var result;
        transaction.oncomplete = function () { resolve(result); };
        transaction.onabort = function () { reject(describeError(transaction.error)); };
        transaction.onerror = function () { reject(describeError(transaction.error)); };
        try {
          result = work(transaction);
        } catch (err) {
          try { transaction.abort(); } catch (ignore) { void ignore; }
          reject(err);
        }
      });
    });
  }

  function describeError(err) {
    if (!err) return new Error('저장 중 알 수 없는 오류가 났습니다.');
    if (err.name === 'QuotaExceededError' || err.code === 22) {
      var quota = new Error('저장 공간이 부족해 저장하지 못했습니다. 내보내기 후 사진을 정리해 주세요.');
      quota.name = 'QuotaExceededError';
      return quota;
    }
    return err;
  }

  function reqToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(describeError(request.error)); };
    });
  }

  function getAll(storeName) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var store = db.transaction(storeName, 'readonly').objectStore(storeName);
        var req = store.getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(describeError(req.error)); };
      });
    });
  }

  function getOne(storeName, key) {
    return openDb().then(function (db) {
      var store = db.transaction(storeName, 'readonly').objectStore(storeName);
      return reqToPromise(store.get(key));
    });
  }

  function put(storeName, value) {
    return tx([storeName], 'readwrite', function (t) {
      t.objectStore(storeName).put(value);
      return value;
    });
  }

  function del(storeName, key) {
    return tx([storeName], 'readwrite', function (t) {
      t.objectStore(storeName).delete(key);
    });
  }

  /* ── 설정 (작은 값만 localStorage) ───────────────────────────── */

  function getSetting(key, fallback) {
    try {
      var raw = global.localStorage.getItem(SETTINGS_PREFIX + key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      void err;
      return fallback;
    }
  }

  function setSetting(key, value) {
    try {
      global.localStorage.setItem(SETTINGS_PREFIX + key, JSON.stringify(value));
      return true;
    } catch (err) {
      void err;
      return false;   // 사생활 보호 모드 등에서 실패할 수 있다. 성공으로 보고하지 않는다.
    }
  }

  function removeSetting(key) {
    try { global.localStorage.removeItem(SETTINGS_PREFIX + key); } catch (err) { void err; }
  }

  /* ── 조사(Survey) ───────────────────────────────────────────── */

  function saveSurvey(survey) {
    survey.schemaVersion = SCHEMA_VERSION;
    return put(STORE.surveys, survey);
  }

  function listSurveys() {
    return getAll(STORE.surveys);
  }

  function getSurvey(id) {
    return getOne(STORE.surveys, id);
  }

  /* ── 기록(Observation) + 사진 ───────────────────────────────── */

  /**
   * 기록과 사진을 한 트랜잭션으로 저장한다. 사진 저장이 실패하면 기록도 함께
   * 롤백되므로 '사진 없는 성공'을 사용자에게 성공으로 보여 주지 않는다.
   */
  function saveObservation(observation, photos) {
    var list = photos || [];
    return tx([STORE.observations, STORE.photos], 'readwrite', function (t) {
      t.objectStore(STORE.observations).put(observation);
      var photoStore = t.objectStore(STORE.photos);
      list.forEach(function (photo) { photoStore.put(photo); });
      return observation;
    });
  }

  function updateObservation(observation) {
    observation.updatedAt = new Date().toISOString();
    return put(STORE.observations, observation);
  }

  function listObservations() {
    return getAll(STORE.observations).then(function (rows) {
      return rows.sort(function (a, b) {
        return String(b.createdAt).localeCompare(String(a.createdAt));
      });
    });
  }

  function getObservation(id) {
    return getOne(STORE.observations, id);
  }

  function deleteObservation(id) {
    return listPhotosFor(id).then(function (photos) {
      return tx([STORE.observations, STORE.photos], 'readwrite', function (t) {
        t.objectStore(STORE.observations).delete(id);
        var photoStore = t.objectStore(STORE.photos);
        photos.forEach(function (p) { photoStore.delete(p.id); });
      });
    });
  }

  function listPhotosFor(observationId) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var store = db.transaction(STORE.photos, 'readonly').objectStore(STORE.photos);
        var index = store.index('observationId');
        var req = index.getAll(observationId);
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(describeError(req.error)); };
      });
    });
  }

  function getPhoto(id) {
    return getOne(STORE.photos, id);
  }

  function listAllPhotos() {
    return getAll(STORE.photos);
  }

  function countPhotos() {
    return openDb().then(function (db) {
      var store = db.transaction(STORE.photos, 'readonly').objectStore(STORE.photos);
      return reqToPromise(store.count());
    });
  }

  function deletePhoto(id) {
    return del(STORE.photos, id);
  }

  /* ── 팀 임시 도감 항목 (FR-11) ──────────────────────────────── */

  function listTeamPlants() {
    return getAll(STORE.teamPlants);
  }

  function saveTeamPlant(plant) {
    return put(STORE.teamPlants, plant);
  }

  function deleteTeamPlant(id) {
    return del(STORE.teamPlants, id);
  }

  /* ── 메타 ───────────────────────────────────────────────────── */

  function getMeta(key, fallback) {
    return getOne(STORE.meta, key).then(function (row) {
      return row ? row.value : fallback;
    });
  }

  function setMeta(key, value) {
    return put(STORE.meta, { key: key, value: value });
  }

  /* ── 기존 localStorage 데이터 마이그레이션 (PRD 10절) ───────── */

  function readLegacy() {
    try {
      var raw = global.localStorage.getItem(LEGACY_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      var rows = Array.isArray(parsed) ? parsed : (parsed && parsed.records) || [];
      return Array.isArray(rows) ? rows : null;
    } catch (err) {
      void err;
      return null;
    }
  }

  /**
   * 기존 데이터를 IndexedDB로 옮긴다. 건수를 대조하고, 실패하면 기존
   * localStorage 값을 지우지 않는다(PRD 10절).
   */
  function migrateLegacy(mapRow) {
    var rows = readLegacy();
    if (!rows || !rows.length) {
      return Promise.resolve({ migrated: 0, skipped: 0, status: 'nothing-to-migrate' });
    }
    return getMeta('legacyMigratedAt', null).then(function (done) {
      if (done) return { migrated: 0, skipped: rows.length, status: 'already-migrated' };
      var mapped = rows.map(mapRow).filter(Boolean);
      return listObservations().then(function (existing) {
        var existingIds = {};
        existing.forEach(function (o) { existingIds[o.id] = true; });
        var toInsert = mapped.filter(function (o) { return !existingIds[o.id]; });
        return tx([STORE.observations], 'readwrite', function (t) {
          var store = t.objectStore(STORE.observations);
          toInsert.forEach(function (o) { store.put(o); });
        }).then(function () {
          return listObservations();
        }).then(function (after) {
          var expected = existing.length + toInsert.length;
          if (after.length !== expected) {
            throw new Error('마이그레이션 건수가 맞지 않습니다(기대 ' + expected + ', 실제 ' + after.length + '). 기존 데이터는 그대로 두었습니다.');
          }
          return setMeta('legacyMigratedAt', new Date().toISOString()).then(function () {
            return {
              migrated: toInsert.length,
              skipped: mapped.length - toInsert.length,
              status: 'ok'
            };
          });
        });
      });
    });
  }

  function estimateUsage() {
    if (global.navigator && global.navigator.storage && global.navigator.storage.estimate) {
      return global.navigator.storage.estimate().catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  function clearAll() {
    return tx([STORE.observations, STORE.photos, STORE.surveys, STORE.teamPlants], 'readwrite', function (t) {
      t.objectStore(STORE.observations).clear();
      t.objectStore(STORE.photos).clear();
      t.objectStore(STORE.surveys).clear();
      t.objectStore(STORE.teamPlants).clear();
    });
  }

  global.BibimStorage = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    LEGACY_KEY: LEGACY_KEY,
    openDb: openDb,
    getSetting: getSetting,
    setSetting: setSetting,
    removeSetting: removeSetting,
    saveSurvey: saveSurvey,
    listSurveys: listSurveys,
    getSurvey: getSurvey,
    saveObservation: saveObservation,
    updateObservation: updateObservation,
    listObservations: listObservations,
    getObservation: getObservation,
    deleteObservation: deleteObservation,
    listPhotosFor: listPhotosFor,
    listAllPhotos: listAllPhotos,
    countPhotos: countPhotos,
    getPhoto: getPhoto,
    deletePhoto: deletePhoto,
    listTeamPlants: listTeamPlants,
    saveTeamPlant: saveTeamPlant,
    deleteTeamPlant: deleteTeamPlant,
    getMeta: getMeta,
    setMeta: setMeta,
    readLegacy: readLegacy,
    migrateLegacy: migrateLegacy,
    estimateUsage: estimateUsage,
    clearAll: clearAll
  };
})(window);
