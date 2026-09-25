// ═══════════════════════════════════════════════════════════
// 🎬 ANIME PRECACHE SCRAPER v3
// Top 80 anime × 5 bölüm rotation ile m3u8 + altyazı çeker
// ve Supabase'e kaydeder
//
// ÖZELLİKLER:
// - Cache skip (7 gün TTL)
// - Kara liste (hiç bölüm gelmeyen animeler)
// - Otomatik retry (MAX_RETRIES=3)
// - Rotation (her turda farklı anime + farklı bölümler)
// - Rate limit koruması
// ═══════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

// ════ AYARLAR ════
const BACKEND_URL = process.env.BACKEND_URL || 'https://mk-anmov31-12-2025.onrender.com';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const MAX_ANIME_PER_RUN = parseInt(process.env.MAX_ANIME || '16', 10);

// ⚡ Süre limitleri
const MAX_RUNTIME_MS = 170 * 60 * 1000;
const WAIT_BETWEEN_REQUESTS = 8000;
const WAIT_BETWEEN_ANIME = 15000;
const WAIT_ON_429 = 60000;
const WAIT_BETWEEN_RETRY = 30000;
const FETCH_TIMEOUT = 90000;
const MAX_RETRIES = 3;

// ⚡ Cache TTL — 7 gün
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const EPISODES_PER_ANIME = 5;
const TOTAL_ANIME_POOL = 80;
const TUR_ANIME_COUNT = 16;
const TOTAL_TURS_FOR_5_EPS = TOTAL_ANIME_POOL / TUR_ANIME_COUNT;

// ════ CLIENTS ════
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL ve SUPABASE_KEY env variable gerekli!');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ════ STATE ════
let startTime = Date.now();
let stats = {
  animeProcessed: 0,
  episodesCached: 0,
  episodesSkipped: 0,
  episodesFailed: 0,
  blacklisted: 0,
  rateLimited: 0
};
let stopRequested = false;

process.on('SIGINT', () => {
  console.log('\n⚠️  Durduruluyor... (mevcut işlem bitince çıkılacak)');
  stopRequested = true;
});

