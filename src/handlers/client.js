const { Markup } = require('telegraf');
const dayjs = require('dayjs');
const sheets = require('../sheets');

function registerClientHandlers(bot) {
  bot.start(async (ctx) => {
    await ctx.reply(
      'Здравствуйте! Это бот записи на макияж.\n\n' +
        '📅 /book — записаться на визит\n' +
        '🗂 /mybookings — мои записи\n' +
        'ℹ️ /help — помощь',
      Markup.keyboard([['📅 Записаться'], ['🗂 Мои записи']]).resize()
    );
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      'Команды:\n' +
        '/book — записаться на макияж\n' +
        '/mybookings — посмотреть свои записи\n' +
        '/cancelbooking — отменить одну из своих записей'
    );
  });

  bot.hears('📅 Записаться', (ctx) => ctx.scene.enter('booking-wizard'));
  bot.command('book', (ctx) => ctx.scene.enter('booking-wizard'));

  const showBookings = async (ctx) => {
    const all = await sheets.getBookings({ status: 'confirmed' });
    const mine = all.filter((b) => b.client_chat_id === String(ctx.from.id));
    if (!mine.length) {
      await ctx.reply('У вас пока нет активных записей. Отправьте /book, чтобы записаться.');
      return;
    }
    const lines = mine.map(
      (b) => `#${b.id} — ${dayjs(b.date).format('DD.MM.YYYY')} в ${b.time}, ${b.service} (${b.price}₽)`
    );
    await ctx.reply(`Ваши записи:\n\n${lines.join('\n')}\n\nЧтобы отменить: /cancelbooking`);
  };

  bot.hears('🗂 Мои записи', showBookings);
  bot.command('mybookings', showBookings);

  bot.command('cancelbooking', async (ctx) => {
    const all = await sheets.getBookings({ status: 'confirmed' });
    const mine = all.filter((b) => b.client_chat_id === String(ctx.from.id));
    if (!mine.length) {
      await ctx.reply('У вас нет активных записей для отмены.');
      return;
    }
    const buttons = mine.map((b) => [
      Markup.button.callback(
        `#${b.id} ${dayjs(b.date).format('DD.MM')} ${b.time} ${b.service}`,
        `cancel_own:${b.id}`
      ),
    ]);
    await ctx.reply('Какую запись отменить?', Markup.inlineKeyboard(buttons));
  });

  bot.action(/cancel_own:(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const booking = await sheets.getBookings();
    const match = booking.find((b) => b.id === id);
    if (!match || match.client_chat_id !== String(ctx.from.id)) {
      await ctx.answerCbQuery('Запись не найдена');
      return;
    }
    await sheets.cancelBooking(id);
    await ctx.answerCbQuery('Отменено');
    await ctx.editMessageText(`Запись #${id} отменена.`);

    const config = require('../config');
    if (config.ADMIN_CHAT_ID) {
      await ctx.telegram
        .sendMessage(
          config.ADMIN_CHAT_ID,
          `❌ Клиент отменил запись #${id} (${match.service}, ${dayjs(match.date).format('DD.MM.YYYY')} ${match.time})`
        )
        .catch(() => {});
    }
  });
}

module.exports = { registerClientHandlers };
