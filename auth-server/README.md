# Zamunda Auth Server

Сървър за автентикация в Zamunda.ch с Puppeteer. Използва се за генериране на конфигурационни линкове за Stremio addon-а.

## Deployment на Render.com

1. Създай нов Web Service в Render.com
2. Свържи GitHub репото
3. Избери `auth-server` директорията като Root Directory
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Добави environment variable:
   - `ADDON_URL` = URL на addon-а в Beamup (напр. `https://zamunda-addon.beamup.dev`)

## Как работи

1. Потребителят отваря auth сървъра в браузъра
2. Въвежда Zamunda username и password
3. Сървърът използва Puppeteer за login в Zamunda
4. Получава auth cookies (uid, pass)
5. Генерира конфигуриран линк за Stremio addon
6. Потребителят инсталира addon-а с този линк

## Local Development

```bash
npm install
npm start
```

Сървърът стартира на http://localhost:3000
