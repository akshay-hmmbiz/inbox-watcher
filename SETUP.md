# Set up Inbox Watcher

This guide takes you from a fresh download to your first alert in Google Chat. It takes
about 10 minutes. You do not need to be a developer. You will type a few commands into a
terminal; each one is shown exactly.

- **Part A** tries it on invented mail. No accounts needed.
- **Part B** connects it to your Gmail and your Chat space.
- **Part C** is what using it looks like day to day.
- **Part D** is for people who want to feed it mail without Claude.

---

## Part A: Try it in 2 minutes

### 1. Install Node.js 22 or newer

Download the LTS version from [nodejs.org](https://nodejs.org) and install it with the
default options.

**Check:** open a new terminal and type:

```
node --version
```

It should print `v22` or a higher number, for example `v24.11.0`.

### 2. Get the code

Pick one:

- **Download ZIP.** On [github.com/akshay-hmmbiz/inbox-watcher](https://github.com/akshay-hmmbiz/inbox-watcher),
  click the green **Code** button, then **Download ZIP**. Unzip it. The folder is called
  `inbox-watcher-main`. If you open it and see only another `inbox-watcher-main` folder,
  go into that one: it is the one with `README.md` inside.
- **Or, if you use git:**

  ```
  git clone https://github.com/akshay-hmmbiz/inbox-watcher.git
  ```

**Check:** the folder contains `README.md`, `SETUP.md` and a `src` folder.

### 3. Open a terminal in that folder

- **Windows:** open the folder in File Explorer, click the address bar, type `cmd` and
  press Enter. A black window opens, already in the right folder.
- **macOS:** right-click the folder in Finder and choose **New Terminal at Folder**.
- **Linux:** right-click inside the folder and choose **Open in Terminal**, or `cd` into it.

All the commands below are typed in this window. (On Windows, if you used PowerShell
instead and it says "running scripts is disabled", use the `cmd` window described above.)

### 4. Run the tests

```
npm test
```

**Check:** after a few seconds the last lines include `tests 323`, `pass 323` and
`fail 0`. The tests need no internet and no setup.

### 5. Run the demo

```
npm run demo
```

**Check:** it prints the Chat messages the Watcher would send for nine invented
messages: three alerts, a daily digest, a reminder two hours later, and a list of what is
still open. It posts nothing anywhere and changes no files in the folder.

That is the whole tool. Part B makes it read your real mail.

---

## Part B: Connect it for real

You need a Google Chat space you can add a webhook to, and the
[Claude desktop app](https://claude.ai/download) with the Gmail connector turned on.

### 6. Make a Chat webhook and put it in `.env`

In Google Chat, open the space you want alerts in. Click the space name, then
**Apps & integrations**, then **Webhooks**, then **Add webhook**. Give it a name and copy
the URL.

In the terminal, make your own copy of the settings file:

| Windows | macOS / Linux |
|---|---|
| `copy .env.example .env` | `cp .env.example .env` |

Open it with `notepad .env` (Windows) or `open -e .env` (macOS), paste the URL right
after `CHAT_WEBHOOK_URL=` on the same line, and save. (Double-clicking `.env` does not
work well: the name starts with a dot, so Windows asks which app to use and macOS hides it.)

The URL is a secret: anyone who has it can post into your space. Keep it in `.env` only.

**Check:** `.env` has one line that starts `CHAT_WEBHOOK_URL=https://chat.googleapis.com/`.

### 7. Turn on Chat email notifications

The Watcher sees Google Chat through the emails Chat sends you. In Google Chat, open
**Settings**, then **Notifications**, and turn on email notifications for unread direct
messages and @mentions.

### 8. Write your config file

| Windows | macOS / Linux |
|---|---|
| `copy watcher.config.example.json watcher.config.json` | `cp watcher.config.example.json watcher.config.json` |

Open `watcher.config.json`. Only `owner` is required. The smallest file that works is:

```json
{
  "owner": { "name": "Your Name", "email": "you@your-company.com" },
  "timezone": "Europe/London"
}
```

- `owner.name`: your name exactly as Google Chat shows it.
- `owner.email`: the address your mail arrives at. If that is a personal `@gmail.com`
  (or other public webmail) address, also add `"internalDomain": "your-company.com"` so
  that colleagues are recognised. Without it, nobody counts as a colleague by address.
- `timezone` is optional (the default is `UTC`), but set it so the daily digest goes out
  at 9 in the morning your time.

The example file has more fields (a CEO, newsletter senders, sites to watch). Keep the
ones you want and delete the rest. The README table "Your config file" explains each one.

**Check:** run

```
node src/triage.mjs
```

It should print `triage: nothing to triage; 0 open threads to check for read`. (This
creates a `state` folder. Leave it there.) If the file has a mistake it prints
`triage failed:`, followed either by every problem listed by field name, or by
`is not valid JSON` with the position of a missing quote or an extra comma.

### 9. Pre-approve the task's tools

A scheduled run has nobody to click "Allow", so it needs permission in advance.

| Windows | macOS / Linux |
|---|---|
| `mkdir .claude` | `mkdir -p .claude` |
| `copy docs\claude-settings.example.json .claude\settings.local.json` | `cp docs/claude-settings.example.json .claude/settings.local.json` |

Open it with `notepad .claude\settings.local.json` (Windows) or
`open -e .claude/settings.local.json` (macOS). Replace `<GMAIL SERVER ID>` (three times) with your
Gmail connector's id. It is the middle part of the connector's tool names, as in
`mcp__<id>__search_threads`. If you do not know it, leave those lines as they are and
choose **Always allow** on the Gmail prompts in step 11: the app then writes the right
names for you.

### 10. Create the scheduled task in the Claude desktop app

1. Open [`docs/scheduled-task-prompt.md`](docs/scheduled-task-prompt.md). Copy the
   text inside the grey box, from `You are one run of the Watcher` down to the end of
   **Hard rules**. (GitHub's copy button also copies the few `---` lines at the top of
   the box. Delete them.)
2. In that text, replace every placeholder:
   - `<OWNER NAME>` and `<OWNER EMAIL>`: the same values as in `watcher.config.json`.
   - `<PROJECT ROOT>` (it appears three times): the full path of this folder. On
     Windows, click the File Explorer address bar and copy it, for example
     `C:\Users\you\Downloads\inbox-watcher-main`.
   - `<CEO NAME>` and `<CEO EMAIL>`: as in `ceo` in your config. If you set no CEO,
     delete the paragraph that starts **The CEO.** and the sentence that starts
     **Never set it for the CEO**.
3. In the Claude desktop app, create a new scheduled task. Name it `inbox-watcher` and
   paste the edited text as its prompt.
4. Choose this folder as the task's working folder. The commands in the prompt only work
   from here.
5. Set the schedule to every 2 hours, for example from 08:00 to 22:00.

### 11. Run it once by hand

In the task, click **Run now**. Watch the run. If the app asks for permission (for
example for the Gmail tools), choose **Always allow**.

**Check that it worked:**

- The run ends with one summary line, such as `posted 2 messages (1 alert, daily digest)`
  or `nothing to post`. No permission prompt is left waiting.
- If anyone is waiting on you, a message appears in your Chat space. After 9 in the
  morning (your `digestHour`), the first run of the day also posts the daily digest.
- `state/lastRun` now holds the time of this run. See it with `type state\lastRun`
  (Windows) or `cat state/lastRun` (macOS / Linux).
- `node src/close.mjs --list` shows what is open, or `nothing is open`.

Run it by hand once more and check it finishes with no prompt at all. Scheduled runs
will now work on their own while the app is open and the computer is awake.

---

## Part C: Day to day

- **Alerts.** When a person is waiting on you, a message arrives in your Chat space with
  who it is, what they said, an importance level (Top most, High, Medium or Low) and a link.
- **Reminders.** An item you have not dealt with is raised again after 2 hours and after
  6 hours. After that it appears in every daily digest until it is closed.
- **Daily digest.** Once a day, after the digest hour: leads, site-down alerts,
  notifications and the date of the last blog post on each site you watch. It comes every
  day, even an empty one. No digest by mid-morning means the Watcher is not running.
- **Closing items.** An item closes on its own when you open it in Gmail, or when you
  reply to the email. Opened it but still need to act? Mark it unread again and it stays
  open. Careful: **Select all → Mark as read** in Gmail closes every open item at once.
- **Closing by hand.** `node src/close.mjs --list` shows open items with a key for each.
  `node src/close.mjs <key>` closes one (part of a name works, such as
  `node src/close.mjs dana`). `node src/close.mjs all` closes everything. Chat items
  with no notification email behind them only close this way.

---

## Part D: Without Claude

You do not need Claude. Any script or tool that writes `state/inbox.json` in the shape
shown in [`examples/README.md`](examples/README.md) works: a Gmail API script, an IMAP
script, an export. Add `state/sent.json` if you want answered threads to close, and leave
`state/verdicts.json` as `{}` if nothing judges the messages the rules cannot place (they
are then reported as "could not be judged" and are not alerted). Then run the two
commands, on a schedule of your choice:

```
node src/triage.mjs
node src/run.mjs
```

Without `state/readState.json`, items close only when you reply or close them by hand. To
close them when you have read them, have your script read `state/openThreads.json` after
`node src/triage.mjs` and write `state/readState.json` in the shape shown in
[`examples/README.md`](examples/README.md), before `node src/run.mjs`.

---

## If something goes wrong

- **A run sits waiting, or never finishes.** It is stuck on a permission prompt. Check
  step 9, check this folder is the task's working folder, run it by hand and choose
  **Always allow**. A run left "running" for hours blocks every later run: clear it in
  the task's run list.
- **No messages and no digest.** The app was closed, the computer was asleep, or the task
  is switched off. The next run picks up any mail from the last day.
- **`run failed: CHAT_WEBHOOK_URL is not set`.** `.env` is missing or the URL is not on
  the `CHAT_WEBHOOK_URL=` line (step 6).
- **The summary says a post failed and will be retried.** The webhook was probably
  deleted or regenerated. Put the new URL in `.env`. Nothing is lost: the next run sends
  the backlog.
- **`no watcher config at ...`** or **`watcher config has ... problems`.** Redo step 8 and
  fix each field it names.
- **A Chat message was never alerted.** Google only emails you about messages you have
  not opened, and only for direct messages and real @mentions. Check step 7.

More detail is in [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
