/* 서비스 워커 — 앱을 기기에 담아 인터넷 없이도 열리게 한다.
 *
 * 현장조사 앱인데 하천변에서 데이터가 끊기면 페이지 자체가 안 열리던 문제를 막는다.
 * 지도 그림은 원래부터 간이 좌표판으로 내려가고, GPS는 인터넷 없이 동작한다.
 *
 * 캐시하는 것: 이 저장소의 파일(앱 껍데기)뿐이다.
 * 캐시하지 않는 것:
 *   - OpenStreetMap 타일 — 타일 정책이 미리 받기·대량 내려받기를 금지한다.
 *   - Leaflet CDN, Pl@ntNet, Google 지도 — 바깥 주소는 아예 건드리지 않고 그대로 통과시킨다.
 *
 * VERSION 은 src/app.js 의 BUILD 와 같이 올린다. 값이 바뀌면 기기가 새 파일을 받는다.
 */
'use strict';

var VERSION = '2026-10-28.8';
var CACHE = 'bibimbot-shell-' + VERSION;

// 앱이 열리는 데 필요한 파일 전부. 하나라도 빠지면 오프라인에서 깨진다.
var PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'styles.css',
  'src/plants.js',
  'src/catalog.js',
  'src/storage.js',
  'src/location.js',
  'src/photo.js',
  'src/exif.js',
  'src/identify.js',
  'src/map.js',
  'src/export.js',
  'src/app.js',
  'images/sicyos-angulatus.svg',
  'images/ambrosia-trifida.svg',
  'images/symphyotrichum-pilosum.svg',
  'images/aster-yomena.svg',
  'images/icon-192.png',
  'images/icon-512.png',
  'images/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // 한 장이라도 실패하면 설치를 실패시킨다. 반쯤 담긴 캐시가 더 위험하다.
      return cache.addAll(PRECACHE);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return key === CACHE ? null : caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

/** 캐시를 먼저 주고, 뒤에서 새 파일을 받아 다음 실행에 쓴다. */
function staleWhileRevalidate(request) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(request).then(function (cached) {
      var network = fetch(request).then(function (response) {
        if (response && response.ok && response.type === 'basic') {
          cache.put(request, response.clone());
        }
        return response;
      }).catch(function () {
        return null;
      });
      // 캐시에 있으면 네트워크를 기다리지 않는다. 없으면 네트워크를 기다린다.
      return cached || network.then(function (response) {
        if (response) return response;
        throw new Error('offline and not cached');
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url;
  try { url = new URL(request.url); } catch (err) { void err; return; }

  // 바깥 주소(타일·CDN·식별 API)는 손대지 않는다.
  if (url.origin !== self.location.origin) return;

  // 주소창으로 들어오는 요청은 항상 앱 껍데기를 준다.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE).then(function (cache) {
        return cache.match('index.html').then(function (cached) {
          if (cached) return cached;
          return fetch(request);
        });
      })
    );
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
