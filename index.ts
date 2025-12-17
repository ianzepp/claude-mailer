#!/usr/bin/env bun

/**
 * claude-mailer - Send HTML emails via direct SMTP/IMAP to Proton Bridge
 *
 * A CLI tool for sending emails programmatically through Proton Mail Bridge.
 * Supports plain text, HTML, and markdown (via pandoc) input with proper
 * email threading and quote formatting.
 *
 * SETUP
 * =====
 * 1. Install and configure Proton Mail Bridge (https://proton.me/mail/bridge)
 * 2. Get bridge credentials: Proton Bridge > Account > Configure > IMAP/SMTP
 * 3. Create .env file in project root:
 *
 *    SMTP_HOST=127.0.0.1
 *    SMTP_PORT=1025
 *    SMTP_USER=you@example.com
 *    SMTP_PASS=bridge-generated-password
 *    SMTP_SECURITY=SSL
 *
 *    IMAP_HOST=127.0.0.1
 *    IMAP_PORT=1143
 *    IMAP_USER=you@example.com
 *    IMAP_PASS=bridge-generated-password
 *    IMAP_SECURITY=STARTTLS
 *
 * USAGE
 * =====
 * Send a new email:
 *   echo "Message body" | bun run index.ts send <to> <subject>
 *
 * Send markdown email (requires pandoc):
 *   echo "# Hello\n\n**Bold** text" | pandoc -f markdown -t html | bun run index.ts send <to> <subject>
 *
 * Reply with auto-quoted original:
 *   echo "Thanks!" | bun run index.ts reply <to> <subject> --quote-message-id="<message-id>"
 *
 * Reply with threading only (no quote):
 *   echo "Thanks!" | bun run index.ts reply <to> <subject> --in-reply-to="<message-id>"
 *
 * EXAMPLES
 * ========
 * # Plain text email
 * echo "Hello, world!" | bun run index.ts send alice@example.com "Quick hello"
 *
 * # Markdown email with pandoc
 * cat update.md | pandoc -f markdown -t html | bun run index.ts send team@example.com "Weekly Update"
 *
 * # Reply with quoted original (fetches via IMAP, formats as collapsible blockquote)
 * echo "Sounds good, thanks!" | bun run index.ts reply alice@example.com "Re: Meeting" \
 *   --quote-message-id="<abc123@mail.protonmail.ch>"
 *
 * # Verbose mode for debugging
 * echo "Test" | bun run index.ts send alice@example.com "Test" --verbose
 *
 * NOTES
 * =====
 * - Input is auto-detected: HTML passes through, plain text gets <br> conversion
 * - Quoted messages use <blockquote type="cite"> for proper collapse in mail clients
 * - Threading uses In-Reply-To and References headers for conversation grouping
 * - Message-IDs can be found in email headers or via IMAP inspection
 */

import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { parseArgs } from "util";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Auto-load config from ~/.config/claude-mailer/.env if not already set
async function loadConfig() {
  const configPath = join(homedir(), ".config", "claude-mailer", ".env");
  if (process.env.SMTP_USER) return; // Already configured

  try {
    const envFile = Bun.file(configPath);
    if (await envFile.exists()) {
      const content = await envFile.text();
      for (const line of content.split("\n")) {
        const [key, ...valueParts] = line.split("=");
        const value = valueParts.join("=").trim();
        if (key && value && !process.env[key.trim()]) {
          process.env[key.trim()] = value;
        }
      }
    }
  }
  catch {
    // Config file not found, rely on environment variables
  }
}

function getSmtpConfig() {
  return {
    host: process.env.SMTP_HOST || "127.0.0.1",
    port: parseInt(process.env.SMTP_PORT || "1025"),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    secure: process.env.SMTP_SECURITY === "SSL",
  };
}

function getImapConfig() {
  return {
    host: process.env.IMAP_HOST || "127.0.0.1",
    port: parseInt(process.env.IMAP_PORT || "1143"),
    user: process.env.IMAP_USER || "",
    pass: process.env.IMAP_PASS || "",
    secure: process.env.IMAP_SECURITY === "SSL",
  };
}

let verbose = false;

