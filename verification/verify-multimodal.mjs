// M0 multimodal probe: send the M0 verification screenshot to glm-5.3-flash
// via the same OpenAI-compatible wire format dsh-llm-pi-ai uses, and check
// the description matches the actual screenshot content.
// Credentials are read from the dsh credential store, never printed.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const creds = readFileSync(join(homedir(), '.dsh/.credentials.yaml'), 'utf8');
const key = creds.match(/ZAI_CODING_CN_API_KEY[^]*?(?:data:|value:)\s*([^\s]+)/)?.[1]
  ?? creds.split('ZAI_CODING_CN_API_KEY')[1]?.match(/([A-Za-z0-9._]{20,})/)?.[1];
if (!key) { console.error('FAIL: no ZAI key found'); process.exit(1); }

const png = readFileSync(new URL('./shots/full.png', import.meta.url));
const b64 = png.toString('base64');
console.log('image bytes:', png.length, 'base64 chars:', b64.length);

const res = await fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'glm-5.3-flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        { type: 'text', text: '用一句话描述这张截图里的 3D 视口中渲染的是什么几何体，并说明页面上 RPC cad/echo 的返回值里 echo 字段的值。' },
      ],
    }],
    max_tokens: 300,
  }),
});
console.log('HTTP', res.status);
const data = await res.json();
const text = data.choices?.[0]?.message?.content ?? JSON.stringify(data);
console.log('model reply:', text);

// Automated acceptance: reply must identify a cube and the echo value.
const ok = /立方体|cube|正方体|方块/i.test(text) && /hello from M0 panel/.test(text);
console.log(ok ? 'MULTIMODAL PROBE PASSED' : 'MULTIMODAL PROBE FAILED');
process.exit(ok ? 0 : 1);
