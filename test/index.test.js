// Runs the function's code paths with the bank scraper, the browser and Twilio
// stubbed out, so no real credentials or network are needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const env = {
  TWILIO_ACCOUNT_ID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'test-token',
  MAX_USERNAME: 'test-user',
  MAX_PASSWORD: 'test-password',
  MAYS_CARD: '1111',
  ITAYS_CARD: '2222',
  SHARED_CRAD: '3333',
  WHATSAPP_NUMBER: 'whatsapp:+10000000000',
};
Object.assign(process.env, env);

const calls = { launch: [], createScraper: [], scrape: [], messages: [], twilio: [] };
let scrapeResult;
let failMessages = false;

function stub(name, exports) {
  const file = require.resolve(name);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

// Capture the real library's API shape before replacing it with a stub.
const realScrapers = require('israeli-bank-scrapers');
const realTwilio = require('twilio');

stub('puppeteer', {
  launch: async (opts) => { calls.launch.push(opts); return { fake: 'browser' }; },
});
stub('israeli-bank-scrapers', {
  ...realScrapers,
  createScraper: (opts) => {
    calls.createScraper.push(opts);
    return { scrape: async (creds) => { calls.scrape.push(creds); return scrapeResult; } };
  },
});
stub('twilio', Object.assign((sid, token) => {
  calls.twilio.push([sid, token]);
  return {
    messages: {
      create: async (msg) => {
        if (failMessages) throw new Error('twilio down');
        calls.messages.push(msg);
        return { sid: 'SM0' };
      },
    },
  };
}, { validateRequest: realTwilio.validateRequest }));

const { incoming } = require('../index.js');

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (body) => { res.body = body; return res; };
  return res;
}

// Twilio's signing scheme, written out independently of the twilio package:
// HMAC-SHA1 over the URL followed by each POST param name+value sorted by name,
// base64-encoded, keyed with the auth token.
const HOST = 'us-central1-my-project.cloudfunctions.net';
const PUBLIC_URL = `https://${HOST}/budget`;
function sign(url, params, token = env.TWILIO_AUTH_TOKEN) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

// A request as a 1st gen function sees it: Google strips "/budget" from the path.
function twilioReq(body, { signature, url = PUBLIC_URL, path = '/' } = {}) {
  return {
    headers: { host: HOST, 'x-twilio-signature': signature ?? sign(url, body) },
    originalUrl: path,
    body,
  };
}

function reset() {
  for (const k of Object.keys(calls)) calls[k].length = 0;
  failMessages = false;
}

test('the scraper library still offers the call shape index.js uses', () => {
  assert.equal(typeof realScrapers.createScraper, 'function');
  assert.equal(realScrapers.CompanyTypes.max, 'max');
  assert.deepEqual(realScrapers.SCRAPERS.max.loginFields, ['username', 'password']);
  const scraper = realScrapers.createScraper({ companyId: 'max', startDate: new Date(), browser: {} });
  assert.equal(typeof scraper.scrape, 'function');
});

test('the Twilio client still offers messages.create', () => {
  const client = realTwilio(env.TWILIO_ACCOUNT_ID, env.TWILIO_AUTH_TOKEN);
  assert.equal(typeof client.messages.create, 'function');
});

