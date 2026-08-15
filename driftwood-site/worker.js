// Single Worker script: serves the static site AND handles /api/reservations
// Requires a KV namespace bound as RESERVATIONS (already set up in your dashboard).

// ---- Configure your shop here ----
const HOURS = {
  0: { open: '07:30', close: '14:00' }, // Sunday
  1: { open: '06:30', close: '16:00' }, // Monday
  2: { open: '06:30', close: '16:00' },
  3: { open: '06:30', close: '16:00' },
  4: { open: '06:30', close: '16:00' },
  5: { open: '06:30', close: '16:00' },
  6: { open: '07:00', close: '16:00' }, // Saturday
};

const SLOT_MINUTES = 30;
const TABLES_PER_SLOT = 4;
const MAX_PARTY_SIZE = 6;
const LAST_BOOKING_BUFFER_MIN = 60;
// -----------------------------------

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function minutesToTime(mins) {
  const h = Math.floor(mins / 60).toString().padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}
function isValidDate(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(new Date(dateStr + 'T00:00:00').getTime());
}
function buildSlots(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  const hours = HOURS[date.getDay()];
  if (!hours) return [];
  const open = timeToMinutes(hours.open);
  const close = timeToMinutes(hours.close) - LAST_BOOKING_BUFFER_MIN;
  const slots = [];
  for (let t = open; t <= close; t += SLOT_MINUTES) slots.push(minutesToTime(t));
  return slots;
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleAvailability(request, env) {
  const url = new URL(request.url);
  const date = url.searchParams.get('date');

  if (!date || !isValidDate(date)) {
    return json({ error: 'Provide a valid date=YYYY-MM-DD' }, 400);
  }

  const slots = buildSlots(date);
  if (slots.length === 0) {
    return json({ date, open: false, slots: [] });
  }

  const raw = await env.RESERVATIONS.get(`bookings:${date}`);
  const bookings = raw ? JSON.parse(raw) : [];

  const result = slots.map(time => {
    const tablesBooked = bookings.filter(b => b.time === time).length;
    return { time, tablesRemaining: Math.max(0, TABLES_PER_SLOT - tablesBooked) };
  });

  return json({
    date,
    open: true,
    tablesPerSlot: TABLES_PER_SLOT,
    maxPartySize: MAX_PARTY_SIZE,
    slots: result,
  });
}

async function handleBooking(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  const { date, time, name, email, partySize } = body || {};

  if (!date || !isValidDate(date)) return json({ error: 'Invalid date' }, 400);
  if (!name || typeof name !== 'string' || !name.trim()) return json({ error: 'Name is required' }, 400);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Valid email is required' }, 400);

  const party = Number(partySize);
  if (!Number.isInteger(party) || party < 1 || party > MAX_PARTY_SIZE) {
    return json({ error: `Party size must be between 1 and ${MAX_PARTY_SIZE}` }, 400);
  }

  const slots = buildSlots(date);
  if (!slots.includes(time)) return json({ error: 'That time slot is not available' }, 400);

  const key = `bookings:${date}`;
  const raw = await env.RESERVATIONS.get(key);
  const bookings = raw ? JSON.parse(raw) : [];

  const tablesBooked = bookings.filter(b => b.time === time).length;
  if (tablesBooked >= TABLES_PER_SLOT) {
    return json({ error: 'That time just filled up — pick another slot' }, 409);
  }

  const booking = {
    id: crypto.randomUUID(),
    date,
    time,
    name: name.trim(),
    email: email.trim(),
    partySize: party,
    createdAt: new Date().toISOString(),
  };

  bookings.push(booking);
  await env.RESERVATIONS.put(key, JSON.stringify(bookings));

  return json({ ok: true, booking });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/reservations') {
      if (request.method === 'GET') return handleAvailability(request, env);
      if (request.method === 'POST') return handleBooking(request, env);
      return new Response('Method not allowed', { status: 405 });
    }

    // everything else falls through to the static site
    return env.ASSETS.fetch(request);
  },
};
