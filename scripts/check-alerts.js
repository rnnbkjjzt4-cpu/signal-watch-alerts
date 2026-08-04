// Signal Watch — free background alert checker
// Runs on a GitHub Actions schedule. Polls NWS/FIRMS/News,
// diffs against previously-seen events, and emails/texts subscribers
// whose watch location + hazard filters match.

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const STATE_PATH = path.join(__dirname, '..', 'state', 'seen-alerts.json');
const SUBSCRIBERS_PATH = path.join(__dirname, '..', 'subscribers.json');
const ALERTS_LOG_PATH = path.join(__dirname, '..', 'state', 'alerts-log.json');

// Free carrier email-to-SMS gateways. Best-effort only — not guaranteed,
// and some carriers throttle/flag these. Fine for small-scale personal alerts.
// Note: AT&T (txt.att.net) shut this down in June 2025 and no longer works.
const CARRIER_GATEWAYS = {
  verizon: 'vtext.com',
  att: 'txt.att.net',
  tmobile: 'tmomail.net',
  sprint: 'messaging.sprintpcs.com',
  uscellular: 'email.uscc.net',
  boost: 'sms.myboostmobile.com',
  cricket: 'sms.cricketwireless.net',
  metropcs: 'mymetropcs.com',
  googlefi: 'msg.fi.google.com',
};

function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}
function saveJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

async function fetchWeatherAlerts() {
  // Large-loss tuning: Extreme/Severe only, dropping Moderate to cut noise.
  const res = await fetch('https://api.weather.gov/alerts/active', {
    headers: {
      Accept: 'application/geo+json',
      'User-Agent': 'signal-watch (contact: castondown98@gmail.com)',
    },
  });
  if (!res.ok) throw new Error('NWS fetch failed: ' + res.status);
  const data = await res.json();

  const target = /(tornado|hurricane|flood|tropical|severe thunderstorm)/i;
  return (data.features || [])
    .filter(f => target.test(f.properties.event || '')
      && (f.properties.severity === 'Extreme' || f.properties.severity === 'Severe'))
    .map(f => ({
      id: f.id,
      source: 'NWS',
      hazard: classifyHazard(f.properties.event),
      title: f.properties.event,
      area: f.properties.areaDesc || '',
      severity: f.properties.severity,
      headline: f.properties.headline || f.properties.event || '',
      link: f.properties['@id'] || '',
    }));
}

function classifyHazard(event = '') {
  const e = event.toLowerCase();
  if (e.includes('tornado')) return 'tornado';
  if (e.includes('hurricane') || e.includes('tropical')) return 'hurricane';
  if (e.includes('flood')) return 'flood';
  if (e.includes('thunderstorm')) return 'hail';
  return 'other';
}

async function fetchFireAlerts() {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) {
    console.log('FIRMS_MAP_KEY not set, skipping satellite fire tracking.');
    return [];
  }
  // Continental US bounding box, VIIRS, last 1 day.
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/-125,24,-66,50/1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('FIRMS fetch failed: ' + res.status);
  const csv = await res.text();
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  const latIdx = headers.indexOf('latitude');
  const lonIdx = headers.indexOf('longitude');
  const dateIdx = headers.indexOf('acq_date');
  const confIdx = headers.indexOf('confidence');

  return lines.slice(1)
    .map(line => line.split(','))
    .map(cols => ({
      lat: parseFloat(cols[latIdx]),
      lon: parseFloat(cols[lonIdx]),
      acq_date: cols[dateIdx],
      confidence: cols[confIdx],
    }))
    .filter(r => r.confidence === 'h' || r.confidence === 'high' || r.confidence === '100')
    .map(r => ({
      id: `fire_${r.lat}_${r.lon}_${r.acq_date}`,
      source: 'FIRMS',
      hazard: 'fire',
      title: 'High-confidence fire detection',
      area: `${r.lat.toFixed(3)}, ${r.lon.toFixed(3)}`,
      severity: 'Severe',
      headline: `Satellite fire detection near ${r.lat.toFixed(2)}, ${r.lon.toFixed(2)}`,
      link: '',
      lat: r.lat,
      lon: r.lon,
    }));
}

// Free, no API key: scans Google News for large-loss structure fires,
// collapses, and storm damage — categories NWS/FIRMS don't give us.
// Novelis Oswego ($84M, three-alarm) is the fire calibration example;
// Klipsch/Lasko are the collapse calibration examples.
const NEWS_CATEGORIES = [
  {
    hazard: 'fire',
    query: '("three-alarm fire" OR "four-alarm fire" OR "multi-alarm fire" OR "warehouse fire" OR "industrial fire" OR "plant fire")',
    hint: /(three-alarm|four-alarm|multi-alarm|warehouse|industrial|plant|factory|evacuat)/i,
  },
  {
    hazard: 'collapse',
    query: '("roof collapse" OR "structural collapse" OR "building collapse" OR "partial collapse")',
    hint: /(collapse|evacuat|million|destroyed|structural)/i,
  },
  {
    hazard: 'stormdamage',
    query: '("severe storm damage" OR "storm damage" OR "tornado damage" OR "hail damage")',
    hint: /(million|destroyed|damage|evacuat|shelter|debris)/i,
  },
];

