---
name: session-start
description: Холодный старт сессии — контекст, статус, фокус. Использовать в начале каждой новой сессии.
user-invocable: true
argument-hint: "[workstream]"
---

# /session-start — Холодный старт сессии

Быстрый вход в контекст. Собрать состояние, показать что осталось, предложить фокус.

---

## Step 1: Memory — загрузить контекст

Прочитать MEMORY.md (карта контекста).

Если передан аргумент workstream — сразу подгрузить детали и перейти к Step 3.

Если аргумент не передан — найти memory.js для текущего проекта:

```bash
# Resolve memory dir from cwd
PROJ_KEY=$(pwd | tr '/' '-' | sed 's/^-//')
MEM_DIR="$HOME/.claude/projects/-${PROJ_KEY}/memory"
# Fallback: try parent dirs
if [ ! -f "$MEM_DIR/memory.js" ]; then
  for dir in $(find ~/.claude/projects -maxdepth 3 -name "memory.js" -path "*/memory/*" 2>/dev/null); do
    MEM_DIR=$(dirname "$dir")
    break
  done
fi
MEM="$MEM_DIR/memory.js"
```

Показать workstreams:

```bash
node "$MEM" workstreams
```

Показать меню:

```
Workstreams:
  1. pr-review — 3 файла, handoff от 2026-04-07
  2. core — 12 файлов
  3. ➕ Создать новый workstream

Что делаем?
```

Варианты ответа:
- Номер или имя workstream → подгрузить детали и перейти к Step 3
- «Все» / «обзор» → показать краткий срез по каждому, потом фокус-кандидаты
- «Новый» / номер ➕ → Step 1b: создать workstream

---

## Step 1b: Создать новый workstream (если выбрано ➕)

Спросить:
1. **Имя**: "Как назвать workstream?" (e.g. `auth-refactor`, `mobile-fix`)
2. **Ключевые слова**: "По каким словам искать связанные файлы?" (e.g. `auth, login, session, token`)

Обновить `workstreams.json`:

```bash
# Прочитать текущий, добавить новый, записать
node -e "
const fs = require('fs');
const p = '$MEM_DIR/workstreams.json';
const data = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
data['{name}'] = [{keywords}];
fs.writeFileSync(p, JSON.stringify(data, null, 2));
console.log('Added workstream: {name}');
"
```

Создать директорию и начальный файл:

```bash
mkdir -p "$MEM_DIR/workstreams"
```

Записать note:

```bash
node "$MEM" note "NEW_WORKSTREAM: {name} keywords: {keywords}"
```

Перейти к Step 3 с новым workstream.

---

## Step 2: Git status

```bash
git status
git log --oneline -5
git branch --show-current
```

Если есть незакоммиченные изменения — сообщить и спросить: «Закоммитить или продолжить поверх?»
Если последний коммит >5 дней назад — отметить.

---

## Step 3: Task plan

Прочитать source of truth текущего workstream из MEMORY.md → Workstreams.

Показать краткий срез:
- Сколько задач [ ] / [x]
- Что заблокировано
- Что можно взять сейчас

---

## Step 4: Фокус-кандидаты

Формат:

```text
## Сессия YYYY-MM-DD

Git: <ветка> / чистое дерево / N uncommitted files
Last commit: <hash> <message> (<days> дней назад)

### Фокус-кандидаты
1. <задача> — <SP> — почему сейчас
2. <задача> — <SP> — почему сейчас
3. <задача> — <SP> — почему сейчас
```

---

## Step 5: Рекомендация модели

Для каждого кандидата — предложить модель по типу работы:

| Тип задачи | Модель | Почему |
| --- | --- | --- |
| Планирование, архитектура, новый домен | Opus | exploration, нужен reasoning |
| Кодинг по готовому плану, scaffold | Sonnet | execution по правилам |
| Рутина: переводы, копирование паттерна | Haiku | дешёво, правила достаточны |
| Ревью, анализ, рефакторинг | Sonnet/Opus | зависит от глубины |

Формат: после каждого кандидата — `→ рекомендация: Sonnet (execution по паттерну)`

---

## Step 6: Ask

«Что делаем? Или выбираем из кандидатов? Модель ок или переключить?»

---

## Step 7: Метка сессии

После выбора фокуса — записать метку:

```bash
node "$MEM" --dir="$MEM_DIR" note "SESSION_START branch:$(git branch --show-current) workstream:<выбранный> focus:<задача>"
```

Это позволяет `/session-restore search SESSION_START` найти все точки входа в сессии.

---

## Rules

- Не читать все файлы целиком — только заголовки и [ ] задачи
- Не предлагать больше 3 кандидатов
- Если есть заблокированные задачи (ждём макеты/бэкенд) — отметить, не предлагать
- При аргументе workstream — сразу глубже в контекст, без общего обзора
- Если предыдущая сессия закончилась compact — проверить что было последним действием через `/session-restore`
