const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const dayjs = require('dayjs');
const config = require('./config');

const SHEET_TITLES = {
  SERVICES: 'Services',
  SLOTS: 'Slots',
  BOOKINGS: 'Bookings',
  WORK_HOURS: 'WorkHours',
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
    'duration_min',
    'slot_times',
    'client_name',
    'phone',
    'client_chat_id',
    'status',
    'reminder_sent',
    'created_at',
  ],
  [SHEET_TITLES.WORK_HOURS]: ['weekday', 'start', 'end'],
};

// Порядок днів тижня (Пн — перший день, як зазвичай в українському календарі).
// Індекс у масиві НЕ відповідає dayjs .day() (там 0 = неділя) — для цього є WEEKDAY_BY_DAYJS_INDEX.
const WEEKDAY_ORDER = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
// dayjs .day(): 0=неділя, 1=понеділок, ... 6=субота
const WEEKDAY_BY_DAYJS_INDEX = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

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

// ---------- Утиліти для роботи з часом (HH:mm) ----------

function timeToMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(totalMinutes) {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function addMinutesToTime(time, minutes) {
  return minutesToTime(timeToMinutes(time) + minutes);
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
    // Ігноруємо биті/порожні рядки (наприклад, випадковий порожній рядок у
    // таблиці) — без дати або часу слот все одно непридатний для бронювання,
    // а без цього фільтра він ламав пошук послідовних слотів (undefined.split).
    .filter((row) => row.get('date') && row.get('time'))
    .map((row) => ({ date: row.get('date'), time: row.get('time'), _row: row }))
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
}

async function addSlot(date, time) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[SHEET_TITLES.SLOTS];
  await sheet.addRow({ date, time, status: 'free' });
}

// Усі слоти (і вільні, і заброньовані) — на відміну від getFreeSlots(), яка
// свідомо ховає зайняті. Потрібна там, де важливо не створити дубль слота,
// що вже існує, незалежно від його статусу.
async function getAllSlots() {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[SHEET_TITLES.SLOTS];
  const rows = await sheet.getRows();
  return rows
    .filter((row) => row.get('date') && row.get('time'))
    .map((row) => ({ date: row.get('date'), time: row.get('time'), status: row.get('status'), _row: row }));
}