// ════ YARDIMCILAR ════
function log(tag, msg) {
  const t = new Date().toLocaleTimeString('tr-TR');
  console.log(`[${t}] [${tag}] ${msg}`);
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}s ${m % 60}dk`;
  if (m > 0) return `${m}dk ${s % 60}sn`;
  return `${s}sn`;
}

function checkTimeBudget(additionalMs = 0) {
  if (stopRequested) throw new Error('STOP_REQUESTED');
  const elapsed = Date.now() - startTime;
  if (elapsed + additionalMs > MAX_RUNTIME_MS) {
    throw new Error('MAX_RUNTIME_REACHED');
  }
}

async function sleep(ms) {
  checkTimeBudget(ms);
  await new Promise(r => setTimeout(r, ms));
}

// ════ ROTATION ════
async function loadRotation() {
  const { data, error } = await supabase
    .from('anime_rotation')
    .select('*')
    .eq('id', 'main')
    .single();

  if (error || !data) {
    log('ROT', '⚠️  Rotation kaydı yok, oluşturuluyor...');
    await supabase.from('anime_rotation').insert({
      id: 'main',
      current_tur: 1,
      current_anime_offset: 0
    });
    return { current_tur: 1, current_anime_offset: 0 };
  }
  return data;
}

async function saveRotation(state) {
  const { error } = await supabase
    .from('anime_rotation')
    .update({
      current_tur: state.current_tur,
      current_anime_offset: state.current_anime_offset,
      last_run_at: new Date().toISOString(),
      last_success_count: stats.episodesCached,
      last_fail_count: stats.episodesFailed,
      updated_at: new Date().toISOString()
    })
    .eq('id', 'main');
  if (error) log('ROT', '⚠️  Rotation kaydedilemedi: ' + error.message);
}

function computeRotationParams(rot) {
  const tur = rot.current_tur || 1;
  const offset = rot.current_anime_offset || 0;
  const epStart = Math.floor((tur - 1) / TOTAL_TURS_FOR_5_EPS) * EPISODES_PER_ANIME + 1;
  const turAnimeStart = ((tur - 1) % TOTAL_TURS_FOR_5_EPS) * TUR_ANIME_COUNT;
  return { tur, offset, epStart, turAnimeStart };
}

// ════ BLACKLIST ════
async function loadBlacklist() {
  try {
    const { data, error } = await supabase
      .from('anime_blacklist')
      .select('anilist_id');
    if (error) {
      log('BL', `⚠️  Blacklist yüklenemedi: ${error.message}`);
      return new Set();
    }
    return new Set((data || []).map(r => r.anilist_id));
  } catch (e) {
    log('BL', `⚠️  Blacklist catch: ${e.message}`);
    return new Set();
  }
}

async function addToBlacklist(anime, reason = 'no_stream') {
  try {
    const { error } = await supabase
      .from('anime_blacklist')
      .upsert({
        anilist_id: anime.id,
        anime_title: anime.title?.english || anime.title?.romaji || '',
        reason,
        last_tried_at: new Date().toISOString()
      }, { onConflict: 'anilist_id' });
    if (error) log('BL', `⚠️  Blacklist kayıt hatası: ${error.message}`);
  } catch (e) {}
}

// ════ ANILIST ════
async function fetchTopAnime(count = 80) {
  log('ANILIST', `Top ${count} popüler anime çekiliyor...`);
  const pages = Math.ceil(count / 50);
  const all = [];

  for (let page = 1; page <= pages; page++) {
    const body = {
      query: `query($page:Int,$perPage:Int){
        Page(page:$page,perPage:$perPage){
          media(type:ANIME,sort:POPULARITY_DESC){
            id
            title{ romaji english native }
            episodes
            coverImage{ large }
            seasonYear
          }
        }
      }`,
      variables: { page, perPage: 50 }
    };

    try {
      const r = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      const items = (d.data?.Page?.media) || [];
      all.push(...items);
      if (page < pages) await sleep(1000);
    } catch (e) {
      log('ANILIST', `⚠️  Sayfa ${page} hatası: ${e.message}`);
    }
  }

  log('ANILIST', `✅ ${all.length} anime çekildi`);
  return all;
}

// ════ BACKEND CALLS ════
async function fetchStream(anilistId, episode, mode = 'sub') {
  const url = `${BACKEND_URL}/api/anime/stream?id=${anilistId}&ep=${episode}&mode=${mode}&nocache=1`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (r.status === 429) {
      stats.rateLimited++;
      return { rateLimited: true };
    }

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = { error: 'parse_error' }; }

    if (data.url) {
      return { success: true, url: data.url, mode: data.mode || mode };
    }
    return { success: false, error: data.error || 'no_url' };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') return { success: false, error: 'timeout' };
    return { success: false, error: e.message };
  }
}

async function fetchSubtitle(anilistId, episode, mode, season, title) {
  const url = `${BACKEND_URL}/api/anime/subtitle?id=${anilistId}&ep=${episode}&mode=${mode}&season=${season || 1}&lang=tr&title=${encodeURIComponent(title)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!r.ok) return null;
    const text = await r.text();
    if (text.includes('WEBVTT')) return text;
    return null;
  } catch (e) {
    clearTimeout(timeoutId);
    return null;
  }
}

// ════ SUPABASE CACHE CHECK ════
async function isCached(anilistId, episode, mode = 'sub', season = 1) {
  try {
    const id = `ac_${anilistId}_${episode}_${mode}_${season}`;
    const { data, error } = await supabase
      .from('anime_cache')
      .select('updated_at')
      .eq('id', id)
      .single();

    if (error || !data) return { cached: false };

    const age = Date.now() - new Date(data.updated_at).getTime();
    if (age < CACHE_TTL_MS) {
      return { cached: true, age };
    }
    return { cached: false, expired: true, age };
  } catch (e) {
    return { cached: false };
  }
}

// ════ SUPABASE SAVE ════
async function saveToCache(anime, episode, mode, season, m3u8Url, subtitleVtt) {
  const id = `ac_${anime.id}_${episode}_${mode}_${season}`;
  const { error } = await supabase
    .from('anime_cache')
    .upsert({
      id,
      shikimori_id: anime.id,
      anime_title: anime.title?.english || anime.title?.romaji || '',
      anime_title_romaji: anime.title?.romaji || '',
      poster: anime.coverImage?.large || '',
      year: anime.seasonYear || null,
      episodes_total: anime.episodes || 0,
      episode,
      mode,
      season: season || 1,
      m3u8_url: m3u8Url,
      subtitle_vtt: subtitleVtt || null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });

  if (error) {
    log('SAVE', `❌ Supabase hata: ${error.message}`);
    return false;
  }
  return true;
}

