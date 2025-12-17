# claude-mailer

CLI tool for sending and receiving emails via Proton Mail Bridge. Supports plain text, HTML, and markdown input with proper email threading and quote formatting.

## Setup

1. Install and configure [Proton Mail Bridge](https://proton.me/mail/bridge)
2. Get bridge credentials: Proton Bridge > Account > Configure > IMAP/SMTP
3. Create config file at `~/.config/claude-mailer/.env`:

```
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_USER=you@example.com
SMTP_PASS=bridge-generated-password
SMTP_SECURITY=SSL

IMAP_HOST=127.0.0.1
IMAP_PORT=1143
IMAP_USER=you@example.com
IMAP_PASS=bridge-generated-password
IMAP_SECURITY=STARTTLS
```

## Installation

```bash
# Clone and install dependencies
git clone https://github.com/ianzepp/claude-mailer.git
cd claude-mailer
bun install

# Create a wrapper script for global access
mkdir -p ~/.local/bin
echo '#!/bin/bash
exec bun /path/to/claude-mailer/index.ts "$@"' > ~/.local/bin/claude-mailer
chmod +x ~/.local/bin/claude-mailer

# Add to PATH (in ~/.zshrc or ~/.bashrc)
export PATH="$HOME/.local/bin:$PATH"
```

## Commands

### send

Send a new email. Body is read from stdin.

```bash
echo "Hello, world!" | claude-mailer send alice@example.com "Quick hello"
```

### reply

Send a reply with threading. Use `--quote-message-id` to include the original message as a collapsible quote.

```bash
# Reply with quoted original
echo "Thanks for the update!" | claude-mailer reply alice@example.com "Re: Project Status" \
  --quote-message-id="<abc123@mail.example.com>"

# Reply with threading only (no quote)
echo "Got it." | claude-mailer reply alice@example.com "Re: Meeting" \
  --in-reply-to="<abc123@mail.example.com>"
```

### next

Get the next unread message from the inbox. If no unread messages exist, waits for one until timeout.

```bash
# Get next unread message (default 60s timeout)
claude-mailer next

# Quick check with short timeout
claude-mailer next --timeout=10

# Filter by sender
claude-mailer next --from=alice@example.com

# Filter by subject
claude-mailer next --subject="Project"
```

Returns JSON:

```json
{
  "messageId": "<abc123@mail.example.com>",
  "from": "Alice <alice@example.com>",
  "to": "<you@example.com>",
  "subject": "Project Status",
  "date": "2025-01-15T10:30:00.000Z",
  "body": "Here's the latest update...",
  "references": "<previous-message-id>"
}
```

## Options

### send/reply options

| Option | Description |
|--------|-------------|
| `--quote-message-id=<id>` | Message-ID to reply to (fetches and quotes original) |
| `--in-reply-to=<id>` | Message-ID for threading only (no quote) |
| `--references=<ids>` | Full references chain |

### next options

| Option | Description |
|--------|-------------|
| `--from=<email>` | Filter by sender (partial match) |
| `--subject=<text>` | Filter by subject (partial match) |
| `--timeout=<seconds>` | Wait timeout in seconds (default: 60) |

### Global options

| Option | Description |
|--------|-------------|
| `--verbose`, `-v` | Enable debug output |

## Markdown emails

Pipe through pandoc for markdown-to-HTML conversion:

```bash
cat update.md | pandoc -f markdown -t html | claude-mailer send team@example.com "Weekly Update"
```

## Notes

- Input is auto-detected: HTML passes through, plain text gets `<br>` conversion
- Quoted messages use `<blockquote type="cite">` for proper collapse in mail clients
- Threading uses `In-Reply-To` and `References` headers for conversation grouping
- Messages fetched with `next` are automatically marked as read
