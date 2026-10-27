/* 개발용 정적 파일 서버. 배포에는 쓰지 않는다(배포는 GitHub Pages 같은 HTTPS 정적 호스팅).
 * 실행: node tools/serve.js [포트]
 * IndexedDB와 위치 권한은 file:// 에서 막히므로 로컬 확인도 http 로 띄운다.
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');

var root = path.resolve(__dirname, '..');
var port = Number(process.argv[2]) || 5173;

var TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json'
};

http.createServer(function (req, res) {
  var urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  var target = path.join(root, urlPath);
  // 프로젝트 폴더 밖으로 나가는 경로는 거부한다.
  if (target.indexOf(root) !== 0) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(target, function (err, body) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found: ' + urlPath);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  });
}).listen(port, function () {
  console.log('비빔봇 현장조사앱: http://localhost:' + port);
});
