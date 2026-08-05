const { Markup } = require('telegraf');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

const sheets = require('../sheets');
const config = require('../config');

function isAdmin(ctx) {
  return config.ADMIN_CHAT_ID && String(ctx.from.id) === config.ADMIN_CHAT_ID;
}

function requireAdmin(handler) {
  return async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('Эта команда доступна только мастеру.');
      return;
    }
    return handler(ctx);
  };
}

// Понимает и 2026-08-10, и 10.08.2026
function parseDateArg(raw) {
  const iso = dayjs(raw, 'YYYY-MM-DD', true);
  if (iso.isValid()) return iso.format('YYYY-MM-DD');
  const ru = dayjs(raw, 'DD.MM.YYYY', true);
  if (ru.isValid()) return ru.format('YYYY-MM-DD');
  return null;
}

function registerAdminHandlers(bot) {
  bot.command('admin', requireAdmin(async (ctx) => {
    await ctx.reply(
      'Админ-панель мастера:\n\n' +
        '💇 Услуги\n' +
        '  /services — список услуг\n' +
        '  /addservice Название;Длительность_мин;Цена\n' +
        '  /delservice Название\n\n' +
        '🕐 Слоты (свободное время)\n' +
        '  /slots — список свободных слотов\n' +
        '  /addslot ДД.ММ.ГГГГ ЧЧ:ММ\n' +
        '  /delslot ДД.ММ.ГГГГ ЧЧ:ММ\n\n' +
        '📖 Записи\n' +
        '  /bookings — предстоящие записи клиентов'
    );
  }));

  // ---------- Услуги ----------

  bot.command('services', requireAdmin(async (ctx) => {
    const services = await sheets.getServices();
    if (!services.length) {
      await ctx.reply('Услуг пока нет. Добавьте: /addservice Название;Длительность_мин;Цена');
      return;
    }
    const lines = services.map((s) => `• ${s.name} — ${s.price}₽, ${s.duration_min} мин`);
    await ctx.reply(lines.join('\n'));
  }));

  bot.command('addservice', requireAdmin(async (ctx) => {
    const arg = ctx.message.text.split(' ').slice(1).join(' ');
    const parts = arg.split(';').map((p) => p.trim());
    if (parts.length !== 3 || !parts[0] || isNaN(Number(parts[1])) || isNaN(Number(parts[2]))) {
      await ctx.reply('Формат: /addservice Название;Длительность_мин;Цена\nНапример: /addservice Дневной макияж;60;2500');
      return;
    }
    const [name, duration, price] = parts;
    await sheets.addService(name, Number(duration), Number(price));
    await ctx.reply(`Добавлено: ${name} — ${price}₽ (${duration} мин)`);
  }));

  bot.command('delservice', requireAdmin(async (ctx) => {
    const name = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!name) {
      await ctx.reply('Формат: /delservice Название');
      return;
    }
    const ok = await sheets.deleteServiceByName(name);
    await ctx.reply(ok ? `Услуга «${name}» удалена.` : `Не нашёл услугу «${name}». Проверьте /services`);
  }));

  // ---------- Слоты ----------

  bot.command('slots', requireAdmin(async (ctx) => {
    const slots = await sheets.getFreeSlots();
    if (!slots.length) {
      await ctx.reply('Свободных слотов нет. Добавьте: /addslot ДД.ММ.ГГГГ ЧЧ:ММ');
      return;
    }
    const lines = slots.map((s) => `• ${dayjs(s.date).format('DD.MM.YYYY')} ${s.time}`);
    await ctx.reply(lines.join('\n'));
  }));

  bot.command('addslot', requireAdmin(async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length !== 2) {
      await ctx.reply('Формат: /addslot ДД.ММ.ГГГГ ЧЧ:ММ\nНапример: /addslot 10.08.2026 14:00');
      return;
    }
    const date = parseDateArg(args[0]);
    const time = args[1];
    if (!date || !/^\d{1,2}:\d{2}$/.test(time)) {
      await ctx.reply('Не распознал дату или время. Формат: /addslot ДД.ММ.ГГГГ ЧЧ:ММ');
      return;
    }
    await sheets.addSlot(date, time);
    await ctx.reply(`Слот добавлен: ${dayjs(date).format('DD.MM.YYYY')} ${time}`);
  }));

  bot.command('delslot', requireAdmin(async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length !== 2) {
      await ctx.reply('Формат: /delslot ДД.ММ.ГГГГ ЧЧ:ММ');
      return;
    }
    const date = parseDateArg(args[0]);
    const time = args[1];
    if (!date) {
      await ctx.reply('Не распознал дату.');
      return;
    }
    const ok = await sheets.removeSlot(date, time);
    await ctx.reply(ok ? 'Слот удалён.' : 'Такой свободный слот не найден.');
  }));

  // ---------- Записи ----------

  bot.command('bookings', requireAdmin(async (ctx) => {
    const bookings = await sheets.getBookings({ status: 'confirmed' });
    if (!bookings.length) {
      await ctx.reply('Активных записей нет.');
      return;
    }
    const sorted = bookings.sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
    for (const b of sorted) {
      await ctx.reply(
        `#${b.id} — ${dayjs(b.date).format('DD.MM.YYYY')} ${b.time}\n` +
          `${b.service} (${b.price}₽)\n` +
          `Клиент: ${b.client_name}, тел. ${b.phone}`,
        Markup.inlineKeyboard([Markup.button.callback('❌ Отменить запись', `admin_cancel:${b.id}`)])
      );
    }
  }));

  bot.action(/admin_cancel:(.+)/, requireAdmin(async (ctx) => {
    const id = ctx.match[1];
    const cancelled = await sheets.cancelBooking(id);
    await ctx.answerCbQuery();
    if (!cancelled) {
      await ctx.reply('Запись не найдена или уже отменена.');
      return;
    }
    await ctx.editMessageText(`Запись #${id} отменена мастером.`);
    if (cancelled.client_chat_id) {
      await ctx.telegram
        .sendMessage(
          cancelled.client_chat_id,
          `К сожалению, ваша запись на ${dayjs(cancelled.date).format('DD.MM.YYYY')} в ${cancelled.time} (${cancelled.service}) была отменена мастером. Свяжитесь для уточнения деталей.`
        )
        .catch(() => {});
    }
  }));
}

module.exports = { registerAdminHandlers, isAdmin };
