/**
 * CommuteMate+ v4 — script.js
 *
 * Deep-link strategy (all URLs built client-side with encodeURIComponent):
 *
 * UBER  → m.uber.com/ul/ with pickup=my_location + dropoff[formatted_address]
 *          + dropoff lat/lon from the plan response (most accurate deep link)
 * OLA   → book.olacabs.com with pickup_name + drop_name query params
 * RAPIDO → rapido.bike (no public deep-link API; opens app via its own PWA logic)
 * METRO  → Google Maps /maps/dir/ with origin + destination + travelmode=transit
 *           This is the MOST reliable way to show a prefilled transit route.
 */

'use strict';

// ── State ──────────────────────────────────────
let activeEventId = null;
let plan          = null;   // last successful /plan response

// ── DOM helpers ────────────────────────────────
const $ = id => document.getElementById(id);

function toast(msg, type = 'info') {
  const wrap = $('toast-wrap');
  const el   = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success:'✅', error:'❌', info:'ℹ️' };
  el.innerHTML = `<span>${icons[type] || '•'}</span><span>${msg}</span>`;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(s) {
  if (!s) return '';
  return new Date(s + 'T00:00').toLocaleDateString('en-IN',
    { weekday:'short', day:'numeric', month:'short' });
}

function fmtTime(s) {
  if (!s) return '';
  const [h,m] = s.split(':').map(Number);
  return `${((h+11)%12+1)}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`;
}

function setBtnLoad(btn, on) {
  if (on) {
    btn._txt   = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span>`;
    btn.disabled  = true;
  } else {
    btn.innerHTML = btn._txt || btn.innerHTML;
    btn.disabled  = false;
  }
}

// ── Add Event ──────────────────────────────────
$('event-form').addEventListener('submit', async function(e) {
  e.preventDefault();
  const btn = this.querySelector('[type=submit]');
  setBtnLoad(btn, true);

  const src = $('ev-source').value.trim();
  if (!src) {
    toast('Source location is required', 'error');
    setBtnLoad(btn, false);
    $('ev-source').focus();
    return;
  }

  const body = {
    name:        $('ev-name').value.trim(),
    source:      src,
    destination: $('ev-dest').value.trim(),
    date:        $('ev-date').value,
    time:        $('ev-time').value,
  };

  try {
    const r = await fetch('/add-event', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (r.ok) { toast('Event saved!', 'success'); this.reset(); loadEvents(); }
    else       { toast(d.error || 'Save failed', 'error'); }
  } catch { toast('Network error', 'error'); }
  finally  { setBtnLoad(btn, false); }
});

// ── Load / render events ───────────────────────
async function loadEvents() {
  try { renderEvents(await (await fetch('/events')).json()); }
  catch { /* silent */ }
}

function renderEvents(evs) {
  const c = $('events-list');
  if (!evs?.length) {
    c.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📅</div>
      <div class="empty-title">No events yet</div>
      <div class="empty-sub">Add an event above to start</div>
    </div>`;
    return;
  }

  c.innerHTML = evs.map(ev => `
    <div class="event-card ${activeEventId===ev.id?'active':''}" id="ec-${ev.id}">
      <div class="event-name">${esc(ev.name)}</div>
      <div class="event-meta">
        <span class="event-tag">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="10" r="3"/><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
          </svg>
          ${esc(ev.source||'?')} → ${esc(ev.destination)}
        </span>
        <span class="event-tag">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          ${fmtDate(ev.date)}
        </span>
        <span class="event-tag">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          ${fmtTime(ev.time)}
        </span>
      </div>
      <div class="event-actions">
        <button class="btn btn-ghost btn-sm" onclick="planCommute('${ev.id}')">🗺️ Plan Commute</button>
        <button class="btn btn-danger btn-sm" onclick="delEvent('${ev.id}')">🗑️</button>
      </div>
    </div>`).join('');
}

async function delEvent(id) {
  if (!confirm('Delete this event?')) return;
  try {
    const r = await fetch('/delete-event', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({event_id:id}),
    });
    if (r.ok) {
      toast('Deleted', 'success');
      if (activeEventId === id) { activeEventId = null; plan = null; showPlaceholder(); }
      loadEvents();
    }
  } catch { toast('Delete failed', 'error'); }
}

