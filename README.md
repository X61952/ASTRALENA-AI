# Lexa

> A private, owner-first WhatsApp AI agent that can chat naturally, use tools, remember context, and ask before it takes consequential actions.

Lexa is a Node.js WhatsApp agent designed to work for one authorized owner. She can hold natural conversations, understand voice notes, browse the web, work with files, assist with code and GitHub, operate an authorized website over SSH, create reminders, and retain useful memory across restarts.

The project is intentionally safety-oriented: the default autonomy mode is `ask`, sensitive operations require explicit confirmation, credentials are kept out of command environments, and owner-only access is enforced in code.

## What Lexa can do

| Area | Capabilities |
| --- | --- |
| Conversation | Natural text conversations, short progress updates, owner-only replies, group-aware responses |
| Voice | Speech-to-text for voice notes through Groq Whisper; optional text-to-speech and voice-note replies |
| Computer tasks | Run authorized shell commands, Python/Node/Bash code, background processes, builds, and package installs |
| Web | Search, read pages, scrape sites, call APIs, download files, read PDFs, and use a real browser for JavaScript-heavy pages and screenshots |
| Images | Resize, crop, rotate, recolor, convert, compress, create stickers, generate images, and perform OCR |
| Documents | Create and read PDF, Word, Excel, and CSV files; generate QR codes; zip and unzip files |
| Code | JavaScript obfuscation with configurable protection levels |
| GitHub | Clone repositories, inspect status, commit and push with approval, open pull requests, and create repositories |
| Websites | Check availability, take screenshots, and run approved SSH commands or uploads |
| Planning | Persistent reminders and scheduled jobs that Lexa can execute when due |
| Memory | Conversation history and durable facts stored locally and reused after restarts |
| Controls | Natural-language `status`, `stop`, `mode ask`, and `mode auto` commands |

## Safety model

Lexa is built for a private, owner-controlled deployment.

- Only `LEXA_OWNER_NUMBER` is authorized for direct interaction.
- In groups, Lexa responds only to the owner and only when called by name, replied to, or tagged.
- `ask` is the default autonomy mode. Read-only actions may run immediately; consequential actions request approval.
- `auto` allows more autonomy, but destructive or high-impact operations still require confirmation.
- Shell execution, GitHub pushes, website changes, credential-related actions, and destructive commands are guarded.
- Sensitive commands are confirmed in a direct message using `confirm` or the configured `LEXA_SENSITIVE_PIN`.
- Catastrophic commands and requests involving secrets are refused.
- Web pages, downloaded files, and other external content are treated as data—not as instructions.
- Requests to localhost, private IP ranges, and cloud metadata endpoints are blocked.
- Commands run with a stripped environment so API keys and tokens are not exposed to subprocesses.
- `.env`, session data, keys, and other sensitive files are not intended to be read, sent, committed, or uploaded.

Use a separate WhatsApp number for Lexa, preferably a spare SIM or WhatsApp Business account. Do not run an automation agent on your personal WhatsApp number.

## Architecture

Lexa starts from `src/index.js` and assembles a small set of focused services:

```text
WhatsApp connection
        │
        ▼
  message handler ───────► LLM client (OpenRouter / Groq)
        │                         │
        ├── approvals              ├── tool selection
        ├── memory                  ├── conversation response
        ├── scheduler               └── fallback model
        └── tool registry
```

Important components include:

- `src/whatsapp.js` — WhatsApp connection and message transport.
- `src/handler.js` — message routing, commands, approvals, and responses.
- `src/llm.js` — OpenRouter/Groq model selection and verification.
- `src/agent.js` — agent execution and tool orchestration.
- `src/tools/` — computer, web, file, image, document, GitHub, and website tools.
- `src/memory.js` — conversation and durable-memory persistence.
- `src/approvals.js` — approval and timeout handling.
- `src/scheduler.js` — persistent reminders and due-job execution.
- `src/config.js` — environment loading and runtime configuration.
- `src/doctor.js` — configuration and dependency diagnostics.
- `src/setup.js` — guided environment setup.

## Requirements

- Ubuntu or another Linux environment suitable for the required system tools.
- Node.js 22 or newer.
- Git.
- Python 3 and `pip`.
- `poppler-utils` for PDF workflows.
- `ffmpeg` for audio and video workflows.
- `openssh-client` for approved website operations.
- A dedicated WhatsApp number for Lexa.
- An OpenRouter API key, Groq API key, or both.

Optional providers and integrations are configured through `.env`:

- Tavily or Brave for web search.
- GitHub fine-grained token for repository operations.
- SSH key and site details for website operations.

## Installation on Ubuntu

```bash
# Install Node.js 22, Git, Python, and system tools.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git python3 python3-pip poppler-utils ffmpeg openssh-client

# Install project dependencies.
npm install

# Create the local configuration file.
cp .env.example .env

# Use the guided setup wizard, or edit .env manually.
npm run setup

# Check configuration before connecting WhatsApp.
npm run doctor
```

For JavaScript-heavy websites and page screenshots, install Chromium for Playwright when needed:

```bash
npx playwright install --with-deps chromium
```

## Configuration

All runtime settings belong in one local `.env` file. Never commit it.

