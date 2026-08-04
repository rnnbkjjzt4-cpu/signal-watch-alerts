// Signal Watch — free background alert checker
// Runs on a GitHub Actions schedule. Polls NWS (always) and NASA FIRMS (if key set),
// diffs against previously-seen events, and emails/texts subscribers whose
// watch location + hazard filters match.

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const STATE_PATH = path.join(__dirname, '..', 'state', 'seen-alerts.json');
const SUBSCRIBERS_PATH = path.join(__dirname, '..', 'subscribers.json');

// Free carrier email-to-SMS gateways. Best-effort delivery only — not guaranteed,
// and some carriers throttle/flag these. Fine for a small list, not for scale.
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
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

async function fetchWeatherAlerts() {
  // Large-loss tuning: Extreme/Severe only, dropped Moderate to cut noise.
  const res = await fetch('https://api.weather.gov/alerts/active?severity=Extreme,Severe', {
    headers: { Accept: 'application/geo+json', 'User-Agent': 'signal-watch (contact: set-your-email@example.com)' },
  });
  if (!res.ok) throw new Error('NWS fetch failed: ' + res.status);
  const data = await res.json();
  // Added Severe Thunderstorm Warning — that's how NWS flags large hail, not a separate "hail" alert type.
  const target = /(tornado|hurricane|flood|tropical storm|storm surge|severe thunderstorm)/i;
  return (data.features || [])
    .filter(f => target.test(f.properties.event || ''))
    .map(f => ({
      id: f.id,
      source: 'NWS',
      hazard: classifyHazard(f.properties.event),
      title: f.properties.event,
      area: f.properties.areaDesc || '',
      severity: f.properties.severity,
      headline: f.properties.headline || '',
      link: f.properties['@id'] || '',
    }));
}

function classifyHazard(event = '') {
  const e = event.toLowerCase();
  if (e.includes('tornado')) return 'tornado';
  if (e.includes('hurricane') || e.includes('tropical storm') || e.includes('storm surge')) return 'hurricane';
  if (e.includes('flood')) return 'flood';
  if (e.includes('thunderstorm')) return 'hail';
  return 'other';
}

async function fetchFireAlerts() {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return []; // fire tracking skipped until a free FIRMS key is set as a secret

  // Continental US bounding box, last 1 day, VIIRS NOAA-20 NRT (good balance of coverage/resolution)
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_NOAA20_NRT/-125,24,-66,49/1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('FIRMS fetch failed: ' + res.status);
  const csv = await res.text();
  const rows = csv.trim().split('\n').slice(1); // drop header
  return rows
    .map(line => {
      const cols = line.split(',');
      const [lat, lon, brightness, , , acq_date, acq_time, , , , confidence] = cols;
      return { lat: parseFloat(lat), lon: parseFloat(lon), confidence, acq_date, acq_time };
    })
    .filter(r => r.confidence === 'h' || r.confidence === 'high') // high-confidence detections only
    .map(r => ({
      id: `fire_${r.lat}_${r.lon}_${r.acq_date}_${r.acq_time}`,
      source: 'FIRMS',
      hazard: 'fire',
      title: 'High-confidence fire detection',
      area: `${r.lat.toFixed(3)}, ${r.lon.toFixed(3)}`,
      severity: 'Severe',
      headline: `Satellite fire detection near ${r.lat.toFixed(3)}, ${r.lon.toFixed(3)}`,
      lat: r.lat,
      lon: r.lon,
    }));
}

