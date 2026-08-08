const { Scenes, Markup } = require('telegraf');
const dayjs = require('dayjs');
require('dayjs/locale/uk');
dayjs.locale('uk');
const sheets = require('../sheets');
const config = require('../config');

const STEP = {
  SERVICE: 'service',
  DATE: 'date',
  TIME: 'time',
  NAME: 'name',
  PHONE: 'phone',
  CONFIRM: 'confirm',
};

function formatDateLabel(dateStr) {
  return dayjs(dateStr).format('DD.MM.YYYY (dd)');
}

function formatEndTime(date, time, durationMin) {
  return dayjs(`${date} ${time}`, 'YYYY-MM-DD HH:mm').add(Number(durationMin), 'minute').format('HH:mm');
}

// Показує список послуг. Використовується і при вході в сцену, і при натисканні
// "Назад" з екрана вибору дати.
async function renderServiceList(ctx) {
  const services = await sheets.getServices();
  if (!services.length) {
    await ctx.reply(
      'Поки немає жодної послуги в прайсі. Попросіть майстра додати послуги через адмін-панель (/admin).'
    );
    return false;
  }
  const buttons = services.map((s) => [
    Markup.button.callback(`${s.name} — ${s.price}₴ (${s.duration_min} хв)`, `svc:${s.name}`),
  ]);
  if (ctx.callbackQuery) {
    await ctx.editMessageText('Оберіть послугу:', Markup.inlineKeyboard(buttons));
  } else {
    await ctx.reply('Оберіть послугу:', Markup.inlineKeyboard(buttons));
  }
  return true;
}

// Показує список доступних дат для вже обраної послуги (ctx.wizard.state.booking.durationMin).
// Використовується і при переході вперед з вибору послуги, і при натисканні
// "Назад" з екрана вибору часу.
async function renderDateList(ctx) {
  const durationMin = ctx.wizard.state.booking.durationMin;
  const bookable = await sheets.getBookableStartSlots(durationMin);
  if (!bookable.length) {
    await ctx.reply(
      'На жаль, немає достатньо вільного часу підряд для цієї послуги. Напишіть майстру напряму.'
    );
    return false;
  }
  const dates = [...new Set(bookable.map((s) => s.date))];
  const buttons = dates.map((d) => [Markup.button.callback(formatDateLabel(d), `date:${d}`)]);
  buttons.push([Markup.button.callback('⬅️ Назад (до послуг)', 'back')]);
  await ctx.editMessageText(
    'Оберіть дату:\n\nЯкщо немає зручної дати — напишіть майстру напряму.',
    Markup.inlineKeyboard(buttons)
  );
  return true;
}

// Показує список доступного часу початку для обраної дати.
async function renderTimeList(ctx, date) {
  const durationMin = ctx.wizard.state.booking.durationMin;
  const bookable = await sheets.getBookableStartSlots(durationMin);
  const times = bookable.filter((s) => s.date === date).map((s) => s.time);
  if (!times.length) {
    await ctx.reply('На цю дату вже не вистачає вільного часу підряд, оберіть іншу дату: /book');
    return false;
  }
  const buttons = times.map((t) => [
    Markup.button.callback(`${t}–${formatEndTime(date, t, durationMin)}`, `time:${t}`),
  ]);
  buttons.push([Markup.button.callback('⬅️ Назад (до дати)', 'back')]);
  await ctx.editMessageText(
    `Дата: ${formatDateLabel(date)}\nОберіть час початку:\n\nЯкщо немає зручного часу — напишіть майстру напряму.`,
    Markup.inlineKeyboard(buttons)
  );
  return true;
}

async function enterScene(ctx) {
  ctx.wizard.state.booking = {};
  const ok = await renderServiceList(ctx);
  if (!ok) return ctx.scene.leave();
  return ctx.wizard.next();
}

async function chooseService(ctx) {
  if (!ctx.callbackQuery) {
    await ctx.reply('Будь ласка, оберіть послугу кнопкою вище.');
    return;
  }
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery();
  if (!data.startsWith('svc:')) return;
  const serviceName = data.slice(4);
  const services = await sheets.getServices();
  const service = services.find((s) => s.name === serviceName);
  if (!service) {
    await ctx.reply('Ця послуга вже недоступна, почніть заново: /book');
    return ctx.scene.leave();
  }
  ctx.wizard.state.booking.service = service.name;
  ctx.wizard.state.booking.price = service.price;
  ctx.wizard.state.booking.durationMin = Number(service.duration_min);

  // Шукаємо не просто вільні слоти, а такі, де підряд вистачає слотів під усю
  // тривалість послуги (наприклад, для 90 хв при кроці 30 хв потрібно 3 підряд).
  const ok = await renderDateList(ctx);
  if (!ok) return ctx.scene.leave();
  return ctx.wizard.next();
}

async function chooseDate(ctx) {
  if (!ctx.callbackQuery) {
    await ctx.reply('Будь ласка, оберіть дату кнопкою вище.');
    return;
  }
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery();

  if (data === 'back') {
    const ok = await renderServiceList(ctx);
    if (!ok) return ctx.scene.leave();
    ctx.wizard.selectStep(1); // повертаємось на крок вибору послуги (chooseService)
    return;
  }

  if (!data.startsWith('date:')) return;
  const date = data.slice(5);
  ctx.wizard.state.booking.date = date;

  const ok = await renderTimeList(ctx, date);
  if (!ok) return ctx.scene.leave();
  return ctx.wizard.next();
}

