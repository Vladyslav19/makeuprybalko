const express = require('express');
const { Telegraf, Scenes, session } = require('telegraf');

const config = require('./config');
const { bookingWizard } = require('./scenes/bookingWizard');
const { registerClientHandlers } = require('./handlers/client');
const { registerAdminHandlers } = require('./handlers/admin');
const { runReminderCheck, scheduleInternalReminderCron } = require('./reminders');
const { runSlotGeneration, scheduleInternalSlotGenerationCron } = require('./slotsGenerator');

if (!config.BOT_TOKEN) {
  console.error('BOT_TOKEN не задано. Перевірте .env / змінні середовища на хостингу.');
  process.exit(1);
}

const bot = new Telegraf(config.BOT_TOKEN);

const stage = new Scenes.Stage([bookingWizard]);
bot.use(session());
bot.use(stage.middleware());

registerClientHandlers(bot);
registerAdminHandlers(bot);

bot.catch((err, ctx) => {
  console.error(`Помилка під час обробки оновлення ${ctx.updateType}:`, err);
});

// Внутрішній таймер нагадувань — працює, поки процес не "спить".
scheduleInternalReminderCron(bot);
// Внутрішній щотижневий таймер автогенерації слотів (запасний варіант,
// основний механізм — виклик runSlotGeneration() у /reminders/run нижче).
scheduleInternalSlotGenerationCron(bot);

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.send('Makeup booking bot is running');
});

// Точка входу для зовнішнього cron-пінгу (наприклад, cron-job.org або UptimeRobot), щоб:
// 1) не давати безкоштовному хостингу "засинати";
// 2) гарантовано перевіряти й надсилати нагадування, навіть якщо внутрішній cron не встиг спрацювати;
// 3) підтримувати вікно відкритих слотів на DAYS_AHEAD_TO_GENERATE днів вперед за графіком роботи.
// Досить налаштувати ОДИН зовнішній пінг на цей ендпоінт (кожні 10-15 хв) —
// він сам покриває і нагадування, і автогенерацію слотів.
app.get('/reminders/run', async (req, res) => {
  if (config.CRON_SECRET && req.query.secret !== config.CRON_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const reminders = await runReminderCheck(bot);
    let slotsGenerated = [];
    try {
      slotsGenerated = await runSlotGeneration();
      if (slotsGenerated.length && config.ADMIN_CHAT_ID) {
        const lines = slotsGenerated.map((s) => `• ${s.date} (${s.weekday}) — додано ${s.created} слот(ів)`);
        await bot.telegram
          .sendMessage(config.ADMIN_CHAT_ID, `🗓 Автоматично згенеровано слоти:\n${lines.join('\n')}`)
          .catch(() => {});
      }
    } catch (e) {
      console.error('Помилка автогенерації слотів у /reminders/run:', e);
    }
    res.json({ ok: true, reminders, slotsGenerated });
  } catch (e) {
    console.error('Помилка /reminders/run:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Окрема точка входу, якщо потрібно запустити тільки автогенерацію слотів вручну/ззовні.
app.get('/slots/generate', async (req, res) => {
  if (config.CRON_SECRET && req.query.secret !== config.CRON_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const summary = await runSlotGeneration();
    res.json({ ok: true, summary });
  } catch (e) {
    console.error('Помилка /slots/generate:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

async function start() {
  if (config.PUBLIC_URL) {
    // Режим webhook — рекомендується для хостингу (Render тощо)
    const webhookPath = `/telegraf/${config.BOT_TOKEN}`;
    app.use(bot.webhookCallback(webhookPath));
    // Порт відкриваємо ОДРАЗУ — Render має побачити відкритий порт швидко,
    // інакше він вирішить, що деплой не вдався.
    app.listen(config.PORT, () => {
      console.log(`HTTP-сервер слухає порт ${config.PORT}`);
    });
    await bot.telegram.setWebhook(`${config.PUBLIC_URL}${webhookPath}`);
    console.log(`Webhook встановлено на ${config.PUBLIC_URL}${webhookPath}`);
  } else {
    // Режим polling. Важливо: bot.launch() у режимі long polling НЕ завершується,
    // поки бот не зупинено — це нескінченний цикл отримання оновлень.
    // Тому не можна його чекати (await) перед відкриттям порту: код нижче просто
    // ніколи б не виконався. Відкриваємо порт одразу, а бота запускаємо "у фоні".
    app.listen(config.PORT, () => {
      console.log(`HTTP-сервер слухає порт ${config.PORT}`);
    });
    bot
      .launch()
      .then(() => console.log('Бот запущено в режимі long polling'))
      .catch((e) => console.error('Помилка запуску бота (polling):', e));
  }
}

start().catch((e) => {
  console.error('Не вдалося запустити бота:', e);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