test('sums the cards and replies on WhatsApp', async () => {
  reset();
  scrapeResult = {
    success: true,
    accounts: [
      { accountNumber: '1111', txns: [
        { status: 'completed', chargedAmount: -100.2, originalAmount: -999 },
        { status: 'pending', chargedAmount: -999, originalAmount: -50 },
      ] },
      { accountNumber: '2222', txns: [{ status: 'completed', chargedAmount: -10, originalAmount: -10 }] },
      { accountNumber: '3333', txns: [{ status: 'completed', chargedAmount: -300.5, originalAmount: -300.5 }] },
    ],
  };
  const res = fakeRes();
  await incoming(twilioReq({ From: 'whatsapp:+19999999999' }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.launch, [{ args: ['--no-sandbox'] }]);
  assert.equal(calls.createScraper.length, 1);
  const opts = calls.createScraper[0];
  assert.equal(opts.companyId, 'max');
  assert.ok(opts.startDate instanceof Date);
  assert.equal(opts.startDate.getDay(), 6, 'startDate is a Saturday');
  assert.deepEqual(opts.browser, { fake: 'browser' });
  assert.deepEqual(calls.scrape, [{ username: 'test-user', password: 'test-password' }]);

  assert.equal(calls.messages.length, 2);
  for (const m of calls.messages) {
    assert.equal(m.to, 'whatsapp:+19999999999');
    assert.equal(m.from, 'whatsapp:+14155238886');
  }
  const final = calls.messages[1].body;
  assert.match(final, /הוצאות קבועות 301 ש״ח/);
  assert.match(final, /יכולנו בלי זה 161 ש״ח/);
});

test('falls back to the configured WhatsApp number', async () => {
  reset();
  const res = fakeRes();
  await incoming(twilioReq({}), res);
  assert.equal(res.statusCode, 200);
  assert.ok(calls.messages.every((m) => m.to === env.WHATSAPP_NUMBER));
});

test('answers 400 when the scraper fails', async () => {
  reset();
  scrapeResult = { success: false, errorType: 'INVALID_PASSWORD' };
  const res = fakeRes();
  await incoming(twilioReq({}), res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.messages.length, 1, 'only the progress message went out');
});

test('a failed progress message does not crash the process', async () => {
  reset();
  failMessages = true;
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = e; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const res = fakeRes();
    await incoming(twilioReq({}), res);
    await new Promise((r) => setImmediate(r));
    assert.equal(res.statusCode, 400);
    assert.equal(unhandled, null);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// Signature checks

const whatsappBody = {
  SmsMessageSid: 'SM1234', NumMedia: '0', ProfileName: 'Someone', MessageType: 'text',
  Body: 'כמה?', To: 'whatsapp:+14155238886', From: 'whatsapp:+19999999999',
  AccountSid: env.TWILIO_ACCOUNT_ID, ApiVersion: '2010-04-01',
};

async function rejected(req) {
  reset();
  scrapeResult = { success: true, accounts: [] };
  const res = fakeRes();
  await incoming(req, res);
  assert.equal(calls.launch.length, 0, 'no browser was started');
  assert.equal(calls.scrape.length, 0, 'no bank login was tried');
  assert.equal(calls.messages.length, 0, 'no WhatsApp message went out');
  return res;
}

test('a request Twilio signed for the public 1st gen URL is served', async () => {
  reset();
  scrapeResult = { success: true, accounts: [] };
  const res = fakeRes();
  await incoming(twilioReq(whatsappBody), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.scrape.length, 1);
});

test('a request without a signature gets 403 and starts nothing', async () => {
  const req = twilioReq({ From: 'whatsapp:+15555555555' });
  delete req.headers['x-twilio-signature'];
  const res = await rejected(req);
  assert.equal(res.statusCode, 403);
});

test('a wrong signature gets 403', async () => {
  const res = await rejected(twilioReq(whatsappBody, { signature: sign(PUBLIC_URL, whatsappBody, 'another-token') }));
  assert.equal(res.statusCode, 403);
});

test('a signature for other params gets 403 (the recipient cannot be swapped)', async () => {
  const signature = sign(PUBLIC_URL, whatsappBody);
  const res = await rejected(twilioReq({ ...whatsappBody, From: 'whatsapp:+15555555555' }, { signature }));
  assert.equal(res.statusCode, 403);
});

test('a signature for another URL gets 403', async () => {
  const signature = sign('https://example.com/budget', whatsappBody);
  const res = await rejected(twilioReq(whatsappBody, { signature }));
  assert.equal(res.statusCode, 403);
});

test('TWILIO_WEBHOOK_URL, when set, is the URL checked', async () => {
  const url = 'https://budget.example.com/hook?x=1';
  process.env.TWILIO_WEBHOOK_URL = url;
  try {
    reset();
    scrapeResult = { success: true, accounts: [] };
    const ok = fakeRes();
    await incoming(twilioReq(whatsappBody, { url }), ok);
    assert.equal(ok.statusCode, 200);
    const res = await rejected(twilioReq(whatsappBody));
    assert.equal(res.statusCode, 403, 'the rebuilt URL is not trusted when one is configured');
  } finally {
    delete process.env.TWILIO_WEBHOOK_URL;
  }
});

test('without TWILIO_AUTH_TOKEN every request is rejected, with one clear log line', async () => {
  const errors = [];
  const origError = console.error;
  console.error = (line) => errors.push(line);
  delete process.env.TWILIO_AUTH_TOKEN;
  try {
    const res = await rejected(twilioReq(whatsappBody));
    assert.equal(res.statusCode, 500);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /TWILIO_AUTH_TOKEN is not set/);
  } finally {
    process.env.TWILIO_AUTH_TOKEN = env.TWILIO_AUTH_TOKEN;
    console.error = origError;
  }
});
