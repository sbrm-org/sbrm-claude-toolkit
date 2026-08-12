---
description: Create a new Claude Code slash command
argument-hint: "[command-name] [description]"
model: sonnet
---

# Create New Slash Command

Create a new custom slash command following Claude Code conventions and best practices.

## Philosophy

**User invocation = implicit approval:** When a user invokes a slash command, they're granting approval for its intended purpose. If `/save` is invoked, you can include Write/Edit in allowed-tools without prompting.

## Design principles

Verify the new command complies with each of these before delivery:

- **Single purpose**: one command does one job; split unrelated jobs into separate commands
- **Right altitude**: specific enough to constrain bad outputs, flexible enough for judgment — not a rigid script
- **Minimal frontmatter**: only `description` is required; add `argument-hint`, `allowed-tools`, `model` only when they earn their place
- **Args only when needed**: don't add `$ARGUMENTS`/`$1` plumbing for commands that work fine without input
- **Every token earns its place**: no filler, no restating what Claude already knows

**Three approaches for bash execution:**
1. **Instructions only** - Tell Claude what to do; it decides when to execute
2. **Pre-execution with exclamation-backtick** - Runs immediately at invocation, output injected into context
3. **Tool restrictions** - Limit which tools Claude can use via `allowed-tools`

## When to Use Exclamation-Backtick Prefix

**Use exclamation-backtick prefix when you need:**
- Exact timestamps: `!date "+%Y-%m-%d %H:%M"` guarantees NOW
- File listings before destructive operations: `!find` to show what will be deleted
- Guaranteed factual context: Pre-populate context with actual output

**Don't use this prefix when:**
- Execution depends on runtime conditions
- Need dynamic calculations (date math, conditional logic)
- Execution timing matters (not just invocation time)

## Required Information

1. **Command name** (without `/` prefix): $1 or ask if not provided
2. **Brief description**: $2 or ask if not provided
3. **Command purpose**: Understand what it actually does
4. **Prompt content**: What Claude should do when this command runs
5. **Arguments**: Does it need $ARGUMENTS, $1, $2, etc.?
6. **Bash needs**: Does it need bash? Should commands pre-execute with exclamation-backtick?
7. **Tools needed**: Which tools does it actually need?
8. **Model preference**: Should it use a specific model? (optional)

## Location

**Default**: Save to `~/.claude/commands/[command-name].md` (global)
**Project-specific**: If user requests, save to `.claude/commands/` in the project instead

## Determining allowed-tools

**Ask these questions:**
1. Does it read existing files? → Include `Read`
2. Does it create new files? → Include `Write`
3. Does it modify existing files? → Include `Edit`
4. Does it need bash commands? → Include specific `Bash(command:*)` not `Bash(*)`
5. Does it launch other agents? → Include `Task`
6. Does it call other slash commands? → Include `SlashCommand`
7. Does it do web research? → Include `WebSearch`, `WebFetch`
8. Is it read-only analysis? → Only include `Read` (or no tools if just text generation)
9. Is it pure text generation? → No tools needed

**Be specific with Bash permissions:**
- Good: `Bash(date:*)`, `Bash(find:*)`, `Bash(ls:*)`
- Bad: `Bash(*)` (too permissive)

## File Structure

```markdown
---
description: Brief one-line description (required for SlashCommand tool)
argument-hint: Describe expected arguments (shows in autocomplete)
allowed-tools: List of tools needed (optional, inherits conversation permissions if omitted)
model: haiku|sonnet|opus (optional, inherits if omitted)
---

[Prompt content with instructions for Claude]

Can include:
- $ARGUMENTS for all args or $1, $2 for positional args
- @filename for file references
- !\`command\` for pre-executed bash (requires allowed-tools: Bash)
  (Remove backslashes in actual use - shown escaped here to prevent execution)
```

## Example Patterns

**Timestamp command (pre-execute):**
```markdown
---
description: Save conversation with timestamp
model: haiku
allowed-tools: Bash(date:*), Write
---

**Current timestamp:** !\`date "+%Y-%m-%d %H:%M"\`

Save conversation using the timestamp above...
```
(Note: Remove backslashes before backticks in actual use)

**File listing before delete (show-before-destroy):**
```markdown
---
description: Clean up old files
allowed-tools: Bash(find:*), Bash(rm:*)
---

**Files to be deleted:**
!\`find "path/" -name "*.md" -mtime +30\`

Review the list above and confirm deletion...
```
(Note: Remove backslashes before backticks in actual use)

**Dynamic search (instructions-based):**
```markdown
---
description: Search for context files
allowed-tools: Read, Grep, Bash(find:*)
---

Search for files matching the topic using flexible strategies.
Use Grep and find commands as needed (executed when appropriate).
```

**Read-only analysis:**
```markdown
---
description: Analyze draft quality
allowed-tools: Read
---

Read the draft and provide feedback (no file modifications).
```

**Pure text generation:**
```markdown
---
description: Generate writing alternatives
---

Generate text alternatives based on constraints (no file access needed).
```

## Process

1. **Understand the command's purpose** - What does it actually do?
2. **Determine bash approach** - Instructions only, exclamation-backtick prefix, or both?
3. **Identify required tools** - Be minimal and specific
4. **Gather all required information** from user
5. **Write file** to `~/.claude/commands/[command-name].md` (or project `.claude/commands/` if requested)
6. **Show the created frontmatter** so user can review
7. **Confirm**: "Created `/command-name` - available now"
8. **Show usage example** if arguments are used

## Quality Checklist

Before creating the command, verify:
- [ ] Has `description:` field (required for SlashCommand tool)
- [ ] Has `argument-hint:` if it takes arguments
- [ ] `allowed-tools` includes only what's needed
- [ ] Bash permissions are specific (not `Bash(*)`)
- [ ] Uses exclamation-backtick prefix only when pre-execution is needed
- [ ] Model specified only if required (haiku for efficiency, sonnet for complexity)
- [ ] Prompt is clear about what Claude should do
- [ ] File will be saved to `~/.claude/commands/` (global default) or project `.claude/commands/` if requested
- [ ] Verified against the design principles above
