const J = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const bad = (m, s = 400) => J({ error: m }, s);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

async function getSettings(db) {
  const { results } = await db.prepare('SELECT key,value FROM settings').all();
  const s = { name: 'Secret Santa', date: '', budget: '', drawn: '0' };
  for (const r of results) s[r.key] = r.value;
  return s;
}
const setSetting = (db, k, v) => db.prepare(
  'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k, String(v));

// Random assignment where nobody draws themselves or an excluded person (backtracking).
function solve(ids, ban) {
  const order = shuffle([...ids]), used = new Set(), res = {};
  const go = i => {
    if (i === order.length) return true;
    const g = order[i];
    for (const r of shuffle(ids.filter(x => x !== g && !used.has(x) && !ban.has(g + ':' + x)))) {
      used.add(r); res[g] = r;
      if (go(i + 1)) return true;
      used.delete(r);
    }
    return false;
  };
  return go(0) ? res : null;
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (!u.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    const p = u.pathname.slice(5).split('/').filter(Boolean), m = req.method, db = env.DB;
    const body = (m === 'GET' || m === 'DELETE') ? {} : await req.json().catch(() => ({}));
    try {
      // ---------- Participant endpoints (no login) ----------
      if (p[0] === 'public' && m === 'GET') {
        const s = await getSettings(db);
        const { results } = await db.prepare('SELECT id,name FROM members ORDER BY name').all();
        return J({ settings: { name: s.name, date: s.date, budget: s.budget }, drawn: s.drawn === '1', members: results });
      }
      if (p[0] === 'assignment' && m === 'GET') {
        const me = await db.prepare('SELECT drawn_id FROM members WHERE id=?').bind(+p[1]).first();
        if (!me || !me.drawn_id) return bad('Names have not been drawn yet.', 404);
        const t = await db.prepare('SELECT id,name FROM members WHERE id=?').bind(me.drawn_id).first();
        const { results } = await db.prepare('SELECT id,title,url FROM wishes WHERE member_id=? ORDER BY id').bind(t.id).all();
        return J({ name: t.name, wishes: results });
      }
      if (p[0] === 'wishes') {
        if (m === 'GET') {
          const { results } = await db.prepare('SELECT id,title,url FROM wishes WHERE member_id=? ORDER BY id').bind(+p[1]).all();
          return J(results);
        }
        if (m === 'POST') {
          const title = String(body.title || '').trim().slice(0, 200), url = String(body.url || '').trim().slice(0, 1000);
          if (!title) return bad('Add a title for the gift.');
          if (url && !/^https?:\/\//i.test(url)) return bad('Links must start with http:// or https://');
          const c = await db.prepare('SELECT COUNT(*) n FROM wishes WHERE member_id=?').bind(+body.memberId).first();
          if (c.n >= 20) return bad('Wish lists are limited to 20 gifts.');
          await db.prepare('INSERT INTO wishes(member_id,title,url) VALUES(?,?,?)').bind(+body.memberId, title, url || null).run();
          return J({ ok: true });
        }
        if (m === 'DELETE') {
          await db.prepare('DELETE FROM wishes WHERE id=? AND member_id=?').bind(+p[1], +u.searchParams.get('member')).run();
          return J({ ok: true });
        }
      }

      // ---------- Organiser endpoints (admin key) ----------
      if (p[0] === 'admin') {
        if (!env.ADMIN_KEY || req.headers.get('x-admin-key') !== env.ADMIN_KEY) return bad('Wrong admin password.', 401);
        const s = await getSettings(db), drawn = s.drawn === '1';
        const sub = p[1];
        if (!sub && m === 'GET') {
          const mem = (await db.prepare('SELECT id,name FROM members ORDER BY name').all()).results;
          const ex = (await db.prepare('SELECT giver,receiver FROM exclusions').all()).results;
          return J({ settings: s, drawn, members: mem, exclusions: ex });
        }
        if (sub === 'settings' && m === 'POST') {
          await db.batch([setSetting(db, 'name', String(body.name || 'Secret Santa').slice(0, 100)),
            setSetting(db, 'date', String(body.date || '').slice(0, 50)), setSetting(db, 'budget', String(body.budget || '').slice(0, 50))]);
          return J({ ok: true });
        }
        if (sub === 'members' && m === 'POST') {
          if (drawn) return bad('Reset the draw before changing participants.');
          const name = String(body.name || '').trim().slice(0, 60);
          if (!name) return bad('Enter a name.');
          try { await db.prepare('INSERT INTO members(name) VALUES(?)').bind(name).run(); }
          catch { return bad('That name is already in the group.'); }
          return J({ ok: true });
        }
        if (sub === 'members' && m === 'DELETE') {
          if (drawn) return bad('Reset the draw before changing participants.');
          const id = +p[2];
          await db.batch([db.prepare('DELETE FROM members WHERE id=?').bind(id), db.prepare('DELETE FROM wishes WHERE member_id=?').bind(id),
            db.prepare('DELETE FROM exclusions WHERE giver=? OR receiver=?').bind(id, id)]);
          return J({ ok: true });
        }
        if (sub === 'exclusions' && m === 'POST') {
          const g = +body.giver, r = +body.receiver;
          if (!g || !r || g === r) return bad('Pick two different people.');
          const st = [db.prepare('INSERT OR IGNORE INTO exclusions VALUES(?,?)').bind(g, r)];
          if (body.both) st.push(db.prepare('INSERT OR IGNORE INTO exclusions VALUES(?,?)').bind(r, g));
          await db.batch(st);
          return J({ ok: true });
        }
        if (sub === 'exclusions' && m === 'DELETE') {
          await db.prepare('DELETE FROM exclusions WHERE giver=? AND receiver=?').bind(+p[2], +p[3]).run();
          return J({ ok: true });
        }
        if (sub === 'draw' && m === 'POST') {
          if (drawn) return bad('Names are already drawn. Reset first if you want to redo it.');
          const ids = (await db.prepare('SELECT id FROM members').all()).results.map(r => r.id);
          if (ids.length < 2) return bad('Add at least 2 participants so nobody draws themselves.');
          const ban = new Set((await db.prepare('SELECT giver,receiver FROM exclusions').all()).results.map(r => r.giver + ':' + r.receiver));
          const res = solve(ids, ban);
          if (!res) return bad('No valid draw exists with these exclusions. Remove some and try again.');
          await db.batch([...ids.map(id => db.prepare('UPDATE members SET drawn_id=? WHERE id=?').bind(res[id], id)), setSetting(db, 'drawn', 1)]);
          return J({ ok: true });
        }
        if (sub === 'reset' && m === 'POST') {
          await db.batch([db.prepare('UPDATE members SET drawn_id=NULL'), setSetting(db, 'drawn', 0)]);
          return J({ ok: true });
        }
      }
      return bad('Not found', 404);
    } catch (e) { return bad(e.message, 500); }
  }
};
