require('dotenv').config({ quiet: true });
const twilio = require('twilio');
const { createScraper } = require('israeli-bank-scrapers');
const puppeteer = require('puppeteer');

const twilioAccountSid = process.env.TWILIO_ACCOUNT_ID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const maxUsername = process.env.MAX_USERNAME;
const maxPassword = process.env.MAX_PASSWORD;
const maysCard = process.env.MAYS_CARD;
const itaysCard = process.env.ITAYS_CARD;
const sharedCard = process.env.SHARED_CRAD;
const whatsappNumber = process.env.WHATSAPP_NUMBER;

exports.incoming = async (req, res) => {
  const check = checkTwilioSignature(req);
  if (!check.ok) {
    console.error(`Rejected request: ${check.reason}`);
    res.status(check.status).send('Forbidden');
    return;
  }
  try {
    const to = req.body.From || whatsappNumber;
    sendMessage('🤖 מחשב נתונים.. זה יקח דקה.. ', to)
      .catch((e) => console.error(`Failed to send the progress message: ${e.message}`));
    const { fixedPrice, weCouldLiveWithoutIt } = await getBalance();
    const message = `💡 זה מה שמצאתי 💡\nהוצאות קבועות ${fixedPrice} ש״ח\nיכולנו בלי זה ${weCouldLiveWithoutIt} ש״ח`;
    await sendMessage(message, to);
    res.status(200).send('Message was sent! :)');
  } catch (e) {
    console.error(`Failed for the following reason: ${e.message}`);
    res.status(400).send('Failed');
  }
};

async function getBalance() {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const scraper = createScraper({
    companyId: 'max',
    startDate: getLastSaturday(),
    browser
  });
  const scrapeResult = await scraper.scrape({
    username: maxUsername,
    password: maxPassword
  });
  const accounts = {
    'May': maysCard,
    'Itay': itaysCard,
    'Shared': sharedCard,
  };

  if (scrapeResult.success) {
    const sums = {};
    scrapeResult.accounts.forEach((account) =>
      sums[account.accountNumber] = account.txns.reduce((sum, tx) => sum + (isCompletedTx(tx) ? tx.chargedAmount : tx.originalAmount), 0)
    );
    const fixedPrice = Math.ceil(Math.abs(sums[accounts.Shared]));
    const weCouldLiveWithoutIt = Math.ceil(Math.abs(sums[accounts.May] + sums[accounts.Itay]));
    return { fixedPrice, weCouldLiveWithoutIt };
  }
  else {
    throw new Error(scrapeResult.errorType);
  }
}

async function sendMessage(message, to) {
  return twilio(twilioAccountSid, twilioAuthToken).messages
    .create({
      from: 'whatsapp:+14155238886',
      body: message,
      to,
    });
}

// Serve only requests that Twilio signed with this account's auth token.
// Twilio signs the webhook URL exactly as set in its console, followed by each
// POST parameter (name then value, sorted by name), with HMAC-SHA1:
// https://www.twilio.com/docs/usage/webhooks/webhooks-security
function checkTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return {
      ok: false,
      status: 500,
      reason: 'TWILIO_AUTH_TOKEN is not set, so no request can be checked as coming from Twilio. Set it on the function and redeploy.',
    };
  }
  const headers = req.headers || {};
  const signature = headers['x-twilio-signature'];
  if (!signature) {
    return { ok: false, status: 403, reason: 'no X-Twilio-Signature header' };
  }
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  const urls = webhookUrls(req);
  if (urls.some((url) => twilio.validateRequest(authToken, signature, url, params))) {
    return { ok: true };
  }
  return { ok: false, status: 403, reason: `X-Twilio-Signature does not match (checked ${urls.join(', ')})` };
}

// The URL Twilio calls. TWILIO_WEBHOOK_URL, when set, is the one to trust: it
// must be exactly what Twilio's console has. Without it, rebuild it from the
// request. On a 1st gen function the URL is
// https://us-central1-<project>.cloudfunctions.net/budget, and Google strips
// the "/budget" part before the code sees the path, so put it back.
function webhookUrls(req) {
  const configured = process.env.TWILIO_WEBHOOK_URL;
  if (configured) return [configured];
  const headers = req.headers || {};
  const hosts = [headers.host, headers['x-forwarded-host']].filter(Boolean);
  const path = req.originalUrl || req.url || '/';
  const name = process.env.K_SERVICE || process.env.FUNCTION_NAME || 'budget';
  // "/" -> "/budget", "/?a=1" -> "/budget?a=1"
  const rest = path === '/' || path.startsWith('/?') ? path.slice(1) : path;
  const candidates = hosts.flatMap((host) => [`https://${host}/${name}${rest}`, `https://${host}${path}`]);
  return [...new Set(candidates)];
}

function getLastSaturday() {
  const prevSaturday = new Date();
  prevSaturday.setDate(prevSaturday.getDate() - (prevSaturday.getDay() + 1) % 7);
  prevSaturday.setHours(0, 0, 0, 0);
  return prevSaturday;
}

function isCompletedTx(tx) {
  return tx.status === 'completed';
}
