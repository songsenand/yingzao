#!/usr/bin/env node
// Mock Anthropic Messages endpoint for the DSH compatibility matrix.
//
//   node accept-dsh-matrix-mock.mjs text <port> <request-log>
//   node accept-dsh-matrix-mock.mjs tool <port> <request-log>
//
// `text` answers every request with "matrix-ok". `tool` asks for one
// `cad_session {action:"info"}` tool call, then answers "tool-ok" once the
// tool_result comes back. The request log is how the matrix proves the CAD
// tools were actually offered to the model, not merely registered.
//
// No network is needed beyond loopback; the box runs with --net none.

import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const mode = process.argv[2] === 'tool' ? 'tool' : 'text';
const port = Number(process.argv[3] ?? 4331);
const logPath = process.argv[4];

function stream(res, blocks, stopReason) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_matrix',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-flash',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      send('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      send('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    }
    send('content_block_stop', { type: 'content_block_stop', index });
  });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (logPath) appendFileSync(logPath, `${req.method} ${req.url}\n${body}\n---\n`);
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    if (!req.url.includes('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    if (mode === 'tool' && !body.includes('tool_result')) {
      stream(res, [{ type: 'tool_use', id: 'toolu_matrix_1', name: 'cad_session', input: { action: 'info' } }], 'tool_use');
      return;
    }
    stream(res, [{ type: 'text', text: mode === 'tool' ? 'tool-ok' : 'matrix-ok' }], 'end_turn');
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`accept-dsh-matrix-mock: ${mode} on 127.0.0.1:${port}`);
});