// Масово створює вільні слоти на одну дату з кроком SLOT_INTERVAL_MINUTES,
// починаючи з startTime (включно) і до endTime (не включно).
// Наприклад addSlotsRange('2026-08-10', '10:00', '18:00') створить
// слоти 10:00, 10:30, 11:00 ... 17:30 (якщо крок 30 хв).
async function addSlotsRange(date, startTime, endTime) {
  const interval = config.SLOT_INTERVAL_MINUTES;
  // Важливо: перевіряємо ВСІ слоти на цю дату (а не лише вільні) — інакше
  // вже заброньований час не вважається "існуючим", і при повторному запуску
  // (наприклад, авто-генерацією раз на кілька хвилин) для нього створюється
  // дублікат-рядок зі статусом "free".
  const existing = new Set((await getAllSlots()).filter((s) => s.date === date).map((s) => s.time));
  const created = [];
  const skipped = [];
  let cur = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  while (cur < end) {
    const time = minutesToTime(cur);
    if (existing.has(time)) {
      skipped.push(time);
    } else {
      await addSlot(date, time);
      existing.add(time);
      created.push(time);
    }
    cur += interval;
  }
  return { created, skipped };
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

// Повертає список можливих "стартів" запису для послуги заданої тривалості:
// для кожного вільного слота перевіряє, чи є достатньо послідовних вільних
// слотів підряд (з кроком SLOT_INTERVAL_MINUTES), щоб вмістити всю послугу.
// Кожен елемент результату містить slotTimes — точний список часів, які треба
// зайняти, якщо клієнт обере саме цей старт.
async function getBookableStartSlots(durationMin) {
  const interval = config.SLOT_INTERVAL_MINUTES;
  const neededCount = Math.max(1, Math.ceil(Number(durationMin) / interval));

  // Сьогоднішню дату клієнтам не пропонуємо (запис на сьогодні через бота не
  // приймаємо), а будь-які дати РАНІШЕ сьогодні — це вже прострочені слоти
  // (наприклад, лишились незакритими з минулого) і показувати їх точно не
  // можна. Порівняння рядків ISO-дат (YYYY-MM-DD) працює як звичайне
  // хронологічне порівняння.
  const today = dayjs().format('YYYY-MM-DD');

  const freeSlots = (await getFreeSlots()).filter((s) => s.date > today);
  const byDate = {};
  for (const s of freeSlots) {
    if (!byDate[s.date]) byDate[s.date] = new Set();
    byDate[s.date].add(s.time);
  }

  const result = [];
  for (const date of Object.keys(byDate)) {
    const set = byDate[date];
    for (const time of set) {
      const slotTimes = [];
      let cur = time;
      let ok = true;
      for (let i = 0; i < neededCount; i++) {
        if (!set.has(cur)) {
          ok = false;
          break;
        }
        slotTimes.push(cur);
        cur = addMinutesToTime(cur, interval);
      }
      if (ok) {
        result.push({ date, time, slotTimes });
      }
    }
  }

  return result.sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
}

// ---------- Bookings ----------

// Проста внутрішньопроцесна черга (мьютекс), щоб перевірка "слот вільний" і
// сам запис відбувались як єдина неподільна операція. Без цього два клієнти,
// які тиснуть "Підтвердити" майже одночасно, можуть обидва пройти перевірку
// ДО того, як хтось із них встигне зайняти слот — і обидва запишуться на один
// і той самий час (саме це й трапилось). Спрацьовує, поки бот працює як один
// процес (стандартний випадок для Render free-тарифу).
let bookingQueue = Promise.resolve();
function withBookingLock(fn) {
  const run = bookingQueue.then(fn, fn);
  bookingQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// Атомарно перевіряє, що потрібні слоти підряд досі вільні, і одразу створює
// запис. Повертає { ok: false } якщо хтось встиг зайняти час, поки клієнт
// підтверджував. Це основний спосіб створення запису з боку клієнта —
// замість окремих getBookableStartSlots() + addBooking().
async function bookSlotsAtomic({ date, time, service, price, durationMin, clientName, phone, clientChatId }) {
  return withBookingLock(async () => {
    const bookable = await getBookableStartSlots(durationMin);
    const match = bookable.find((s) => s.date === date && s.time === time);
    if (!match) {
      return { ok: false };
    }
    const id = await addBooking({
      date,
      time,
      service,
      price,
      durationMin,
      slotTimes: match.slotTimes,
      clientName,
      phone,
      clientChatId,
    });
    return { ok: true, id, slotTimes: match.slotTimes };
  });
}

async function addBooking({ date, time, service, price, durationMin, slotTimes, clientName, phone, clientChatId }) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[SHEET_TITLES.BOOKINGS];
  const id = `${Date.now()}`;
  await sheet.addRow({
    id,
    date,
    time,
    service,
    price,
    duration_min: durationMin,
    slot_times: slotTimes.join(','),
    client_name: clientName,
    phone,
    client_chat_id: String(clientChatId),
    status: 'confirmed',
    reminder_sent: 'no',
    created_at: new Date().toISOString(),
  });
  for (const t of slotTimes) {
    await markSlotStatus(date, t, 'booked');
  }
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
      duration_min: row.get('duration_min'),
      slot_times: row.get('slot_times'),
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

  const slotTimes = (match.slot_times || match.time || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  for (const t of slotTimes) {
    await markSlotStatus(match.date, t, 'free');
  }
  return match;
}

async function markReminderSent(id) {
  const bookings = await getBookings();
  const match = bookings.find((b) => b.id === id);
  if (!match) return;
  match._row.set('reminder_sent', 'yes');
  await match._row.save();
}

// ---------- Графік роботи (WorkHours) ----------

// Повертає графік у вигляді { 'Пн': {start:'10:00', end:'18:00'}, ... }.
// Дні, яких немає в таблиці, вважаються вихідними.
async function getWorkHours() {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[SHEET_TITLES.WORK_HOURS];
  const rows = await sheet.getRows();
  const result = {};
  for (const row of rows) {
    const weekday = row.get('weekday');
    if (!weekday) continue;
    result[weekday] = { start: row.get('start'), end: row.get('end'), _row: row };
  }
  return result;
}

async function setWorkHour(weekday, start, end) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[SHEET_TITLES.WORK_HOURS];
  const rows = await sheet.getRows();
  const match = rows.find((r) => r.get('weekday') === weekday);
  if (match) {
    match.set('start', start);
    match.set('end', end);
    await match.save();
  } else {
    await sheet.addRow({ weekday, start, end });
  }
}

async function deleteWorkHour(weekday) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[SHEET_TITLES.WORK_HOURS];
  const rows = await sheet.getRows();
  const match = rows.find((r) => r.get('weekday') === weekday);
  if (match) {
    await match.delete();
    return true;
  }
  return false;
}

// Генерує (за потреби) слоти на найближчі daysAhead днів на основі графіка
// роботи. Вже наявні слоти не чіпає й не дублює (addSlotsRange сам пропускає
// існуючі). Повертає масив { date, created } лише для днів, де щось додалося.
async function generateUpcomingSlots(daysAhead) {
  const workHours = await getWorkHours();
  const summary = [];
  for (let i = 0; i < daysAhead; i++) {
    const d = dayjs().add(i, 'day');
    const weekday = WEEKDAY_BY_DAYJS_INDEX[d.day()];
    const wh = workHours[weekday];
    if (!wh || !wh.start || !wh.end) continue;
    const date = d.format('YYYY-MM-DD');
    const { created } = await addSlotsRange(date, wh.start, wh.end);
    if (created.length) {
      summary.push({ date, weekday, created: created.length });
    }
  }
  return summary;
}

module.exports = {
  SHEET_TITLES,
  WEEKDAY_ORDER,
  getServices,
  addService,
  deleteServiceByName,
  getFreeSlots,
  addSlot,
  addSlotsRange,
  removeSlot,
  markSlotStatus,
  getBookableStartSlots,
  bookSlotsAtomic,
  addBooking,
  getBookings,
  cancelBooking,
  markReminderSent,
  getWorkHours,
  setWorkHour,
  deleteWorkHour,
  generateUpcomingSlots,
};
