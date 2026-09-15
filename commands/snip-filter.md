---
description: Author, test, and install a custom snip filter for a command
---

Write a custom snip filter for: $ARGUMENTS

snip is a CLI proxy that filters shell output via declarative YAML pipelines
(installed at `~/.config/snip/filters/`). The opencode-smartsnip plugin scans that
directory at startup, so a new filter is routed to after the next opencode restart —
no further wiring needed.

## Workflow

1. Fetch the authoritative filter-authoring guide (DSL reference, 16 pipeline
   actions, examples): https://raw.githubusercontent.com/edouard-claude/snip/master/SKILL.md
   If offline, run `snip config` to locate the filters dir and study an existing
   filter as a template.
2. Run the target command and capture its raw output to understand the structure.
   If it supports a machine-readable flag (`--json`, `--porcelain`), prefer
   injecting that and filtering structured output.
3. Decide what an LLM actually needs from this output (errors, counts, names) —
   target 60-90% reduction without losing actionable signal.
4. Write the YAML filter to `~/.config/snip/filters/<name>.yaml`. Always set
   `on_error: "passthrough"`.
5. Test: run `snip -v <command>` and compare against the raw output. Iterate on
   the pipeline until the output is minimal but sufficient.
6. Verify the plugin picks it up: `bunx opencode-smartsnip doctor` should show
   the allowlist grew by one. Restart opencode before the plugin routes to it.

If $ARGUMENTS is empty, first run `bunx opencode-smartsnip discover --days 30` and
propose filters for the top "NO FILTER IN SNIP" commands. Those counts are stored
output volume, not measured savings — confirm the output is actually repetitive before
writing a filter for it.
