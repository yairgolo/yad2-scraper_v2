// --- deps ---
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const path = require('path');

// --- config ---
let config = { telegramApiToken: "", chatId: 0, cookies: "", projects: [] };
try {
  const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
  config = JSON.parse(raw);
} catch (e) {
  console.warn('No config.json found or invalid JSON. Falling back to env only.');
}

// --- constants ---
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const types = {
  CARS: 'cars',
  NADLAN: 'nadlan',
  UNKNOWN: 'x'
};

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

// --- utils ---
const ensureDataDir = () => fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

const loadSavedUrls = (topic) => {
  ensureDataDir();
  const filePath = path.join(__dirname, 'data', `${topic}.json`);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '[]');
    return [];
  }
  const txt = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(txt || '[]');
  } catch (e) {
    console.error(`Failed reading ${filePath}`, e);
    throw new Error(`Could not read ${filePath}`);
  }
};

const saveUrls = (topic, urls) => {
  const filePath = path.join(__dirname, 'data', `${topic}.json`);
  fs.writeFileSync(filePath, JSON.stringify(urls, null, 2));
};

const createPushFlagForWorkflow = () => {
  fs.writeFileSync(path.join(__dirname, 'push_me'), '');
};

// --- network ---
async function getYad2HtmlWithPuppeteer(url, cookiesCfg) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(DEFAULT_UA);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
      'Upgrade-Insecure-Requests': '1'
    });

    // הזרקת קוקיז (אם הוגדרו)
    if (cookiesCfg) {
      if (typeof cookiesCfg === 'string' && cookiesCfg.trim()) {
        await page.setExtraHTTPHeaders({ Cookie: cookiesCfg.trim() });
      } else if (Array.isArray(cookiesCfg) && cookiesCfg.length) {
        await page.setCookie(...cookiesCfg);
      }
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const title = await page.title();
    if (title.includes('ShieldSquare')) {
      throw new Error('Bot detection');
    }

    // המתנה קטנה לרינדור lazy
    await page.waitForTimeout(1200);

    // ניסיון נוסף קצר אם הקונטיינר טרם הופיע
    const hasFeed =
      (await page.$(stages[types.CARS][0])) ||
      (await page.$(stages[types.NADLAN][0]));
    if (!hasFeed) {
      await page.waitForTimeout(1200);
    }

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
  if (titleText === 'ShieldSquare Captcha') throw new Error('Bot detection');

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

  // השאר רק מה שעדיין קיים
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

// --- main scraper ---
const scrape = async (topic, url) => {
  const apiToken = process.env.API_TOKEN || config.telegramApiToken;
  const chatId = process.env.CHAT_ID || config.chatId;
  if (!apiToken || !chatId) throw new Error('Missing Telegram credentials (API_TOKEN / CHAT_ID).');

  const telenode = new Telenode({ apiToken });

  try {
    const scrapeData = await scrapeItemsAndExtractImgUrls(url);
    const newItems = await checkIfHasNewItem(scrapeData, topic);

    if (newItems.length > 0) {
      await telenode.sendTextMessage(`${newItems.length} new items for "${topic}"`, chatId);
      await Promise.all(newItems.map(msg => telenode.sendTextMessage(msg, chatId)));
    }
  } catch (e) {
    const errMsg = e?.message ? `Error: ${e.message}` : 'Unknown error';
    try {
      await telenode.sendTextMessage(`Scan workflow failed for "${topic}" 😥\n${errMsg}`, chatId);
    } catch (_) {}
    throw e;
  }
};

// --- entrypoint ---
const program = async () => {
  ensureDataDir();

  const activeProjects = (config.projects || []).filter(p => {
    if (p.disabled) {
      console.log(`Topic "${p.topic}" is disabled. Skipping.`);
    }
    return !p.disabled;
  });

  if (!activeProjects.length) {
    console.log('No active projects to run.');
    return;
  }

  await Promise.all(activeProjects.map(p => scrape(p.topic, p.url)));
};

program().catch(err => {
  console.error(err);
  process.exit(1);
});