// ── Plan commute ───────────────────────────────
async function planCommute(id) {
  activeEventId = id;
  document.querySelectorAll('.event-card').forEach(c => c.classList.remove('active'));
  const ec = $(`ec-${id}`);
  if (ec) ec.classList.add('active');

  const panel = $('commute-panel');
  panel.innerHTML = `
    <div class="commt-placeholder">
      <div class="spinner" style="width:38px;height:38px;border-width:3px;"></div>
      <div class="placeholder-text">Calculating commute…</div>
    </div>`;

  try {
    const r = await fetch('/plan', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({event_id:id}),
    });
    const d = await r.json();

    if (r.ok) {
      plan = d;
      renderPlan(d);
      panel.scrollIntoView({behavior:'smooth', block:'nearest'});
    } else {
      panel.innerHTML = `
        <div class="commt-placeholder">
          <div class="placeholder-icon">⚠️</div>
          <div class="placeholder-text" style="color:var(--red)">${esc(d.error)}</div>
        </div>`;
    }
  } catch {
    panel.innerHTML = `
      <div class="commt-placeholder">
        <div class="placeholder-icon">⚠️</div>
        <div class="placeholder-text" style="color:var(--red)">Network error</div>
      </div>`;
  }
}

function renderPlan(d) {
  const recCab   = d.recommended === 'cab';
  const recMetro = d.recommended === 'metro';

  const metroSection = d.metro_available ? `
    <div class="tc tc-metro ${recMetro ? 'tc-recommended' : ''}" id="tc-metro">
      ${recMetro ? '<div class="rec-badge">⭐ Best Option</div>' : ''}
      <div class="tc-header">
        <div class="tc-icon">🚇</div>
        <span class="tc-name">Metro</span>
      </div>
      <div class="tc-stats">
        <div class="stat-row">
          <span class="stat-key">Travel time</span>
          <span class="stat-val">${d.metro.time} min</span>
        </div>
        <div class="stat-row">
          <span class="stat-key">Estimated fare</span>
          <span class="stat-val">₹${d.metro.fare}</span>
        </div>
        <div class="stat-row">
          <span class="stat-key">Mode</span>
          <span class="stat-val" style="font-family:var(--font-body)">Rapid Transit</span>
        </div>
      </div>
      <button class="btn btn-metro" style="width:100%" onclick="openProviders('metro')">
        🚇 View Metro Route
      </button>
      <div id="prov-metro"></div>
    </div>
  ` : `
    <div class="metro-na">
      <div style="font-size:22px;margin-bottom:8px;opacity:0.3">🚇</div>
      <div style="font-size:12px">Metro not available for this route</div>
      <div style="font-size:10px;margin-top:4px">Both stops must be within Bangalore metro coverage</div>
    </div>
  `;

  $('commute-panel').innerHTML = `
    <div class="commute-inner">

      <!-- Route bar -->
      <div class="route-bar">
        <div class="route-dot src"></div>
        <span class="route-label" title="${esc(d.source)}">${esc(d.source)}</span>
        <div class="route-track">
          <span class="route-km">${d.distance_km} km</span>
          <div class="route-train"></div>
        </div>
        <span class="route-label" style="text-align:right" title="${esc(d.destination_resolved)}">${esc(d.event.destination)}</span>
        <div class="route-dot dst"></div>
      </div>

      <!-- Leave-by -->
      <div class="leave-banner">
        <div>
          <div class="leave-label">⏰ Leave By</div>
          <div class="leave-sub">${esc(d.event.name)} · ${fmtDate(d.event.date)}</div>
        </div>
        <div class="leave-time">${d.leave_by}</div>
      </div>

      <!-- Transport cards -->
      <div class="transport-grid">

        <!-- Cab -->
        <div class="tc tc-cab ${recCab ? 'tc-recommended' : ''}" id="tc-cab">
          ${recCab ? '<div class="rec-badge">⭐ Best Option</div>' : ''}
          <div class="tc-header">
            <div class="tc-icon">🚗</div>
            <span class="tc-name">Cab</span>
          </div>
          <div class="tc-stats">
            <div class="stat-row">
              <span class="stat-key">Travel time</span>
              <span class="stat-val">${d.cab.time} min</span>
            </div>
            <div class="stat-row">
              <span class="stat-key">Estimated fare</span>
              <span class="stat-val">₹${d.cab.fare}</span>
            </div>
            <div class="stat-row">
              <span class="stat-key">Mode</span>
              <span class="stat-val" style="font-family:var(--font-body)">Door to Door</span>
            </div>
          </div>
          <button class="btn btn-cab" style="width:100%" onclick="openProviders('cab')">
            🚗 Book a Cab
          </button>
          <div id="prov-cab"></div>
        </div>

        ${metroSection}
      </div>

    </div>
  `;
}

