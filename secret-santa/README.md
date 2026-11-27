# Secret Santa

A small web app for running a Secret Santa name draw with friends, family or colleagues. It runs entirely on your own computer as a Cloudflare Worker with a local D1 (SQLite) database, so it is free to host and needs no Cloudflare account.

## Features

- **Fixed draw.** Names are drawn once on the server and saved. Everyone sees the same result on every device.
- **Hidden exclusions.** The organiser can stop specific people from drawing each other (optionally both ways). Exclusions never reach participant pages.
- **Simple PIN sign-in.** No email or accounts: participants pick their name and enter a PIN that the organiser chose for them. They can change their own PIN any time.
- **Questionnaire.** Each person answers the same 5 fun questions. Your Secret Santa sees your answers after the draw.
- **Organiser can play.** The admin page never shows who drew whom.
- **Safe redraws.** The draw is locked after it runs. A "Reset draw" button (with a confirmation) lets the organiser redo it.

## How it works

| Piece | What it does |
| --- | --- |
| `public/index.html` | The whole front-end (participant view at `/`, organiser view at `/#admin`) |
| `public/favicon.svg` | The browser tab icon |
| `src/index.js` | The Worker: serves the API under `/api/*` and everything else from `public/` |
| `schema.sql` | Database tables: `settings`, `members`, `exclusions`, `answers`, `pins` |
| `wrangler.toml` | Worker configuration and database binding |
| `.dev.vars` | Your organiser password (`ADMIN_KEY`). Never share or commit this file |

The draw uses a randomised backtracking search. Nobody draws themselves or someone they are excluded from. If the exclusions make a valid draw impossible, the organiser is told and nothing is saved. At least 2 participants are needed (nobody can draw only themselves).

## Requirements

- Node.js 20 or newer (22 LTS recommended; newer versions may work but are less tested with Wrangler)
- Windows, macOS or Linux
- Optional: `cloudflared`, to let people outside your network reach the app

## First-time setup

Run these in the project folder (the one containing `wrangler.toml`):

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and set your password:
   ```
   ADMIN_KEY=choose-a-long-password
   ```
3. `npm run db:init` creates the database tables. It is safe to run again; it will not erase data.

## Running the app

```
npm start
```

The app is now at `http://localhost:8787`.

- Participants use `http://localhost:8787/`
- The organiser uses `http://localhost:8787/#admin` and logs in with `ADMIN_KEY`

The first time you start it, Windows may show a firewall prompt. Allowing it on private networks lets people on your Wi-Fi use `http://<your-PC-IP>:8787`.

## Organiser workflow

