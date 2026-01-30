# Як додати cookies.json

Цей файл потрібен, щоб бот "прикинувся" вами і обійшов захист Quizlet (Cloudflare).

## Крок 1: Встановіть розширення для браузера
Найпростіший спосіб дістати куки у потрібному форматі — використати розширення.
*   **Chrome/Edge/Brave**: [Cookie-Editor](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)
*   **Firefox**: [Cookie-Editor](https://addons.mozilla.org/en-US/firefox/addon/cookie-editor/)

## Крок 2: Скопіюйте куки
1.  Зайдіть на [Quizlet.com](https://quizlet.com) і переконайтесь, що ви **залогінені** (відображається ваш профіль).
2.  Відкрийте розширення **Cookie-Editor**.
3.  Натисніть кнопку **Export** (Експорт) -> **Export as JSON**.
4.  Текст скопіюється у буфер обміну.

## Крок 3: Вставте у файл
1.  Відкрийте файл `cookies.json`, який я створив у цій папці (`/Users/person/Study/quizlet-ios-app/cookies.json`).
2.  Видаліть все, що там є.
3.  Вставте (Paste) те, що ви скопіювали з браузера.
4.  Збережіть файл (`Cmd+S`).

## Крок 4: Оновіть бот
Після збереження файлу, потрібно перебудувати контейнер, щоб він побачив нові куки:

```bash
docker-compose up --build -d
```

Тепер спробуйте команду `/sync` знову.
