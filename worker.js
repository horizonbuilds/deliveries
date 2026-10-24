// deliveries-tracker Worker. KV key "data" holds {schemaVersion, shipments[], checkedAt}.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-lock",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-max-age": "86400",
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const nowIso = () => new Date().toISOString();
async function load(env) {
  const d = await env.DELIVERIES.get("data", "json");
  return d || { schemaVersion: 1, shipments: [], checkedAt: null };
}
const save = (env, d) => env.DELIVERIES.put("data", JSON.stringify(d));
const isWriter = (req, env) => env.WRITE_TOKEN && req.headers.get("authorization") === "Bearer " + env.WRITE_TOKEN;
function merge(t, p) { // deep merge; null deletes key; arrays replace
  for (const k of Object.keys(p)) {
    if (p[k] === null) delete t[k];
    else if (typeof p[k] === "object" && !Array.isArray(p[k]) && typeof t[k] === "object" && t[k] && !Array.isArray(t[k])) merge(t[k], p[k]);
    else t[k] = p[k];
  }
  return t;
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/api/deliveries" && req.method === "GET") {
      // Optional page lock: set secret LOCK_PASSWORD to require header x-lock. Unset = open.
      if (env.LOCK_PASSWORD && req.headers.get("x-lock") !== env.LOCK_PASSWORD && !isWriter(req, env)) return json({ error: "locked" }, 401);
      const d = await load(env);
      return json({ ...d, serverTime: nowIso() });
    }
    if (path.startsWith("/api/") && req.method !== "GET") {
      if (!isWriter(req, env)) return json({ error: "unauthorized" }, 401);
      const d = await load(env);
      let body = {};
      try { body = await req.json(); } catch (e) {}
      const m = path.match(/^\/api\/shipments\/([\w.-]+)$/);
      if (path === "/api/shipments" && req.method === "POST") { // upsert full shipment
        if (!body.id) return json({ error: "id required" }, 400);
        const i = d.shipments.findIndex(s => s.id === body.id);
        body.updatedAt = body.updatedAt || nowIso();
        if (i >= 0) d.shipments[i] = body; else d.shipments.push(body);
        d.checkedAt = nowIso(); await save(env, d); return json({ ok: true, shipment: body });
      }
      if (m && req.method === "PATCH") { // partial merge, bumps updatedAt + lastCheckedAt
        const s = d.shipments.find(x => x.id === m[1]);
        if (!s) return json({ error: "not found" }, 404);
        merge(s, body); s.updatedAt = body.updatedAt || nowIso(); s.lastCheckedAt = body.lastCheckedAt || s.updatedAt;
        d.checkedAt = s.updatedAt; await save(env, d); return json({ ok: true, shipment: s });
      }
      if (m && req.method === "DELETE") {
        d.shipments = d.shipments.filter(x => x.id !== m[1]); await save(env, d); return json({ ok: true });
      }
      const t = path.match(/^\/api\/touch(?:\/([\w.-]+))?$/);
      if (t && req.method === "POST") { // "I checked, nothing changed" - bumps lastCheckedAt only
        const ts = nowIso();
        for (const s of d.shipments) if (!t[1] || s.id === t[1]) s.lastCheckedAt = ts;
        d.checkedAt = ts; await save(env, d); return json({ ok: true, checkedAt: ts });
      }
      return json({ error: "bad route" }, 404);
    }
    return json({ service: "deliveries-tracker", ok: true });
  },
};