async function fetchNewsAlerts() {
  const results = await Promise.all(NEWS_CATEGORIES.map(async cat => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(cat.query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, { headers: { 'User-Agent': 'signal-watch/1.0' } });
    if (!res.ok) throw new Error(`Google News fetch failed for ${cat.hazard}: ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

    return items
      .map(m => {
        const block = m[1];
        const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1]
          .replace('<![CDATA[', '').replace(']]>', '').trim();
        const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [, ''])[1].trim();
        return { title, link };
      })
      .filter(a => a.title && a.link && cat.hint.test(a.title))
      .map(a => ({
        id: `news_${cat.hazard}_${a.link}`,
        source: 'NEWS',
        hazard: cat.hazard,
        title: a.title,
        area: a.title,
        severity: 'Severe',
        headline: a.title,
        link: a.link,
      }));
  }));

  return results.flat();
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function matchesSubscriber(event, sub) {
  if (!sub.hazards.includes(event.hazard)) return false;

  if (sub.nationwide) return true;

  if (event.source === 'FIRMS') {
    if (sub.lat == null || sub.lon == null) return false;
    return haversineMiles(sub.lat, sub.lon, event.lat, event.lon) <= (sub.fireRadiusMiles || 25);
  }

  if (!sub.watchLocation) return false;
  return event.area.toLowerCase().includes(sub.watchLocation.toLowerCase());
}

async function sendEmail(transporter, from, to, event) {
  await transporter.sendMail({
    from,
    to,
    subject: `⚠ ${event.severity.toUpperCase()} — ${event.title || event.hazard}`,
    text: `${event.headline}\n\nArea: ${event.area}\nSource: ${event.source}\n${event.link || ''}`,
  });
}

async function main() {
  const seen = new Set(loadJSON(STATE_PATH, []));
  const subscribers = loadJSON(SUBSCRIBERS_PATH, []);

  const [weatherEvents, fireEvents, newsFireEvents] = await Promise.all([
    fetchWeatherAlerts(),
    fetchFireAlerts().catch(err => { console.error('FIRMS error:', err.message); return []; }),
    fetchNewsAlerts().catch(err => { console.error('News error:', err.message); return []; }),
  ]);
  const allEvents = [...weatherEvents, ...fireEvents, ...newsFireEvents];
  const newEvents = allEvents.filter(e => !seen.has(e.id));

  console.log(`Fetched ${allEvents.length} events, ${newEvents.length} new.`);

  if (newEvents.length === 0) {
    saveJSON(STATE_PATH, [...seen]);
    return;
  }

  // Log full details of new events for the dashboard, newest first, capped at 200.
  const logEntries = newEvents.map(e => ({
    id: e.id,
    hazard: e.hazard,
    title: e.title,
    area: e.area,
    severity: e.severity,
    headline: e.headline,
    link: e.link,
    source: e.source,
    timestamp: new Date().toISOString(),
  }));
  const existingLog = loadJSON(ALERTS_LOG_PATH, []);
  saveJSON(ALERTS_LOG_PATH, [...logEntries, ...existingLog].slice(0, 200));

  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

  // Cap per run so a big backlog (e.g. first run ever) doesn't trip Gmail's
  // "too many login attempts" throttle. Deferred events roll to next run.
  const MAX_EMAILS_PER_RUN = 15;
  const eventsToSend = newEvents.slice(0, MAX_EMAILS_PER_RUN);
  const eventsDeferred = newEvents.slice(MAX_EMAILS_PER_RUN);

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error('GMAIL_USER / GMAIL_APP_PASSWORD not set — skipping sends.');
  } else {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
      pool: true,
      maxConnections: 1,
      maxMessages: 100,
      rateDelta: 20000,
      rateLimit: 5, // max 5 sends per 20 seconds
    });

    for (const event of eventsToSend) {
      for (const sub of subscribers) {
        if (!matchesSubscriber(event, sub)) continue;

        const targets = [];
        if ((sub.method === 'email' || sub.method === 'both') && sub.email) targets.push(sub.email);
        if ((sub.method === 'sms' || sub.method === 'both') && sub.phone && sub.carrier) {
          const gateway = CARRIER_GATEWAYS[sub.carrier];
          if (gateway) targets.push(`${sub.phone.replace(/\D/g, '')}@${gateway}`);
        }

        for (const to of targets) {
          try {
            await sendEmail(transporter, GMAIL_USER, to, event);
            console.log(`Sent [${event.hazard}] ${event.title || event.headline} to ${to}`);
          } catch (err) {
            console.error(`Failed sending to ${to}:`, err.message);
          }
        }
      }
    }
    transporter.close();
  }

  eventsToSend.forEach(e => seen.add(e.id));
  if (eventsDeferred.length > 0) {
    console.log(`${eventsDeferred.length} events deferred to next run.`);
  }
  saveJSON(STATE_PATH, [...seen].slice(-500));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
