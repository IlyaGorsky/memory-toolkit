# memory-toolkit — plan

## Philosophy

См. [PHILOSOPHY.md](PHILOSOPHY.md)

### Конкурентный ландшафт

- В официальном маркетплейсе (33 плагина) — ничего похожего на session memory lifecycle
- На GitHub: claude-mem (SQLite+vector, тяжёлый), claude-memory-compiler (closest, но без workstreams/handoff), memory-store-plugin (cloud), claude-handoff (только handoff)
- Наша ниша: **unified lifecycle** (start->continue->end) + workstreams + memory API + hooks — без внешних зависимостей, pure markdown

## Done

- [x] AP-1: `.claude-plugin/plugin.json` — манифест с name, description, version, author, license, keywords
- [x] AP-2: `commands/` -> `skills/` — 8 skills, все с `user-invocable: true`
- [x] AP-3: Хуки на `${CLAUDE_PLUGIN_ROOT}` — убраны хардкод-пути из hooks.json
- [x] AP-4: `claude plugin validate .` — passed
- [x] AP-6: Пути к memory.js в SKILL.md — bootstrap использует `${CLAUDE_PLUGIN_ROOT}`
- [x] AP-7: README.md
- [x] AP-8: LICENSE (MIT)
- [x] memory.js: добавлена команда `dir`
- [x] AP-10: Тест — skills (8/8), memory search, `${CLAUDE_PLUGIN_ROOT}` в хуках — всё работает
- [x] AP-11: Удалены старые копии из `~/.claude/skills/`
- [x] Установка через `claude plugin install` — marketplace.json + локальный маркетплейс

## Next

### ~~AP-5: install.sh~~ — удалён, нативная структура плагина его заменяет

### AP-9: Submission в маркетплейс

- Форма: <https://clau.de/plugin-directory-submission>
- Целевой маркетплейс: claude-plugins-community (первый релиз)

## Открытые вопросы

1. Доступна ли `${CLAUDE_PLUGIN_ROOT}` внутри SKILL.md (в bash-блоках), или только в hooks? -> проверить в AP-10
2. ~~install.sh — оставить для backward compat или убрать?~~ -> удалён

## Research notes

### Структура нативного плагина

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   └── skill-name/
│       └── SKILL.md
├── hooks/
│   └── hooks.json
├── README.md
└── LICENSE
```

### Ключевые находки

1. `--plugin-dir <path>` — подключает плагин для одной сессии
2. `claude plugin validate <path>` — валидация структуры
3. `${CLAUDE_PLUGIN_ROOT}` — env var в хуках, указывает на корень плагина
4. `hooks/hooks.json` — авто-подключаются при установке, не нужно мержить в settings.json
5. Submission через форму, GitHub-репо — read-only зеркало
6. Два маркетплейса: claude-plugins-official (strict review) и claude-plugins-community (basic review)
