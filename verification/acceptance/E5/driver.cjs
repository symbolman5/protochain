// E5 验收独立复验：用生成 client（http.js）发起真实 fetch 调用
const http = require('node:http');
const { HttpClient, HttpError } = require('/tmp/http-dist/http.js');

let received = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received = { method: req.method, url: req.url, headers: req.headers, body };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, echo: body }));
  });
});

server.listen(18765, '127.0.0.1', async () => {
  try {
    const client = new HttpClient({
      protocolName: 'hskng-p1',
      protocolVersion: '0.7.0',
      roles: { 'R-Op': { baseUrl: 'http://127.0.0.1:18765', auth: 'none' } },
      bindings: [
        {
          action: 'register',
          roleId: 'R-Op',
          method: 'POST',
          path: '/api/servers/register',
          params: [
            { logicalName: 'name', in: 'body' },
            { logicalName: 'nodeId', in: 'query' },
          ],
        },
      ],
    });
    const resp = await client.invoke('register', { name: 'srv-1', nodeId: 'n-9' });
    console.log('CALL_OK status=' + resp.status + ' data=' + JSON.stringify(resp.data));
    console.log('SERVER_RECEIVED method=' + received.method + ' url=' + received.url + ' body=' + received.body);
    // 未注册 action → HttpError（错误归一化路径）
    let unregistered = null;
    try {
      await client.invoke('noSuchAction', {});
    } catch (e) {
      unregistered = e instanceof HttpError ? e.message : String(e);
    }
    console.log('UNREGISTERED=' + unregistered);
    server.close();
  } catch (err) {
    console.error('SMOKE_FAIL', err);
    server.close();
    process.exit(1);
  }
});
