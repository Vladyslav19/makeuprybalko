const { Markup } = require('telegraf');
const dayjs = require('dayjs');
const sheets = require('../sheets');

function registerClientHandlers(bot) {
  bot.start(async (ctx) => {
    await ctx.reply(
      'Вітаємо! Це бот запису на макіяж.\n\n' +
        '📅 /book — записатися на візит\n' +
        '🗂 /mybookings — мої записи\n' +
        'ℹ️ /help — допомога',
      Markup.keyboard([['📅 Записатися'], ['🗂 Мої записи']]).resize()
    );
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      'Команди:\n' +
        '/book — записатися на макіяж\n' +
        '/mybookings — переглянути свої записи\n' +
        '/cancelbooking — скасувати один зі своїх записів'
    );
  });

  bot.hears('📅 Записатися', (ctx) => ctx.scene.enter('booking-wizard'));
  bot.command('book', (ctx) => ctx.scene.enter('booking-wizard'));

  const showBookings = async (ctx) => {
    const all = await sheets.getBookings({ status: 'confirmed' });
    const mine = all.filter((b) => b.client_chat_id === String(ctx.from.id));
    if (!mine.length) {
      await ctx.reply('У вас поки немає активних записів. Надішліть /book, щоб записатися.');
      return;
    }
    const lines = mine.map(
      (b) => `#${b.id} — ${dayjs(b.date).format('DD.MM.YYYY')} о ${b.time}, ${b.service} (${b.price}₴)`
    );
    await ctx.reply(`Ваші записи:\n\n${lines.join('\n')}\n\nЩоб скасувати: /cancelbooking`);
  };

  bot.hears('🗂 Мої записи', showBookings);
  bot.command('mybookings', showBookings);

  bot.command('cancelbooking', async (ctx) => {
    const all = await sheets.getBookings({ status: 'confirmed' });
    const mine = all.filter((b) => b.client_chat_id === String(ctx.from.id));
    if (!mine.length) {
      await ctx.reply('У вас немає активних записів для скасування.');
      return;
    }
    const buttons = mine.map((b) => [
      Markup.button.callback(
        `#${b.id} ${dayjs(b.date).format('DD.MM')} ${b.time} ${b.service}`,
        `cancel_own:${b.id}`
      ),
    ]);
    await ctx.reply('Який запис скасувати?', Markup.inlineKeyboard(buttons));
  });

  bot.action(/cancel_own:(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const booking = await sheets.getBookings();
    const match = booking.find((b) => b.id === id);
    if (!match || match.client_chat_id !== String(ctx.from.id)) {
      await ctx.answerCbQuery('Запис не знайдено');
      return;
    }
    await sheets.cancelBooking(id);
    await ctx.answerCbQuery('Скасовано');
    await ctx.editMessageText(`Запис #${id} скасовано.`);

    const config = require('../config');
    if (config.ADMIN_CHAT_ID) {
      await ctx.telegram
        .sendMessage(
          config.ADMIN_CHAT_ID,
          `❌ Клієнт скасував запис #${id} (${match.service}, ${dayjs(match.date).format('DD.MM.YYYY')} ${match.time})`
        )
        .catch(() => {});
    }
  });
}

module.exports = { registerClientHandlers };
