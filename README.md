# claude-code-plugins

Personal marketplace of Claude Code plugins.

## Plugins

- **session-overview**: a colored row above the terminal prompt with the model, effort, git branch,
  context and session cost. [Changelog](plugins/session-overview/CHANGELOG.md).

## Structure

- `.claude-plugin/marketplace.json` — marketplace catalog.
- `plugins/` — one subfolder per plugin.

## Usage

From another machine or Claude Code session:

```
claude plugin marketplace add <path-or-url-to-this-repo>
claude plugin install <plugin-name>@mlemolt-plugins
```

## Adding a plugin

1. Create the plugin folder under `plugins/<plugin-name>/` (see the Claude Code docs for plugin structure).
2. Validate the plugin:
   ```
   claude plugin validate ./plugins/<plugin-name>
   ```
3. Add an entry to `.claude-plugin/marketplace.json`:
   ```json
   {
     "name": "<plugin-name>",
     "source": "./plugins/<plugin-name>",
     "description": "..."
   }
   ```
4. Validate the whole marketplace:
   ```
   claude plugin validate .
   ```