1. Open `/#admin` and log in.
2. Set the event name, date and budget.
3. Add all participants. Choose a starting PIN for each one (4 digits) and tell them privately.
4. Add any exclusions (for example, couples who shouldn't draw each other).
5. Share the participant link, and give each person their PIN. Ask everyone to fill in their answers.
6. When everyone is ready, press **Draw names**.
7. Participants return to the link and tap **Reveal who I drew**.

Participants can't be added or removed once the draw is done. Reset the draw first if you need to change the group.

## Sharing with people outside your network

Install `cloudflared`:

- Windows: `winget install Cloudflare.cloudflared`
- macOS: `brew install cloudflared`

With the app running, open a second terminal and run:

```
cloudflared tunnel --url http://localhost:8787
```

It prints an `https://something.trycloudflare.com` link. Share that link with participants.

Notes:

- The link changes every time you restart the tunnel, so share it after starting.
- Keep both terminals running and your PC awake until the event is over.
- Quick tunnels have no uptime guarantee. They are fine for a small group.

## Inspecting the database

Run these from the project folder (the one with `wrangler.toml`):

```
npx wrangler d1 execute santa --local --command "SELECT * FROM members"
npx wrangler d1 execute santa --local --command "SELECT * FROM exclusions"
npx wrangler d1 execute santa --local --command "SELECT * FROM answers"
npx wrangler d1 execute santa --local --command "SELECT * FROM settings"
```

To see who drew whom (spoilers!):

```
npx wrangler d1 execute santa --local --command "SELECT g.name AS giver, r.name AS receiver FROM members g LEFT JOIN members r ON r.id = g.drawn_id"
```

You can also open the SQLite file under `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/` with a tool such as DB Browser for SQLite. Open a copy, not the live file.

## Data and backups

All data is stored in `.wrangler/state/` inside the project folder and survives restarts. To back up, copy that folder somewhere safe, ideally before the draw. Deleting it wipes everything.

## Changing the questions

The questions live in ONE place: the `QUESTIONS` list near the top of `src/index.js`. The page asks the server for that list, so nothing in `public/index.html` needs to change.

- Fixing a typo or rewording a question: edit the text. Existing answers stay and show under the new wording.
- Adding a question: add it to the END of the list.
- Removing or re-ordering questions: answers are saved by question number, so old answers would line up with the wrong questions. Clear them first:
  `npx wrangler d1 execute santa --local --command "DELETE FROM answers"` (add `--remote` for the live site).

Redeploy with `npx wrangler deploy` after changing them. The headings "My answers" and "<name>'s answers" are in `public/index.html`.

## Updating an existing database (one time)

If your database was created before the questionnaire or PINs existed, add the new tables once. It is safe to run more than once and keeps all existing data:

```
npm run db:init
npx wrangler d1 execute santa --remote --file=schema.sql
```

The first command updates your local test database, the second the live one. The old `wishes` table is simply no longer used.

## PINs

- **Starting PIN:** you choose it when adding a participant on `/#admin`.
- **Forgotten PIN:** press **Reset PIN** next to the person's name, type the new value you want, and **Save PIN**. This also clears any lock-out. Anyone already signed in on another device with the old PIN is asked for the new one on their next visit.
- **Changing it themselves:** after signing in, the "Change my PIN" card at the bottom of their page. They can do it as often as they like.
- **Signing in:** the PIN is remembered on that device, so people only type it again on a new device or after pressing "Not you?".
- **Storage:** only a salted hash is saved, so PINs can't be read back from the database, not even by you.
- **Lock-out:** 5 wrong tries in a row locks that person for 60 seconds (`MAX_WRONG_TRIES` and `LOCK_SECONDS` at the top of `src/index.js`). The number of digits is `PIN_LENGTH` in the same place.
- **Existing participants** (added before PINs existed) have no PIN yet. They see "your organiser hasn't set a PIN" until you press **Set PIN** next to their name.

## Changing the favicon

The icon is `public/favicon.svg`, referenced in the `<head>` of `public/index.html`. To use another file type, update both the `href` and `type` attributes of the `<link rel="icon">` tag, then hard refresh (Ctrl+Shift+R).

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Cannot find module ... finetunes.js` during setup | The install is damaged. Delete `node_modules` and `package-lock.json`, run `npm cache clean --force`, then `npm install`. If it persists, use Node 22 LTS or move the project out of OneDrive/Desktop. |
| `Couldn't find a D1 DB with the name or binding 'santa'` | You are in the wrong folder. `cd` into the folder that contains `wrangler.toml`. |
| "Wrong admin password" | Check that `.dev.vars` is named exactly that (no `.example` or `.txt`), contains `ADMIN_KEY=...`, and that you restarted `npm start` after editing it. |
| Favicon still shows the old icon or 404 | Hard refresh, or open a private window. Browsers cache favicons heavily. |
| Friends can't open the link | The tunnel must still be running and the link must be the latest one printed. Your PC must be on and awake. |
| "No valid draw exists" | Your exclusions are too restrictive. Remove some and try again. |

## Security notes

- Participants sign in with a 4-digit PIN. That is a light lock for a group you trust, not strong security: a 4-digit PIN has only 10,000 possibilities, and the 60-second lock after 5 wrong tries only slows guessing down. Someone can also deliberately lock another person out for a minute by typing wrong PINs for them. Share the link only with people you trust, and give out PINs privately.
- The organiser password is stored in `.dev.vars` and sent as a request header, so keep the app on trusted networks or behind the HTTPS tunnel.
- Exclusions and assignments are only exposed through organiser-only or per-person endpoints, but anyone with access to the database files on your PC can read everything.
- `wrangler dev` is a development server. It is fine for a small group for a few weeks, not for public production use.

## Limitations

- Single event per installation. For a second group, copy the project to a new folder with its own database.
- No email notifications or reminders.
- Answers are plain text (up to 500 characters each).