// Free, no API key: scans Google News for large-loss coverage across three
// categories NWS/FIRMS don't give us — structure fires, collapses, and general
// storm damage writeups. Novelis Oswego ($84M, three-alarm, plant evacuated)
// is the fire calibration example; Klipsch/Lasko RFG collapses are the
// collapse calibration examples.
const NEWS_CATEGORIES = [
  {
    hazard: 'fire',
    query: '("three-alarm fire" OR "four-alarm fire" OR "multi-alarm fire" OR "warehouse fire" OR "plant fire" OR "industrial fire" OR "mill fire" OR "factory fire") -house -apartment',
    hint: /(three-alarm|four-alarm|multi-alarm|evacuat|million|collapse|destroyed|shut ?down|plant|warehouse|mill|facility|industrial)/i,
  },
  {
    hazard: 'collapse',
    query: '("roof collapse" OR "structural collapse" OR "building collapse" OR "partial collapse") -house',
    hint: /(collapse|evacuat|million|destroyed|damage|injur)/i,
  },
  {
    hazard: 'stormdamage',
    query: '("severe storm damage" OR "storm damage to" OR "tornado damage" OR "hail damage" OR "wind damage") (plant OR warehouse OR facility OR factory OR mill OR commercial)',
    hint: /(million|destroyed|damage|evacuat|shut ?down|plant|warehouse|facility|factory|mill)/i,
  },
];

async function fetchNewsAlerts() {
  const results = await Promise.all(NEWS_CATEGORIES.map(async cat => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(cat.query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, { headers: { 'User-Agent': 'signal-watch (contact: set-your-email@example.com)' } });
    if (!res.ok) throw new Error(`Google News fetch failed for ${cat.hazard}: ` + res.status);
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
        area: a.title, // headline stands in for area — used for keyword/location matching below
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
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function matchesSubscriber(event, sub) {
  if (!sub.hazards.includes(event.hazard)) return false;

  // Sales/lead-gen use case: subscriber wants every large-loss hit nationwide,
  // not just events near one watch location.
  if (sub.nationwide) return true;

  if (event.source === 'FIRMS') {
    if (sub.lat == null || sub.lon == null) return false; // fire matching needs coordinates
    return haversineMiles(sub.lat, sub.lon, event.lat, event.lon) <= (sub.fireRadiusMiles || 25);
  }

  // NWS: simple case-insensitive text match against the alert's county/area list.
  // NEWS (structure fires): headline text stands in for area — best-effort only.
  if (!sub.watchLocation) return false;
  return event.area.toLowerCase().includes(sub.watchLocation.toLowerCase());
}

async function sendEmail(transporter, from, to, event) {
  await transporter.sendMail({
    from,
    to,
    subject: `⚠ ${event.severity.toUpperCase()} — ${event.title} — ${event.area.split(';')[0]}`,
    text: `${event.headline}\n\nArea: ${event.area}\nSource: ${event.source}\n${event.link || ''}`,
  });
}

async function main() {
  const seen = new Set(loadJSON(STATE_PATH, []));
  const subscribers = loadJSON(SUBSCRIBERS_PATH, []);

  const [weatherEvents, fireEvents, newsFireEvents] = await Promise.all([
    fetchWeatherAlerts(),
    fetchFireAlerts().catch(err => { console.error('FIRMS skipped:', err.message); return []; }),
    fetchNewsAlerts().catch(err => { console.error('News scan skipped:', err.message); return []; }),
  ]);
  const allEvents = [...weatherEvents, ...fireEvents, ...newsFireEvents];
  const newEvents = allEvents.filter(e => !seen.has(e.id));

  console.log(`Fetched ${allEvents.length} events, ${newEvents.length} new.`);

  if (newEvents.length === 0) {
    saveJSON(STATE_PATH, [...seen]); // still trims/persists
    return;
  }

  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error('GMAIL_USER / GMAIL_APP_PASSWORD not set — cannot send alerts. Add them as repo secrets.');
  } else {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });

    for (const event of newEvents) {
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
            console.log(`Sent [${event.hazard}] ${event.title} -> ${to}`);
          } catch (err) {
            console.error(`Failed sending to ${to}:`, err.message);
          }
        }
      }
    }
  }

  newEvents.forEach(e => seen.add(e.id));
  // Keep state file from growing forever — cap at last 500 IDs
  saveJSON(STATE_PATH, [...seen].slice(-500));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

