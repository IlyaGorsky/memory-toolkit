---
name: session-insights
description: Извлечь инсайты из .jsonl сессий через llm-runner — проблемы, решения, friction по тикетам.
user-invocable: true
argument-hint: "[ticket|session-id|workstream]"
---

# /session-insights — Извлечение инсайтов из истории сессий

Парсит `.jsonl` файлы сессий, извлекает user-сообщения, прогоняет через llm-runner (Haiku) для structured output.

## Шаг 1: Найти сессии

По аргументу определи scope:

- **Тикет** (`HH-301562`) — grep по всем `.jsonl` файлам, найти сессии где упоминается тикет
- **Session ID** — конкретный файл
- **Workstream** — использовать `node $MEM/memory.js workstream <name>` для контекста, найти связанные сессии по датам/ключевым словам
- **Без аргумента** — последняя сессия

```bash
SESSIONS_DIR=~/.claude/projects/-$(pwd | tr '/' '-' | sed 's/^-//')/
grep -l "<query>" "$SESSIONS_DIR"*.jsonl 2>/dev/null | head -10
```

## Шаг 2: Извлечь user-сообщения

Для каждой найденной сессии:

```python
import json, sys

with open(sys.argv[1]) as f:
    for i, line in enumerate(f):
        try:
            obj = json.loads(line.strip())
            if obj.get('type') != 'user':
                continue
            c = obj.get('message', {}).get('content', obj.get('content', ''))
            if isinstance(c, list):
                for item in c:
                    if isinstance(item, dict) and item.get('type') == 'text':
                        text = item.get('text', '').strip()
                        if text and not text.startswith('<') and len(text) > 5:
                            print(text[:300])
            elif isinstance(c, str):
                text = c.strip()
                if text and not text.startswith('<') and len(text) > 5:
                    print(text[:300])
        except:
            pass
```

## Шаг 3: Отправить в llm-runner

Если llm-runner доступен (`node ~/Desktop/projects/llm-runner/llm/index.js` или `scripts/llm/index.js`):

```bash
node ~/Desktop/projects/llm-runner/llm/index.js --tier fast --json <<EOF
Извлеки из диалога разработчика с AI-агентом:

1. **Проблемы** — что не получилось, переделывалось, вызвало friction
2. **Решения** — что выбрали и почему (архитектурные, процессные)
3. **Инсайты** — неочевидные выводы, паттерны, переоценки
4. **Friction points** — где AI ошибался повторно, что требовало много итераций

Диалог:
${USER_MESSAGES}

Ответь JSON:
{
  "problems": [{"description": "...", "resolution": "..."}],
  "decisions": [{"what": "...", "why": "..."}],
  "insights": [{"insight": "...", "evidence": "..."}],
  "friction": [{"what": "...", "count": N, "root_cause": "..."}]
}
EOF
```

Если llm-runner недоступен — проанализировать самостоятельно (медленнее, но работает).

## Шаг 4: Показать и сохранить

Показать пользователю structured output. Спросить:

- «Сохранить инсайты в memory?» → feedback/ или decisions/
- «Добавить friction в backlog?» → backlog.md items
- «Пропустить» → только показать

## Правила

- Фильтровать системные сообщения, ide_opened_file, tool calls — только USER текст
- Большие сессии (>50KB user text) — разбить на chunks по 4K токенов
- Не показывать сырой JSON — форматировать в читаемые блоки
- Если по тикету найдено несколько сессий — объединить хронологически
- Haiku достаточно для extraction — не тратить на Opus
