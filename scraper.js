// --- deps ---
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const path = require('path');

// --- helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const DEFAULT_UA_BASE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/';
const DEFAULT_UA_TAIL = '.0 Safari/537.36';
const buildUA = () => `${DEFAULT_UA_BASE}${rand(120, 127)}${DEFAULT_UA_TAIL}`;

const types = { CARS: 'cars', NADLAN: 'nadlan', UNKNOWN: 'x' };
const stages = {
  [types.CARS]: [
    "div[class^=results-feed_feedListBox]",
    "div[class^=feed-item-base_imageBox]",
    "div[class^=feed-item-base_feedItemBox]"
  ],
  [types.NADLAN]: [
    "div[class^=map-feed_mapFeedBox]",
    "div[class^=item-image_itemImageBox]",
    "div[class^=item-layout_feedItemBox]"
  ],
  [types.UNKNOWN]: []
};

// --- config ---
let config = { telegramApiToken: "", chatId: 0, cookies: "", projects: [] };
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch {
  console.warn('No config.json found or invalid JSON. Falling back to env only.');
}

// --- FS utils ---
const dataDir = path.join(__dirname, 'data');
const ensureDataDir = () => fs.mkdirSync(dataDir, { recursive: true });

const loadSavedUrls = (topic) => {
  ensureDataDir();
  const filePath = path.join(dataDir, `${topic}.json`);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '[]');
    return [];
  }
  const txt = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(txt || '[]');
};

const saveUrls = (topic, urls) => {
  const filePath = path.join(dataDir, `${topic}.json`);
  fs.writeFileSync(filePath, JSON.stringify(urls, null, 2));
};

const createPushFlagForWorkflow = () => {
  fs.writeFileSync(path.join(__dirname, 'push_me'), '');
};

