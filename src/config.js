require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.warn(`[config] Увага: змінна середовища ${name} не задана`);
  }
  return value;
}

module.exports = {
  BOT_TOKEN: required('BOT_TOKEN'),
  ADMIN_CHAT_ID: String(process.env.ADMIN_CHAT_ID || ''),
  SHEET_ID: required('SHEET_ID'),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: required('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
  // У .env приватний ключ зберігається з \n замість переносів рядків — розгортаємо назад
  GOOGLE_PRIVATE_KEY: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  REMINDER_HOURS_BEFORE: Number(process.env.REMINDER_HOURS_BEFORE || 24),
  // Крок сітки слотів у хвилинах. Усі слоти мають додаватися саме з таким кроком
  // (наприклад, кожні 30 хв), інакше пошук послідовних вільних слотів під
  // довгу послугу (90/120/180 хв тощо) працюватиме некоректно.
  SLOT_INTERVAL_MINUTES: Number(process.env.SLOT_INTERVAL_MINUTES || 30),
  CRON_SECRET: process.env.CRON_SECRET || '',
  PUBLIC_URL: process.env.PUBLIC_URL || '',
  PORT: Number(process.env.PORT || 3000),
};