// ════ ANA İŞLEM ════
async function processAnime(anime, epStart) {
  const title = anime.title?.english || anime.title?.romaji || `Anime ${anime.id}`;
  log('ANIME', `▶️  [${anime.id}] ${title} — bölüm ${epStart}-${epStart + 4}`);

  let cachedThisAnime = 0;
  let anySuccess = false;

  for (let i = 0; i < EPISODES_PER_ANIME; i++) {
    const episode = epStart + i;

    if (anime.episodes && episode > anime.episodes) {
      log('EP', `   ⏭️  Bölüm ${episode} yok (toplam: ${anime.episodes})`);
      continue;
    }

    // ⚡ Cache kontrolü
    const cacheCheck = await isCached(anime.id, episode, 'sub', 1);
    if (cacheCheck.cached) {
      const ageDays = (cacheCheck.age / (24 * 60 * 60 * 1000)).toFixed(1);
      log('EP', `   ⏭️  B${episode} zaten cache'de (${ageDays} gün önce) — atla`);
      stats.episodesSkipped++;
      anySuccess = true;
      continue;
    }
    if (cacheCheck.expired) {
      const ageDays = (cacheCheck.age / (24 * 60 * 60 * 1000)).toFixed(1);
      log('EP', `   🔄 B${episode} eski cache (${ageDays} gün) — yenilenecek`);
    }

    let success = false;
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        checkTimeBudget(WAIT_BETWEEN_REQUESTS + FETCH_TIMEOUT);

        const result = await fetchStream(anime.id, episode, 'sub');

        if (result.rateLimited) {
          log('EP', `   ⚠️  429 rate limit — ${WAIT_ON_429 / 1000}sn bekleniyor`);
          await sleep(WAIT_ON_429);
          continue;
        }

        if (result.success) {
          log('EP', `   ✅ B${episode} m3u8 alındı, altyazı çekiliyor...`);
          const subtitleVtt = await fetchSubtitle(anime.id, episode, result.mode, 1, anime.title?.romaji || title);

          const saved = await saveToCache(anime, episode, result.mode, 1, result.url, subtitleVtt);
          if (saved) {
            stats.episodesCached++;
            cachedThisAnime++;
            anySuccess = true;
            log('EP', `   💾 B${episode} kaydedildi${subtitleVtt ? ' (+altyazı)' : ''}`);
          } else {
            stats.episodesFailed++;
          }
          success = true;
          break;
        } else {
          lastError = result.error;
          if (attempt <= MAX_RETRIES) {
            log('EP', `   ⚠️  B${episode} deneme ${attempt} başarısız (${lastError}) — 30sn bekle`);
            await sleep(WAIT_BETWEEN_RETRY);
          }
        }
      } catch (e) {
        if (e.message === 'MAX_RUNTIME_REACHED' || e.message === 'STOP_REQUESTED') throw e;
        lastError = e.message;
        if (attempt <= MAX_RETRIES) await sleep(WAIT_BETWEEN_RETRY);
      }
    }

    if (!success) {
      stats.episodesFailed++;
      log('EP', `   ❌ B${episode} başarısız: ${lastError}`);
    }

    await sleep(WAIT_BETWEEN_REQUESTS);
  }

  return { cachedThisAnime, anySuccess };
}