// --- network (Puppeteer + stealth + optional proxy/cookies) ---
async function getYad2HtmlWithPuppeteer(url, cookiesCfg) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage'
  ];
  const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || '';
  if (proxy) args.push(`--proxy-server=${proxy}`);

  const browser = await puppeteer.launch({
    headless: process.env.HEADLESS === 'false' ? false : 'new',
    args
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(buildUA());
    await page.setViewport({ width: 1366, height: 840 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
      'Upgrade-Insecure-Requests': '1'
    });

    // Cookie string פשוטה (אם הוגדרה)
    if (cookiesCfg && typeof cookiesCfg === 'string' && cookiesCfg.trim()) {
      await page.setExtraHTTPHeaders({ Cookie: cookiesCfg.trim() });
    }

    // 1) דף הבית (לאסוף קוקיז בסיסיים)
    await page.goto('https://www.yad2.co.il/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(rand(800, 1600));

    // 2) דף החיפוש
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    let title = await page.title();
    if (title.includes('ShieldSquare')) {
      await sleep(rand(900, 1800));
      await page.reload({ waitUntil: 'domcontentloaded' });
      title = await page.title();
      if (title.includes('ShieldSquare')) throw new Error('Bot detection');
    }

    await sleep(rand(900, 1800)); // lazy

    // וידוא הופעת הפיד
    const hasFeed =
      (await page.$(stages[types.CARS][0])) ||
      (await page.$(stages[types.NADLAN][0]));
    if (!hasFeed) await sleep(rand(800, 1600));

    return await page.content();
  } finally {
    await browser.close();
  }
}

// --- parsing ---
const scrapeItemsAndExtractImgUrls = async (url) => {
  const yad2Html = await getYad2HtmlWithPuppeteer(url, config.cookies);
  if (!yad2Html) throw new Error('Could not get Yad2 response');

  const $ = cheerio.load(yad2Html);
  const titleText = $('title').first().text().trim();
  if (titleText.includes('ShieldSquare')) throw new Error('Bot detection');

  let type = types.UNKNOWN;
  if ($(stages[types.CARS][0]).length) type = types.CARS;
  else if ($(stages[types.NADLAN][0]).length) type = types.NADLAN;
  else throw new Error('Unknown type');

  const $feed = $(stages[type][0]);
  if (!$feed.length) throw new Error('Could not find feed items');

  const $items = $feed.find(stages[type][2]);
  if (!$items.length) throw new Error('Could not find feed item boxes');

  const data = [];
  $items.each((_, el) => {
    const $item = $(el);
    const $imgBox = $item.find(stages[type][1]).first();

    let imgSrc =
      $imgBox.find('img').attr('src') ||
      $imgBox.find('img').attr('data-src') ||
      $imgBox.find('img').attr('data-original') ||
      ($imgBox.find('img').attr('srcset') || '').split(' ')[0] ||
      null;

    let lnkSrc = $item.find('a').attr('href');
    if (lnkSrc) {
      try { lnkSrc = new URL(lnkSrc, url).href; } catch { lnkSrc = null; }
    }

    if (imgSrc && lnkSrc) data.push({ img: imgSrc, lnk: lnkSrc });
  });

  if (!data.length) {
    console.log('DEBUG: No parseable items. Title:', titleText);
    console.log('DEBUG: Items found:', $items.length);
    throw new Error('No parseable items');
  }

  return data;
};

// --- diff & notify ---
const checkIfHasNewItem = async (data, topic) => {
  let savedUrls = loadSavedUrls(topic);
  const currentImgUrls = data.map(d => d.img);

  // שמור רק פריטים שעדיין קיימים
  savedUrls = savedUrls.filter(u => currentImgUrls.includes(u));

  const newItems = [];
  for (const item of data) {
    if (!savedUrls.includes(item.img)) {
      savedUrls.push(item.img);
      newItems.push(item.lnk);
    }
  }

  if (newItems.length > 0) {
    saveUrls(topic, savedUrls);
    createPushFlagForWorkflow();
  }

  return newItems;
};

// --- main (with retries) ---
async function scrapeOnce(topic, url, telenode, chatId) {
  const scrapeData = await scrapeItemsAndExtractImgUrls(url);
  const newItems = await checkIfHasNewItem(scrapeData, topic);

  if (newItems.length > 0) {
    await telenode.sendTextMessage(`${newItems.length} new items for "${topic}"`, chatId);
    await Promise.all(newItems.map(msg => telenode.sendTextMessage(msg, chatId)));
  }
}

async function scrapeWithRetry(topic, url, telenode, chatId) {
  const retries = parseInt(process.env.MAX_RETRIES || '3', 10);
  let attempt = 0;
  while (true) {
    try {
      await scrapeOnce(topic, url, telenode, chatId);
      return; // success
    } catch (e) {
      attempt++;
      const isLast = attempt >= retries;
      const delay = rand(1500 * attempt, 3000 * attempt);
      const msg = `Attempt ${attempt}/${retries} failed for "${topic}": ${e?.message || e}`;

      console.error(msg);
      // שליחת עדכון רק בכישלון האחרון כדי לא להציף
      if (isLast) {
        try { await telenode.sendTextMessage(`Scan failed for "${topic}" 😥\n${e?.message || 'unknown'}`, chatId); } catch {}
        throw e;
      }
      await sleep(delay);
    }
  }
}

const scrape = async (topic, url) => {
  const apiToken = process.env.API_TOKEN || config.telegramApiToken;
  const chatId = process.env.CHAT_ID || config.chatId;
  if (!apiToken || !chatId) throw new Error('Missing Telegram credentials (API_TOKEN / CHAT_ID).');

  const telenode = new Telenode({ apiToken });
  await scrapeWithRetry(topic, url, telenode, chatId);
};

// --- entrypoint ---
(async function program() {
  ensureDataDir();

  const activeProjects = (config.projects || []).filter(p => !p.disabled);
  if (!activeProjects.length) {
    console.log('No active projects to run.');
    return;
  }
  await Promise.all(activeProjects.map(p => scrape(p.topic, p.url)));
})().catch(err => {
  console.error(err);
  process.exit(1);
});
