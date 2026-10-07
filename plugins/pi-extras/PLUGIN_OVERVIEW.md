Pi Extras brings Pi usage and settings into BB. Its Sessions view estimates token use and cost from local Pi session transcripts, broken down by backend, model, project, and day. Subscriptions shows current usage for Pi-managed legacy Codex, OpenCode Go, and Ollama Cloud accounts. Pi's newer `openai` Sign in with ChatGPT credential can authorize eligible Responses API inference, but OpenAI does not document a way to read Codex usage totals with it; the plugin directs users to ChatGPT settings instead.

The settings panel edits Pi defaults, model scope, selected runtime settings, model catalogs, and extensions. For Pi to generate BB thread titles or commit messages, select Pi separately for each task under BB Settings > AI services. This does not change the model running the thread.

## Requirements and privacy

Pi must be installed on BB's primary machine. Subscription usage requires the relevant credentials in Pi's auth.json. Legacy Codex usage requires Pi's `openai-codex` credential and account ID; Pi's newer `openai` SIWC credential does not provide access to Codex usage totals. The plugin reads credentials to request usage but never displays, logs, refreshes, or modifies them. Subscription endpoints are undocumented and may change.
