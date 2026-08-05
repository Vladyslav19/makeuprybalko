const cron = require('node-cron');
const dayjs = require('dayjs');
const sheets = require('./sheets');
const config = require('./config');

// Перевіряє майбутні записи і надсилає нагадування клієнту, якщо до візиту
// залишилось менше REMINDER_HOURS_BEFORE годин і нагадування ще не надсилалось.
async function runReminderCheck(bot) {
  const bookings = await sheets.getBookings({ status: 'confirmed' });
  const now = dayjs();
  const windowEnd = now.add(config.REMINDER_HOURS_BEFORE, 'hour');
  let sent = 0;

  for (const b of bookings) {
    if (b.reminder_sent === 'yes') continue;
    const visitAt = dayjs(`${b.date} ${b.time}`, 'YYYY-MM-DD HH:mm');
    if (!visitAt.isValid()) continue;
    // Нагадуємо, тільки якщо візит ще не пройшов і потрапляє у вікно нагадування
    if (visitAt.isAfter(now) && visitAt.isBefore(windowEnd)) {
      try {
        await bot.telegram.sendMessage(
          b.client_chat_id,
          `⏰ Нагадування: у вас запис на ${visitAt.format('DD.MM.YYYY')} о ${b.time} (${b.service}). Чекаємо на вас!`
        );
        await sheets.markReminderSent(b.id);
        sent += 1;
      } catch (e) {
        console.error(`Не вдалося надіслати нагадування для запису #${b.id}:`, e.message);
      }
    }
  }
  return { checked: bookings.length, sent };
}

// Внутрішній cron-таймер працює, поки процес не "спить" (годиться для VPS/Railway).
// На безкоштовному Render з засинанням додатково використовуйте зовнішній пінг на /reminders/run.
function scheduleInternalReminderCron(bot) {
  cron.schedule('*/15 * * * *', () => {
    runReminderCheck(bot).catch((e) => console.error('Помилка перевірки нагадувань:', e));
  });
}

module.exports = { runReminderCheck, scheduleInternalReminderCron };
