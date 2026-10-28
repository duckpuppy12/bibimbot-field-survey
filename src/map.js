/* 지도 (PRD 9절·11절)
 *
 * 지도 백엔드는 세 단계로 내려간다.
 *   1) osm      — Leaflet + OpenStreetMap 타일. 키도 결제도 필요 없다. 기본값.
 *   2) google   — 교사가 Maps JavaScript API 키를 넣었을 때만.
 *   3) fallback — 둘 다 안 되면 간이 좌표판(지도 아님)으로 좌표 선택만 유지한다.
 *
 * 지도 실패가 기록을 지우는 일은 절대 없다.
 *
 * OSM 타일 정책(operations.osmfoundation.org/policies/tiles)에 따라
 *   - 저작자 표시를 화면에 보이게 두고 숨기지 않는다
 *   - 화면에 보이는 타일만 받고 미리 받기·대량 내려받기를 하지 않는다
 *   - https 주소를 쓰고 캐시 헤더를 그대로 따른다
 * 를 지킨다.
 */
(function (global) {
  'use strict';

  var CALLBACK_NAME = '__bibimMapReady';
  var googleState = { promise: null, status: 'idle', error: null };
  var leafletState = { promise: null };

  var LEAFLET_VERSION = '1.9.4';
  var LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/' + LEAFLET_VERSION + '/leaflet.js';
  var LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/' + LEAFLET_VERSION + '/leaflet.css';
  var OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  var OSM_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 기여자';

  var TONE_COLOR = {
    red: '#d92d20',
    yellow: '#dc9100',
    green: '#17864a',
    purple: '#7a3dbd',
    gray: '#6b7280'
  };

  function mapsError(kind, message, hints) {
    var err = new Error(message);
    err.kind = kind;
    err.hints = hints || [];
    return err;
  }

  var AUTH_HINTS = [
    'Google Cloud 프로젝트에서 Maps JavaScript API를 활성화했는지',
    '해당 프로젝트에 결제 계정을 연결했는지',
    'API 키의 웹사이트(HTTP 리퍼러) 제한에 이 앱의 주소가 들어 있는지',
    'API 키의 API 제한에 Maps JavaScript API가 들어 있는지',
    '키를 복사할 때 앞뒤 공백이 섞이지 않았는지'
  ];

  /* ── Leaflet 불러오기 ───────────────────────────────────────── */

  function loadLeaflet() {
    if (global.L) return Promise.resolve(global.L);
    if (leafletState.promise) return leafletState.promise;
    leafletState.promise = new Promise(function (resolve, reject) {
      var link = global.document.createElement('link');
      link.rel = 'stylesheet';
      link.href = LEAFLET_CSS;
      global.document.head.appendChild(link);

      var script = global.document.createElement('script');
      script.src = LEAFLET_JS;
      script.async = true;
      script.onload = function () {
        if (global.L) resolve(global.L);
        else reject(mapsError('leaflet', '지도 라이브러리를 읽지 못했습니다.', []));
      };
      script.onerror = function () {
        leafletState.promise = null;
        reject(mapsError('network', '지도 라이브러리를 내려받지 못했습니다. 인터넷 연결을 확인해 주세요.', []));
      };
      global.document.head.appendChild(script);
    });
    return leafletState.promise;
  }

  /* ── Google Maps 불러오기 ──────────────────────────────────── */

  function loadGoogle(apiKey) {
    if (googleState.promise) return googleState.promise;
    if (!apiKey) {
      googleState.status = 'no-key';
      googleState.error = mapsError('no-key', '지도 API 키가 없습니다.', []);
      return Promise.reject(googleState.error);
    }
    googleState.status = 'loading';
    googleState.promise = new Promise(function (resolve, reject) {
      var done = false;

      function fail(err) {
        if (done) return;
        done = true;
        googleState.status = 'error';
        googleState.error = err;
        googleState.promise = null;    // 키를 고친 뒤 다시 시도할 수 있게 둔다.
        reject(err);
      }

      global.gm_authFailure = function () {
        fail(mapsError('auth', '지도 인증이 거부되었습니다. 아래 항목을 차례로 확인해 주세요.', AUTH_HINTS));
      };

      global[CALLBACK_NAME] = function () {
        if (done) return;
        done = true;
        googleState.status = 'ready';
        resolve(global.google.maps);
      };

      var params = [
        'key=' + encodeURIComponent(apiKey),
        'v=weekly',
        'libraries=marker',
        'language=ko',
        'region=KR',
        'loading=async',
        'callback=' + CALLBACK_NAME
      ];
      var script = global.document.createElement('script');
      script.src = 'https://maps.googleapis.com/maps/api/js?' + params.join('&');
      script.async = true;
      script.onerror = function () {
        fail(mapsError('network', '지도 파일을 내려받지 못했습니다. 인터넷 연결을 확인해 주세요.',
          ['와이파이·데이터 연결 상태', '학교 방화벽이 maps.googleapis.com을 막고 있는지']));
      };
      global.document.head.appendChild(script);

      global.setTimeout(function () {
        if (!done) fail(mapsError('timeout', '지도가 응답하지 않습니다. 연결과 키 설정을 확인해 주세요.', AUTH_HINTS));
      }, 20000);
    });
    return googleState.promise;
  }

  function status() {
    return { status: googleState.status, error: googleState.error };
  }

  /* ── 지도 뷰 ────────────────────────────────────────────────── */

  function create(options) {
    var container = options.container;
    var onPick = options.onPickCoordinate || function () {};
    var onSelect = options.onSelectObservation || function () {};

    var state = {
      backend: 'none',
      map: null,
      maps: null,          // google.maps
      L: null,             // Leaflet
      layer: null,         // Leaflet 마커 레이어
      markers: [],
      meMarker: null,
      accuracyCircle: null,
      pickMode: false,
      follow: true,
      observations: [],
      current: null,
      colorOf: options.colorOf || function () { return TONE_COLOR.gray; },
      labelOf: options.labelOf || function (o) { return o.confirmedName || '기록'; }
    };

    function center() {
      return state.current && global.BibimLocation.isValidCoord(state.current.lat, state.current.lng)
        ? { lat: state.current.lat, lng: state.current.lng }
        : global.BibimLocation.JEONJU_CENTER;
    }

    /** 키가 있으면 Google, 없으면 OSM. 실패하면 한 단계씩 내려간다. */
    function initAuto(apiKey, mapId) {
      if (apiKey) {
        return initGoogle(apiKey, mapId).catch(function (err) {
          return initOsm().then(function () {
            throw err;      // 지도는 떴지만 교사에게 구글 키 문제는 알려야 한다.
          });
        });
      }
      return initOsm();
    }

    /**
     * 이미 떠 있는 지도를 걷어낸다.
     * Leaflet 은 컨테이너에 _leaflet_id 를 심어 두기 때문에 innerHTML 만 비우고
     * 다시 L.map() 을 부르면 "Map container is already initialized" 로 터진다.
     * remove() 를 거쳐야 그 표시가 지워진다.
     */
    function teardownMap() {
      if (state.map && state.backend === 'osm' && state.map.remove) {
        try { state.map.remove(); } catch (err) { void err; }
      }
      clearMarkers();
      state.meMarker = null;
      if (state.accuracyCircle && state.accuracyCircle.setMap) {
        try { state.accuracyCircle.setMap(null); } catch (err) { void err; }
      }
      state.accuracyCircle = null;
      state.map = null;
      state.layer = null;
      container.innerHTML = '';
    }

    function initOsm() {
      return loadLeaflet().then(function (L) {
        state.L = L;
        container.classList.remove('is-fallback');
        teardownMap();
        var start = center();
        state.map = L.map(container, { zoomControl: true, attributionControl: true })
          .setView([start.lat, start.lng], 16);
        L.tileLayer(OSM_TILES, {
          attribution: OSM_ATTRIBUTION,
          maxZoom: 19,
          crossOrigin: true
        }).addTo(state.map);
        state.layer = L.layerGroup().addTo(state.map);

        state.map.on('click', function (event) {
          if (!state.pickMode) return;
          onPick(event.latlng.lat, event.latlng.lng);
        });
        state.map.on('dragstart', function () { state.follow = false; });

        state.backend = 'osm';
        render();
        return state.backend;
      }).catch(function (err) {
        state.backend = 'fallback';
        renderFallback(err);
        throw err;
      });
    }

    function initGoogle(apiKey, mapId) {
      return loadGoogle(apiKey).then(function (maps) {
        state.maps = maps;
        container.classList.remove('is-fallback');
        teardownMap();
        state.map = new maps.Map(container, {
          center: center(),
          zoom: 16,
          mapId: mapId || 'DEMO_MAP_ID',
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          clickableIcons: false
        });
        state.map.addListener('click', function (event) {
          if (!state.pickMode || !event.latLng) return;
          onPick(event.latLng.lat(), event.latLng.lng());
        });
        state.map.addListener('dragstart', function () { state.follow = false; });
        state.backend = 'google';
        render();
        return state.backend;
      });
    }

    function setObservations(list) {
      state.observations = list || [];
      render();
    }

    function setCurrentPosition(fix) {
      state.current = fix || null;
      render();
    }

    function setPickMode(on) {
      state.pickMode = !!on;
      container.classList.toggle('is-picking', state.pickMode);
    }

    function setFollow(on) { state.follow = !!on; }
    function isFollowing() { return state.follow; }
    function backend() { return state.backend; }

    function focus(lat, lng, zoom) {
      if (!state.map) return;
      if (state.backend === 'google') {
        state.map.setCenter({ lat: lat, lng: lng });
        if (zoom) state.map.setZoom(zoom);
      } else if (state.backend === 'osm') {
        state.map.setView([lat, lng], zoom || state.map.getZoom());
      }
    }

    function render() {
      if (state.backend === 'google' && state.map) renderGoogle();
      else if (state.backend === 'osm' && state.map) renderOsm();
      else if (state.backend === 'fallback') renderFallback(googleState.error);
    }

    /* ── OSM 그리기 ─────────────────────────────────────────── */

    function renderOsm() {
      var L = state.L;
      state.layer.clearLayers();

      state.observations.forEach(function (obs) {
        if (!global.BibimLocation.isValidCoord(obs.lat, obs.lng)) return;
        var marker = L.circleMarker([obs.lat, obs.lng], {
          radius: 9,
          color: '#ffffff',
          weight: 2,
          fillColor: state.colorOf(obs),
          fillOpacity: 1
        });
        marker.bindTooltip(state.labelOf(obs));
        marker.on('click', function () { onSelect(obs.id); });
        marker.addTo(state.layer);
      });

      if (state.current && global.BibimLocation.isValidCoord(state.current.lat, state.current.lng)) {
        var pos = [state.current.lat, state.current.lng];
        L.circleMarker(pos, {
          radius: 7, color: '#ffffff', weight: 2, fillColor: '#1d4ed8', fillOpacity: 1
        }).bindTooltip('내 위치').addTo(state.layer);

        if (typeof state.current.accuracyMeters === 'number' && state.current.accuracyMeters > 0) {
          L.circle(pos, {
            radius: state.current.accuracyMeters,
            color: '#1d4ed8', weight: 1, opacity: 0.5, fillColor: '#1d4ed8', fillOpacity: 0.12
          }).addTo(state.layer);
        }
        if (state.follow) state.map.setView(pos, state.map.getZoom());
      }
    }

    /* ── Google 그리기 ──────────────────────────────────────── */

    function clearMarkers() {
      state.markers.forEach(function (m) {
        if (m.setMap) m.setMap(null);
        else m.map = null;
      });
      state.markers = [];
    }

    function makeMarker(position, color, title, onClick) {
      var maps = state.maps;
      var marker;
      if (maps.marker && maps.marker.AdvancedMarkerElement) {
        var content = null;
        if (maps.marker.PinElement) {
          content = new maps.marker.PinElement({
            background: color, borderColor: '#ffffff', glyphColor: '#ffffff'
          }).element;
        }
        marker = new maps.marker.AdvancedMarkerElement({
          map: state.map, position: position, title: title, content: content || undefined
        });
        marker.addListener('click', onClick);
      } else {
        marker = new maps.Marker({
          map: state.map,
          position: position,
          title: title,
          icon: {
            path: maps.SymbolPath.CIRCLE, scale: 8,
            fillColor: color, fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2
          }
        });
        marker.addListener('click', onClick);
      }
      return marker;
    }

    function renderGoogle() {
      var maps = state.maps;
      clearMarkers();
      state.observations.forEach(function (obs) {
        if (!global.BibimLocation.isValidCoord(obs.lat, obs.lng)) return;
        state.markers.push(makeMarker(
          { lat: obs.lat, lng: obs.lng },
          state.colorOf(obs),
          state.labelOf(obs),
          function () { onSelect(obs.id); }
        ));
      });

      if (state.current && global.BibimLocation.isValidCoord(state.current.lat, state.current.lng)) {
        var pos = { lat: state.current.lat, lng: state.current.lng };
        if (state.meMarker) {
          if (state.meMarker.setPosition) state.meMarker.setPosition(pos);
          else state.meMarker.position = pos;
        } else {
          state.meMarker = makeMarker(pos, '#1d4ed8', '내 위치', function () {});
        }
        if (state.accuracyCircle) state.accuracyCircle.setMap(null);
        if (typeof state.current.accuracyMeters === 'number' && state.current.accuracyMeters > 0) {
          state.accuracyCircle = new maps.Circle({
            map: state.map, center: pos, radius: state.current.accuracyMeters,
            strokeColor: '#1d4ed8', strokeOpacity: 0.5, strokeWeight: 1,
            fillColor: '#1d4ed8', fillOpacity: 0.12
          });
        }
        if (state.follow) state.map.setCenter(pos);
      }
    }

    /* ── 간이 좌표판 ────────────────────────────────────────────
     * 지도 그림이 없을 뿐, GPS는 인터넷 없이도 동작한다. 그래서 이 화면에서도
     * 기록·핀 확인·좌표 선택이 모두 된다. 지도가 아니라는 점은 분명히 적는다.
     * 거리 눈금과 방위를 넣어 핀 사이 간격을 눈으로 가늠할 수 있게 했다.
     */

    var PLOT_W = 320, PLOT_H = 320, PLOT_PAD = 24;
    var plotFrame = null;      // 탭한 자리를 좌표로 되돌릴 때 쓴다.

    function renderFallback(err) {
      var points = state.observations.filter(function (o) {
        return global.BibimLocation.isValidCoord(o.lat, o.lng);
      });
      var hasMe = state.current && global.BibimLocation.isValidCoord(state.current.lat, state.current.lng);
      if (hasMe) points = points.concat([{ lat: state.current.lat, lng: state.current.lng }]);

      var box = bounds(points);
      plotFrame = box;

      function toX(lng) {
        if (box.spanLng === 0) return PLOT_W / 2;
        return PLOT_PAD + ((lng - box.minLng) / box.spanLng) * (PLOT_W - PLOT_PAD * 2);
      }
      function toY(lat) {
        if (box.spanLat === 0) return PLOT_H / 2;
        return PLOT_H - PLOT_PAD - ((lat - box.minLat) / box.spanLat) * (PLOT_H - PLOT_PAD * 2);
      }

      var parts = [];
      parts.push('<rect x="0" y="0" width="' + PLOT_W + '" height="' + PLOT_H + '" fill="#f3f4f6" />');
      parts.push(gridLines());

      // 내 위치 정확도 원을 먼저 깔아 핀이 가리지 않게 한다.
      if (hasMe && typeof state.current.accuracyMeters === 'number' && state.current.accuracyMeters > 0) {
        var rPx = state.current.accuracyMeters / metersPerPixel(box);
        if (rPx > 1 && rPx < PLOT_W) {
          parts.push('<circle cx="' + toX(state.current.lng).toFixed(1) + '" cy="' + toY(state.current.lat).toFixed(1) +
            '" r="' + rPx.toFixed(1) + '" fill="#1d4ed8" fill-opacity="0.12" stroke="#1d4ed8" stroke-opacity="0.5" stroke-width="1" />');
        }
      }

      state.observations.forEach(function (obs) {
        if (!global.BibimLocation.isValidCoord(obs.lat, obs.lng)) return;
        parts.push('<circle data-obs-id="' + escapeAttr(obs.id) + '" class="plot-pin" cx="' +
          toX(obs.lng).toFixed(1) + '" cy="' + toY(obs.lat).toFixed(1) +
          '" r="8" fill="' + state.colorOf(obs) + '"><title>' + escapeText(state.labelOf(obs)) + '</title></circle>');
      });

      if (hasMe) {
        parts.push('<circle cx="' + toX(state.current.lng).toFixed(1) + '" cy="' + toY(state.current.lat).toFixed(1) +
          '" r="6" fill="#1d4ed8" stroke="#fff" stroke-width="2"><title>내 위치</title></circle>');
      }

      parts.push(northArrow());
      parts.push(scaleBar(box));

      var offline = global.navigator && global.navigator.onLine === false;
      var reason = offline
        ? '인터넷이 끊겨 지도 그림을 불러오지 못했습니다.'
        : (err ? err.message : '지도를 불러오지 못했습니다.');

      // 좌표판은 지도보다 내용이 길어서 고정 높이에 가두면 제목이 잘린다.
      container.classList.add('is-fallback');
      container.innerHTML =
        '<div class="map-fallback">' +
        '<p class="map-fallback__title">간이 좌표판 (지도 아님)</p>' +
        '<p class="map-fallback__reason">' + escapeText(reason) + '</p>' +
        '<svg class="map-fallback__plot" id="plot-svg" viewBox="0 0 ' + PLOT_W + ' ' + PLOT_H + '" ' +
        'role="img" aria-label="기록 좌표 배치도">' + parts.join('') + '</svg>' +
        '<p class="map-fallback__ok">GPS는 인터넷 없이도 됩니다. 기록과 빠른 기록은 그대로 쓸 수 있습니다.</p>' +
        '<p class="map-fallback__hint">핀을 눌러 기록을 엽니다. 좌표 지정 모드에서는 좌표판을 눌러 위치를 고를 수 있습니다.</p>' +
        '</div>';

      Array.prototype.forEach.call(container.querySelectorAll('[data-obs-id]'), function (node) {
        node.addEventListener('click', function (event) {
          event.stopPropagation();       // 핀 선택이 좌표 지정으로 새지 않게 한다.
          onSelect(node.getAttribute('data-obs-id'));
        });
      });

      var svg = container.querySelector('#plot-svg');
      if (svg) svg.addEventListener('click', onPlotClick);
    }

    /** 좌표판을 탭한 자리를 위도·경도로 되돌린다. */
    function onPlotClick(event) {
      if (!state.pickMode || !plotFrame) return;
      var svg = event.currentTarget;
      var rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var x = ((event.clientX - rect.left) / rect.width) * PLOT_W;
      var y = ((event.clientY - rect.top) / rect.height) * PLOT_H;
      var usableW = PLOT_W - PLOT_PAD * 2;
      var usableH = PLOT_H - PLOT_PAD * 2;
      if (x < PLOT_PAD || x > PLOT_W - PLOT_PAD || y < PLOT_PAD || y > PLOT_H - PLOT_PAD) return;
      var lng = plotFrame.minLng + ((x - PLOT_PAD) / usableW) * plotFrame.spanLng;
      var lat = plotFrame.minLat + ((PLOT_H - PLOT_PAD - y) / usableH) * plotFrame.spanLat;
      if (global.BibimLocation.isValidCoord(lat, lng)) onPick(lat, lng);
    }

    function metersPerPixel(box) {
      var midLat = box.minLat + box.spanLat / 2;
      var metersWide = box.spanLng * 111320 * Math.cos(midLat * Math.PI / 180);
      return metersWide / (PLOT_W - PLOT_PAD * 2);
    }

    function gridLines() {
      var out = [];
      for (var i = 1; i < 4; i += 1) {
        var x = PLOT_PAD + (i / 4) * (PLOT_W - PLOT_PAD * 2);
        var y = PLOT_PAD + (i / 4) * (PLOT_H - PLOT_PAD * 2);
        out.push('<line x1="' + x.toFixed(1) + '" y1="' + PLOT_PAD + '" x2="' + x.toFixed(1) +
          '" y2="' + (PLOT_H - PLOT_PAD) + '" stroke="#dde1dd" stroke-width="1" />');
        out.push('<line x1="' + PLOT_PAD + '" y1="' + y.toFixed(1) + '" x2="' + (PLOT_W - PLOT_PAD) +
          '" y2="' + y.toFixed(1) + '" stroke="#dde1dd" stroke-width="1" />');
      }
      return out.join('');
    }

    function northArrow() {
      var x = PLOT_W - 22, y = 16;
      return '<g><path d="M' + x + ' ' + (y + 16) + ' L' + x + ' ' + y + ' M' + (x - 4) + ' ' + (y + 5) +
        ' L' + x + ' ' + y + ' L' + (x + 4) + ' ' + (y + 5) + '" fill="none" stroke="#55615b" stroke-width="1.5" />' +
        '<text x="' + x + '" y="' + (y + 27) + '" text-anchor="middle" font-size="10" fill="#55615b">N</text></g>';
    }

    /** 화면에서 재어 볼 수 있게 가까운 반올림 거리로 눈금을 그린다. */
    function scaleBar(box) {
      var mpp = metersPerPixel(box);
      if (!isFinite(mpp) || mpp <= 0) return '';
      var nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
      var target = mpp * 90;                       // 90px 안팎이 되는 거리를 고른다.
      var meters = nice[nice.length - 1];
      for (var i = 0; i < nice.length; i += 1) {
        if (nice[i] >= target) { meters = nice[i]; break; }
      }
      var px = meters / mpp;
      if (px > PLOT_W - PLOT_PAD * 2) return '';
      var x0 = PLOT_PAD, y0 = PLOT_H - 10;
      return '<g><line x1="' + x0 + '" y1="' + y0 + '" x2="' + (x0 + px).toFixed(1) + '" y2="' + y0 +
        '" stroke="#33413a" stroke-width="2" />' +
        '<line x1="' + x0 + '" y1="' + (y0 - 4) + '" x2="' + x0 + '" y2="' + (y0 + 4) + '" stroke="#33413a" stroke-width="2" />' +
        '<line x1="' + (x0 + px).toFixed(1) + '" y1="' + (y0 - 4) + '" x2="' + (x0 + px).toFixed(1) + '" y2="' + (y0 + 4) +
        '" stroke="#33413a" stroke-width="2" />' +
        '<text x="' + (x0 + px / 2).toFixed(1) + '" y="' + (y0 - 7) + '" text-anchor="middle" font-size="11" fill="#33413a">' +
        meters + ' m</text></g>';
    }

    function bounds(points) {
      if (!points.length) {
        var c = global.BibimLocation.JEONJU_CENTER;
        return { minLat: c.lat - 0.001, minLng: c.lng - 0.001, spanLat: 0.002, spanLng: 0.002 };
      }
      var lats = points.map(function (p) { return p.lat; });
      var lngs = points.map(function (p) { return p.lng; });
      var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
      var minLng = Math.min.apply(null, lngs), maxLng = Math.max.apply(null, lngs);
      // 점이 하나뿐이어도 주변 100m 정도는 보이게 한다.
      var padLat = Math.max((maxLat - minLat) * 0.25, 0.00045);
      var padLng = Math.max((maxLng - minLng) * 0.25, 0.00055);
      return {
        minLat: minLat - padLat,
        minLng: minLng - padLng,
        spanLat: (maxLat - minLat) + padLat * 2,
        spanLng: (maxLng - minLng) + padLng * 2
      };
    }

    function escapeText(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function escapeAttr(value) {
      return escapeText(value).replace(/"/g, '&quot;');
    }

    // 지도가 뜨기 전에도 좌표판은 보여 준다.
    renderFallback(mapsError('loading', '지도를 불러오는 중입니다.', []));
    state.backend = 'fallback';

    return {
      init: initAuto,
      initOsm: initOsm,
      initGoogle: initGoogle,
      setObservations: setObservations,
      setCurrentPosition: setCurrentPosition,
      setPickMode: setPickMode,
      setFollow: setFollow,
      isFollowing: isFollowing,
      focus: focus,
      backend: backend
    };
  }

  global.BibimMap = {
    TONE_COLOR: TONE_COLOR,
    AUTH_HINTS: AUTH_HINTS,
    OSM_ATTRIBUTION: OSM_ATTRIBUTION,
    load: loadGoogle,
    loadLeaflet: loadLeaflet,
    status: status,
    create: create
  };
})(window);
