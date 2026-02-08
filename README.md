# Zamunda Stremio Addon

Stremio addon за торенти от Zamunda.ch - български торент тракер.

## Архитектура

Проектът се състои от две части:

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Телефон/ТВ     │────>│  Auth сървър     │────>│  Zamunda.ch │
│  (браузър)      │     │  (Render.com)    │     │             │
└────────┬────────┘     └──────────────────┘     └─────────────┘
         │                                              │
         │  1. Въвежда user/pass                        │
         │  2. Получава линк за Stremio                 │
         │                                              │
         v                                              v
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│    Stremio      │────>│     Addon        │────>│  Zamunda.ch │
│     App         │     │   (Beamup)       │     │  (торенти)  │
└─────────────────┘     └──────────────────┘     └─────────────┘
```

1. **Auth сървър** (`auth-server/`) - Хостван на Render.com с Puppeteer за обход на Cloudflare
2. **Addon** (root) - Хостван на Beamup, лек serverless

## Инсталация за потребители

1. Отвори [Auth сървъра](https://zamunda-auth.onrender.com) в браузъра
2. Въведи Zamunda потребителско име и парола
3. Натисни бутона за инсталация в Stremio
4. Готово! Вече можеш да гледаш.

## Deployment

### 1. Addon (Beamup - безплатен)

```bash
npm install -g stremio-beamup-deploy
cd Zamunda_addon_stremio
beamup
```

Ще получиш URL като: `https://zamunda-addon.beamup.dev`

### 2. Auth Server (Render.com - безплатен tier)

1. Създай акаунт в [Render.com](https://render.com)
2. New → Web Service → Connect GitHub repo
3. Root Directory: `auth-server`
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Environment Variables:
   - `ADDON_URL` = URL от Beamup (напр. `https://zamunda-addon.beamup.dev`)

## Локално тестване

```bash
# Terminal 1: Addon
npm install
npm start
# Работи на http://localhost:7000

# Terminal 2: Auth Server
cd auth-server
npm install
npm start
# Работи на http://localhost:3000
```

## Функции

- ✅ Филми и сериали
- ✅ Автоматично търсене по IMDB ID
- ✅ Сезонни пакети за сериали
- ✅ Качество (4K, 1080p, 720p)
- ✅ Брой seeders
- ✅ Обход на Cloudflare защита

## Структура на проекта

```
├── addon.js              # Главен Stremio addon
├── lib/
│   ├── sessionManager.js # Cookie management
│   ├── zamundaService.js # Zamunda API
│   └── utils.js          # Помощни функции
├── auth-server/
│   ├── server.js         # Auth сървър с Puppeteer
│   ├── Dockerfile        # За Render.com
│   └── package.json
└── package.json
```

## Лиценз

MIT
