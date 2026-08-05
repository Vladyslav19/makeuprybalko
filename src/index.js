const express = require('express');
const { Telegraf, Scenes, session } = require('telegraf');

const config = require('./config');
const { bookingWizard } = require('./scenes/bookingWizard');
const { registerClientHandlers } = require('./handlers/client');
const { registerAdminHandlers } = require('./handlers/admin');
const { runReminderCheck, scheduleInternalReminderCron } = require('./reminders');

if (!config.BOT_TOKEN) {
  console.error('BOT_TOKEN не задан. Проверьте .env / переменные окружения на хостинге.');
  process.exit(1);
}

const bot = new Telegraf(config.BOT_TOKEN);

const stage = new Scenes.Stage([bookingWizard]);
bot.use(session());
bot.use(stage.middleware());

registerClientHandlers(bot);
registerAdminHandlers(bot);

bot.catch((err, ctx) => {
  console.error(`Ошибка при обработке обновления ${ctx.updateType}:`, err);
});

// Внутренний таймер напоминаний — работает, пока процесс не "спит".
scheduleInternalReminderCron(bot);

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.send('Makeup booking bot is running');
});

// Точка входа для внешнего cron-пинга (например, cron-job.org), чтобы:
// 1) не давать бесплатному хостингу "засыпать";
// 2) гарантированно проверять и слать напоминания, даже если внутренний cron не успел сработать.
app.get('/reminders/run', async (req, res) => {
  if (config.CRON_SECRET && req.query.secret !== config.CRON_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const result = await runReminderCheck(bot);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('Ошибка /reminders/run:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

async function start() {
  if (config.PUBLIC_URL) {
    // Режим webhook — рекомендуется для хостинга (Render и т.п.)
    const webhookPath = `/telegraf/${config.BOT_TOKEN}`;
    app.use(bot.webhookCallback(webhookPath));
    await bot.telegram.setWebhook(`${config.PUBLIC_URL}${webhookPath}`);
    console.log(`Webhook установлен на ${config.PUBLIC_URL}${webhookPath}`);
  } else {
    // Режим polling — удобен для локальной разработки
    await bot.launch();
    console.log('Бот запущен в режиме long polling (локальный режим)');
  }

  app.listen(config.PORT, () => {
    console.log(`HTTP-сервер слушает порт ${config.PORT}`);
  });
}

start().catch((e) => {
  console.error('Не удалось запустить бота:', e);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
