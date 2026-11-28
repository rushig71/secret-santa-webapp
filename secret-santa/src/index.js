// =====================================================================
// Secret Santa backend (Cloudflare Worker + D1 database)
//
// This one file does two jobs:
//   1. Answers every request that starts with /api/ (the app's data).
//   2. Hands every other request (the web page, images, fonts) to the
//      static files in the "public" folder.
// =====================================================================


// ---------------------------------------------------------------------
// Small helper functions
// ---------------------------------------------------------------------

// J = "JSON response". Wraps any data in an HTTP response with the right headers.
//   d = the data to send back, s = the HTTP status code (200 = OK by default).
//   "no-store" tells browsers never to cache API answers, so data is always fresh.
const J = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store'
  }
});

// bad = shortcut for sending an error message as JSON.
//   m = the message shown to the user, s = status code (400 = bad request by default),
//   code = optional short label the web page can react to (e.g. 'pin' = wrong or outdated PIN).
const bad = (m, s = 400, code) => J({ error: m, code }, s);

// shuffle = randomly reorders a list in place (Fisher-Yates shuffle) and returns it.
// Used by the draw so the result is random.
const shuffle = a => {
  for (let i = a.length - 1; i > 0; i--) {
    // Pick a random position from 0 up to i...
    const j = Math.floor(Math.random() * (i + 1));
    // ...and swap the two items.
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};


// ---------------------------------------------------------------------
// THE QUESTIONNAIRE  (edit the questions here)
//
// This is the ONE place where the questions live. The web page asks the
// server for this list, so changing a question here and redeploying is all
// you need to do. Rules of thumb:
//   * Fixing a typo or rewording a question: just edit the text. Existing
//     answers are kept and shown under the new wording.
//   * Adding a question: add it to the END of the list. Existing answers keep working.
//   * Removing or re-ordering questions: answers are saved by question NUMBER
//     (position in this list, starting at 0), so old answers would line up with the
//     wrong questions. Clear the answers first (see README) if you do that.
// ---------------------------------------------------------------------
const QUESTIONS = [
  'What is closest to your ideal saturday afternoon: curled up somewhere cosy / out exploring / making or creating something / out with people / treating yourself somewhere fancy',
  'You’ve got an unexpected free hour and a small budget in a market. Where do you drift to first? bookstalls and stationery / food and snack stalls / plants and home décor / quirky gadgets and gizmos / handmade crafts and trinkets',
  'What’s a small, unnecessary purchase that you can never really resist?',
  'What’s something you’ve fallen down a rabbit hole with lately? (a hobby, show, food, game, anything)',
  'If your personality had a little theme, would it be cosy, artsy, adventurous, bougie or chaotic?'
];


// ---------------------------------------------------------------------
// PINs (a light lock so people can't casually open each other's page)
//
// The organiser chooses everyone's starting PIN on the admin page. Participants
// send their PIN with every request (in the "x-pin" header) and can change it themselves.
// PINs are never stored as typed: only a salted SHA-256 hash is saved.
// This is a deterrent for a group you trust, not strong security: a 4-digit PIN
// has only 10,000 possibilities, so after a few wrong tries in a row the person is
// locked out for a minute.
// ---------------------------------------------------------------------
const PIN_LENGTH = 4;                                   // number of digits in a PIN
const PIN_RE = new RegExp('^\\d{' + PIN_LENGTH + '}$');  // "exactly PIN_LENGTH digits"
const MAX_WRONG_TRIES = 5;                              // wrong PINs in a row before a lock
const LOCK_SECONDS = 60;                                // how long the lock lasts

// Bytes -> hex text, a random salt, and the salted hash of a PIN.
const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const newSalt = () => toHex(crypto.getRandomValues(new Uint8Array(16)));
const hashPin = async (salt, pin) => toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin)));

// Saves (or replaces) a person's PIN and clears any wrong-try lock.
async function savePin(db, memberId, pin) {
  const salt = newSalt(), hash = await hashPin(salt, pin);
  await db.prepare(
    'INSERT INTO pins(member_id,salt,hash,fails,locked_until) VALUES(?,?,?,0,0) ' +
    'ON CONFLICT(member_id) DO UPDATE SET salt=excluded.salt, hash=excluded.hash, fails=0, locked_until=0'
  ).bind(memberId, salt, hash).run();
}

