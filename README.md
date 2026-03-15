# BGTorrents Stremio Addon

![BGTorrents](https://zamunda-addon-stremio.onrender.com/static/logo.png)

Stremio addon за български торенти - филми и сериали директно в Stremio.

## Източници

- **Zamunda.rip** - архив на Zamunda + ArenaBG, без логин
- **Bultor.net** - български торент сайт, без логин

## Какво прави

- Търси автоматично по IMDb metadata (филм/сериал, сезон, епизод)
- Показва качество, seeders и размер
- Сортира резултатите по качество и след това по seeders
- Филтрира резултатите, за да намали грешните съвпадения
- При сериали допуска и **season pack** резултати за търсения сезон
- Маркира сериалните резултати като `Release` или `Season Pack`

## Инсталация

### Вариант 1 (препоръчително)

1. Отвори: **https://zamunda-addon-stremio.onrender.com/configure**
2. Избери източници (`rip`, `bultor` или и двете)
3. Натисни **Инсталация**
4. Отвори линка в Stremio

### Вариант 2 (ръчно през manifest)

1. Използвай:

   ```
   https://zamunda-addon-stremio.onrender.com/manifest.json
   ```

2. В Stremio: Addons -> Addon Repository URL -> постави линка -> Add

## Локално стартиране

```bash
npm install
npm start
```

По подразбиране addon-ът тръгва на порт `7000`.

## Конфигурация

- `PROVIDERS` - списък с източници, напр. `rip,bultor`
- `PORT` - порт за локално/hosted стартиране
- `RENDER_EXTERNAL_URL` - публичният URL за правилни линкове в UI/manifest

## Подкрепа

[☕ Подкрепете проекта](https://buymeacoffee.com/Bgsubs)

## Отказ от отговорност

Този addon е инструмент за индексиране на външни източници. Използването е изцяло на отговорност на потребителя и трябва да е съобразено с местното законодателство.

## Лиценз

MIT
