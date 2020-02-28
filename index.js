require('dotenv').config();
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
  try {
    const to = req.body.From || whatsappNumber;
    sendMessage('🤖 מחשב נתונים.. זה יקח דקה.. ', to);
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
      sums[account.accountNumber] = account.txns.reduce((sum, tx) => sum + tx.originalAmount, 0)
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

function getLastSaturday() {
  const prevSaturday = new Date();
  prevSaturday.setDate(prevSaturday.getDate() - (prevSaturday.getDay() + 1) % 7);
  prevSaturday.setHours(0, 0, 0, 0);
  return prevSaturday;
}