// Checks a person's PIN. Returns null when it is correct, otherwise a ready-made error
// response that the caller should send back as-is.
async function checkPin(db, memberId, pin) {
  pin = String(pin || '');

  const row = await db.prepare('SELECT salt,hash,fails,locked_until FROM pins WHERE member_id=?').bind(memberId).first();

  // No PIN saved for this person yet: the organiser still has to set one.
  if (!row) return bad('Your organiser hasn’t set a PIN for you yet.', 403, 'nopin');

  // Nothing typed at all: refuse without counting it as a wrong try.
  if (!pin) return bad('Enter your PIN.', 403, 'pin');

  // Temporarily locked after too many wrong tries (even the right PIN is refused until it ends).
  const now = Math.floor(Date.now() / 1000);
  if (row.locked_until > now) return bad('Too many wrong tries. Please wait ' + (row.locked_until - now) + ' seconds and try again.', 429, 'locked');

  // Correct PIN: forget any earlier wrong tries.
  if (await hashPin(row.salt, pin) === row.hash) {
    if (row.fails) await db.prepare('UPDATE pins SET fails=0 WHERE member_id=?').bind(memberId).run();
    return null;
  }

  // Wrong PIN: count it, and lock the person out for a bit once the limit is reached.
  const fails = row.fails + 1;
  if (fails >= MAX_WRONG_TRIES) await db.prepare('UPDATE pins SET fails=0, locked_until=? WHERE member_id=?').bind(now + LOCK_SECONDS, memberId).run();
  else await db.prepare('UPDATE pins SET fails=? WHERE member_id=?').bind(fails, memberId).run();
  return bad('That PIN doesn’t match.', 403, 'pin');
}


// ---------------------------------------------------------------------
// Settings stored in the database
// ---------------------------------------------------------------------

// Reads all rows of the "settings" table (event name, date, budget, whether
// the draw has happened) and turns them into one object.
async function getSettings(db) {
  const { results } = await db.prepare('SELECT key,value FROM settings').all();

  // Defaults used until the organiser saves something.
  // "drawn" is stored as text: '0' = not drawn yet, '1' = drawn.
  const s = { name: 'Secret Santa', date: '', budget: '', drawn: '0' };

  // Overwrite the defaults with whatever is saved in the database.
  for (const r of results) s[r.key] = r.value;

  return s;
}

// Builds (but does not run yet) a statement that saves one setting.
// "UPSERT": insert the row, or update it if that key already exists.
const setSetting = (db, k, v) => db.prepare(
  'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
).bind(k, String(v));


// ---------------------------------------------------------------------
// The draw algorithm
// ---------------------------------------------------------------------

// Random assignment where nobody draws themselves or an excluded person (backtracking).
//   ids = list of all participant ids
//   ban = set of "giver:receiver" pairs that are not allowed (the exclusions)
// Returns { giverId: receiverId, ... } or null if no valid draw exists.
function solve(ids, ban) {
  // Handle givers in random order; "used" = people already picked by someone;
  // "res" = the result being built.
  const order = shuffle([...ids]), used = new Set(), res = {};

  // Recursive helper: assign a receiver to the giver at position i.
  const go = i => {
    // Everyone has a receiver: success.
    if (i === order.length) return true;

    const g = order[i]; // the current giver

    // Candidate receivers, in random order: not the giver, not already taken,
    // and not excluded for this giver.
    for (const r of shuffle(ids.filter(x => x !== g && !used.has(x) && !ban.has(g + ':' + x)))) {
      used.add(r);   // try this receiver...
      res[g] = r;

      // ...and see if the remaining givers can still be matched.
      if (go(i + 1)) return true;

      // Dead end: undo this choice and try the next candidate (backtrack).
      used.delete(r);
    }

    // No candidate worked for this giver.
    return false;
  };

  // Start with the first giver; return the result, or null if impossible.
  return go(0) ? res : null;
}