// ── Deep-link URL builder ──────────────────────
//
// All URLs are built here in the browser using the plan data.
// encodeURIComponent ensures spaces and special chars are safe.
//
// IMPORTANT NOTES on each provider:
//
// UBER  — m.uber.com/ul/ is Uber's official mobile deep-link endpoint.
//   pickup=my_location  → uses device GPS for pickup (most reliable).
//   dropoff[formatted_address] → pre-fills the drop-off search box.
//   If lat/lon are available from the plan response, they are added for
//   pinpoint accuracy (Uber uses them to bypass its own geocoder).
//
// OLA   — book.olacabs.com accepts pickup_name / drop_name as URL params.
//   This is more reliable than the ola.onelink.me scheme which breaks in
//   browsers. Users may still need a one-tap confirmation on the Ola app.
//
// RAPIDO — No publicly documented deep-link API. Opening rapido.bike with
//   source/destination as query params is the closest available option;
//   the PWA may pre-fill if it recognises the params.
//
// GOOGLE MAPS TRANSIT — google.com/maps/dir/ with travelmode=transit is the
//   gold standard: reliably opens the transit route with source and destination
//   pre-filled. No login required. Works on both mobile and desktop.

function buildProviders(transport) {
  const src    = plan.source                  || '';
  const dst    = plan.event.destination       || '';
  const dstLat = plan.dest_lat                || '';  // optional, if backend sends
  const dstLon = plan.dest_lon                || '';

  const S = encodeURIComponent(src);
  const D = encodeURIComponent(dst);

  if (transport === 'cab') {
    // Build Uber URL — add lat/lon if available for precision
    let uberUrl = `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[formatted_address]=${D}`;
    if (dstLat && dstLon) {
      uberUrl += `&dropoff[latitude]=${dstLat}&dropoff[longitude]=${dstLon}`;
    }

    return [
      {
        name:  'Uber',
        emoji: '🚙',
        color: '#e0e0e0',
        url:   uberUrl,
        disp:  'm.uber.com',
        note:  null,
      },
      {
        name:  'Ola',
        emoji: '🟢',
        color: '#22d9a0',
        url:   `https://book.olacabs.com/?serviceType=p2p&pickup_name=${S}&drop_name=${D}`,
        disp:  'book.olacabs.com',
        note:  'Ola may need one-tap location confirmation.',
      },
      {
        name:  'Rapido',
        emoji: '🟡',
        color: '#fbbf24',
        url:   `https://www.rapido.bike/?pickup=${S}&drop=${D}`,
        disp:  'rapido.bike',
        note:  'Open Rapido app and confirm locations.',
      },
    ];
  }

  // Transit / Metro
  const mapsUrl =
    `https://www.google.com/maps/dir/?api=1` +
    `&origin=${S}` +
    `&destination=${D}` +
    `&travelmode=transit`;

  return [
    {
      name:  'Google Maps — Transit Route',
      emoji: '🗺️',
      color: 'var(--cyan)',
      url:   mapsUrl,
      disp:  'maps.google.com',
      note:  null,
      cls:   'prov-transit',
    },
    {
      name:  'Namma Metro Info (BMRCL)',
      emoji: '🚇',
      color: 'var(--green)',
      url:   'https://english.bmrc.co.in/',
      disp:  'bmrc.co.in',
      note:  'Check fares, schedules & interchange info.',
      cls:   'prov-transit',
    },
  ];
}

function openProviders(transport) {
  if (!activeEventId || !plan) { toast('No event selected', 'error'); return; }

  const providers = buildProviders(transport);
  renderProviders(transport, providers);

  // Dim the trigger button
  const btn = document.querySelector(
    `#tc-${transport} .btn-${transport === 'cab' ? 'cab' : 'metro'}`
  );
  if (btn) { btn.disabled = true; btn.style.opacity = '0.4'; }
}

function renderProviders(transport, providers) {
  const wrap = $(`prov-${transport}`);
  if (!wrap) return;

  const isTransit = transport === 'metro';
  const label     = isTransit ? 'Open transit route via:' : 'Choose your cab app:';

  wrap.innerHTML = `
    <div class="providers-wrap">
      <div class="providers-label">${label}</div>
      <div class="providers-list">
        ${providers.map(p => `
          <a class="prov-link ${p.cls||''}"
             href="${esc(p.url)}"
             target="_blank"
             rel="noopener noreferrer">
            <div class="prov-left">
              <span class="prov-emoji">${p.emoji}</span>
              <div class="prov-info">
                <div class="prov-name" style="color:${p.color}">${esc(p.name)}</div>
                <div class="prov-url">${esc(p.disp)}</div>
              </div>
            </div>
            <span class="prov-ext">
              ↗
            </span>
          </a>
          ${p.note ? `<div class="prov-note">ℹ️ ${esc(p.note)}</div>` : ''}
        `).join('')}
      </div>
    </div>
  `;
}

// ── Placeholder ────────────────────────────────
function showPlaceholder() {
  $('commute-panel').innerHTML = `
    <div class="commt-placeholder">
      <div class="placeholder-icon">🗺️</div>
      <div class="placeholder-text">Select an event to plan your commute</div>
      <div class="placeholder-sub">Cab & metro options will appear here</div>
    </div>`;
}

// ── Init ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  showPlaceholder();
  loadEvents();
  $('ev-date').min = new Date().toISOString().split('T')[0];
});