async function chooseTime(ctx) {
  if (!ctx.callbackQuery) {
    await ctx.reply('Будь ласка, оберіть час кнопкою вище.');
    return;
  }
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery();

  if (data === 'back') {
    const ok = await renderDateList(ctx);
    if (!ok) return ctx.scene.leave();
    ctx.wizard.selectStep(2); // повертаємось на крок вибору дати (chooseDate)
    return;
  }

  if (!data.startsWith('time:')) return;
  const time = data.slice(5);
  ctx.wizard.state.booking.time = time;
  await ctx.editMessageText('Як вас звати? Напишіть ім\'я.');
  return ctx.wizard.next();
}

async function askName(ctx) {
  if (!ctx.message || !ctx.message.text) {
    await ctx.reply('Напишіть ім\'я текстом.');
    return;
  }
  ctx.wizard.state.booking.clientName = ctx.message.text.trim();
  await ctx.reply(
    'Вкажіть номер телефону для зв\'язку (можна натиснути кнопку, щоб поділитися контактом):',
    Markup.keyboard([Markup.button.contactRequest('📱 Надіслати телефон')])
      .oneTime()
      .resize()
  );
  return ctx.wizard.next();
}

async function askPhone(ctx) {
  let phone = null;
  if (ctx.message && ctx.message.contact) {
    phone = ctx.message.contact.phone_number;
  } else if (ctx.message && ctx.message.text) {
    phone = ctx.message.text.trim();
  }
  if (!phone) {
    await ctx.reply('Надішліть номер телефону текстом або кнопкою.');
    return;
  }
  ctx.wizard.state.booking.phone = phone;
  const b = ctx.wizard.state.booking;
  await ctx.reply(
    `Перевірте дані запису:\n\n` +
      `Послуга: ${b.service}\n` +
      `Дата: ${formatDateLabel(b.date)}\n` +
      `Час: ${b.time}–${formatEndTime(b.date, b.time, b.durationMin)}\n` +
      `Ім'я: ${b.clientName}\n` +
      `Телефон: ${b.phone}\n` +
      `Вартість: ${b.price}₴`,
    Markup.removeKeyboard()
  );
  await ctx.reply(
    'Все вірно?',
    Markup.inlineKeyboard([
      Markup.button.callback('✅ Підтвердити', 'confirm:yes'),
      Markup.button.callback('❌ Скасувати', 'confirm:no'),
    ])
  );
  return ctx.wizard.next();
}

async function confirmBooking(ctx) {
  if (!ctx.callbackQuery) {
    await ctx.reply('Натисніть «Підтвердити» або «Скасувати» вище.');
    return;
  }
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery();
  if (data === 'confirm:no') {
    await ctx.editMessageText('Запис скасовано. Щоб почати заново, надішліть /book');
    return ctx.scene.leave();
  }
  const b = ctx.wizard.state.booking;

  // Перевірка "слот вільний" і сам запис виконуються атомарно (bookSlotsAtomic
  // ставить це в чергу всередині процесу) — так двоє клієнтів, які тиснуть
  // "Підтвердити" майже одночасно, не зможуть обидва пройти перевірку і
  // зайняти один і той самий час.
  const result = await sheets.bookSlotsAtomic({
    date: b.date,
    time: b.time,
    service: b.service,
    price: b.price,
    durationMin: b.durationMin,
    clientName: b.clientName,
    phone: b.phone,
    clientChatId: ctx.from.id,
  });

  if (!result.ok) {
    await ctx.editMessageText('На жаль, цей час (повністю або частково) вже зайняли, поки ви обирали. Почніть заново: /book');
    return ctx.scene.leave();
  }
  const id = result.id;

  const endTime = formatEndTime(b.date, b.time, b.durationMin);
  await ctx.editMessageText(
    `Готово! Вас записано на ${formatDateLabel(b.date)}, ${b.time}–${endTime} (${b.service}).\n` +
      `Ми надішлемо нагадування за ${config.REMINDER_HOURS_BEFORE} год. до візиту.`
  );

  if (config.ADMIN_CHAT_ID) {
    await ctx.telegram
      .sendMessage(
        config.ADMIN_CHAT_ID,
        `📅 Новий запис #${id}\n` +
          `Послуга: ${b.service} (${b.price}₴)\n` +
          `Дата: ${formatDateLabel(b.date)}, ${b.time}–${endTime}\n` +
          `Клієнт: ${b.clientName}, тел. ${b.phone}\n` +
          `Telegram: @${ctx.from.username || '—'} (id ${ctx.from.id})`
      )
      .catch((e) => console.error('Не вдалося сповістити майстра:', e.message));
  }

  return ctx.scene.leave();
}

const bookingWizard = new Scenes.WizardScene(
  'booking-wizard',
  enterScene,
  chooseService,
  chooseDate,
  chooseTime,
  askName,
  askPhone,
  confirmBooking
);

module.exports = { bookingWizard, STEP };
