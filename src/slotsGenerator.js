const cron = require('node-cron');
const sheets = require('./sheets');
const config = require('./config');

// Підтримує вікно відкритих слотів на DAYS_AHEAD_TO_GENERATE днів вперед,
// спираючись на графік роботи (вкладка WorkHours). Вже наявні слоти не чіпає —
// безпечно викликати хоч щохвилини, зайвого не насотворює.
async function runSlotGeneration() {
  return sheets.generateUpcomingSlots(config.DAYS_AHEAD_TO_GENERATE);
}

// Щотижня (у понеділок вранці) на всяк випадок ще раз "довключаємо" слоти —
// головний механізм підтримки вікна все одно /reminders/run або /slots/generate
// (зовнішній пінг), цей внутрішній cron — лише запасний варіант, поки процес живий.
function scheduleInternalSlotGenerationCron(bot) {
  cron.schedule('0 3 * * 1', async () => {
    try {
      const summary = await runSlotGeneration();
      if (summary.length && config.ADMIN_CHAT_ID) {
        const lines = summary.map((s) => `• ${s.date} (${s.weekday}) — додано ${s.created} слот(ів)`);
        await bot.telegram.sendMessage(
          config.ADMIN_CHAT_ID,
          `🗓 Автоматично згенеровано слоти на найближчі дні:\n${lines.join('\n')}`
        );
      }
    } catch (e) {
      console.error('Помилка автогенерації слотів:', e);
    }
  });
}

module.exports = { runSlotGeneration, scheduleInternalSlotGenerationCron };
