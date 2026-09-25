export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const KV = env.ANIME_KV || env.ANIME_CACHE;
    const BACKEND = "https://mk-anmov31-12-2025.onrender.com";

    // ═══════════════════════════════════════════════════════
    // 🔍 TEST / HEALTH
    // ═══════════════════════════════════════════════════════
    if (url.pathname === "/test") {
      return new Response(JSON.stringify({
        status: "ok",
        hasKV: !!KV,
        kvName: env.ANIME_KV ? "ANIME_KV" : (env.ANIME_CACHE ? "ANIME_CACHE" : "none"),
        timestamp: new Date().toISOString()
      }), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    // ═══════════════════════════════════════════════════════
    // ⚡ ANİME CACHE INVALIDATE (tek item)
    // ═══════════════════════════════════════════════════════
    if (url.pathname === "/api/anime/invalidate" && request.method === "POST") {
      if (!KV) {
        return new Response(JSON.stringify({ ok: false, error: "no_kv" }), {
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }
      try {
        const body = await request.json();
        const { id, ep, mode, season, type } = body || {};
        if (!id || !ep) {
          return new Response(JSON.stringify({ ok: false, error: "missing_id_ep" }), {
            headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const m = mode || "sub";
        const s = season || "1";
        const streamKey = "stream_" + id + "_" + ep + "_" + m + "_" + s;
        const subKey = "subtitle_" + id + "_" + ep + "_" + m + "_" + s;

        const deleted = [];
        if (type === "stream" || !type) {
          await KV.delete(streamKey);
          deleted.push(streamKey);
        }
        if (type === "subtitle" || !type) {
          await KV.delete(subKey);
          deleted.push(subKey);
        }

        console.log("🗑️ KV invalidate: " + deleted.join(", "));
        return new Response(JSON.stringify({ ok: true, deleted }), {
          headers: { ...cors, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          status: 500,
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }
    }

    // ═══════════════════════════════════════════════════════
    // 💬 DM CACHE — Mesaj listesi cache (5 dk TTL)
    // ═══════════════════════════════════════════════════════
    if (url.pathname === "/api/dm-cache") {
      const sender = url.searchParams.get("sender");
      const receiver = url.searchParams.get("receiver");
      const action = url.searchParams.get("action");

      if (!sender || !receiver) {
        return new Response(JSON.stringify({ error: "missing_params" }), {
          status: 400, headers: { ...cors, "Content-Type": "application/json" }
        });
      }

      const pairKey = [sender, receiver].sort().join("__");
      const cacheKey = "dm_" + pairKey;

      // ⚡ action=set değilse cache'ten oku
      if (action !== "set" && KV) {
        try {
          const cached = await KV.get(cacheKey);
          if (cached) {
            return new Response(cached, {
              headers: {
                ...cors,
                "Content-Type": "application/json",
                "X-Cache": "HIT"
              }
            });
          }
        } catch (e) {}
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);
        const backendRes = await fetch(
          BACKEND + "/api/dm-messages?sender=" + encodeURIComponent(sender) + "&receiver=" + encodeURIComponent(receiver),
          { signal: controller.signal }
        );
        clearTimeout(timeoutId);
        const data = await backendRes.text();

        // ⚡ action=set değilse cache'e yaz
        if (action !== "set" && backendRes.ok && KV) {
          try {
            await KV.put(cacheKey, data, { expirationTtl: 300 });
          } catch (e) {}
        }

        return new Response(data, {
          status: backendRes.status,
          headers: {
            ...cors,
            "Content-Type": "application/json",
            "X-Cache": "MISS"
          }
        });
      } catch (e) {
        const errorMsg = e.name === "AbortError"
          ? { error: "backend_timeout", message: "Backend yanit vermedi." }
          : { error: "backend_failed", message: e.message };
        return new Response(JSON.stringify(errorMsg), {
          status: 504,
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }
    }

    // ═══════════════════════════════════════════════════════
    // 💬 DM CACHE INVALIDATE — Yeni mesaj atılınca çağrılır
    // ═══════════════════════════════════════════════════════
    if (url.pathname === "/api/dm-cache-invalidate") {
      const sender = url.searchParams.get("sender");
      const receiver = url.searchParams.get("receiver");

      if (!sender || !receiver) {
        return new Response(JSON.stringify({ error: "missing_params" }), {
          status: 400, headers: { ...cors, "Content-Type": "application/json" }
        });
      }

      const pairKey = [sender, receiver].sort().join("__");
      if (KV) {
        try {
          await KV.delete("dm_" + pairKey);
        } catch (e) {}
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    // ═══════════════════════════════════════════════════════
    // 💬 DM CACHE — TÜMÜNÜ TEMİZLE
    // ═══════════════════════════════════════════════════════
    if (url.pathname === "/api/dm-cache-invalidate-all" && request.method === "POST") {
      if (!KV) {
        return new Response(JSON.stringify({ ok: false, error: "no_kv" }), {
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }
      try {
        let deleted = 0;
        let cursor = undefined;
        do {
          const list = await KV.list({ prefix: "dm_", cursor });
          for (const key of list.keys) {
            await KV.delete(key.name);
            deleted++;
          }
          cursor = list.cursor;
        } while (cursor);

        return new Response(JSON.stringify({ ok: true, deleted }), {
          headers: { ...cors, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          status: 500, headers: { ...cors, "Content-Type": "application/json" }
        });
      }
    }

    // ═══════════════════════════════════════════════════════
    // 🎬 ANİME STREAM
    // ═══════════════════════════════════════════════════════
    if (url.pathname === "/api/anime/stream") {
      const animeId = url.searchParams.get("id");
      const ep = url.searchParams.get("ep");
      const mode = url.searchParams.get("mode") || "sub";
      const season = url.searchParams.get("season") || "1";
      const nocache = url.searchParams.get("nocache");
      const title = url.searchParams.get("title");

      if (!animeId || !ep) {
        return new Response(JSON.stringify({ error: "missing_params" }), {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }

      const subKey = "subtitle_" + animeId + "_" + ep + "_" + mode + "_" + season;

      // ⚡ Arka planda altyazı çek (varsa)
      if (KV && title && ctx) {
        ctx.waitUntil((async () => {
          try {
            const existing = await KV.get(subKey);
            if (existing) return;

            console.log("🎬 Subtitle bg-fetch başlıyor: " + subKey);
            const subUrl = BACKEND + "/api/anime/subtitle?id=" + animeId + "&ep=" + ep + "&mode=" + mode + "&season=" + season + "&lang=tr&title=" + encodeURIComponent(title);
            const subRes = await fetch(subUrl);
            const text = await subRes.text();
            if (subRes.ok && text.indexOf("WEBVTT") !== -1) {
              await KV.put(subKey, text, { expirationTtl: 604800 });
              console.log("💾 Subtitle KV saved: " + subKey);
            }
          } catch (e) {
            console.error("Subtitle bg-fetch error: " + e.message);
          }
        })());
      }

      const cacheKey = "stream_" + animeId + "_" + ep + "_" + mode + "_" + season;

      // ⚡ Cache'ten oku (nocache=1 değilse)
      if (nocache !== "1" && KV) {
        try {
          const cached = await KV.get(cacheKey);
          if (cached) {
            return new Response(cached, {
              headers: { ...cors, "Content-Type": "application/json", "X-Cache": "HIT" }
            });
          }
        } catch (e) {}
      }

      try {
        const controller = new AbortController();
        // ⚡ Backend 110s timeout kullanıyor, o yüzden worker 115s bekleyecek
        const timeoutId = setTimeout(() => controller.abort(), 115000);
        const backendRes = await fetch(BACKEND + url.pathname + url.search, {
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        const data = await backendRes.text();

        // ⚡ nocache=1 değilse ve başarılıysa cache'e yaz
        if (nocache !== "1" && backendRes.ok && KV) {
          try {
            const parsed = JSON.parse(data);
            if (parsed.url && !parsed.error) {
              await KV.put(cacheKey, data, { expirationTtl: 604800 });
            }
          } catch (e) {}
        }

        return new Response(data, {
          status: backendRes.status,
          headers: { ...cors, "Content-Type": "application/json", "X-Cache": "MISS" }
        });
      } catch (e) {
        const errorMsg = e.name === "AbortError"
          ? { error: "backend_timeout", message: "Backend yanit vermedi." }
          : { error: "backend_failed", message: e.message };
        return new Response(JSON.stringify(errorMsg), {
          status: 504,
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }
    }

    // ═══════════════════════════════════════════════════════
    // 📝 ANİME SUBTITLE
    // ═══════════════════════════════════════════════════════
    if (url.pathname === "/api/anime/subtitle") {
      const animeId = url.searchParams.get("id");
      const ep = url.searchParams.get("ep");
      const mode = url.searchParams.get("mode") || "sub";
      const season = url.searchParams.get("season") || "1";

      if (!animeId || !ep) {
        return new Response("id ve ep gerekli", { status: 400 });
      }

      const subKey = "subtitle_" + animeId + "_" + ep + "_" + mode + "_" + season;

      if (KV) {
        try {
          const cached = await KV.get(subKey);
          if (cached) {
            return new Response(cached, {
              headers: {
                ...cors,
                "Content-Type": "text/vtt; charset=utf-8",
                "X-Cache": "HIT"
              }
            });
          }
        } catch (e) {}
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 40000);
        const backendRes = await fetch(BACKEND + url.pathname + url.search, {
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        const text = await backendRes.text();
        if (backendRes.ok && text.indexOf("WEBVTT") !== -1 && KV) {
          try {
            await KV.put(subKey, text, { expirationTtl: 604800 });
            console.log("💾 Subtitle KV saved (direct): " + subKey);
          } catch (e) {}
        }
        return new Response(text, {
          status: backendRes.status,
          headers: {
            ...cors,
            "Content-Type": "text/vtt; charset=utf-8",
            "X-Cache": "MISS"
          }
        });
      } catch (e) {
        return new Response("altyazi yok", { status: 404 });
      }
    }

    // ═══════════════════════════════════════════════════════
    // 📊 SUBTITLE STATUS
    // ═══════════════════════════════════════════════════════
    if (url.pathname === "/api/anime/subtitle-status") {
      const animeId = url.searchParams.get("id");
      const ep = url.searchParams.get("ep");
      const mode = url.searchParams.get("mode") || "sub";
      const season = url.searchParams.get("season") || "1";

      const subKey = "subtitle_" + animeId + "_" + ep + "_" + mode + "_" + season;

      if (KV) {
        try {
          const cached = await KV.get(subKey);
          if (cached) {
            return new Response(JSON.stringify({ ready: true, cached: true }), {
              headers: { ...cors, "Content-Type": "application/json" }
            });
          }
        } catch (e) {}
      }

      return new Response(JSON.stringify({ ready: false, cached: false }), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    // ═══════════════════════════════════════════════════════
    // ⚡ PREFETCH SUBTITLE
    // ═══════════════════════════════════════════════════════
    if (url.pathname === "/api/anime/prefetch-subtitle") {
      const animeId = url.searchParams.get("id");
      const ep = url.searchParams.get("ep");
      const mode = url.searchParams.get("mode") || "sub";
      const season = url.searchParams.get("season") || "1";
      const title = url.searchParams.get("title");

      const subKey = "subtitle_" + animeId + "_" + ep + "_" + mode + "_" + season;

      if (KV && title && ctx) {
        ctx.waitUntil((async () => {
          try {
            const existing = await KV.get(subKey);
            if (existing) return;
            const subUrl = BACKEND + "/api/anime/subtitle?id=" + animeId + "&ep=" + ep + "&mode=" + mode + "&season=" + season + "&lang=tr&title=" + encodeURIComponent(title);
            const subRes = await fetch(subUrl);
            const text = await subRes.text();
            if (subRes.ok && text.indexOf("WEBVTT") !== -1) {
              await KV.put(subKey, text, { expirationTtl: 604800 });
            }
          } catch (e) {}
        })());
      }

      return new Response(JSON.stringify({ status: "queued" }), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    // ═══════════════════════════════════════════════════════
    // 🔄 DİĞER /api/anime/* → Render proxy
    // ═══════════════════════════════════════════════════════
    if (url.pathname.startsWith("/api/anime/")) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 115000);
        const backendRes = await fetch(BACKEND + url.pathname + url.search, {
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        const data = await backendRes.text();
        return new Response(data, {
          status: backendRes.status,
          headers: { ...cors, "Content-Type": backendRes.headers.get("Content-Type") || "application/json" }
        });
      } catch (e) {
        const errorMsg = e.name === "AbortError"
          ? { error: "backend_timeout", message: "Backend yanit vermedi." }
          : { error: "backend_failed", message: e.message };
        return new Response(JSON.stringify(errorMsg), {
          status: 504,
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }
    }

    // ═══════════════════════════════════════════════════════
    // 🏠 ANA SAYFA
    // ═══════════════════════════════════════════════════════
    return new Response("K-ANI Cache Worker aktif", {
      headers: { ...cors, "Content-Type": "text/plain" }
    });
  }
};
