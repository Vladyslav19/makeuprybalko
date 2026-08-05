const cron = require('node-cron');
const dayjs = require('dayjs');
const sheets = require('./sheets');
const config = require('./config');

// Проверяет предстоящие записи и шлёт напоминание клиенту, если до визита осталось
// меньше REMINDER_HOURS_BEFORE часов и напоминание ещё не отправлялось.
async function runReminderCheck(bot) {
  const bookings = await sheets.getBookings({ status: 'confirmed' });
  const now = dayjs();
  const windowEnd = now.add(config.REMINDER_HOURS_BEFORE, 'hour');
  let sent = 0;

  for (const b of bookings) {
    if (b.reminder_sent === 'yes') continue;
    const visitAt = dayjs(`${b.date} ${b.time}`, 'YYYY-MM-DD HH:mm');
    if (!visitAt.isValid()) continue;
    // Напоминаем, только если визит ещё не прошёл и попадает в окно напоминания
    if (visitAt.isAfter(now) && visitAt.isBefore(windowEnd)) {
      try {
        await bot.telegram.sendMessage(
          b.client_chat_id,
          `⏰ Напоминание: у вас запись на ${visitAt.format('DD.MM.YYYY')} в ${b.time} (${b.service}). Ждём вас!`
        );
        await sheets.markReminderSent(b.id);
        sent += 1;
      } catch (e) {
        console.error(`Не удалось отправить напоминание для брони #${b.id}:`, e.message);
      }
    }
  }
  return { checked: bookings.length, sent };
}

// Внутренний cron-таймер работает, пока процесс не спит (годится для VPS/Railway).
// На бесплатном Render с усыплением используйте дополнительно внешний пинг на /reminders/run.
function scheduleInternalReminderCron(bot) {
  cron.schedule('*/15 * * * *', () => {
    runReminderCheck(bot).catch((e) => console.error('Ошибка проверки напоминаний:', e));
  });
}

module.exports = { runReminderCheck, scheduleInternalReminderCron };