async function main() {
  log('START', '════════════════════════════════════');
  log('START', `🎬 Anime Precache v3 başlıyor`);
  log('START', `Backend: ${BACKEND_URL}`);
  log('START', `Max anime: ${MAX_ANIME_PER_RUN}`);
  log('START', `Max süre: ${formatDuration(MAX_RUNTIME_MS)}`);
  log('START', `Cache TTL: ${CACHE_TTL_MS / (24 * 60 * 60 * 1000)} gün`);
  log('START', '════════════════════════════════════');

  // 1) Rotation state
  const rot = await loadRotation();
  const { tur, offset, epStart, turAnimeStart } = computeRotationParams(rot);
  log('ROT', `Tur ${tur} | Anime offset ${offset}/16 | Başlangıç idx: ${turAnimeStart} | Bölüm: ${epStart}-${epStart + 4}`);

  // 1.5) Blacklist
  const blacklist = await loadBlacklist();
  log('BL', `🚫 Kara listede ${blacklist.size} anime var`);

  // 2) Top anime listesi
  const allAnime = await fetchTopAnime(TOTAL_ANIME_POOL);
  if (allAnime.length < TOTAL_ANIME_POOL) {
    log('WARN', `⚠️  Sadece ${allAnime.length} anime alındı (beklenen: ${TOTAL_ANIME_POOL})`);
  }

  // 3) Slice
  const sliceStart = turAnimeStart + offset;
  const slice = allAnime.slice(sliceStart, sliceStart + MAX_ANIME_PER_RUN);
  const blockedInSlice = slice.filter(a => blacklist.has(a.id)).length;
  if (blockedInSlice > 0) {
    log('BL', `   Bu dilimde ${blockedInSlice}/${slice.length} anime kara listede`);
  }

  log('PLAN', `Bu çalıştırmada ${slice.length} anime işlenecek`);
  log('PLAN', `Anime aralığı: ${sliceStart} - ${sliceStart + slice.length - 1}`);

  if (slice.length === 0) {
    log('DONE', 'Bu dilimde anime kalmadı, rotation tamamlandı');
    return;
  }

  // 4) Anime'leri işle
  let localOffset = offset;

  for (let i = 0; i < slice.length; i++) {
    try {
      checkTimeBudget(WAIT_BETWEEN_ANIME);

      const anime = slice[i];
      const animeTitle = anime.title?.english || anime.title?.romaji || `Anime ${anime.id}`;

      // ⚡ Kara liste kontrolü
      if (blacklist.has(anime.id)) {
        log('BL', `   ⏭️  [${anime.id}] ${animeTitle} — kara listede, atla`);
        localOffset++;
        if (localOffset >= TUR_ANIME_COUNT) {
          rot.current_tur = tur + 1;
          rot.current_anime_offset = 0;
          log('ROT', `🏁 Tur ${tur} tamamlandı → Tur ${tur + 1}`);
          break;
        } else {
          rot.current_tur = tur;
          rot.current_anime_offset = localOffset;
          await saveRotation(rot);
        }
        continue;
      }

      const result = await processAnime(anime, epStart);
      stats.animeProcessed++;

      // ⚡ Hiç bölüm gelmediyse → kara listeye
      if (!result.anySuccess) {
        log('BL', `   ❌ [${anime.id}] ${animeTitle} — hiç bölüm gelmedi, KARA LİSTEYE`);
        await addToBlacklist(anime, 'no_stream');
        blacklist.add(anime.id);
        stats.blacklisted++;
      }

      // Rotation güncelle
      localOffset++;
      if (localOffset >= TUR_ANIME_COUNT) {
        rot.current_tur = tur + 1;
        rot.current_anime_offset = 0;
        log('ROT', `🏁 Tur ${tur} tamamlandı → Tur ${tur + 1}`);
        break;
      } else {
        rot.current_tur = tur;
        rot.current_anime_offset = localOffset;
      }

      await saveRotation(rot);

      // Anime arası bekleme
      if (i < slice.length - 1) {
        log('WAIT', `⏸️  Sonraki anime için ${WAIT_BETWEEN_ANIME / 1000}sn`);
        await sleep(WAIT_BETWEEN_ANIME);
      }

    } catch (e) {
      if (e.message === 'MAX_RUNTIME_REACHED') {
        log('STOP', `⏰ Süre doldu (${formatDuration(Date.now() - startTime)})`);
        break;
      }
      if (e.message === 'STOP_REQUESTED') {
        log('STOP', 'Kullanıcı durdurdu');
        break;
      }
      log('ERR', `Anime #${i} hatası: ${e.message}`);
    }
  }

  // 5) Özet
  const elapsed = Date.now() - startTime;
  log('DONE', '════════════════════════════════════');
  log('DONE', `✅ Tamamlandı (${formatDuration(elapsed)})`);
  log('DONE', `   Anime işlenen: ${stats.animeProcessed}`);
  log('DONE', `   Bölüm cache'lenen: ${stats.episodesCached}`);
  log('DONE', `   Bölüm atlanan (cache taze): ${stats.episodesSkipped}`);
  log('DONE', `   Bölüm başarısız: ${stats.episodesFailed}`);
  log('DONE', `   Kara listeye eklenen: ${stats.blacklisted}`);
  log('DONE', `   Rate limit: ${stats.rateLimited}`);
  log('DONE', `   Rotation son: Tur ${rot.current_tur}, offset ${rot.current_anime_offset}`);
  log('DONE', `   Kara liste boyutu: ${blacklist.size}`);
  log('DONE', '════════════════════════════════════');
}

main().catch(e => {
  console.error('❌ Ana hata:', e);
  process.exit(1);
});
