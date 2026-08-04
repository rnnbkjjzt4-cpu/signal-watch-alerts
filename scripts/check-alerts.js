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
  const res = await fetch('https://api.weather.gov/alerts/active?severity=Extreme,Severe,Moderate', {
    headers: { Accept: 'application/geo+json', 'User-Agent': 'signal-watch (contact: set-your-email@example.com)' },
  });
  if (!res.ok) throw new Error('NWS fetch failed: ' + res.status);
  const data = await res.json();
  const target = /(tornado|hurricane|flood|tropical storm|storm surge)/i;
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
  return 'other';
}

async function fetchFireAlerts() {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return []; // fire tracking skipped until a free FIRMS key is set as a secret

  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_NOAA20_NRT/-125,24,-66,49/1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('FIRMS fetch failed: ' + res.status);
  const csv = await res.text();
  const rows = csv.trim().split('\n').slice(1);
  return rows
    .map(line => {
      const cols = line.split(',');
      const [lat, lon, brightness, , , acq_date, acq_time, , , , confidence] = cols;
      return { lat: parseFloat(lat), lon: parseFloat(lon), confidence, acq_date, acq_time };
    })
    .filter(r => r.confidence === 'h' || r.confidence === 'high')
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

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function matchesSubscriber(event, sub) {
  if (!sub.hazards.includes(event.hazard)) return false;

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
    subject: `⚠ ${event.severity.toUpperCase()} — ${event.title} — ${event.area.split(';')[0]}`,
    text: `${event.headline}\n\nArea: ${event.area}\nSource: ${event.source}\n${event.link || ''}`,
  });
}

async function main() {
  const seen = new Set(loadJSON(STATE_PATH, []));
  const subscribers = loadJSON(SUBSCRIBERS_PATH, []);

  const [weatherEvents, fireEvents] = await Promise.all([
    fetchWeatherAlerts(),
    fetchFireAlerts().catch(err => { console.error('FIRMS skipped:', err.message); return []; }),
  ]);
  const allEvents = [...weatherEvents, ...fireEvents];
  const newEvents = allEvents.filter(e => !seen.has(e.id));

  console.log(`Fetched ${allEvents.length} events, ${newEvents.length} new.`);

  if (newEvents.length === 0) {
    saveJSON(STATE_PATH, [...seen]);
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
  saveJSON(STATE_PATH, [...seen].slice(-500));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
