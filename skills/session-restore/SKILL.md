---
name: session-restore
description: Восстановление контекста из .jsonl бэкапов сессий. Парсит историю, строит хронологию, сохраняет ключевые решения в memory.
user-invocable: true
argument-hint: "[backup|restore|list|search <query>]"
---

# Session Restore — бэкап и восстановление контекста

Парсит `.jsonl` файлы сессий Claude Code, извлекает хронологию и ключевые решения.

## Где лежат данные

```
~/.claude/projects/-<project-key>/
├── <UUID>.jsonl          # текущая сессия (или завершённая)
├── <UUID>.jsonl.bak      # бэкап до последнего compact
└── <UUID>/
    └── subagents/        # логи субагентов
```

## Команды

### `/session-restore list`

Показать все сессии с датами и размерами:

```bash
SESSIONS_DIR=~/.claude/projects/-$(pwd | tr '/.' '-' | sed 's/^-//')
ls -lat "$SESSIONS_DIR"/*.jsonl 2>/dev/null | head -20
```

Вывести таблицу:
| Файл | Дата | Размер | .bak |

### `/session-restore restore`

Восстановить контекст из последней (или указанной) сессии:

1. **Найди файл** — по умолчанию самый свежий `.jsonl`, или по UUID из аргумента
2. **Парси** — извлеки USER и CLAUDE сообщения с помощью python3:

```python
import json, sys

path = sys.argv[1]
with open(path) as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    try:
        obj = json.loads(line.strip())
        role = obj.get('role', '?')
        msg_type = obj.get('type', '?')
        c = obj.get('message', {}).get('content', obj.get('content', ''))

        if isinstance(c, list):
            for item in c:
                if isinstance(item, dict):
                    tp = item.get('type', '')
                    if tp == 'text':
                        text = item.get('text', '').strip()
                        if role == '?' and msg_type == 'user':
                            if text and not text.startswith('<ide_') and not text.startswith('<system') and not text.startswith('<local-command') and not text.startswith('<command-') and len(text) > 5:
                                print(f'USER [{i}]: {text[:200]}')
                        elif role == '?' and msg_type == 'assistant':
                            if text and len(text) > 20:
                                print(f'  CLAUDE [{i}]: {text.split(chr(10))[0][:200]}')
        elif isinstance(c, str):
            clean = c.strip()
            if role == '?' and msg_type == 'user' and clean and not clean.startswith('<') and len(clean) > 3:
                print(f'USER [{i}]: {clean[:200]}')
            elif role == '?' and msg_type == 'assistant' and clean and len(clean) > 20:
                print(f'  CLAUDE [{i}]: {clean.split(chr(10))[0][:200]}')
    except:
        pass
```

3. **Сгруппируй по блокам** — определи тематические блоки сессии (по смене темы)
4. **Покажи пользователю** краткую хронологию:

```
## Восстановление сессии <UUID>
Дата: <дата файла>
Строк: <N>

### Блок 1: <тема>
- <что делали>
- <ключевые решения>

### Блок N: <тема>
- <что делали>
- **Последнее действие:** <что было в момент завершения/краша>
```

5. **Найди причину завершения** — проверь последние 20 строк:
   - `API Error` → краш, укажи причину
   - `context` summary → compact, контекст был сжат
   - Обычное завершение → пользователь закрыл

### `/session-restore backup`

Сохранить текущее состояние сессии в memory:

1. Определи текущую задачу (из todo, plan, или контекста)
2. Запиши в memory файл `project_session_snapshot.md`:

```markdown
---
name: Session snapshot
description: Снимок состояния сессии на <дата>
type: project
---

## Задача
<что делаем>

## Сделано
- <список>

## В процессе
- <текущий шаг>

## Осталось
- <список>

## Ключевые решения
- <решения которые влияют на дальнейшую работу>
```

3. Обнови MEMORY.md если нужно

### `/session-restore search <query>`

Поиск конкретного момента в истории сессий:

1. **Найди файл** — самый свежий `.jsonl` (или `.jsonl.bak` для до-compact истории)
2. **Grep** — быстрый поиск по jsonl без полного парсинга:

```bash
grep -i "<query>" "$SESSIONS_DIR"/*.jsonl | head -30
```

3. **Контекст** — для каждого найденного фрагмента покажи ±5 строк вокруг (чтобы понять тему):

```bash
grep -n -i "<query>" <file> | head -10
# для каждого номера строки:
sed -n '<line-5>,<line+5>p' <file>
```

4. **Парси найденное** — извлеки текст из JSON, отфильтруй системные сообщения
5. **Покажи результат**:

```
## Поиск: "<query>" в <файл>
Найдено: N совпадений

### Совпадение 1 (строка N)
USER: <текст>
CLAUDE: <текст>

### Совпадение 2 (строка N)
...
```

6. Если результатов много (>10) — показать первые 5 и спросить «показать ещё?»
7. Если в `.jsonl` не нашлось — проверить `.jsonl.bak`

## Правила

- При restore НЕ показывай системные сообщения, ide_opened_file, tool calls — только USER и CLAUDE текст
- Группируй по темам, не по строкам — пользователю нужна картина, а не лог
- Если `.bak` существует — он содержит полную историю до compact, `.jsonl` может содержать compact summary
- При backup не дублируй то что уже в memory файлах — сохраняй только то чего нет
- Большие сессии (>10K строк) парси порциями через offset
