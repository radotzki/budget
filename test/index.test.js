// Runs the function's code paths with the bank scraper, the browser and Twilio
// stubbed out, so no real credentials or network are needed.
const test = require('node:test');
const assert = require('node:assert/strict');

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
stub('twilio', (sid, token) => {
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
});

const { incoming } = require('../index.js');

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (body) => { res.body = body; return res; };
  return res;
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
  await incoming({ body: { From: 'whatsapp:+19999999999' } }, res);

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
  await incoming({ body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(calls.messages.every((m) => m.to === env.WHATSAPP_NUMBER));
});

test('answers 400 when the scraper fails', async () => {
  reset();
  scrapeResult = { success: false, errorType: 'INVALID_PASSWORD' };
  const res = fakeRes();
  await incoming({ body: {} }, res);
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
    await incoming({ body: {} }, res);
    await new Promise((r) => setImmediate(r));
    assert.equal(res.statusCode, 400);
    assert.equal(unhandled, null);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
