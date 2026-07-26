import { readFile, writeFile } from 'node:fs/promises';

const langbotBase = 'http://127.0.0.1:5300';
const doubaoBase = 'http://127.0.0.1:8000';
const secureDir = '/opt/bundle/secure';
const statusDir = '/opt/bundle/status';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readSecret = async (name) => (await readFile(`${secureDir}/${name}`, 'utf8')).trim();

async function waitFor(url, options = {}, attempts = 120) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(3000) });
      if (response.ok) return response;
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

const apiKey = await readSecret('langbot_api_key');
const sessionId = await readSecret('doubao_sessionid');
const onebotToken = await readSecret('onebot_token');
const apiHeaders = { 'content-type': 'application/json', 'x-api-key': apiKey };

async function api(path, options = {}) {
  const response = await fetch(`${langbotBase}${path}`, {
    ...options,
    headers: { ...apiHeaders, ...(options.headers || {}) },
    signal: AbortSignal.timeout(120000),
  });
  const body = await response.json();
  if (!response.ok || body.code !== 0) {
    throw new Error(`${path}: HTTP ${response.status}: ${body.msg || JSON.stringify(body)}`);
  }
  return body.data;
}

await waitFor(`${doubaoBase}/ping`);
await waitFor(`${langbotBase}/api/v1/provider/providers`, { headers: { 'x-api-key': apiKey } });

const providerList = (await api('/api/v1/provider/providers')).providers || [];
let provider = providerList.find((item) => item.base_url === `${doubaoBase}/v1`);
if (!provider) {
  const created = await api('/api/v1/provider/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Doubao Web Proxy',
      requester: 'openai-chat-completions',
      base_url: `${doubaoBase}/v1`,
      api_keys: [sessionId],
    }),
  });
  provider = { uuid: created.uuid };
}

const modelList = (await api(`/api/v1/provider/models/llm?provider_uuid=${provider.uuid}`)).models || [];
let model = modelList.find((item) => item.name === 'doubao');
if (!model) {
  const created = await api('/api/v1/provider/models/llm', {
    method: 'POST',
    body: JSON.stringify({
      name: 'doubao',
      provider_uuid: provider.uuid,
      abilities: [],
      context_length: 32000,
      extra_args: {},
      prefered_ranking: 100,
    }),
  });
  model = { uuid: created.uuid, name: 'doubao' };
}

const bots = (await api('/api/v1/platform/bots')).bots || [];
let onebot = bots.find((item) => item.adapter === 'aiocqhttp');
if (!onebot) {
  const created = await api('/api/v1/platform/bots', {
    method: 'POST',
    body: JSON.stringify({
      name: 'QQ OneBot v11',
      description: 'Preconfigured OneBot v11 reverse WebSocket endpoint',
      adapter: 'aiocqhttp',
      adapter_config: { host: '0.0.0.0', port: 2280, 'access-token': onebotToken },
      enable: true,
    }),
  });
  onebot = { uuid: created.uuid };
}

const status = {
  ready: true,
  configured_at: new Date().toISOString(),
  provider_uuid: provider.uuid,
  model_uuid: model.uuid,
  onebot_uuid: onebot.uuid,
};
await writeFile(`${statusDir}/ready.json`, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
await writeFile(
  `${statusDir}/qq-onebot.txt`,
  [
    'LangBot QQ OneBot v11 configuration',
    'Reverse WebSocket URL: ws://<TX_PUBLIC_IP>:2280/ws',
    `Access token: ${onebotToken}`,
    'Trigger: mention the bot or prefix the message with ai',
    'Keep TCP 2280 restricted to the NapCat host IP when opening the cloud firewall.',
    '',
  ].join('\n'),
  { mode: 0o600 },
);

console.log(JSON.stringify({ ready: true, provider: provider.uuid, model: model.uuid, onebot: onebot.uuid }));
