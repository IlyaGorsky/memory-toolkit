---
name: session-continue
description: Продолжить workstream с того места где остановился — быстрее чем /session-start, без выбора фокуса.
user-invocable: true
argument-hint: "[workstream]"
---

# /session-continue — Быстрое продолжение

Подхватить workstream без полного cold start. Для случаев когда ты знаешь что делаешь.

---

## Step 1: Найти handoff

```bash
MEM=$(find ~/.claude/projects -maxdepth 3 -name "memory.js" -path "*/memory/*" 2>/dev/null | head -1)
MEM_DIR=$(dirname "$MEM")
cat "$MEM_DIR/workstreams/handoff.md" 2>/dev/null || echo "NO_HANDOFF"
```

Если handoff нет → предложить `/session-start` вместо этого.

---

## Step 2: Git status (молча)

```bash
git status --short
git log --oneline -3
git branch --show-current
```

Если есть незакоммиченные изменения — показать одной строкой.
Если чистое дерево — не упоминать.

---

## Step 3: Показать резюме

Формат (максимум 10 строк):

```
## Продолжаем: {workstream}

**Где остановились:** {из handoff — последнее действие}
**Что дальше:** {из handoff — следующий шаг}
**Ветка:** {branch} {uncommitted count если есть}

Начинаем?
```

Не показывать task plan, фокус-кандидаты, рекомендации модели — это для `/session-start`.

---

## Step 4: Подгрузить контекст по запросу

Если пользователь подтвердил — загрузить только то что нужно для следующего шага:

- Файл который редактировали последним
- Task plan если есть
- Последние 3 feedback через `node $MEM search`

НЕ грузить весь memory — только релевантное.

---

## Step 5: Метка

```bash
node $MEM_DIR/memory.js note "SESSION_CONTINUE branch:$(git branch --show-current) workstream:{name}"
```

---

## Rules

- Максимальная скорость — 10 строк вывода, потом работа
- Не спрашивать модель, не показывать кандидатов — пользователь уже знает
- Если handoff старше 7 дней — предупредить: "Handoff от {дата}, контекст мог устареть. /session-start для полного обзора?"
- Если аргумент не передан — взять workstream из последнего handoff