// ---------------------------------------------------------------------
// The Worker itself: handles every incoming request
// ---------------------------------------------------------------------
export default {
  async fetch(req, env) {
    const u = new URL(req.url);

    // Anything that is not an /api/ call is a normal file request
    // (index.html, images...), so pass it to the static assets.
    if (!u.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

    // Break the URL path into parts. Example: /api/admin/members/5
    // gives p = ['admin', 'members', '5'].
    const p = u.pathname.slice(5).split('/').filter(Boolean),
          m = req.method,   // GET, POST, DELETE...
          db = env.DB;      // the D1 database

    // Read the JSON body for requests that send data. GET and DELETE have no body.
    // If the body is missing or invalid, use an empty object instead of crashing.
    const body = (m === 'GET' || m === 'DELETE') ? {} : await req.json().catch(() => ({}));

    try {

      // =============================================================
      // PARTICIPANT ENDPOINTS (no login needed)
      // =============================================================

      // GET /api/public -> event details, whether names are drawn, the questions, and the list of people.
      // Never includes exclusions or who drew whom.
      if (p[0] === 'public' && m === 'GET') {
        const s = await getSettings(db);
        const { results } = await db.prepare('SELECT id,name FROM members ORDER BY name').all();
        return J({
          settings: { name: s.name, date: s.date, budget: s.budget },
          drawn: s.drawn === '1',
          questions: QUESTIONS,
          pinLength: PIN_LENGTH,
          members: results
        });
      }

      // POST /api/login -> checks a person's PIN. Body: { memberId, pin }.
      if (p[0] === 'login' && m === 'POST') {
        const bounce = await checkPin(db, +body.memberId, body.pin);
        return bounce || J({ ok: true });
      }

      // POST /api/pin -> a participant changes their own PIN. Body: { memberId, newPin }.
      // Their current PIN is checked first (sent in the "x-pin" header like every other call).
      if (p[0] === 'pin' && m === 'POST') {
        const bounce = await checkPin(db, +body.memberId, req.headers.get('x-pin'));
        if (bounce) return bounce;
        if (!PIN_RE.test(String(body.newPin || ''))) return bad('PIN must be exactly ' + PIN_LENGTH + ' digits.');
        await savePin(db, +body.memberId, String(body.newPin));
        return J({ ok: true });
      }

      // GET /api/assignment/<id> -> who person <id> drew, plus that person's questionnaire answers.
      if (p[0] === 'assignment' && m === 'GET') {
        // Only the person themselves (with their PIN) may see who they drew.
        const bounce = await checkPin(db, +p[1], req.headers.get('x-pin'));
        if (bounce) return bounce;

        // Look up the person asking and who they drew.
        const me = await db.prepare('SELECT drawn_id FROM members WHERE id=?').bind(+p[1]).first();

        // Unknown person, or the draw hasn't happened yet.
        if (!me || !me.drawn_id) return bad('Names have not been drawn yet.', 404);

        // Get the drawn person's name...
        const t = await db.prepare('SELECT id,name FROM members WHERE id=?').bind(me.drawn_id).first();

        // ...and their saved answers.
        const { results } = await db.prepare('SELECT q,answer FROM answers WHERE member_id=? ORDER BY q').bind(t.id).all();

        // Send each answer together with its question text. Answers whose question number
        // no longer exists in QUESTIONS (e.g. if the list was shortened later) are skipped.
        return J({
          name: t.name,
          answers: results.filter(r => QUESTIONS[r.q]).map(r => ({ question: QUESTIONS[r.q], answer: r.answer }))
        });
      }

      // Questionnaire answer endpoints: /api/answers/...
      if (p[0] === 'answers') {

        // GET /api/answers/<memberId> -> that person's saved answers, as [{ q, answer }, ...].
        // "q" is the question number (its position in QUESTIONS, starting at 0).
        if (m === 'GET') {
          // PIN needed: these are your own answers.
          const bounce = await checkPin(db, +p[1], req.headers.get('x-pin'));
          if (bounce) return bounce;

          const { results } = await db.prepare('SELECT q,answer FROM answers WHERE member_id=? ORDER BY q').bind(+p[1]).all();
          return J(results);
        }

        // POST /api/answers -> save ALL of one person's answers at once.
        // The body looks like { memberId: 3, answers: [text for question 0, text for question 1, ...] }.
        if (m === 'POST') {
          const memberId = +body.memberId;

          // PIN needed: only you may change your own answers.
          const bounce = await checkPin(db, memberId, req.headers.get('x-pin'));
          if (bounce) return bounce;

          // The person must exist.
          const known = await db.prepare('SELECT id FROM members WHERE id=?').bind(memberId).first();
          if (!known) return bad('Unknown person.');

          const given = Array.isArray(body.answers) ? body.answers : [];

          // Keep only the non-empty answers (trimmed, capped at 500 characters),
          // numbered by question. Empty boxes simply mean "no answer".
          const rows = QUESTIONS
            .map((_, q) => ({ q, text: String(given[q] || '').trim().slice(0, 500) }))
            .filter(r => r.text);

          // Replace the person's old answers with the new ones, all in one batch.
          await db.batch([
            db.prepare('DELETE FROM answers WHERE member_id=?').bind(memberId),
            ...rows.map(r => db.prepare('INSERT INTO answers(member_id,q,answer) VALUES(?,?,?)').bind(memberId, r.q, r.text))
          ]);
          return J({ ok: true });
        }
      }

      // =============================================================
      // ORGANISER ENDPOINTS (need the admin password)
      // =============================================================
      if (p[0] === 'admin') {

        // Every admin call must send the right password in the "x-admin-key" header.
        // The real password is the ADMIN_KEY secret set on the server.
        if (!env.ADMIN_KEY || req.headers.get('x-admin-key') !== env.ADMIN_KEY) return bad('Wrong admin password.', 401);

        const s = await getSettings(db),
              drawn = s.drawn === '1';   // true once names have been drawn
        const sub = p[1];                // which admin action, e.g. 'members', 'draw'

        // GET /api/admin -> everything the organiser page needs, including exclusions.
        if (!sub && m === 'GET') {
          // hasPin = whether the organiser has set a PIN for that person yet (the PIN itself is never sent).
          const mem = (await db.prepare('SELECT m.id, m.name, (p.member_id IS NOT NULL) AS hasPin FROM members m LEFT JOIN pins p ON p.member_id = m.id ORDER BY m.name').all()).results;
          const ex = (await db.prepare('SELECT giver,receiver FROM exclusions').all()).results;
          return J({ settings: s, drawn, pinLength: PIN_LENGTH, members: mem, exclusions: ex });
        }

        // POST /api/admin/settings -> save event name, date and budget (all three at once).
        if (sub === 'settings' && m === 'POST') {
          await db.batch([
            setSetting(db, 'name', String(body.name || 'Secret Santa').slice(0, 100)),
            setSetting(db, 'date', String(body.date || '').slice(0, 50)),
            setSetting(db, 'budget', String(body.budget || '').slice(0, 50))
          ]);
          return J({ ok: true });
        }

        // POST /api/admin/members -> add a participant together with their starting PIN. Body: { name, pin }.
        if (sub === 'members' && m === 'POST') {
          // Changing the group after the draw would break it, so block that.
          if (drawn) return bad('Reset the draw before changing participants.');

          const name = String(body.name || '').trim().slice(0, 60);
          if (!name) return bad('Enter a name.');

          // The organiser must choose a starting PIN for the person.
          const pin = String(body.pin || '');
          if (!PIN_RE.test(pin)) return bad('Choose a PIN of exactly ' + PIN_LENGTH + ' digits for this person.');
          const salt = newSalt(), hash = await hashPin(salt, pin);

          // Add the person and their PIN together (all or nothing).
          // The database requires unique names, so a duplicate makes the insert fail.
          try {
            await db.batch([
              db.prepare('INSERT INTO members(name) VALUES(?)').bind(name),
              db.prepare('INSERT INTO pins(member_id,salt,hash) SELECT id,?,? FROM members WHERE name=?').bind(salt, hash, name)
            ]);
          }
          catch { return bad('That name is already in the group.'); }

          return J({ ok: true });
        }

        // DELETE /api/admin/members/<id> -> remove a participant.
        if (sub === 'members' && m === 'DELETE') {
          if (drawn) return bad('Reset the draw before changing participants.');

          const id = +p[2];

          // Remove the person, their answers, their PIN, and any exclusions involving them, in one go.
          await db.batch([
            db.prepare('DELETE FROM members WHERE id=?').bind(id),
            db.prepare('DELETE FROM answers WHERE member_id=?').bind(id),
            db.prepare('DELETE FROM pins WHERE member_id=?').bind(id),
            db.prepare('DELETE FROM exclusions WHERE giver=? OR receiver=?').bind(id, id)
          ]);
          return J({ ok: true });
        }

        // POST /api/admin/pin -> set or reset a participant's PIN to a value YOU choose.
        // Body: { memberId, pin }. Also clears any "too many wrong tries" lock. Works any time.
        if (sub === 'pin' && m === 'POST') {
          if (!PIN_RE.test(String(body.pin || ''))) return bad('Choose a PIN of exactly ' + PIN_LENGTH + ' digits.');
          const known = await db.prepare('SELECT id FROM members WHERE id=?').bind(+body.memberId).first();
          if (!known) return bad('Unknown person.');
          await savePin(db, +body.memberId, String(body.pin));
          return J({ ok: true });
        }

        // POST /api/admin/exclusions -> add a "giver cannot draw receiver" rule.
        if (sub === 'exclusions' && m === 'POST') {
          const g = +body.giver, r = +body.receiver;

          // Both people are required and must be different.
          if (!g || !r || g === r) return bad('Pick two different people.');

          // Add the rule (ignore it if it already exists).
          const st = [db.prepare('INSERT OR IGNORE INTO exclusions VALUES(?,?)').bind(g, r)];

          // "Both ways" also adds the reverse rule (receiver cannot draw giver).
          if (body.both) st.push(db.prepare('INSERT OR IGNORE INTO exclusions VALUES(?,?)').bind(r, g));

          await db.batch(st);
          return J({ ok: true });
        }

        // DELETE /api/admin/exclusions/<giver>/<receiver> -> remove one rule.
        if (sub === 'exclusions' && m === 'DELETE') {
          await db.prepare('DELETE FROM exclusions WHERE giver=? AND receiver=?').bind(+p[2], +p[3]).run();
          return J({ ok: true });
        }

        // POST /api/admin/draw -> run the draw once and save the result.
        if (sub === 'draw' && m === 'POST') {
          // The draw is locked after it runs.
          if (drawn) return bad('Names are already drawn. Reset first if you want to redo it.');

          // All participant ids.
          const ids = (await db.prepare('SELECT id FROM members').all()).results.map(r => r.id);

          // Minimum group size rule: at least 2 people, otherwise someone would have to draw themselves.
          if (ids.length < 2) return bad('Add at least 2 participants so nobody draws themselves.');

          // Turn the exclusions into a set of "giver:receiver" strings for fast lookup.
          const ban = new Set((await db.prepare('SELECT giver,receiver FROM exclusions').all()).results.map(r => r.giver + ':' + r.receiver));

          // Try to find a valid assignment.
          const res = solve(ids, ban);
          if (!res) return bad('No valid draw exists with these exclusions. Remove some and try again.');

          // Save every assignment and mark the draw as done, all in one batch.
          await db.batch([
            ...ids.map(id => db.prepare('UPDATE members SET drawn_id=? WHERE id=?').bind(res[id], id)),
            setSetting(db, 'drawn', 1)
          ]);
          return J({ ok: true });
        }

        // POST /api/admin/reset -> erase the draw so it can be redone.
        if (sub === 'reset' && m === 'POST') {
          await db.batch([
            db.prepare('UPDATE members SET drawn_id=NULL'),
            setSetting(db, 'drawn', 0)
          ]);
          return J({ ok: true });
        }
      }

      // Nothing above matched this request.
      return bad('Not found', 404);

    } catch (e) {
      // Any unexpected error becomes a 500 response with its message.
      return bad(e.message, 500);
    }
  }
};
