const { Markup } = require('telegraf');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

const sheets = require('../sheets');
const config = require('../config');
const { runSlotGeneration } = require('../slotsGenerator');

function isAdmin(ctx) {
  return config.ADMIN_CHAT_ID && String(ctx.from.id) === config.ADMIN_CHAT_ID;
}

function requireAdmin(handler) {
  return async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('Ця команда доступна лише майстру.');
      return;
    }
    return handler(ctx);
  };
}

// Розуміє і 2026-08-10, і 10.08.2026
function parseDateArg(raw) {
  const iso = dayjs(raw, 'YYYY-MM-DD', true);
  if (iso.isValid()) return iso.format('YYYY-MM-DD');
  const ua = dayjs(raw, 'DD.MM.YYYY', true);
  if (ua.isValid()) return ua.format('YYYY-MM-DD');
  return null;
}

function formatEndTime(date, time, durationMin) {
  if (!durationMin) return null;
  return dayjs(`${date} ${time}`, 'YYYY-MM-DD HH:mm').add(Number(durationMin), 'minute').format('HH:mm');
}

function registerAdminHandlers(bot) {
  bot.command('admin', requireAdmin(async (ctx) => {
    await ctx.reply(
      'Адмін-панель майстра:\n\n' +
        '💇 Послуги\n' +
        '  /services — список послуг\n' +
        '  /addservice Назва;Тривалість_хв;Ціна\n' +
        '  /delservice Назва\n\n' +
        '🕐 Слоти (вільний час)\n' +
        '  /slots — список вільних слотів\n' +
        '  /addslot ДД.ММ.РРРР ГГ:ХХ — один слот\n' +
        `  /addslots ДД.ММ.РРРР ГГ:ХХ ГГ:ХХ — діапазон слотів з кроком ${config.SLOT_INTERVAL_MINUTES} хв\n` +
        '  /delslot ДД.ММ.РРРР ГГ:ХХ\n\n' +
        '📅 Графік роботи (автоматичні слоти)\n' +
        '  /workhours — показати поточний графік\n' +
        '  /setworkhours День ГГ:ХХ ГГ:ХХ — задати робочі години дня\n' +
        '  /delworkhours День — зробити день вихідним\n' +
        `  /generateweek — одразу відкрити слоти на ${config.DAYS_AHEAD_TO_GENERATE} дн. вперед за графіком\n\n` +
        '📖 Записи\n' +
        '  /bookings — майбутні записи клієнтів'
    );
  }));

  // ---------- Послуги ----------

  bot.command('services', requireAdmin(async (ctx) => {
    const services = await sheets.getServices();
    if (!services.length) {
      await ctx.reply('Послуг поки немає. Додайте: /addservice Назва;Тривалість_хв;Ціна');
      return;
    }
    const lines = services.map((s) => `• ${s.name} — ${s.price}₴, ${s.duration_min} хв`);
    await ctx.reply(lines.join('\n'));
  }));

  bot.command('addservice', requireAdmin(async (ctx) => {
    const arg = ctx.message.text.split(' ').slice(1).join(' ');
    const parts = arg.split(';').map((p) => p.trim());
    if (parts.length !== 3 || !parts[0] || isNaN(Number(parts[1])) || isNaN(Number(parts[2]))) {
      await ctx.reply('Формат: /addservice Назва;Тривалість_хв;Ціна\nНаприклад: /addservice Денний макіяж;60;1000');
      return;
    }
    const [name, duration, price] = parts;
    await sheets.addService(name, Number(duration), Number(price));
    await ctx.reply(`Додано: ${name} — ${price}₴ (${duration} хв)`);
  }));

  bot.command('delservice', requireAdmin(async (ctx) => {
    const name = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!name) {
      await ctx.reply('Формат: /delservice Назва');
      return;
    }
    const ok = await sheets.deleteServiceByName(name);
    await ctx.reply(ok ? `Послугу «${name}» видалено.` : `Не знайшов послугу «${name}». Перевірте /services`);
  }));

  // ---------- Слоти ----------

  bot.command('slots', requireAdmin(async (ctx) => {
    const slots = await sheets.getFreeSlots();
    if (!slots.length) {
      await ctx.reply('Вільних слотів немає. Додайте: /addslot ДД.ММ.РРРР ГГ:ХХ');
      return;
    }
    const lines = slots.map((s) => `• ${dayjs(s.date).format('DD.MM.YYYY')} ${s.time}`);
    await ctx.reply(lines.join('\n'));
  }));

  bot.command('addslot', requireAdmin(async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length !== 2) {
      await ctx.reply('Формат: /addslot ДД.ММ.РРРР ГГ:ХХ\nНаприклад: /addslot 10.08.2026 14:00');
      return;
    }
    const date = parseDateArg(args[0]);
    const time = args[1];
    if (!date || !/^\d{1,2}:\d{2}$/.test(time)) {
      await ctx.reply('Не розпізнав дату або час. Формат: /addslot ДД.ММ.РРРР ГГ:ХХ');
      return;
    }
    await sheets.addSlot(date, time);
    await ctx.reply(`Слот додано: ${dayjs(date).format('DD.MM.YYYY')} ${time}`);
  }));

  bot.command('addslots', requireAdmin(async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length !== 3) {
      await ctx.reply(
        'Формат: /addslots ДД.ММ.РРРР ГГ:ХХ_початок ГГ:ХХ_кінець\n' +
          `Наприклад: /addslots 10.08.2026 10:00 18:00 — створить слоти кожні ${config.SLOT_INTERVAL_MINUTES} хв з 10:00 до 17:30 включно`
      );
      return;
    }
    const date = parseDateArg(args[0]);
    const [start, end] = [args[1], args[2]];
    if (!date || !/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
      await ctx.reply('Не розпізнав дату або час. Формат: /addslots ДД.ММ.РРРР ГГ:ХХ ГГ:ХХ');
      return;
    }
    const { created, skipped } = await sheets.addSlotsRange(date, start, end);
    let msg = `Готово: створено ${created.length} слот(ів) на ${dayjs(date).format('DD.MM.YYYY')} (${created.join(', ') || '—'}).`;
    if (skipped.length) {
      msg += `\nВже існували і були пропущені: ${skipped.join(', ')}.`;
    }
    await ctx.reply(msg);
  }));

  bot.command('delslot', requireAdmin(async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length !== 2) {
      await ctx.reply('Формат: /delslot ДД.ММ.РРРР ГГ:ХХ');
      return;
    }
    const date = parseDateArg(args[0]);
    const time = args[1];
    if (!date) {
      await ctx.reply('Не розпізнав дату.');
      return;
    }
    const ok = await sheets.removeSlot(date, time);
    await ctx.reply(ok ? 'Слот видалено.' : 'Такий вільний слот не знайдено.');
  }));

  // ---------- Графік роботи (автогенерація слотів) ----------

  bot.command('workhours', requireAdmin(async (ctx) => {
    const wh = await sheets.getWorkHours();
    const lines = sheets.WEEKDAY_ORDER.map((code) => {
      const entry = wh[code];
      return entry ? `${code}: ${entry.start}–${entry.end}` : `${code}: вихідний`;
    });
    await ctx.reply(
      `Графік роботи:\n\n${lines.join('\n')}\n\n` +
        'Змінити день: /setworkhours День ГГ:ХХ ГГ:ХХ\n' +
        'Зробити вихідним: /delworkhours День'
    );
  }));

  bot.command('setworkhours', requireAdmin(async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length !== 3) {
      await ctx.reply(
        'Формат: /setworkhours День ГГ:ХХ_початок ГГ:ХХ_кінець\n' +
          `Дні: ${sheets.WEEKDAY_ORDER.join(', ')}\n` +
          'Наприклад: /setworkhours Пн 10:00 18:00'
      );
      return;
    }
    const code = sheets.WEEKDAY_ORDER.find((c) => c.toLowerCase() === args[0].trim().toLowerCase());
    const [start, end] = [args[1], args[2]];
    if (!code) {
      await ctx.reply(`Не розпізнав день тижня. Використовуйте: ${sheets.WEEKDAY_ORDER.join(', ')}`);
      return;
    }
    if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
      await ctx.reply('Не розпізнав час. Формат ГГ:ХХ, наприклад 10:00');
      return;
    }
    await sheets.setWorkHour(code, start, end);
    await ctx.reply(`Графік оновлено: ${code} ${start}–${end}.\nЩоб одразу відкрити слоти на найближчі дні за новим графіком: /generateweek`);
  }));

  bot.command('delworkhours', requireAdmin(async (ctx) => {
    const raw = ctx.message.text.split(' ').slice(1).join(' ').trim();
    const code = sheets.WEEKDAY_ORDER.find((c) => c.toLowerCase() === raw.toLowerCase());
    if (!code) {
      await ctx.reply(`Формат: /delworkhours День (${sheets.WEEKDAY_ORDER.join(', ')})`);
      return;
    }
    const ok = await sheets.deleteWorkHour(code);
    await ctx.reply(ok ? `${code} тепер вихідний.` : `${code} і так вже був без графіка.`);
  }));

  bot.command('generateweek', requireAdmin(async (ctx) => {
    await ctx.reply(`Генерую слоти на найближчі ${config.DAYS_AHEAD_TO_GENERATE} дн. за графіком роботи...`);
    const summary = await runSlotGeneration();
    if (!summary.length) {
      await ctx.reply('Нових слотів не додано — або графік порожній (/workhours), або всі слоти на ці дні вже існують.');
      return;
    }
    const lines = summary.map((s) => `• ${dayjs(s.date).format('DD.MM.YYYY')} (${s.weekday}) — додано ${s.created} слот(ів)`);
    await ctx.reply(`Готово:\n${lines.join('\n')}`);
  }));

  // ---------- Записи ----------

  bot.command('bookings', requireAdmin(async (ctx) => {
    const bookings = await sheets.getBookings({ status: 'confirmed' });
    if (!bookings.length) {
      await ctx.reply('Активних записів немає.');
      return;
    }
    const sorted = bookings.sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
    for (const b of sorted) {
      const endTime = formatEndTime(b.date, b.time, b.duration_min);
      const timeLabel = endTime ? `${b.time}–${endTime}` : b.time;
      await ctx.reply(
        `#${b.id} — ${dayjs(b.date).format('DD.MM.YYYY')} ${timeLabel}\n` +
          `${b.service} (${b.price}₴)\n` +
          `Клієнт: ${b.client_name}, тел. ${b.phone}`,
        Markup.inlineKeyboard([Markup.button.callback('❌ Скасувати запис', `admin_cancel:${b.id}`)])
      );
    }
  }));

  bot.action(/admin_cancel:(.+)/, requireAdmin(async (ctx) => {
    const id = ctx.match[1];
    const cancelled = await sheets.cancelBooking(id);
    await ctx.answerCbQuery();
    if (!cancelled) {
      await ctx.reply('Запис не знайдено або вже скасовано.');
      return;
    }
    await ctx.editMessageText(`Запис #${id} скасовано майстром.`);
    if (cancelled.client_chat_id) {
      await ctx.telegram
        .sendMessage(
          cancelled.client_chat_id,
          `На жаль, ваш запис на ${dayjs(cancelled.date).format('DD.MM.YYYY')} о ${cancelled.time} (${cancelled.service}) було скасовано майстром. Зв'яжіться для уточнення деталей.`
        )
        .catch(() => {});
    }
  }));
}

module.exports = { registerAdminHandlers, isAdmin };