At minimum, set the WhatsApp identity, owner number, and one supported LLM provider:

```dotenv
LEXA_PHONE=2340000000000
LEXA_OWNER_NUMBER=2340000000000
LEXA_NAME=Lexa
LEXA_ALIASES=alexa
LEXA_GROUPS=on

OPENROUTER_API_KEY=your-openrouter-key
GROQ_API_KEY=your-groq-key
LLM_PROVIDER=openrouter
LLM_MODEL=your-tool-capable-model
LLM_FALLBACK_MODEL=llama-3.3-70b-versatile
```

Useful operational settings:

```dotenv
LEXA_AUTONOMY=ask
LEXA_DAILY_TOKENS=3000000
LEXA_SENSITIVE_PIN=confirm
TIME_ZONE=Africa/Lagos
LEXA_WORKSPACE=./workspace
LEXA_DATA_DIR=./data
```

### GitHub access

Use a fine-grained token restricted to the repositories Lexa needs. Grant only the permissions required by your workflow, such as repository contents and pull requests.

```dotenv
GITHUB_TOKEN=your-fine-grained-token
GIT_USER_NAME=Lexa
GIT_USER_EMAIL=lexa@example.com
```

### Website access

Use a dedicated SSH key with the narrowest permissions possible:

```dotenv
SITE_URL=https://example.com
SITE_SSH=user@example-host
SITE_SSH_KEY=/absolute/path/to/lexa-site-key
SITE_ROOT=/var/www/example.com
```

## First run

Start Lexa with:

```bash
npm start
```

On the first run, Lexa prints a pairing code. On the WhatsApp number configured in `LEXA_PHONE`:

1. Open **WhatsApp**.
2. Open **Linked devices**.
3. Choose **Link a device**.
4. Select **Link with phone number instead**.
5. Enter the pairing code shown by Lexa.

After the connection opens, keep the process running. For a long-lived VPS deployment, PM2 can be used:

```bash
sudo npm install --global pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## Everyday controls

Lexa understands both explicit commands and natural phrasing.

| Intent | Example |
| --- | --- |
| Check status | `status` or `what's your status?` |
| Stop current work | `stop` |
| Use approval mode | `mode ask` |
| Use higher-autonomy mode | `mode auto` |
| Teach a shortcut | `add a command: deploy means pull the latest website code and restart pm2` |
| Mark a shortcut sensitive | `add a sensitive command: wipe cache means ...` |
| Approve a pending action | `yes` or `confirm` |
| Reject a pending action | `no` |

Always review the action Lexa describes before approving it. An unanswered approval expires and is treated as rejected.

## Groups and direct messages

In a group, Lexa only responds to the configured owner and only when one of these conditions is met:

- The owner calls her by name.
- The owner replies to one of her messages.
- The owner tags her.

For larger tasks, Lexa can acknowledge the request in the group, perform the work, send the result or files to the owner's direct message, and mention the owner in the group when the work is complete.

## Files and media

Lexa can work with files that are sent to her. Reply to a file already available in the conversation with an instruction such as:

```text
Lexa, read this file and scan it for bugs.
```

For sensitive documents, verify that the file is authorized for processing before sending it to the agent. Keep the local `workspace/`, `data/`, and WhatsApp session directories private.

## Development commands

```bash
npm start       # Start the WhatsApp agent
npm test        # Run the Node.js test suite
npm run doctor  # Validate configuration and dependencies
npm run setup   # Guided setup and configuration wizard
```

The test suite is located in `tests/` and covers startup, agent behavior, tools, groups, images, power controls, setup, and diagnostics.

## Production checklist

Before connecting a production account:

- Use a separate WhatsApp number.
- Set `LEXA_OWNER_NUMBER` to the correct authorized owner.
- Keep `.env`, session files, `data/`, and `workspace/` out of Git.
- Use `LEXA_AUTONOMY=ask` until the deployment has been observed safely.
- Use a fine-grained GitHub token and a dedicated SSH key.
- Run `npm run doctor`.
- Run `npm test`.
- Confirm that the configured LLM model supports tool calling.
- Confirm that the server clock and `TIME_ZONE` are correct for reminders.
- Review every approval prompt before responding `yes` or `confirm`.
- Monitor logs and resource usage after startup.

## Repository hygiene

The project should contain only public source, documentation, and example configuration. Do not commit:

- `.env` files containing real values.
- WhatsApp authentication state or pairing artifacts.
- API keys, access tokens, SSH private keys, or cookies.
- Local memory, reminder data, downloaded files, or generated documents.
- Logs containing message content or personal information.

## License and responsible use

Review the repository's license before redistributing Lexa. You are responsible for complying with WhatsApp policies, provider terms, privacy laws, and the permissions of any account, repository, website, file, or data that Lexa accesses.

Lexa is an automation tool. Do not use it for spam, harassment, unauthorized access, credential harvesting, surveillance, or actions against systems and accounts you do not control.

## Project status

Lexa is an actively evolving personal automation agent. WhatsApp protocol behavior, external provider APIs, browser automation, and model tool-calling support can change independently. Test changes in a non-production account first and keep dependencies reviewed and reproducible.
