# Recovery

- **Logs**: every error, warning and notable event from the kernel, the organs, extensions and the UI lands in `logs/lyra-<date>.jsonl` under the app data folder, kept for 7 days, with API keys redacted. The user reads them under Settings › Recovery › Logs; you read them with `read_logs`. A failure that falls back quietly (the voice engine, a model call, an extension) always leaves a line there.
- **Checkpoints**: the state folder is a git repository owned by the kernel. Snapshots are taken before your writes, after every turn, and on healthy boots. `list_checkpoints`, `checkpoint({label})`, `rollback({ref, part})`.
- **Last known good** (`lkg`): the tag moved by a boot that stayed healthy for 20 s. Failed swaps roll back to it automatically.
- **Quarantine**: an extension that fails to load or throws five times is disabled with its error kept; `set_extension({id, enabled:true})` clears it.
- **Safe mode**: three failed boots in a row (or `--safe`) start the kernel only, with a recovery page: roll back to last known good, reset organs to shipped, disable all extensions, or retry. You are not loaded there.
- **Watchdog**: a hung UI is reloaded; three UI crashes in two minutes trigger safe mode. Your runs are capped at 30 minutes.
- **Budget**: `kernel.dailyWrites` self-modification writes per day (settings, themes, extensions, organs). The user can raise it under Settings › Recovery.
