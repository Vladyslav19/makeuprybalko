const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const config = require('./config');

const SHEET_TITLES = {
  SERVICES: 'Services',
  SLOTS: 'Slots',
  BOOKINGS: 'Bookings',
};

const HEADERS = {
  [SHEET_TITLES.SERVICES]: ['name', 'duration_min', 'price'],
  [SHEET_TITLES.SLOTS]: ['date', 'time', 'status'],
  [SHEET_TITLES.BOOKINGS]: [
    'id',
    'date',
    'time',
    'service',
    'price',
    'client_name',
    'phone',
    'client_chat_id',
    'status',
    'reminder_sent',
    'created_at',
  ],
};

let docPromise = null;

async function getDoc() {
  if (!docPromise) {
    docPromise = (async () => {
      const jwt = new JWT({
        email: config.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: config.GOOGLE_PRIVATE_KEY,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const doc = new GoogleSpreadsheet(config.SHEET_ID, jwt);
      await doc.loadInfo();
      await ensureSheets(doc);
      return doc;
    })();
  }
  return docPromise;
}

// Створює відсутні вкладки з потрібними заголовками, якщо їх ще немає в таблиці.
async function ensureSheets(doc) {
  for (const title of Object.values(SHEET_TITLES)) {
    let sheet = doc.sheetsByTitle[title];
    if (!sheet) {
      sheet = await doc.addSheet({ title, headerValues: HEADERS[title] });
    } else {
      await sheet.loadHeaderRow().catch(async () => {
        await sheet.setHeaderRow(HEADERS[title]);
      });
    }
  }
}

// ---------- Services ----------

async function getServices() {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[SHEET_TITLES.SERVICES];
  const rows = await sheet.getRows();
  return rows.map((row, index) => ({
    rowIndex: index,
    name: row.get('name'),
    duration_min: row.get('duration_min'),
    price: row.get('price'),
    _row: row,
  }));
}

async function addService(name, durationMin, price) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[SHEET_TITLES.SERVICES];
  await sheet.addRow({ name, duration_min: durationMin, price });
}

async function deleteServiceByName(name) {
  const services = await getServices();
  const match = services.find((s) => s.name === name);
  if (match) {
    await match._row.delete();
    return true;
  }
  return false;
}

// ---------- Slots ----------

async function getFreeSlots() {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[SHEET_TITLES.SLOTS];
  const rows = await sheet.getRows();
  return rows
    .filter((row) => (row.get('status') || 'free') === 'free')
    .map((row) => ({ date: row.get('date'), time: row.get('time'), _row: row }))
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
}

async function addSlot(date, time) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[SHEET_TITLES.SLOTS];
  await sheet.addRow({ date, time, status: 'free' });
}

async function removeSlot(date, time) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[SHEET_TITLES.SLOTS];
  const rows = await sheet.getRows();
  const match = rows.find((r) => r.get('date') === date && r.get('time') === time);
  if (match) {
    await match.delete();
    return true;
  }
  return false;
}

async function markSlotStatus(date, time, status) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[SHEET_TITLES.SLOTS];
  const rows = await sheet.getRows();
  const match = rows.find((r) => r.get('date') === date && r.get('time') === time);
  if (match) {
    match.set('status', status);
    await match.save();
    return true;
  }
  return false;
}

// ---------- Bookings ----------

async function addBooking({ date, time, service, price, clientName, phone, clientChatId }) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[SHEET_TITLES.BOOKINGS];
  const id = `${Date.now()}`;
  await sheet.addRow({
    id,
    date,
    time,
    service,
    price,
    client_name: clientName,
    phone,
    client_chat_id: String(clientChatId),
    status: 'confirmed',
    reminder_sent: 'no',
    created_at: new Date().toISOString(),
  });
  await markSlotStatus(date, time, 'booked');
  return id;
}

async function getBookings({ status } = {}) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[SHEET_TITLES.BOOKINGS];
  const rows = await sheet.getRows();
  return rows
    .filter((row) => !status || row.get('status') === status)
    .map((row) => ({
      id: row.get('id'),
      date: row.get('date'),
      time: row.get('time'),
      service: row.get('service'),
      price: row.get('price'),
      client_name: row.get('client_name'),
      phone: row.get('phone'),
      client_chat_id: row.get('client_chat_id'),
      status: row.get('status'),
      reminder_sent: row.get('reminder_sent'),
      _row: row,
    }));
}

async function cancelBooking(id) {
  const bookings = await getBookings();
  const match = bookings.find((b) => b.id === id);
  if (!match) return null;
  match._row.set('status', 'cancelled');
  await match._row.save();
  await markSlotStatus(match.date, match.time, 'free');
  return match;
}

async function markReminderSent(id) {
  const bookings = await getBookings();
  const match = bookings.find((b) => b.id === id);
  if (!match) return;
  match._row.set('reminder_sent', 'yes');
  await match._row.save();
}

module.exports = {
  SHEET_TITLES,
  getServices,
  addService,
  deleteServiceByName,
  getFreeSlots,
  addSlot,
  removeSlot,
  markSlotStatus,
  addBooking,
  getBookings,
  cancelBooking,
  markReminderSent,
};
