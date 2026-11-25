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
//   m = the message shown to the user, s = status code (400 = bad request by default).
const bad = (m, s = 400) => J({ error: m }, s);

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

      // GET /api/public -> event details, whether names are drawn, and the list of people.
      // Never includes exclusions or who drew whom.
      if (p[0] === 'public' && m === 'GET') {
        const s = await getSettings(db);
        const { results } = await db.prepare('SELECT id,name FROM members ORDER BY name').all();
        return J({
          settings: { name: s.name, date: s.date, budget: s.budget },
          drawn: s.drawn === '1',
          members: results
        });
      }

      // GET /api/assignment/<id> -> who person <id> drew, plus that person's wish list.
      if (p[0] === 'assignment' && m === 'GET') {
        // Look up the person asking and who they drew.
        const me = await db.prepare('SELECT drawn_id FROM members WHERE id=?').bind(+p[1]).first();

        // Unknown person, or the draw hasn't happened yet.
        if (!me || !me.drawn_id) return bad('Names have not been drawn yet.', 404);

        // Get the drawn person's name...
        const t = await db.prepare('SELECT id,name FROM members WHERE id=?').bind(me.drawn_id).first();

        // ...and their wish list.
        const { results } = await db.prepare('SELECT id,title,url FROM wishes WHERE member_id=? ORDER BY id').bind(t.id).all();

        return J({ name: t.name, wishes: results });
      }

      // Wish list endpoints: /api/wishes/...
      if (p[0] === 'wishes') {

        // GET /api/wishes/<memberId> -> that person's wish list.
        if (m === 'GET') {
          const { results } = await db.prepare('SELECT id,title,url FROM wishes WHERE member_id=? ORDER BY id').bind(+p[1]).all();
          return J(results);
        }

        // POST /api/wishes -> add a gift idea to someone's list.
        if (m === 'POST') {
          // Clean the inputs: text only, trimmed, and capped in length.
          const title = String(body.title || '').trim().slice(0, 200),
                url = String(body.url || '').trim().slice(0, 1000);

          // A title is required.
          if (!title) return bad('Add a title for the gift.');

          // A link is optional, but if given it must be a normal web link.
          if (url && !/^https?:\/\//i.test(url)) return bad('Links must start with http:// or https://');

          // Limit each wish list to 20 gifts.
          const c = await db.prepare('SELECT COUNT(*) n FROM wishes WHERE member_id=?').bind(+body.memberId).first();
          if (c.n >= 20) return bad('Wish lists are limited to 20 gifts.');

          // Save it (store an empty link as NULL).
          await db.prepare('INSERT INTO wishes(member_id,title,url) VALUES(?,?,?)').bind(+body.memberId, title, url || null).run();
          return J({ ok: true });
        }

        // DELETE /api/wishes/<wishId>?member=<memberId> -> remove a gift idea.
        // The member id must match, so you can only delete items from the list you named.
        if (m === 'DELETE') {
          await db.prepare('DELETE FROM wishes WHERE id=? AND member_id=?').bind(+p[1], +u.searchParams.get('member')).run();
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
          const mem = (await db.prepare('SELECT id,name FROM members ORDER BY name').all()).results;
          const ex = (await db.prepare('SELECT giver,receiver FROM exclusions').all()).results;
          return J({ settings: s, drawn, members: mem, exclusions: ex });
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

        // POST /api/admin/members -> add a participant.
        if (sub === 'members' && m === 'POST') {
          // Changing the group after the draw would break it, so block that.
          if (drawn) return bad('Reset the draw before changing participants.');

          const name = String(body.name || '').trim().slice(0, 60);
          if (!name) return bad('Enter a name.');

          // The database requires unique names, so a duplicate makes the insert fail.
          try { await db.prepare('INSERT INTO members(name) VALUES(?)').bind(name).run(); }
          catch { return bad('That name is already in the group.'); }

          return J({ ok: true });
        }

        // DELETE /api/admin/members/<id> -> remove a participant.
        if (sub === 'members' && m === 'DELETE') {
          if (drawn) return bad('Reset the draw before changing participants.');

          const id = +p[2];

          // Remove the person, their wishes, and any exclusions involving them, in one go.
          await db.batch([
            db.prepare('DELETE FROM members WHERE id=?').bind(id),
            db.prepare('DELETE FROM wishes WHERE member_id=?').bind(id),
            db.prepare('DELETE FROM exclusions WHERE giver=? OR receiver=?').bind(id, id)
          ]);
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