function log(...args: unknown[]) {
  if (verbose) {
    console.log("[debug]", ...args);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FetchedMessage {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  date: Date;
  body: string;
  html?: string;
  references?: string;
}

interface SendOptions {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  quotedMessage?: FetchedMessage;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateSmtpConfig() {
  const config = getSmtpConfig();
  if (!config.user || !config.pass) {
    console.error("Error: SMTP_USER and SMTP_PASS environment variables required");
    console.error("Create ~/.config/claude-mailer/.env with your Proton Bridge credentials.");
    process.exit(1);
  }
}

function validateImapConfig() {
  const config = getImapConfig();
  if (!config.user || !config.pass) {
    console.error("Error: IMAP_USER and IMAP_PASS environment variables required");
    console.error("Create ~/.config/claude-mailer/.env with your Proton Bridge credentials.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// HTML Utilities
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isHtml(text: string): boolean {
  return /<[a-z][\s\S]*>/i.test(text);
}

function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>\n");
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Format a quoted message as an HTML blockquote.
 * Uses type="cite" which mail clients recognize for collapsible quotes.
 */
function formatHtmlQuote(msg: FetchedMessage): string {
  const attribution = `On ${formatDate(msg.date)}, ${escapeHtml(msg.from)} wrote:`;
  const quotedContent = msg.html || textToHtml(msg.body);

  return `
<div style="margin-top: 1em; color: #666;">${attribution}</div>
<blockquote type="cite" style="margin: 0.5em 0; padding-left: 1em; border-left: 2px solid #ccc;">
${quotedContent}
</blockquote>`;
}

/**
 * Wrap HTML content in a complete document with proper charset.
 */
function wrapInHtmlDocument(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.5; color: #333;">
${bodyHtml}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// MIME Utilities
// ---------------------------------------------------------------------------

/**
 * Decode quoted-printable encoded text.
 */
function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// ---------------------------------------------------------------------------
// IMAP Operations
// ---------------------------------------------------------------------------

/**
 * Fetch a message from the inbox by its Message-ID header.
 * Parses both plain text and HTML parts from multipart messages.
 */
async function fetchMessageById(messageId: string): Promise<FetchedMessage | null> {
  validateImapConfig();

  const imapConfig = getImapConfig();
  log("Connecting to IMAP", { host: imapConfig.host, port: imapConfig.port });

  const client = new ImapFlow({
    host: imapConfig.host,
    port: imapConfig.port,
    secure: imapConfig.secure,
    auth: {
      user: imapConfig.user,
      pass: imapConfig.pass,
    },
    tls: { rejectUnauthorized: false },
    logger: false,
  });

  await client.connect();
  log("IMAP connected");

  const lock = await client.getMailboxLock("INBOX");

  try {
    const searchId = messageId.replace(/^<|>$/g, "");
    log("Searching for Message-ID:", searchId);

    const uids = await client.search({ header: { "message-id": searchId } });
    log("Found UIDs:", uids);

    if (uids.length === 0) {
      return null;
    }

    const msg = await client.fetchOne(uids[0], { envelope: true, source: true });
    const sourceText = msg.source.toString("utf-8");

    // Split headers and body
    const headerBodySplit = sourceText.split(/\r?\n\r?\n/);
    const headers = headerBodySplit[0];
    const rawBody = headerBodySplit.slice(1).join("\n\n");

    let plainBody = "";
    let htmlBody = "";

    // Check if multipart message
    const boundaryMatch = headers.match(/boundary="?([^"\r\n]+)"?/i);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const escapedBoundary = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const parts = rawBody.split(new RegExp(`--${escapedBoundary}`));

      log("Multipart message with", parts.length, "parts");

      for (const part of parts) {
        if (part.includes("Content-Type: text/plain")) {
          const textContent = part.split(/\r?\n\r?\n/).slice(1).join("\n\n");
          plainBody = decodeQuotedPrintable(textContent);
        }
        else if (part.includes("Content-Type: text/html")) {
          const htmlContent = part.split(/\r?\n\r?\n/).slice(1).join("\n\n");
          htmlBody = decodeQuotedPrintable(htmlContent);
        }
      }
    }
    else {
      log("Single-part message");
      plainBody = decodeQuotedPrintable(rawBody);
    }

    const fromAddr = msg.envelope.from?.[0];
    const toAddr = msg.envelope.to?.[0];

    const result: FetchedMessage = {
      messageId: msg.envelope.messageId || messageId,
      from: fromAddr ? `${fromAddr.name || ""} <${fromAddr.address}>`.trim() : "Unknown",
      to: toAddr ? `${toAddr.name || ""} <${toAddr.address}>`.trim() : "Unknown",
      subject: msg.envelope.subject || "(no subject)",
      date: msg.envelope.date || new Date(),
      body: plainBody.trim(),
      html: htmlBody.trim() || undefined,
      references: msg.envelope.inReplyTo,
    };

    log("Fetched message:", { from: result.from, subject: result.subject });
    return result;
  }
  finally {
    lock.release();
    await client.logout();
    log("IMAP disconnected");
  }
}

// ---------------------------------------------------------------------------
// SMTP Operations
// ---------------------------------------------------------------------------

/**
 * Send an HTML email via SMTP.
 * Handles plain text to HTML conversion and quote formatting.
 */
async function sendEmail(options: SendOptions) {
  validateSmtpConfig();

  const smtpConfig = getSmtpConfig();
  log("Connecting to SMTP", { host: smtpConfig.host, port: smtpConfig.port, secure: smtpConfig.secure });

  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: {
      user: smtpConfig.user,
      pass: smtpConfig.pass,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });

  // Convert input to HTML if needed
  const inputIsHtml = isHtml(options.body);
  log("Input detected as:", inputIsHtml ? "HTML" : "plain text");

  let bodyHtml = inputIsHtml ? options.body : `<div>${textToHtml(options.body)}</div>`;

  // Append quoted message if present
  if (options.quotedMessage) {
    log("Adding quoted message");
    bodyHtml = `${bodyHtml}\n${formatHtmlQuote(options.quotedMessage)}`;
  }

  const fullHtml = wrapInHtmlDocument(bodyHtml);
  log("Final HTML length:", fullHtml.length);

  const mailOptions: nodemailer.SendMailOptions = {
    from: smtpConfig.user,
    to: options.to,
    subject: options.subject,
    html: fullHtml,
  };

  // Set threading headers
  if (options.inReplyTo) {
    mailOptions.inReplyTo = options.inReplyTo;
    mailOptions.references = options.references
      ? `${options.references} ${options.inReplyTo}`
      : options.inReplyTo;
    log("Threading headers:", { inReplyTo: mailOptions.inReplyTo, references: mailOptions.references });
  }

  const info = await transporter.sendMail(mailOptions);

  console.log(`Sent to ${options.to}: ${options.subject}`);
  console.log(`Message-ID: ${info.messageId}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.error("Usage: bun run index.ts <send|reply> <to> <subject> [options]");
  console.error("");
  console.error("Commands:");
  console.error("  send   Send a new email");
  console.error("  reply  Send a reply with threading");
  console.error("");
  console.error("Options:");
  console.error("  --quote-message-id=<id>  Message-ID to reply to (auto-fetches and quotes)");
  console.error("  --in-reply-to=<id>       Message-ID for threading only (no quote)");
  console.error("  --references=<ids>       Full references chain");
  console.error("  --verbose                Enable debug output");
  console.error("");
  console.error("Input: Plain text or HTML via stdin.");
  console.error("       For markdown, pipe through pandoc first:");
  console.error("       cat msg.md | pandoc -f markdown -t html | bun run index.ts send ...");
}

async function main() {
  await loadConfig();

  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !["send", "reply"].includes(command)) {
    printUsage();
    process.exit(1);
  }

  const { values, positionals } = parseArgs({
    args: args.slice(1),
    options: {
      "quote-message-id": { type: "string" },
      "in-reply-to": { type: "string" },
      "references": { type: "string" },
      "verbose": { type: "boolean", short: "v" },
    },
    allowPositionals: true,
  });

  verbose = values.verbose || false;

  const [to, subject] = positionals;

  if (!to || !subject) {
    console.error("Error: <to> and <subject> are required");
    printUsage();
    process.exit(1);
  }

  const body = await Bun.stdin.text();
  if (!body.trim()) {
    console.error("Error: No email body provided via stdin");
    process.exit(1);
  }

  log("Command:", command);
  log("To:", to);
  log("Subject:", subject);
  log("Body length:", body.length);

  let quotedMessage: FetchedMessage | undefined;
  let inReplyTo = values["in-reply-to"];
  let references = values["references"];

  // Fetch quoted message if requested
  if (values["quote-message-id"]) {
    const msgId = values["quote-message-id"];
    console.log(`Fetching message ${msgId}...`);

    const fetched = await fetchMessageById(msgId);
    if (!fetched) {
      console.error(`Error: Could not find message with ID ${msgId}`);
      process.exit(1);
    }

    quotedMessage = fetched;
    inReplyTo = msgId;
    references = fetched.references;
  }

  await sendEmail({
    to,
    subject,
    body: body.trim(),
    inReplyTo,
    references,
    quotedMessage,
  });
}

main().catch((err) => {
  console.error("Failed:", err.message);
  if (verbose) {
    console.error(err.stack);
  }
  process.exit(1);
});
