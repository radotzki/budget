const { join } = require('path');

// Keep Puppeteer's downloaded Chrome inside the function's own folder, so the
// copy that `npm install` fetches during the Cloud Functions build is still
// there when the function runs.
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
