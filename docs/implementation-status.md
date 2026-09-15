# AgentFuse — uygulama durumu ve devir notu

**Son güncelleme:** 2026-09-15 · **`main`'deki son kod commit'i:** `c80c4db`
(`main` HEAD bunu izleyen bu doküman commit'i) · **Durum:** Faz 6 kısmen bitti
(6a); kritik yol `wrap`/`serve` için Faz 6b'ye geçti

Bu dosya, işi başka bir oturumda kaldığı yerden sürdürebilmek için tutulur.
Ürün tanımı burada değil — tek doğruluk kaynağı `../.ssot/PRD.md` ve
`../.ssot/ADR.md`. Tam uygulama planı (mimari kararlar, faz brifingleri,
doğrulama adımları) `~/.claude-bk/plans/prd-ve-adr-d-k-manlar-n-floating-tower.md`
dosyasındadır.

---

## Nerede kaldık

| Faz | Konu | Durum |
| --- | --- | --- |
| 0 | `.ssot` düzeltmeleri | **Bitti** |
| 1 | Workspace iskeleti | **Bitti** — `2e2c4a4` |
| 2 | Çekirdek karar motoru | **Bitti** — `c5fa5d1` |
| 3 | Asenkron semantik döngü katmanı | **Bitti** — `abd96d8` |
| 4 | `@agentfuse/embeddings-local` | Başlanmadı |
| 5 | `@agentfuse/proxy` (MCP adaptörü) | **Bitti** — `ebce8f0` |
| 6 | CLI (`agentfuse`) | **Kısmen bitti (6a)** — `373c240` `f503322` `58741ba` `c80c4db`; `wrap`/`serve` = 6b |
| 7 | Onay akışı + rapor UX | Başlanmadı |
| 8 | Telemetri (OTLP) | Başlanmadı |
| 9 | Benchmark'lar (tespit + gecikme) | Başlanmadı |
| 10 | Dokümanlar + v0.1.0 | Başlanmadı |

Bağımlılık grafiği ve kritik yol:

```
0 → 1 → 2 → { 3 ∥ 4 ∥ 5 } → 6 → { 7 ∥ 8 ∥ 9 } → 10
kritik yol: 0-1-2-5-6-9-10
```

### `main` yeşil — 2026-09-15'te bizzat koşuldu

```
npm run lint          → Checked 140 files. No fixes applied.
npm run typecheck     → temiz (tsc -b && tsc -p tsconfig.test.json)
npm run build         → temiz
npm test              → Test Files 43 passed · Tests 951 passed (2.53 s)
npm run schema:check  → schema up to date
```

Faz 6a öncesindeki sayılar 28 dosya / 633 test idi; eklenen 15 dosya ve 318
test tümüyle `packages/cli`'ye ait ve mevcut 633 testin hiçbiri değişmedi.

Coverage kapısı `vitest.config.ts` içinde `packages/core/src/**` için %90'da ve
**gerçekten zorluyor** (Faz 2'de 100'e çekilip kasten kırılarak doğrulandı).
Faz 6a sonundaki ölçümler (`coverage/lcov.info` üzerinden, glob bazında):

| Paket | lines | functions | branches |
| --- | --- | --- | --- |
| `packages/core/src/**` (kapılı) | %99.89 | %100 | %95.45 |
| `packages/proxy/src/**` (kapısız) | %98.88 | %100 | %91.18 |
| `packages/cli/src/**` (kapısız) | %99.79 | %100 | %98.86 |

Kapı yalnız core'da, ama proxy ve CLI de bilinçli olarak aynı çubuğun üstünde
tutuldu; sayıyı şişirmemek için yazılmamış tek test yok. Metin reporter'ının
satırları: `proxy/src` %98.46 / %91.17 / %100 / %98.87, `cli/src` %99.27 /
%98.86 / %100 / %99.72, `cli/src/commands` %100 / %98.82 / %100 / %100.
Karşılaştırma için Faz 5 sonunda "All files" %99.03 / %93.95 / %100 / %99.53
idi; artık %99.19 / %95.35 / %100 / %99.66.

**`main.ts` metin reporter'ında %0 görünür ve bu beklenen.** Dosya tek bir
top-level `await run(...)` ifadesidir ve gerçek stream'leri bağlar; yalnızca
ayrı bir process olarak koşarken çalışır. `cli.test.ts` onu `dist/main.js`'i
`execFile` ile çağırarak test ediyor (`it.runIf(existsSync(MAIN))` — kapı
`build`'i `test`'ten önce koştuğu için CI'da her zaman koşar). v8
instrumentasyonu child process'i görmez, ama shebang'in, top-level await'in ve
`process.exitCode`'un gerçekten çalıştığı o testle pinli.

`packages/*/src/testing/` coverage'dan ve paket build'inden muaf: içindeki
harness'lar, senaryo dublörleri ve `json-schema.ts` doğrulayıcısı `.test.ts` ile
bitmediği halde test iskelesidir, ve yayınlanmaları her senaryoyu public
kontrata çevirirdi.

Senkron yolun ölçülen maliyeti (`beforeCall` + `afterCall` + `observe`, 20 000
çağrı, 50 oturum, `HashingProvider(384)` bağlı, `mode: warn`): ortalama
0.018 ms, **p95 0.023 ms**, p99 0.038 ms. PRD §6'nın çağrı başına p95 < 50 ms
bütçesi bu katman için üç büyüklük mertebesi boş duruyor — çünkü embedding
hesabı bu yolda değil. Bu rakam kural katmanının maliyetidir; gerçek modelin
gecikmesi kuyrukta ölçülür ve bir `tools/call`'a hiç dokunmaz. Kesin ölçüm ve
eşik kalibrasyonu Faz 9'un işi.

---

## Faz 0 — `.ssot` düzeltmeleri (bitti)

Çatı ADR-002 kapsam değiştiren koddan önce doküman güncellemesi şart koşuyor.
Araştırma üç varsayımı geçersiz kıldığı için `.ssot` düzeltildi:

- **ADR-005 güncellendi** — TypeScript SDK v2'ye bölündü. Taban artık
  `@modelcontextprotocol/{server,client,core}@2.0.0`; `@modelcontextprotocol/sdk`
  v1 monoliti (1.30.0) taban alınmıyor. İki era (`legacy` = `2024-10-07`…
  `2025-11-25`, `modern` = `2026-07-28`) destekleniyor, era *çevirisi* kapsam
  dışı. Düşük seviyeli `Server` + `fallbackRequestHandler` geçirgenlik dikişi.
- **ADR-006 eklendi (oturum kimliği)** — spec `2026-07-28` oturumları tümüyle
  kaldırdı (`Mcp-Session-Id` yok, `initialize` yok, protokol durumsuz). Karar:
  stdio wrap modunda bir child process = bir bağlantı = bir session (ULID);
  HTTP modunda `session.key` merdiveni — `traceparent` → `baggage`'daki
  `tunedness.session-id` → `clientInfo` + remote address hash'i (best-effort).
- **ADR-003 güncellendi (embedding)** — "gömülü ~100 MB model" yanlıştı.
  `onnxruntime-node@1.30.0` tek başına **301 MB** (`dist.unpackedSize =
  301068136`) ve tüm platform ikililerini tek tarball'da taşıyor. Karar:
  opsiyonel yardımcı paket `@agentfuse/embeddings-local`; kural katmanı onsuz
  tam işlevli (çatı ADR-001 "crippleware yasak").
- **ADR-007 eklendi (bütçe dürüstlüğü)** — proxy LLM token'larını göremez,
  ürettiği rakam araç I/O'sunun alt sınırı tahminidir. `_estimated` soneki
  şema/rapor/telemetride bağlayıcı. `max_duration` ve `max_calls` çapa limitler.

---

## Faz 1 — iskelet (bitti, `2e2c4a4`)

npm workspaces (pnpm yok), ESM-only, `engines: node >=20.19`.

```
packages/core/              @agentfuse/core            — SAF karar motoru
packages/proxy/             @agentfuse/proxy           — MCP adaptörü
packages/embeddings-local/  @agentfuse/embeddings-local — OPSİYONEL
packages/cli/               agentfuse (scope'suz)      — npx giriş noktası
bench/                      @agentfuse/bench (private)
```

Araçlar: TypeScript 5.9.3 (`module: nodenext`, strict +
`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` +
`verbatimModuleSyntax`), Biome 2.5.13, Vitest 5.0.1, Changesets 3.
CI: Node 20/22/24 matrisi.

**Bilinmesi gerekenler:**

- Vitest config formu `vitest.config.ts` içinde **`test.projects`** dizisi;
  eski `vitest.workspace.ts` dosyası değil.
- Kökte ek bir `tsconfig.test.json` var: paket tsconfig'leri `**/*.test.ts`'i
  `exclude` ediyor ki `dist/` yayınlanabilir kalsın, ama o zaman testler hiç
  typecheck edilmezdi. `typecheck` scripti `tsc -b && tsc -p tsconfig.test.json`
  koşuyor.
- `packages/core/schemas/` Biome'dan muaf — dosya generator'ın ürünü, formatı da
  onun işi; yoksa `schema:check` her `biome format` sonrası drift raporlar.
- TypeScript 7.0.2 çıkmış durumda ama bilinçli olarak `^5.9.3` sabitlendi.

### Bağımlılık yönü — mimarinin değişmezi

Paket manifest'lerinde zorlanıyor, konvansiyona bırakılmıyor:

| Paket | dependencies |
| --- | --- |
| `@agentfuse/core` | `zod` **yalnızca** |
| `@agentfuse/proxy` | `@agentfuse/core` + `@modelcontextprotocol/{server,client,core}` |
| `agentfuse` | `@agentfuse/core`, `@agentfuse/proxy`, `yaml`, `gpt-tokenizer` |
| `@agentfuse/embeddings-local` | (Faz 4'te dolacak) |

**`core` saftır:** `@modelcontextprotocol/*` yok, `@agentfuse/embeddings-local`
yok, `node:fs`/`net`/`child_process` yok. `node:crypto` kabul. Zaman enjekte
edilen `Clock`'tan, ID'ler `IdGenerator`'dan gelir — `Date.now()` ve
`Math.random()` doğrudan kullanılmaz. `packages/core/src/purity.test.ts` bunu
zorluyor; **gevşetilmemeli.** Bu saflık, P1'deki süreç içi SDK modunu ve
McpGuard'ın motoru yeniden kullanmasını mümkün kılan şeydir.

**CLI asla `@agentfuse/embeddings-local`'a bağlanmaz** — runtime'da dynamic
`import()` ile bulunur, bulunamazsa kural katmanı tam çalışmaya devam eder.

---

## Faz 2 — çekirdek karar motoru (bitti, `c5fa5d1`)

250 test, %99 statement coverage. `packages/core/src` ağacı:

```
index.ts engine.ts testing.ts version.ts purity.test.ts
domain/   breaker decision events records session
ports/    Clock IdGenerator SessionStore ApprovalGateway TelemetrySink
          Tokenizer CostModel EmbeddingProvider Ports
adapters/ approval clock session-store telemetry tokenizer ulid
policy/   schema duration glob compile evaluate
loop/     normalize fingerprint
guards/   breaker breaker-guard policy budget rule-loop pipeline types
report/   trip-report render
util/     json hash
scripts/generate-schema.mts  +  schemas/fusepolicy.v1.schema.json (commit'li)
```

Guard hattı, `FuseEngine.beforeCall()` içinde sırayla — approval beklemesi
hariç hepsi senkron:

```
1. BreakerGuard    — açık devre / pendingTrip tüketimi
2. PolicyGuard     — glob araç kuralları
3. BudgetGuard     — sayaç karşılaştırmaları, %50/80/100 eşik olayları
4. RuleLoopGuard   — R1 exact-repeat, R2 error-repeat, R3 short-cycle
5. (approval)      — yalnız require_approval + mode=enforce ise
```

### Faz 2'nin belgelenmiş kararları — bunları bilmeden devam etmeyin

- **`min_calls` yalnızca semantic kuralı gate'liyor.** Deterministik kurallar
  onu bilinçli olarak yok sayar; aksi halde varsayılan `min_calls: 5` ile "aynı
  çağrı 3 kez → 3. çağrıda trip" senaryosu imkânsız olurdu.
- **Fingerprint ayıracı `\0`** (boşluk değil) — `("a b","c")` ile `("a","b c")`
  çakışmasın diye.
- **`max_duration` wall-clock ölçer** (`now - startedAt`), tool içinde geçen
  sürelerin toplamı değil.
- **Approval timeout'unun sahibi gateway, engine değil.** Engine saflığı korumak
  için gerçek timer kurmaz; `timeoutMs`'i geçer ve `'timeout'` bekler.
  `AbortSignal`, session bitince ya da breaker reset'lenince fire eder.
- **`TripCode`'a `POLICY_WARN` eklendi** — rule action'ı `warn` olabiliyor, bunu
  `POLICY_DENY` ile raporlamak telemetriyi yalancı yapardı.
- **Policy object'leri Zod `strict`** — yazım hatası olan bir key sessizce
  yutulmaz, yükleme anında patlar.
- **`endSession` bilinmeyen session için sıfırlanmış özet döndürür,** throw
  etmez: transport kapanışı ile idle sweep yarışabilir.
- **`half_open`'da insanın reddi → `open`.** Spec sadece "re-trip" diyordu;
  insanın "hayır"ı en az onun kadar güçlü bir sinyal.
- **`warn` modu birinci sınıf kod yolu.** Devre kesici makinesi yine koşar,
  kararlar `action: 'warn'` + `wouldTrip: true`'ya indirgenir ve çağrı iletilir.
  Kullanıcının enforce'a geçmeden yanlış pozitif oranını ölçmesini sağlayan
  mekanizma bu; PRD risk #1'in azaltımı.
- **`onDecision` hook'u argümanı değiştiremez** — yalnız `action`'ı yükseltip
  düşürebilir ve reason ekleyebilir. Yeniden yazan proxy olmak McpGuard'ın
  bölgesi. Fırlatan hook yakalanır, telemetriye yazılır ve no-op sayılır.

### Faz 3 için bırakılan seam'ler (hepsi Faz 3'te tüketildi)

- `EmbeddingProvider` `ports/index.ts`'te **donduruldu** (L2-normalize
  zorunluluğu TSDoc'ta). Değiştirmeyin, karşısına yazın. Faz 3 bunu
  değiştirmedi.
- `SessionState.pendingTrip` ve `SessionState.degraded` alanları mevcut.
  `pendingTrip` **yalnızca** `breakerGuard` tarafından tüketilir (ilk gelen
  kazanır).
- `FuseEngine.onRecordComplete(listener)` — `afterCall` sonunda çağrılır,
  embedding kuyruğunun bağlanacağı nokta.
- `FuseEngine.markPendingTrip(sessionId, reason)` ve `markDegraded(sessionId)` —
  scorer'ın internals'a dokunmadan verdict bırakma yolu. Faz 3 `markDegraded`'a
  opsiyonel bir `cause` parametresi ekledi (aşağıya bakın); varsayılanı
  `'sampled'` olduğu için çağrı biçimi değişmedi.
- `loop_detection.semantic.*` şemada tam tanımlı.
- Mevcut `describe('the semantic seam')` testleri bu kontratı pinliyor.

---

## Faz 3 — asenkron semantik döngü katmanı (bitti, `abd96d8`)

Üç commit: `6b472ce` skorlayıcı + embedding dublörü, `b053582` kuyruk,
`abd96d8` dedektör + motora bağlama. `packages/core/src` ağacına eklenenler:

```
loop/     window embed-text queue hashing-provider
guards/   semantic-loop
```

Ürün yüzeyi: ana giriş noktasından `EmbeddingWindow`, `EmbeddingQueue`,
`SemanticLoopDetector`, `attachSemanticLoopDetector`, `semanticEmbeddingText`;
`@agentfuse/core/testing` alt yolundan `HashingProvider`.

### Taslak dosyalar hakkında verilen kararlar

`wip/phase-3-5-partial`'daki (`798720b`) üç Faz 3 dosyası tek tek değerlendirildi.
Branch'e dokunulmadı.

| Dosya | Karar | Gerekçe |
| --- | --- | --- |
| `loop/window.ts` | **tutuldu**, testleri yazıldı | Kapalı form doğru, halka tamponu doğru, `ensureCapacity`'nin gerekçesi (kural bazlı `window` override'ı) geçerli. Savunabildiğimiz bir tasarımdı; değiştirmek için sebep yoktu. |
| `loop/hashing-provider.ts` | **tutuldu**, testleri yazıldı | FNV-1a trigram + işaret biti hilesi ilgisiz metinleri gerçekten dik tutuyor. `@agentfuse/core/testing` alt yoluna taşındı — `FakeClock` hangi gerekçeyle oradaysa bu da öyle: üretimde provider olarak yapılandırılamasın. |
| `loop/queue.ts` | **yeniden yazıldı** (iskeleti korundu) | Sayaçlar, batch döngüsü, en-eskiyi-düşüren taşma mantığı iyiydi. Ama taslak, hata sonrası backoff için bir `Scheduler` portu ve **gerçek `setTimeout`** getiriyordu. |

### `Scheduler` portu neden atıldı

Faz 2, approval timeout'unun sahibini gateway yaptı ve gerekçeyi yazıya geçirdi:
core'un tek zaman kaynağı enjekte edilen `Clock`'tur, kendi timer'ını kurmaz.
`core` içinde bir `TimerScheduler` yayınlamak bu kararla çelişirdi. Yerine:

- başarısız batch sonrası gecikme, `clock.now()` ile karşılaştırılan bir
  **deadline** (`#retryAfter`),
- worker'ı yeniden uyandıran şey bir sonraki `enqueue`.

Bu zaten doğru tetikleyici: kuyruk yalnız çağrı akarken anlamlıdır ve kimsenin
eklemediği bir backlog, zaten geçip gitmiş bir pencereye aittir. Yan kazançlar:
yüzeyden bir port eksildi, her hata yolu bir sayıyı ilerleterek test edilebilir
oldu, ve arka plan işi bir process'i açık tutamaz.

`purity.test.ts` artık `setTimeout`, `setInterval`, `setImmediate`,
`queueMicrotask`, `process.hrtime` ve `performance.now` taraması yapıyor —
bu karar bir paragraf değil, kırılan bir test.

### Sürüklenme (drift) — yeniden hesaplama aralığı 1024

`S` toplamı `Float64Array`, toplananlar `Float32`. Bir ekle/çıkar çifti en fazla
~2⁻⁵³ bağıl hassasiyet kaybettirir; binlercesi bile kimsenin yapılandıracağı bir
`threshold`'un 1e-3 çözünürlüğünü kıpırdatamaz. **1024 bu yüzden gereklilikten
değil, ucuzluktan seçildi:** yeniden hesaplama `O(W·d)` ve 1024 push'a
amortize edildiğinde `W ≤ 64` için push başına bir toplamadan az. Asıl işi,
provider bir gün denormal ya da tam birim olmayan bir vektör verirse hasarı
sınırlamak.

İki ayrı test var: biri 20 000 push/evict sonrası artımlı `S`'i sıfırdan
hesaplanmışla karşılaştırıyor, diğeri aynı özelliği **yeniden hesaplama kapalıyken**
50 000 döngüde pinliyor — böylece aralığın ileride sessizce taşıyıcı hale gelmesi
imkânsız. Kapalı form ayrıca rastgele pencerelerde naif `O(W²)` referansla
1e-6 içinde karşılaştırılıyor; üreteç tohumlu bir LCG, `Math.random()` yok.

### Adaptif örnekleme tetikleyicisi

Eşik **projeksiyonlu backlog**: ölçülen batch gecikmesinin EWMA'sı (α = 0.3)
çarpı bekleyen batch sayısı (`ceil(depth / batchSize)`), 2000 ms'yi geçerse.
Ham derinlik değil, çünkü 40'lık bir derinlik, bir batch'in bir milisaniye mi
bir saniye mi sürdüğünü bilmeden hiçbir şey ifade etmez. Eşiğin üstünde kuyruk
**her ikinci teklifi kabul eder** — varış hızı yarıya iner, pencere seyrekleşir,
ve etkilenen oturum `degraded` işaretlenir.

Taslak burada daha zekiydi: yalnız kuyrukta zaten aynı fingerprint'i olan
teklifleri örnekliyordu. Fikir iyi ama doğrulanmamış ve tespit kalitesi Faz 9'un
alanı; düz alternasyon açıklanması ve test edilmesi daha kolay. **Faz 9 için
not:** fingerprint'e duyarlı örnekleme, ROC taramasında ölçülecek bir iyileştirme
adayıdır.

### `degraded` iki nedene ayrıldı

`SessionState.degraded` artık `'sampled' | 'unavailable'`:

- `'sampled'` — yük atıldı (taşma ya da örnekleme), pencere politikanın istediğinden
  seyrek,
- `'unavailable'` — provider patladı, **hiçbir şey** skorlanmadı, yalnız
  deterministik kurallar koştu.

Embedding backend'i ölüyken "sampled" yazan bir rapor yalan söyler; ADR-007'nin
"tahmin, kaydını okuyanın göreceği yerde taşır" kuralı tespit sadakati için de
geçerli. `'unavailable'` `'sampled'`'ı ezer, sonradan gelen bir yük atma bildirimi
onu düşüremez. `SessionSummary.degraded` boolean kaldı; varyantı yüzeye çıkarmak
Faz 7'nin rapor UX'inin işi.

### Embedding metni bir kontrattır

`loop/embed-text.ts` tek yer:

```
<server>__<tool>
<argsNormalized, en çok 800 karakter>
result: <özet, en çok 256 karakter>
```

- **Argümanlar `record.argsNormalized`'dan gelir**, yeniden normalize edilmez.
  Exact-repeat kuralı ile semantik kural "aynı çağrı" konusunda anlaşmak zorunda;
  iki normalizer birbirinden sapardı.
- **Sonuç dahildir.** Sayfalayan bir ajan neredeyse aynı istekleri ve tamamen
  farklı sonuçları üretir; başarısız bir yazmayı yeniden deneyen ajan ikisinde de
  neredeyse aynısını üretir. Sonuç olmadan birincisi ikincisine benziyor ve
  pagination bu ürünün en çok kaçınması gereken yanlış pozitif.
- **Hata, imzasını başa yazar:** `ERROR(<errorSignature>): `. Aynı türden iki
  hata, çevresindeki metin farklı olsa da gömme uzayında yan yana düşer.
- `{tool}` yerine `toolKey(server, tool)` yazılıyor — fingerprint de aynı
  gerekçeyle `server \0 tool \0 args` üzerinden kuruluyor; iki farklı sunucudaki
  `read_file` aynı iş değil.
- 800 karakter sınırı yalnız **geniş** argümanlarda devreye girer: `normalizeArgs`
  256 karakteri aşan her tek string'i zaten ortadan çökertiyor.

**Bu metin değişirse Faz 9'un kalibre ettiği her eşik anlamını yitirir.**

### Dedektör

`guards/semantic-loop.ts` bir guard değil — hattın içinde koşmaz.
`onRecordComplete`'e abone olur, sıcak yolun dışında gömer, pencere yakınsayınca
`markPendingTrip` ile not bırakır, `breakerGuard` bunu bir sonraki çağrıda tüketir.

- **Motoru import etmez.** Üç metotlu `SemanticHost` arayüzüne yazılmıştır
  (`policy`, `onRecordComplete`, `markPendingTrip`, `markDegraded`); `FuseEngine`
  bunu yapısal olarak karşılar. Bağımlılık tek yön: motor semantik katmanı
  tanımıyor.
- **Ayar anlık görüntüsü iş başına.** Kural bazlı `loop_detection` override'ı
  eşleştiği çağrıya aittir; vektör geri geldiğinde oturum başka bir aracı
  kullanıyor olabilir. Pencere kapasitesi değişirse `ensureCapacity` ödenmiş
  geçmişi korur.
- **Trip sonrası pencere temizlenir.** Yoksa onu tripleyen geçmiş bir sonraki
  çağrıda yine tripler — `resetBreaker`'ın oturum penceresini düşürmesiyle aynı
  gerekçe.
- **Oturum haritası sınırlı** (varsayılan 1024, en az kullanılan düşer): dedektör
  bir oturumun store'dan silindiğini göremez. Daha iyisini bilen host `forget()`
  çağırır — **Faz 5 için not: `endSession`'dan sonra `detector.forget(sessionId)`
  çağırın.**
- `lastScore(sessionId)` salt gözlem: raporun trip yanında göstereceği sayı ve
  Faz 9'un ROC taramasının private state'e uzanmadan okuyacağı şey.

### Sonraki fazlara bırakılan notlar

- **Faz 4:** `EmbeddingProvider` dokunulmadı. `HashingProvider`, gerçek backend'in
  geçmesi gereken davranış testlerinin de şablonu (`hashing-provider.test.ts`
  içindeki "behaves plausibly" blokları).
- **Faz 6** (Faz 5'te değil — proxy motoru kurmuyor, kendisine verileni
  kullanıyor): dedektör `attachSemanticLoopDetector({ host: engine, provider,
  clock, telemetry })` ile bağlanır; oturum kapanışında `forget()`, kapanışta
  `close()`. Provider bulunamazsa hiç bağlamayın — kural katmanı tam işlevli
  kalır. Proxy `forget()` için dikişi bıraktı:
  `ToolCallGuardOptions.onSessionEnd`.
  **Faz 6a'da yapıldı:** `runtime.ts` içinde `createRuntime`, ve
  `Runtime.onSessionEnd` o kancaya bağlanmış halde.
- **Faz 6:** `provider: 'none'` ya da `semantic.enabled: false`, CLI dinamik
  `import()` ile `@agentfuse/embeddings-local`'ı bulamadığında kullanacağı
  kapatma anahtarıdır; dedektör o çağrıları `skipped` sayar.
- **Faz 8:** kuyruk hatası bilinçli olarak `TelemetrySink`'e yazılmaz — çatı
  ADR-003 şemayı dört olay tipinde sabitliyor ve "embedding backend hasta" bunların
  hiçbiri değil. Sayaçlar `SemanticLoopStats`'ta; nasıl loglanacağı host'un işi.
- **Faz 9:** `threshold: 0.83` / `window: 8` / `consecutive_windows: 2` hâlâ yer
  tutucu. Negatif corpus'un bu katmana özel tuzakları: pagination (`cursor`
  maskelemeden muaf, ama sonuç metni de değişmeli), N benzer dosyanın toplu
  düzenlenmesi, yakınsayan build-test döngüsü. `lastScore()` ve
  `loop_detection.windowScore` olayı taramanın okuma noktaları.

---

## Faz 5 — MCP proxy (bitti, `ebce8f0`)

Üç commit: `a82d014` köprü + era + remap + korumalı `tools/call` yolu,
`4f5c890` kesinti metninin snapshot'ları, `ebce8f0` akış sadakati ve oturum
merdiveni testleri. `packages/proxy/src` ağacı:

```
index.ts version.ts boundary.test.ts
era.ts remap.ts bridge.ts diagnostics.ts   ← MCP tesisatı, motoru tanımaz
tools-call.ts trip-result.ts               ← yalnız bu ikisi motoru tanır
stdio-wrap.ts http-serve.ts                ← servis giriş noktaları
testing/scenarios.ts testing/fixtures/     ← build ve coverage dışı
```

### Sınır kuralı bir testle zorlanıyor

`bridge.ts`, `era.ts`, `remap.ts` ve `diagnostics.ts` `@agentfuse/core`'u import
etmez; `boundary.test.ts` bunu kırılan bir test haline getirir ve ayrıca motoru
import eden dosyaların listesini pinler — yeni bir dosya o listeye eklenmek
istiyorsa bu bir karar olur, formalite değil. McpGuard ADR'ı bu iskeletin
paylaşılan bir iç pakete çıkarılacağını söylüyor; temiz tutmak o günü taşıma
işi yapıyor, yeniden yazma işi olmaktan çıkarıyor.

Aynı test dosyası **stdout disiplinini** de zorluyor: pakette hiçbir kaynak
dosya `console.*` ya da `process.stdout` kullanamaz. Wrap modunda stdout
JSON-RPC akışıdır ve tek bir `console.log` ondan sonraki her mesajı bozar.

### Taslak dosyalar hakkında verilen kararlar

`wip/phase-3-5-partial`'daki (`798720b`) üç Faz 5 dosyası tek tek değerlendirildi.
Branch'e dokunulmadı.

| Dosya | Karar | Gerekçe |
| --- | --- | --- |
| `diagnostics.ts` | **tutuldu**, testleri yazıldı | İki kuralı (asla stdout, prefix + rate-limit) doğru kurmuş; pencere başlangıcı 0 yerine `now()` yapıldı ve bastırma bildirimi yeni pencerenin bütçesinden sayılır oldu. Core'un render ettiği raporu bozmadan yazmak için `block()` eklendi: kutu çizgili tabloyu satır satır prefix'lemek onu mahvediyordu. |
| `era.ts` | **yeniden yazıldı** (iskeleti korundu) | `eraOfProtocolVersion`, `detectRequestEra`, `EraMismatchError` iyiydi ve kaldı. `EraGuard` atıldı — aşağıya bakın. |
| `remap.ts` | **yeniden yazıldı** (yarısı silindi) | Saf `_meta` yardımcıları (`forwardedMeta`, `baggageEntry`, `traceparentOf`, `splitProgressToken`) doğruydu ve kaldı. İki kimlik haritası atıldı: SDK ikisini de kendisi yapıyor — aşağıya bakın. |

### `EraGuard` neden atıldı

Taslak, her istekte downstream era'sını gözleyip upstream ile karşılaştıran bir
sınıf kuruyordu. Kurulan topolojide bu karşılaştırmanın yapacağı bir şey yok:
era kararını **servis giriş noktası** veriyor (`serveStdio` factory'ye
`{ era }` geçiyor) ve upstream `Client` o era'ya göre negotiate ediliyor. Yani
downstream era'sı upstream'in *nedeni*, karşılaştırılacak bağımsız bir gözlem
değil.

Yerine iki şey kaldı: `eraOfConnection(client)` — SDK'nın kendi
`Client.getProtocolEra()` cevabını okur — ve bağlantı kurulduktan sonra bir kez
koşan `assertSameEra()`. Bu tek kontrol yine de gerekli, çünkü
`versionNegotiation: { mode: 'auto' }` legacy handshake'e **düşmeye** izinli:
modern bir downstream'in önünde `server/discover`'a legacy sinyal veren bir
sunucu, sessizce era sınırı aşan bir proxy üretirdi. `stdio-wrap.ts` bu yüzden
`auto` değil `{ pin: '2026-07-28' }` kullanıyor.

### İki kimlik haritası neden gerekmedi

Plan `progressToken` ve `requestId` için iki harita öngörüyordu. Kurulu SDK
ikisinin de tel seviyesindeki çevirisini kendisi yapıyor:

- **`progressToken`:** `Protocol.request`, `options.onprogress` verildiğinde
  `_meta.progressToken`'ı **kendi giden mesaj id'siyle üzerine yazıyor** ve
  gelen `notifications/progress`'i o callback'e yönlendiriyor. Elle token
  üretmek buna karşı çalışmak olurdu: ajanın token'ının yankısı SDK'nın progress
  dispatcher'ında "bilinmeyen token" diye `onerror`'a yazılıp düşürülür ve
  **notification fallback'ine hiç uğramaz**.
- **`requestId`:** gelen `notifications/cancelled` `Protocol`'ün kendi handler'ı
  tarafından tüketiliyor ve istek handler'ının `AbortController`'ını abort
  ediyor; bu `ctx.mcpReq.signal` olarak görünüyor. O signal iletilen
  `client.request`'e zincirlendiğinde upstream `Client` **kendi** request id'siyle
  kendi `notifications/cancelled`'ını yolluyor. Yani id çevirisi bir haritanın
  değil, tek bir `AbortSignal`'i geçirmenin sonucu. Modern era'da Streamable
  HTTP üzerinde aynı signal per-request stream'i kapatıyor.

Geriye kalan tek tablo **downstream request id'siyle anahtarlı** ve iki işi var:
"bu progress notification'ı hangi token'a ait" sorusunu cevaplamak, ve
assert edilebilir olmak. `RequestRemap.size` settle olan her istekten sonra sıfıra
dönmek zorunda; `finally` içinde bırakılıyor, böylece sonuç/hata/iptal
yollarının hiçbiri sızdıramıyor. Beş ayrı test bunu pinliyor (progress'li,
progress'siz, hatalı, iptal edilmiş ve 20 eşzamanlı çağrı sonrası).

### Kurulu SDK v2 API'si gerçekte nasıl görünüyor

**Faz 6 için taşıyıcı bilgi budur.** Hepsi `node_modules` içinde doğrulandı,
hafızadan değil.

**Paket yerleşimi.** Kurulu olan yalnız `@modelcontextprotocol/{server,client,core}@2.0.0`.
`@modelcontextprotocol/node` **kurulu değil** — yani `toNodeHandler` yok, Faz 6
Express/`node:http` köprüsünü kendi yazmak ya da o paketi eklemek zorunda.
`core` paketi **yalnız Zod şemaları ve sabitler** yayıyor; `core/internal`
`_meta` anahtar sabitlerini ve JSON-RPC hata kodlarını ekliyor. **Her çalışma
zamanı sınıfı ve tipi `server` ya da `client` paketinden gelir:** `Server`,
`Protocol`, `Transport`, `InMemoryTransport`, `StandardSchemaV1`, `SdkError`,
`ProtocolErrorCode`, `CallToolResult`, `ProtocolEra`, `RequestOptions`,
`ServerContext`, `SUPPORTED_PROTOCOL_VERSIONS` — hepsi
`@modelcontextprotocol/server`'da. `StdioServerTransport` ve `serveStdio`
`server/stdio` alt yolunda; `StdioClientTransport` `client/stdio`'da.

**`fallbackRequestHandler` / `fallbackNotificationHandler` public tiplerde
var.** İkisi de `Protocol` üzerinde alan olarak duruyor, dolayısıyla `Server` ve
`Client`'ta da. İmzalar:

```
fallbackRequestHandler?: (request: JSONRPCRequest, ctx: ContextT) => Promise<Result>
fallbackNotificationHandler?: (notification: Notification) => Promise<void>
```

Request fallback'i **açık handler'ın aldığı `ctx`'in aynısını alıyor** —
`mcpReq.id`, `mcpReq._meta`, `mcpReq.envelope`, `mcpReq.signal`, `mcpReq.notify`,
`mcpReq.send` dahil. Notification fallback'i yalnız notification'ı alıyor.

**SDK'nın kendi kurduğu handler'lar — proxy bunları hiç görmez:**

| Kim kurar | Method |
| --- | --- |
| `Protocol` constructor | `notifications/cancelled`, `notifications/progress`, `ping` |
| `Server` constructor | `initialize`, `notifications/initialized`, `logging/setLevel` (yalnız `capabilities.logging` varsa), `server/discover` (yalnız `supportedProtocolVersions` modern bir revizyon içeriyorsa) |
| `serveStdio` (modern bağlantı) | `server/discover`, `subscriptions/listen` |

**Plan brifingiyle çelişen nokta:** `server/discover` fallback'ten geçmiyor,
geçemez de. Legacy bir bağlantıda o method era registry'sinde olmadığı için
`Protocol.request` **transport'a hiç ulaşmadan, senkron olarak** hata fırlatıyor
(`_assertOutboundRequestInEra`); modern bir bağlantıda ise servis giriş noktası
onu kendisi cevaplıyor. `initialize` de geçemez: `Server` onu her zaman kendi
cevaplıyor, ve cevaplaması **zorunlu** — yoksa instance kendi era'sını hiç
öğrenmez ve sonraki her istek yanlış codec'le çözülür. Proxy bu yüzden
handshake'i upstream'den **aynalanan** kimlik, capability ve `instructions` ile
cevaplıyor. Bu körlemesine iletmekten daha doğru: ajan gerçek sunucunun
capability'leriyle negotiate ediyor.

**Düşük seviyeli `Server` modern era'ya hizmet EDEMEZ.** Gelen istek dispatch'i
codec'i `_negotiatedProtocolVersion`'dan çözüyor; o alan bir şey bağlamadıkça
`undefined` (= legacy) kalıyor ve legacy codec'te `server/discover` tanımlı
olmadığı için modern probe handler'a varmadan "method not found" alıyor.
`supportedProtocolVersions`'a `2026-07-28` eklemek yetmiyor — handler kurulur,
istek gelmez. Alanı bağlayan tek şey `initialize` handshake'i ve servis giriş
noktalarının çağırdığı SDK-içi `setNegotiatedProtocolVersion`. **Sonuç: Faz 6
modern era'yı `serveStdio` / `createMcpHandler` üzerinden servis etmek zorunda,
elle `new Server()` + transport ile değil.** Testler bunu da bu yüzden
`serveStdio`'ya `InMemoryTransport` vererek kuruyor (`createServedHarness`).

**Sürüm sabitleri.** `SUPPORTED_PROTOCOL_VERSIONS` **yalnız legacy**:
`['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']`.
`LATEST_PROTOCOL_VERSION` = `'2025-11-25'`. Modern liste
(`SUPPORTED_MODERN_PROTOCOL_VERSIONS = ['2026-07-28']`) ve era sınırı sabiti
**internal**, export edilmiyor — `era.ts` `FIRST_MODERN_PROTOCOL_VERSION`'ı bu
yüzden kendi yazıyor.

**Cancellation nasıl yüzeye çıkıyor.** Gelen tarafta: `Protocol` tüketir, istek
handler'ının `AbortController`'ını abort eder, handler bunu `ctx.mcpReq.signal`
olarak görür; iptal edilen istekte handler'ın dönüşü/hatası **cevaba
dönüştürülmez**. Giden tarafta: `options.signal` abort olunca `Protocol.request`
kendi `notifications/cancelled`'ını yollar — **ancak**
`codec.era === modern && transport.hasPerRequestStream === true` ise notification
yerine per-request stream'i abort eder. Yani signal'i zincirlemek iki era'da da
doğru davranışı bedava veriyor.

**Spec dışı methodlar açık result schema istiyor.** `Protocol.request(request,
options)` iki argümanlı formu şemayı era registry'sinden yalnız `RequestMethod`
için çözebiliyor; başka bir method adı için `TypeError` fırlatıyor. Standard
Schema üç özellikli bir arayüz olduğundan "hiçbir şeyi doğrulama" şeması on
satır: `bridge.ts` içindeki `PASSTHROUGH_RESULT`. **Bu sayede pakete `zod`
bağımlılığı eklenmedi** — Faz 1'in bağımlılık yönü tablosu olduğu gibi duruyor.

**`_meta` lifting.** SDK, rezerve `io.modelcontextprotocol/*` anahtarlarını
handler'ın gördüğü `_meta`'dan **çıkarıp** `ctx.mcpReq.envelope`'a koyuyor. Her
okuyucu birleşimi istediği için `remap.mergeMeta` tek yerde birleştiriyor.

**Modern era result'ları.** SDK giden her result'ın `_meta`'sına
`io.modelcontextprotocol/serverInfo` basıyor, cacheable methodlar için
`ttlMs`/`cacheScope` dolduruyor ve handler koymadıysa `resultType: 'complete'`
damgalıyor. İki era'nın snapshot'ı bu yüzden birebir aynı değil ve ikisi de
pinli.

**`Client` tarafı.** `Client.getProtocolEra(): ProtocolEra | undefined` **var** —
istemci tarafında era tespiti hazır. `Server`'da karşılığı yok, yalnız
`getNegotiatedProtocolVersion()`. `ClientOptions.versionNegotiation` varsayılanı
`'legacy'`; `'auto'` `server/discover` ile probe ediyor ve SDK'nın kendi
`StdioClientTransport`'unda probe için **kısa ömürlü ikinci bir child process**
doğuruyor; `{ pin: '2026-07-28' }` katı.

**`StdioClientTransport`** child'ı `stdio: ['pipe','pipe', stderr ?? 'inherit']`
ile doğuruyor — wrap modunun tam istediği şey, stderr baytları bu process'e hiç
girmiyor. Ama `env` varsayılanı `getDefaultEnvironment()`, yani güvenli
değişkenlerin beyaz listesi. `wrapStdioServer` bunu bilinçli olarak ezip ebeveyn
env'ini geçiriyor: sunucunun ihtiyaç duyduğu API anahtarını sessizce düşüren bir
wrapper, AgentFuse'u sunucuyu kıran şey gibi gösterir.

**Diğer davranış notları.**

- `Server.setRequestHandler('tools/call'|'tools/list')` capability'lerde `tools`
  yoksa **fırlatıyor**. Proxy aynalanan capability'lerde `tools` yoksa
  handler'ları kurmuyor; `tools/call` yine de fallback içinden gate'e
  yönlendiriliyor, böylece spec'i ihlal eden bir upstream korumasız delik
  açamıyor.
- `ping` `Protocol` tarafından yerel cevaplanıyor. Bir proxy için dürüst: `ping`
  gönderildiği bağlantının canlılığını sorar, proxy de canlıdır. Upstream
  canlılığı başka bir soru ve `ping` onu sormuyor.
- `server.projectCallToolResult` **iletilen bir result üzerinde çağrılmamalı**.
  Upstream kendi era'sı için zaten projekte etti; `advertisedOutputSchema:
  undefined` ile yeniden çağırmak legacy era'da `{result: …}` sarmasını
  ikileyebilir. Üretilen kesinti sonucunun `structuredContent`'i bilinçle
  nesne şeklinde, böylece iki era'da da projeksiyon identity.
- `McpServerFactory = (ctx: { era, authInfo?, requestInfo? }) => McpServer |
  Server | Promise<…>`. `createMcpHandler` factory'yi legacy yolda **HTTP isteği
  başına** çağırıyor; `serveStdio` bağlantı başına, artı modern açılışta
  vazgeçilebilen bir probe instance'ı için bir kez daha — yani fallback
  durumunda child iki kez doğabilir. Teardown `Server.onclose`'a bağlı, bu
  yüzden vazgeçilen instance kendi arkasını topluyor.

### Era tespiti yaklaşımı

Revizyonlar ISO tarih olduğu için sözlüksel karşılaştırma kronolojik: tek bir
`version >= '2026-07-28'` yeterli, sürüm ayrıştırma yok ve bilinmeyen bir
gelecek revizyon legacy'ye değil modern'e düşüyor. `detectRequestEra`, modern
isteklerin taşımak **zorunda** olduğu `io.modelcontextprotocol/protocolVersion`
anahtarının yokluğunu legacy kanıtı sayıyor. Bağlantı seviyesinde SDK'nın kendi
cevabı (`Client.getProtocolEra()`) tercih ediliyor.

### Faz 5'in çelişki kaydı

Plan brifingiyle ya da ADR'larla uyuşmayan noktalar, hepsi kodda da yorumlu:

1. **`server/discover` fallback'ten geçmez** (yukarıda). `initialize` de geçmez.
   ADR-005'in "kalan tüm istek ve notification'lar olduğu gibi aktarılır"
   ifadesi lifecycle methodları için geçerli değil ve olamaz.
2. **`requestId` haritası gereksiz** (yukarıda).
3. **ADR-006 merdiven sıralaması.** ADR "HTTP üzerinde legacy era'da
   `Mcp-Session-Id` varsa o kullanılır" diyor, ama aynı ADR `baggage`'daki
   `tunedness.session-id`'yi bir **zincirleme sözleşmesi** olarak tanımlıyor:
   "en dışta duran proxy session'ı çözer ve baggage girdisini enjekte eder,
   içteki proxy'ler onu benimser". İkisi birlikte varken transport seviyesindeki
   bir id'nin baggage'ı ezmesi o sözleşmeyi anlamsız kılar. Uygulama
   `traceparent → baggage → Mcp-Session-Id → clientInfo+adres` sırasını
   kullanıyor. **`.ssot`'ta açıklayıcı bir düzeltme hak eden bir gerilim;**
   ADR-002 gereği kod bunu tek başına değiştirmedi, kayda geçirdi.
4. **HTTP gateway servis etmek P1.** Gerekçe yapısal, emek değil:
   `createMcpHandler`'ın factory context'i HTTP `Request`'i taşıyor ama
   **ayrıştırılmış `_meta`'yı taşımıyor**, yani merdivenin `_meta`'da yaşayan
   basamakları ancak bir istek *işlenirken* okunabiliyor. Doğru bir gateway,
   istek başına çözülen bir session'a göre anahtarlanmış upstream bağlantı
   havuzu ister; bu kendi ADR'ını hak eden bir tasarım. Sessizce HTTP isteği
   başına bir upstream bağlantı açan bir handler çalışıyor gibi görünür ve araç
   çağrısı başına bir process spawn'ı maliyeti çıkarır. `http-serve.ts` bu
   yüzden **yalnız merdiven**: `SessionKeyResolver`, `traceIdOf`,
   `clientAddressKey`, `describeSessionRegime`, `sessionIdResolverFor`.
5. **Upstream'e bildirilen client capability'leri fazla beyan.** Proxy
   downstream `initialize`'ını upstream'in capability'leriyle cevaplamak
   zorunda, yani upstream bağlantısı gerçek istemci ne desteklediğini söylemeden
   **önce** kurulmak zorunda. Hiçbir şey beyan etmek sampling/elicitation/roots'u
   proxy üzerinden kalıcı olarak kapatırdı; **iletebileceğini** beyan etmek
   (`RELAYABLE_CLIENT_CAPABILITIES`) bunları çalışır tutuyor. Daha az beyan eden
   bir istemcide hata modu: upstream gerçek istemcinin karşılayamadığı bir push
   denemesi yapar ve downstream `Server`'dan capability hatası alır.
   `StdioWrapOptions.clientCapabilities` ile ezilebilir — Faz 6'nın yapacağı şey
   bu.
6. **Bütçe dürüstlüğü (ADR-007).** Proxy'nin yüzeye çıkardığı her token ve USD
   rakamı `_estimated` adını taşıyor: kesinti metninde `tokens_estimated` /
   `usd_estimated` ve core'un `TOKEN_ESTIMATE_NOTE`'u, `session_end`
   diagnostic'inde `tokensEstimated` / `usdEstimated`. Proxy araç I/O'sundan
   başkasını görmüyor ve aksini ima eden hiçbir sayı yazmıyor.

### Core'da bulunan boşluk ve kapatılması

**Core değiştirilmedi.** Bulunan tek gerçek boşluk proxy tarafında kapatıldı:
ADR-004 bir `onDecision` hook'unun action'ı yükseltip **hiç reason
döndürmemesine** izin veriyor, ve `buildTripResult` reason'sız bir kararda
fırlatıyordu — yani ajana okuyabileceği bir ret yerine JSON-RPC hatası
gidiyordu, ki bu tam olarak o modülün var olma sebebi olan başarısızlık. Artık
her blok açıklanabilir: reason'sız bir `deny` `POLICY_DENY`, reason'sız bir
`require_approval` `POLICY_APPROVAL` bildiriyor, ikisi de hook'u adıyla anıyor.

### Kesinti metni bir ürün yüzeyidir

`trip-result.ts` her `TripCode` için ayrı bir varyant taşıyor — on dört tane — ve
üç ayrı test onu işine bağlıyor: yeniden deneme cümlesi mevcut, iki ya da üç
alternatif var (duvar değil), ve toplam ~120 token civarında. **Yeni bir
`TripCode` eklendiğinde build, ona tavsiye yazılana kadar kırılır.**

Yeniden deneme cümlesi (`RETRY_WARNING`) paketteki tek taşıyıcı cümle: o olmadan
ajan devre kesiciyi sıkı bir döngüde yeniden dener ve birincinin üstüne ikinci
bir döngü kurulmuş olur.

İnsan raporu **yeniden yazılmadı**: `renderTripDiagnostic` core'un
`renderTripReport`'una ince bir geçiş. Tek bir renderer, CLI'nin, Control
Plane'in ve snapshot'ların aynı metne varması demek.

### Faz 6'nın bağlanacağı dikişler

- **`wrapStdioServer(options)`** — `agentfuse wrap`'in tamamı. `command`, `args`,
  `env`, `cwd`, `engine`, `serverName`, `quiet`, ve opsiyonel `transport`
  (stdio dışı bir downstream için), `clientInfo`, `clientCapabilities`,
  `requestTimeoutMs`, `onError`. Dönen handle `sessionId`, `bridge` ve
  `close()` veriyor.
- **`createBridge(options)`** — transport'larını kendi yöneten bir host için bir
  alt katman. `client` **önceden bağlanmış** olmak zorunda: köprü upstream'in
  kimliğini ve capability'lerini aynalıyor.
- **`createToolCallGuard(options)`** — `engine`, `serverName`, `sessionId`, ve
  Faz 6/7'nin dolduracağı üç kanca:
  - `writeReport(decision) => string | undefined` — **proxy hiç dosya I/O'su
    yapmıyor**; ajana ve `structuredContent`'e giden rapor yolu bunun
    döndürdüğüdür. `report.dir` politikası CLI'nin işi.
  - `annotationsFor(toolName)` — sunucunun beyan ettiği davranış ipuçları. Bir
    `tools/list` önbelleği ister, o da CLI'nin işi. Yalnız
    `annotations.trust_hints: true` iken okunur (varsayılan `false`).
  - `onSessionEnd(summary)` — **Faz 3'ün notu buraya bağlanır:** semantik
    dedektör bir oturumun store'dan silindiğini göremez, o yüzden burada
    `detector.forget(sessionId)` çağrılır.
- **`SessionKeyResolver` + `sessionIdResolverFor`** — HTTP modunda çağrı başına
  session çözümü. `ToolCallGuardOptions.resolveSessionId` bunu alıyor;
  `undefined` dönmesi "bağlantının session'ını kullan" demek. Katı bir
  `session.key` çözülemediğinde isteği reddetmek servis giriş noktasının işi
  (P1).
- **`describeSessionRegime(resolution)`** — ADR-006'nın "araç hangi rejimin etkin
  olduğunu raporunda ve log'unda açıkça yazar" maddesinin tek cümlelik hali.
- **`Diagnostics`** — `--quiet` bunun `quiet` seçeneği. `emit(event, fields)`
  tek satır JSON, `block(text)` render edilmiş raporu olduğu gibi. Pakette
  stderr'e yazan başka hiçbir yol yok.
- **`buildTripResult` / `renderTripText` / `TRIP_META_KEY`** — `agentfuse report`
  komutunun okuyacağı yüzey.

Faz 6'nın ayrıca bilmesi gerekenler: `@modelcontextprotocol/node` kurulu değil
(Node HTTP köprüsü için ya yazılacak ya eklenecek), ve modern era servis etmek
`serveStdio`/`createMcpHandler` üzerinden zorunlu.

### `wip/phase-3-5-partial` artık tamamen aşıldı

Branch'teki altı dosyanın hepsi ya tutuldu ya yeniden yazıldı — Faz 3 üçünü,
Faz 5 diğer üçünü değerlendirdi ve kararlar yukarıdaki tablolarda. Branch'te
`main`'e girmemiş hiçbir şey kalmadı; **silinebilir.**

### Paralelleştirme dersi — hâlâ geçerli

Faz 3 ve 5 ayrık paketlere dokunduğu için bir kez paralel koşuldu ve bu kısım işe
yaradı: çakışma olmadı. Ama iki uzun ajanı birlikte koşturmak, makine uykuya
geçtiğinde **iki fazı birden** kaybettirdi, çünkü ikisi de commit atmamıştı. Ders
ikili: ya tek faz koşturun, ya da her ajana "ara commit at" talimatı verin. Faz 3
üç ara commit'le, Faz 5 de üç ara commit'le yürütüldü ve ikisinde de işe yaradı.

---

## Faz 6a — CLI tesisatı ve proxy dışı komutlar (bitti)

Dört commit: `373c240` tesisat (errors, io, args, config, tokenizer),
`f503322` rapor dizini + `onDecision` hook'u + opsiyonel embedding backend'i,
`58741ba` runtime, `c80c4db` komutlar + giriş noktası. `packages/cli/src`
ağacı:

```
main.ts                    ← process'e dokunan TEK dosya
cli.ts                     ← komut tablosu, CliError → exit code
index.ts                   ← CLI_VERSION + versionBanner()
errors.ts io.ts args.ts    ← tesisat: hata, stream, bayrak
config.ts                  ← fusepolicy.yaml bulma/okuma/doğrulama
tokenizer.ts               ← gpt-tokenizer o200k_base + CostModel
reports.ts                 ← .agentfuse/reports (proxy'nin writeReport dikişi)
hook.ts                    ← --hook ./hook.mjs (ADR-004)
embeddings.ts              ← dinamik import() + zarif düşüş tablosu
runtime.ts                 ← motoru, portları ve semantik katmanı kuran yer
commands/{init,validate,report,models,shared}.ts
testing/json-schema.ts     ← build ve coverage dışı
```

**`wrap` ve `serve` bilinçli olarak yazılmadı — Faz 6b.** `cli.ts` ikisini de
tabloda tutuyor ve `CliError` ile reddediyor (`exit 2`), çünkü tabloda
olmayan bir komut "yazım hatası yaptın" gibi görünür. `PHASE_6B_COMMANDS`
sabiti ve `cli.test.ts` içindeki "is the only part of the table that is not
wired up" testi, 6b bitince bu listenin boşalmasını zorunlu kılıyor.

### Taslak dosyalar hakkında verilen kararlar

Devralınan 14 dosya tek tek değerlendirildi. `wip/phase-6-partial` branch'ine
dokunulmadı.

| Dosya | Karar | Gerekçe |
| --- | --- | --- |
| `errors.ts` | **tutuldu**, testleri yazıldı + `messageOf` eklendi | `CliError` + `EXIT` tablosu + stack'siz format doğru kurulmuş. Tek ekleme: `error instanceof Error ? error.message : String(error)` ternary'si altı dosyada on kez tekrar ediyordu; tek bir `messageOf()` oldu ve test edildi (dinamik import'u reddeden `throw 'x'` bir `Error` değildir, `String({})` ise `[object Object]` yazar). |
| `io.ts` | **tutuldu**, testleri yazıldı | Stream'leri parametre yapma kararı ve `writeNotice` (prefix'li, çok satırlı, stderr-only uyarı) tamdı. Referans verdiği `discipline.test.ts` bu fazda yazıldı. |
| `args.ts` | **tutuldu**, `nearest`/`distance` yeniden yazıldı | `--` ayıracı, bildirilmiş bayraklar ve inline `=` doğru. Ama mesafe düz Levenshtein'dı: `--quite` → `quiet` 2 puan alıp `max(1, len/3)` = 1 bütçesini geçemiyordu, yani **en yaygın yazım hatası hiç öneri almıyordu**. Damerau'ya (transpozisyon = 1 düzenleme) ve DP tablosu yerine bütçeli özyinelemeye çevrildi; ikinci kazanç, `noUncheckedIndexedAccess` yüzünden var olan beş erişilemez `?? 0` dalının yok olması. Ayrıştırma döngüsü `argv.entries()`'e geçti, böylece `token === undefined` koruması da gerekmez oldu. |
| `config.ts` | **tutuldu**, YAML hata yolu yeniden yazıldı | Arama sırası, `LineCounter` ile Zod issue'sunu satıra bağlama ve `LoadedPolicy.dir` gerekçesi doğru ve savunulabilir. Üç hata düzeltildi, aşağıda. |
| `tokenizer.ts` | **tutuldu**, sayaç enjekte edilebilir yapıldı | `bytes/4` yerine gerçek BPE gerekçesi ADR-007'nin kendi gerekçesi. `allowedSpecial` kararı doğru: `count` senkron olarak `afterCall` içinde koşuyor, bir dosyanın içindeki `<|endoftext|>` yüzünden fırlatmak araç çağrısını düşürürdü. Fallback yolu test edilebilsin diye sayma fonksiyonu opsiyonel constructor parametresi oldu. |
| `reports.ts` | **tutuldu**, iki alan düzeltildi | "Yazma asla araç çağrısını düşürmez" kuralı ve kronolojik sıralanan dosya adı doğru. `ReportEntry.trippedAt` "ISO-8601, raporun kendisinden okunur" diye belgelenmişti; ikisi de yanlıştı (`:` ve `.` değiştirilmiş, ve ad'dan okunuyor) — `stamp` oldu ve doğru belgelendi. `find()` `resolve(reference)` ile ortam cwd'sini okuyordu; artık store'un kendi dizinine göre çözüyor. |
| `hook.ts` | **tutuldu**, testleri yazıldı | Dosya URL'siyle import, `default` sonra `onDecision`, ikisini de adıyla anan hata mesajı. Fırlatan hook'un core'da yakalandığını yeniden uygulamaması doğru karar. |
| `embeddings.ts` | **tutuldu**, `SemanticRequest.model` eklendi | Karar tablosu ADR-001 ve ADR-003'ten doğru türetilmiş; `wanted` hesabının **her kuralın** birleşmiş ayarına bakması (global `false` altında tek bir kural `true` diyebilir) ince ve doğru bir nokta. Tek değişiklik: `request.models[0] ?? 'Xenova/…'` üç yerde şemanın varsayılanının ikinci kopyasıydı ve erişilemezdi; `model` alanı tek geçişte dolduruluyor ve `wanted` ile birlikte boş kalıyor. |
| `runtime.ts` | **yeniden yazıldı** (iskeleti korundu) | Port enjeksiyonu, uyarılar ve semantik bağlama iyiydi ve kaldı. İki hata: `endSession(sessionId)` "oturumu bitirir ve dedektöre söyler" diye belgelenmişti ama yalnız `forget()` çağırıyordu — proxy oturumu zaten bitirip **özeti** veriyor, o yüzden alan `onSessionEnd(summary)` oldu ve bağlandığı kancayla aynı imzaya kavuştu. `withTimeout` `ms <= 0` için verilen promise'i hiç ele almadan dönüyordu: kapanışta reddeden bir provider "unhandled rejection" üretir, ki Node 20+ bunu process'i düşürerek karşılar. Ayrıca 6b'nin ihtiyaç duyduğu `writeReport`, `quiet` ve `onSessionEnd` alanları yüzeye çıkarıldı. |
| `commands/init.ts` | **tutuldu**, testleri yazıldı | Başlangıç dosyası bir ürün yüzeyi olarak ele alınmış: `mode: warn` açık yazılmış, `$schema` satırı ilk satırda, `max_usd_estimated` kendi uyarısıyla, çapa limitler tahminlerden önce. Yayınlanmış JSON Schema'ya karşı doğrulanıyor ve geçiyor. |
| `commands/validate.ts` | **tutuldu**, bir satır yeniden yazıldı | "Neyin yanlış olduğunu söyle" + "neyin doğru olduğunu söyle" ayrımı doğru. `found via` satırı iç içe üç ternary'ydi ve `env` durumunda `--env (AGENTFUSE_POLICY)` yazıyordu — var olmayan bir bayrak. `describeOrigin()` oldu. |
| `commands/report.ts` | **tutuldu**, iki değişiklik | Metni yeniden render etmemesi doğru karar. `Diagnostics.block()` kullanımına geçti (aşağıda). `list`, okunamayan bir dosya yüzünden tüm listelemeyi düşürüyordu; artık o satırı `UNREADABLE` diye gösteriyor. |
| `commands/models.ts` | **tutuldu**, bir mesaj düzeltildi | Komutun asıl ürünü başarısızlık mesajı olduğu için doğru yerde emek harcanmış. Kullanıcıya giden ipucundan `ADR-003` atıfı çıkarıldı: kullanıcı ADR'ları hiç görmedi. Bir test artık kullanıcı mesajlarında `ADR-\d` bulunmamasını zorluyor. |
| `commands/shared.ts` | **yarısı silindi** | `asMode` kaldı. `asPort` atıldı: yalnız `serve`'in bayrağı ve `serve` 6b'nin. Kullanılmayan bir yardımcıyı test etmek, olmayan bir komutun tasarımını şimdiden dondurmak olurdu. |

Taslakta hiçbir dosya tümüyle atılmadı; hiçbiri kayda geçmiş bir kararla
çelişmiyordu. `main.ts` (Faz 1'in 6 satırlık stub'ı) değiştirildi ve dispatch
`cli.ts`'e ayrıldı.

### Taslakta bulunan hatalar — hepsi testle kapatıldı

1. **`prettyErrors: false` satır numaralarını yok ediyor.** `yaml`'ın
   `YAMLError.linePos` alanı yalnız `prettyErrors` açıkken doluyor, ama
   `prettyErrors` `message`'ı da kendi pozisyonu ve kod çerçevesiyle yeniden
   yazıyor. Taslak `prettyErrors: false` verip `linePos`'u okuyordu, yani
   **bozuk YAML mesajlarının hiçbirinde satır yoktu.** Artık pozisyon,
   Zod issue'larının kullandığı `LineCounter` üzerinden `error.pos[0]`'dan
   hesaplanıyor; dosyadaki her problem satırı tek bir biçimde.
2. **Fırlatan adım `toJS()`, `parseDocument()` değil.** `parseDocument`
   sorunları `document.errors`'da topluyor, hiç fırlatmıyor — taslağın
   try/catch'i ölü koddu. Fırlatan yer, anchor/alias'ları çözen
   `document.toJS()`: çözülmemiş bir `*alias` ve `maxAliasCount`'un
   durdurduğu genişleme bombası. Korumasızdı, yani bir YAML bombası
   kullanıcıya AgentFuse'un iç stack'ini gösterirdi.
3. **Transpozisyon öneri alamıyordu** (yukarıda, `args.ts`).
4. **`withTimeout(…, 0)` promise'i sahipsiz bırakıyordu** (yukarıda,
   `runtime.ts`).
5. **`onSessionEnd` imzası kancayla uyuşmuyordu** (yukarıda, `runtime.ts`).

### Politika dosyası arama sırası ve gerekçesi

`findPolicyFile` sırayla dener; **her basamak testli**:

1. **`--policy <path>`** — açık talimat. Var olmayan bir yol **hata**dır ve
   asla aramaya düşmez. Operatörün adını verdiğinden başka bir politikayı
   sessizce uygulamak, limit uygulamak için var olan bir araç için mevcut en
   kötü sonuçtur.
2. **`AGENTFUSE_POLICY`** — aynı katılıkta. Kolaylık değil **gereklilik**: bir
   MCP istemcisinin sunucu yapılandırması `env` ve `args` vermeye izin verir,
   ama çalışma dizini genellikle kullanıcının seçimi değildir (sık sık `/`),
   yani bazen tek kanal budur.
3. **Yukarı doğru arama** — `cwd`'den dosya sistemi köküne, her dizinde
   `fusepolicy.yaml` → `fusepolicy.yml` → `.agentfuse/fusepolicy.yaml` →
   `.agentfuse/fusepolicy.yml`. Yukarı, çünkü bir deponun politikası o deponun
   herhangi bir alt dizininde başlatılan ajana uygulanmalı — `tsconfig.json` ve
   `.editorconfig` ile aynı gerekçe. `.git` sınırında durmuyor, böylece
   kullanıcı home dizinine kişisel bir varsayılan koyabilir; çözülen absolute
   yol her zaman `policy_loaded` diagnostic'inde ve `validate` çıktısında
   bildirildiği için şaşırtıcı bir seçim gizemli değil görünür olur.

`.yaml` önce, çünkü dokümanlar, `init` ve JSON Schema ilişkilendirmesi hep
`.yaml` diyor; `.yml` yine kabul ediliyor ki ötekini yazan kullanıcıya "dosyan
yok" denmesin.

**Politika içindeki relatif yollar politika dosyasına göre çözülür**, process
cwd'sine göre değil (`LoadedPolicy.dir` + `resolveFromPolicy`). Bir MCP
istemcisi `agentfuse wrap`'i kullanıcının seçmediği bir dizinde başlatır, yani
`report.dir: .agentfuse/reports` "onu isteyen politikanın yanı" demek zorunda;
aksi halde raporlar kimsenin bakmadığı bir yere düşer.

**Varsayılanlar tek bir yerden gelir:** core'daki Zod şeması. `config.ts`
hiçbir yerde kendi fallback değerini vermiyor — ikinci bir varsayılan kopyası
birinciden sapar ve yayınlanmış JSON Schema o zaman insanların editörüne
runtime'ın inanmadığı bir şey söyler. Bunun tek istisnası
`commands/models.ts`'teki `DEFAULT_MODEL`, ve o bilinçli: `models install`
politika **olmadan** da koşmak zorunda, çünkü `init`'in çıktısı modeli
politikadan önce kurmayı öneriyor.

### Embedding yoksa ne olur — uygulanan tam tablo

`resolveEmbeddingProvider` (`embeddings.ts`) tek karar noktası; dört satırın
dördü de ayrı testle pinli.

| Yapılandırma | Paket kullanılabilir | Sonuç |
| --- | --- | --- |
| `semantic.enabled: false` | — | dedektör **hiç bağlanmaz**, sessizce. Kapalı olmasını istemek ve kapalı bulmak bir düşüş değildir. Bu satır `mode: enforce`'ta da sessizdir. |
| `semantic.provider: none` | — | aynısı. Belgelenmiş kapatma anahtarı budur. |
| `provider: local` | var | bağlanır (`attachSemanticLoopDetector`). |
| `provider: local` + `mode: warn` | yok | **stderr'e uyarı, koşum devam eder**, kural katmanı **tam güçte**. ADR-001'in "crippleware yasak" maddesi bu satırın gerekçesi; testi de kelimesi kelimesine bunu ölçüyor: paket yokken `exact_repeat` üçüncü çağrıda tripliyor. |
| `provider: local` + `mode: enforce` | yok | **ilk çağrıdan önce hard error** (`exit 4`). Operatör "benim adıma devreyi kes" dedi; adı geçen dedektörlerden biri yokken yine de başlamak, aracın istenen korumanın bir alt kümesinin yeterince yakın olduğuna sessizce karar vermesi olurdu. |
| `provider: openai` (herhangi bir mod) | — | bu sürümde backend yok; `warn`'da uyarı, `enforce`'ta hata. Hiç bağlamayıp raporun skorladığını ima etmesine izin vermekten iyi. |
| paket var ama `createEmbeddingProvider` yok | — | yukarıdaki iki satırın aynısı, **farklı mesajla**: "kur" ile "güncelle" farklı talimatlardır. |

**Faz 4 için taşıyıcı not:** bu monorepo içinde `@agentfuse/embeddings-local`
specifier'ı **çözülüyor** — npm workspaces her paketi `node_modules`'a
symlink'liyor ve import Faz 1'in stub'ını buluyor. Stub iki factory'den
hiçbirini export etmediği için CLI "kurulu ama eski" satırını alıyor, ki doğru
davranış bu. `embeddings.test.ts` her iki durumu da (çözülür / çözülmez)
kapsıyor, böylece Faz 4 stub'ı gerçek implementasyonla değiştirdiğinde test
kırılmaz ama boşluk da kalmaz.

**Bağımlılık yönü bir testle zorlanıyor.** `discipline.test.ts`
`packages/cli/package.json`'ın `dependencies`, `devDependencies`,
`peerDependencies` ve `optionalDependencies` alanlarının hiçbirinde
`@agentfuse/embeddings-local` olmamasını; `tsconfig.json`'da ona project
reference olmamasını; ve kaynakta yalnız `import(EMBEDDINGS_PACKAGE)` biçiminde
geçmesini (statik specifier'lı `from '…'` biçiminde hiç geçmemesini)
kontrol ediyor. Ayrıca CLI'nin bildirdiği bağımlılık listesinin tam olarak Faz
1'in tablosu olmasını pinliyor: `@agentfuse/core`, `@agentfuse/proxy`,
`gpt-tokenizer`, `yaml`. Precedent core'un `purity.test.ts`'i.

### stdio disiplini

Aynı `discipline.test.ts` **`main.ts` dışında hiçbir kaynak dosyanın**
`console.*`, `process.stdout`, `process.stderr` ya da `process.exit`'e
dokunmamasını zorluyor. Wrap modunda bu process'in stdout'u ajanın JSON-RPC
akışıdır; paylaşılan bir modüldeki tek bir `console.log` ondan sonraki her
frame'i bozar ve suç sarılan sunucuya kalır. Bu yüzden her komut bir
`CliContext` alır ve bir sayı döndürür; gerçek stream'leri, `argv`'yi, `cwd`'yi
ve exit code'u bağlayan tek yer `main.ts`.

`process.exit()` değil `process.exitCode`: `exit()` son yazmayı — yani neyin
yanlış gittiğini anlatan hata mesajını — kesebilir.

`report` ve `validate`'in stdout'a yazması beklenen ve doğru: ikisi de proxy
yolunda değil.

### `report` neden `Diagnostics.block()` kullanıyor

Core'un `renderTripReport`'u kutu çizgili bir tablo üretiyor. `Diagnostics`'in
`emit()`'i her satıra prefix basar ve bu tabloyu mahveder; `block()` Faz 5'te
tam bunun için eklendi: bir işaret satırı, sonra metin **olduğu gibi**. `report`
onu stdout'a bağlı bir `Diagnostics` üzerinden yazıyor, böylece canlı bir trip
ile sonradan okunan rapor birebir aynı görünüyor.

**Bilinen ödünç:** bu, stdout'a bir `[agentfuse] {"event":"trip_report",…}`
satırı da koyuyor, yani `agentfuse report last > incident.txt` o satırı da
alıyor. Makine yolu bilinçli olarak temiz bırakıldı: `--json` core'un yazdığı
dokümanı hiçbir şeye sarmadan veriyor. Faz 7 rapor UX'ini elden geçirirken bu
işaret satırını kaldırmak isterse, karar noktası burası.

### `init`'in çıktısı yayınlanmış şemaya karşı doğrulanıyor

Zod şemasına karşı değil: `z.toJSONSchema` onun bir **projeksiyonu** ve ikisi
ayrışabilir. Runtime'ın kabul ettiği ama editörün kırmızıyla altını çizdiği bir
başlangıç dosyası, tam olarak yakalanmaya değer hata. Bunun için bir JSON
Schema doğrulayıcı gerekti ve faz brifingi yeni bağımlılık yasakladı (haklı
olarak: tek test için `ajv` iyi bir takas değil). Şema on dört anahtar kelime
kullanıyor, hepsi yapısal — `src/testing/json-schema.ts` kırk satır.

**Doğrulayıcının kendisi test ediliyor:** `init.test.ts` ona dokuz bilinen
ihlali (yazım hatalı key, eksik `version`, yanlış `mode`, bozuk süre, tam sayı
olmayan sayaç, 1'in üstünde `threshold`, `action`'sız kural, geçersiz `action`,
tümüyle yanlış tip) reddettirmeden başlangıç dosyasını kabul etmesine
güvenmiyor. Her şeyi sessizce geçiren bir doğrulayıcı, hiç test olmamasından
kötüdür.

`init`'in yazdığı dosya ayrıca `parsePolicy` ile de geçiriliyor (iki artefakt,
ikisi de yanlış olabilir) ve yalnız bir yerde şemanın varsayılanından sapıyor:
`budgets.on_exceeded: halt`. Gerekçe dosyanın kendi yorumunda: cevaplanamayan
bir onay, fazladan adımı olan bir rettir, ve onay akışı Faz 7'de.

### Faz 6b'nin `runtime.ts`'ten alacağı şey

`createRuntime(options)` → `Runtime`; `wrapStdioServer`'ın istediği argüman
kümesi bu ve fazlası değil. 6b'nin yapacağı çağrı aşağı yukarı şudur:

```ts
const flag = args.value('policy');
const loaded = loadPolicy({ flag, env: ctx.env, cwd: ctx.cwd });
const runtime = await createRuntime({
  loaded, context: ctx,
  quiet: args.bool('quiet'),
  mode: asMode(args.value('mode')),
  hook: args.value('hook'),
});
const handle = wrapStdioServer({
  command, args: childArgs, env, cwd,
  engine: runtime.engine,
  serverName,
  diagnostics: runtime.diagnostics,   // --quiet zaten içinde
  writeReport: runtime.writeReport,   // proxy dosya I/O'su yapmıyor
  onSessionEnd: runtime.onSessionEnd, // Faz 3'ün forget() notası burada
});
// kapanışta:
await handle.close();
await runtime.close();      // sayaçları loglar, provider'ı bırakır
```

Alan alan:

- **`engine`** — portları bağlanmış `FuseEngine`. `tokenizer` ve `cost` CLI'nin,
  `clock`/`ids`/`sessions` core'un varsayılanları. `--hook` verilmişse hook
  zaten `onDecision` ile kayıtlı.
- **`writeReport`** — `ToolCallGuardOptions.writeReport` imzasında, rapor
  store'una bağlı. Ajanın kesinti metninde göreceği yol bunun döndürdüğüdür;
  asla fırlatmaz, başarısız olursa `undefined` döner ve `report_write_failed`
  diagnostic'i yazar.
- **`onSessionEnd`** — `ToolCallGuardOptions.onSessionEnd` imzasında
  (`(summary: SessionSummary) => void`), `detector.forget(summary.sessionId)`
  çağırır. Proxy oturumu **kendisi** bitiriyor (`stdio-wrap.ts` içinde
  `instance.endSession()`), o yüzden 6b `engine.endSession`'ı elle çağırmamalı.
- **`diagnostics`** — `--quiet` bunun `quiet` seçeneğine geçmiş durumda;
  `wrapStdioServer`'a `quiet` yerine bunu geçin, yoksa iki ayrı
  `Diagnostics` (biri startup uyarıları için, biri proxy için) kurulur ve
  rate-limit pencereleri ayrışır.
- **`policy`** — `--mode` uygulanmış hali. `engine.policy.sha256` bunun hash'i;
  `--mode` gerçekten değiştirdiyse dosyanın hash'inden farklıdır ve olması
  gereken de bu.
- **`reports`** — `FileReportStore`; `dir` alanı `report.dir`'in çözülmüş hali.
  `agentfuse report`'un okuduğu yer.
- **`detector`** — `SemanticLoopDetector | undefined`. `undefined` olması bir
  hata değil, tablonun üç satırının normal sonucu.
- **`close({ timeoutMs })`** — semantik sayaçları `semantic_stats` olarak
  yazar, sonra `detector.close()`'u **sınırlı** bekler (varsayılan 2000 ms).
  Sınırlı, çünkü `close()` uçuştaki batch'i ve provider'ın kendi `close()`'unu
  bekliyor; takılmış bir model o await'i takar ve kapanan bir proxy gerçekten
  kapanmak zorundadır. İki kez çağrılabilir.

**`runtime.ts`'te olmayan ve 6b'nin yazacağı şeyler:**

- `annotationsFor(toolName)` — `annotations.trust_hints: true` iken okunan
  sunucu ipuçları. Bir `tools/list` önbelleği ister; önbellek bağlantı başına
  ve bridge'in yanında yaşamalı, o yüzden runtime'ın işi değil.
- `resolveSessionId` — yalnız HTTP; `sessionIdResolverFor` proxy'de hazır.
- `clientCapabilities` — Faz 5'in çelişki kaydı #5: proxy varsayılan olarak
  `RELAYABLE_CLIENT_CAPABILITIES` beyan ediyor ve CLI bunu ezebilir.
- `serverName` — sarılan sunucunun takma adı. Her fingerprint'in parçası, yani
  bir bayrak (`--name`) ve varsayılanı hak ediyor; runtime onu görmüyor.
- `asPort` — `--port` ayrıştırıcısı. Taslakta vardı, `serve` ile birlikte
  gelmesi için silindi.

**Hatırlatma (Faz 5'ten):** modern era'yı elle `new Server()` ile servis etmek
mümkün değil, `serveStdio`/`createMcpHandler` zorunlu; ve
`@modelcontextprotocol/node` kurulu değil, yani `serve`'in Node HTTP köprüsü ya
yazılacak ya o paket eklenecek. HTTP gateway'in kendisi P1 ve kendi ADR'ını hak
ediyor (Faz 5 §çelişki kaydı #4).

### Faz 6a'nın çelişki kaydı

1. **`report`'un stdout'una giden işaret satırı** (yukarıda). Brifing
   `Diagnostics.block()` kullanılmasını istedi ve öyle yapıldı; `block()`'un
   ayrılmaz parçası olan JSON işaret satırı bu yüzden stdout'a düşüyor.
   Alternatifi metni satır satır yazmaktı, ki bu da brifingin adını verdiği
   API'yi kullanmamak olurdu. Kayda geçirildi, sessizce sapılmadı.
2. **`AGENTFUSE_POLICY` brifingde yoktu.** Brifing "bir CLI bayrağı override'ı
   ve bir arama sırası" istiyordu; ortam değişkeni basamağı eklendi çünkü bir
   MCP istemcisinin sunucu yapılandırmasında çalışma dizini kullanıcının
   seçimi değil ve bazen tek kanal bu. Kapsam değiştiren bir karar değil, ama
   brifingde olmayan bir yüzey.
3. **`core` ve `proxy` değiştirilmedi.** Kapatılması gereken gerçek bir boşluk
   çıkmadı; `writeReport`, `onSessionEnd`, `Diagnostics.block()` ve
   `renderTripReport` dikişlerinin hepsi olduğu gibi yeterliydi. Faz 5'in
   bıraktığı seam listesinden yalnız `annotationsFor` ve `resolveSessionId`
   tüketilmedi ve ikisi de 6b'nin.

---

## Sırada ne var

### Faz 6b — `wrap` ve `serve`, kritik yol buradan geçiyor

Faz 6a'nın bıraktığı her şey hazır ve testli; kalan iş transport ve child
process. Ne alınacağı yukarıdaki "Faz 6b'nin `runtime.ts`'ten alacağı şey"
başlığında alan alan yazılı, örnek çağrı dahil. Üç kısa madde:

- `agentfuse wrap` neredeyse tümüyle `wrapStdioServer()` çağrısıdır; politika
  yükleme, `Tokenizer`/`CostModel` portları, `writeReport`, `onSessionEnd`,
  `--quiet`/`--mode`/`--hook` ve semantik katman **6a'da bitti** —
  `createRuntime()` hepsini kuruyor.
- `cli.ts` ikisini de tabloda tutuyor ve `CliError` ile reddediyor;
  `PHASE_6B_COMMANDS` listesi boşalınca `cli.test.ts`'teki "is the only part of
  the table that is not wired up" testi de doğal olarak boş listeyi bekler hale
  gelmeli. `--` ayıracı `args.ts`'te hazır ve testli: `wrap -- node server.mjs
  --verbose` çocuğun `--verbose`'una dokunmuyor.
- **Modern era'yı elle `new Server()` ile servis etmek mümkün değil** —
  `serveStdio` / `createMcpHandler` zorunlu, gerekçe Faz 5 bölümünde.
  `@modelcontextprotocol/node` kurulu değil, yani `serve` komutunun Node HTTP
  köprüsü ya yazılacak ya o paket eklenecek; HTTP gateway'in kendisi P1 ve
  kendi ADR'ını hak ediyor (Faz 5 §çelişki kaydı #4).

### Faz 4 — `@agentfuse/embeddings-local`

**Ayrı koşulmalı:** `onnxruntime-node` kurulumu 301 MB indirir ve postinstall
çalıştırır; eşzamanlı `npm install`'la çakışmaması için tek başına. Kullanıcıya
kurulum öncesi haber verin.

Yığın: ham `onnxruntime-node@1.30.0` + `@huggingface/tokenizers@0.2.0` (361 KB,
sıfır dep). `@huggingface/transformers` reddedildi (`sharp` çekiyor, ORT
1.24.3'e pinliyor), `fastembed` reddedildi (bakımsız, ORT 1.21'e pinli). Model
`Xenova/all-MiniLM-L6-v2` int8 (~23 MB), `~/.cache/agentfuse/models/`
(`XDG_CACHE_HOME` gözetilir), sha256 doğrulamalı, `AGENTFUSE_OFFLINE=1` ile
kapatılabilir. Kabul kriteri: **başka hiçbir paket buna bağımlı olmamalı.**

Not: Faz 1'de `embeddings-local` `@agentfuse/core`'a bağlanmadı, bu yüzden
`src/index.ts` `EmbeddingBackend` arayüzünü yerel tanımlıyor. Faz 4 bunu core'un
dondurulmuş `EmbeddingProvider`'ıyla değiştirmeli ve tsconfig `references`'ını
düzeltmeli.

### Faz 7–10

Plan dosyasındaki brifingler geçerli. Kısaca: Faz 7 onay akışı (unix socket +
webhook); Faz 8 OTLP telemetri (kapalıyken **sıfır** OTel modülü yüklenmeli);
Faz 9 benchmark'lar ve eşik kalibrasyonu; Faz 10 dokümanlar ve v0.1.0.

Faz 7 için proxy'nin bıraktığı iki not: `ApprovalGateway` portu core'da duruyor
ve timeout'un sahibi gateway (Faz 2 kararı), yani proxy o yolda hiçbir şey
yapmıyor — `beforeCall` enforce modunda onayı kendi çözüyor. Yazılı rapor
`ToolCallGuardOptions.writeReport` kancasından geçiyor; **proxy hiç dosya I/O'su
yapmıyor** ve ajana gösterdiği rapor yolu o kancanın döndürdüğüdür.

**Faz 9 yalnız test değil, ürünün sayısal iddiasıdır.** PRD §6 eşikleri —
recall ≥ 0.90, FP < 0.05, p95 eklenen < 50 ms — CI'da kapı olur. Corpus'un
negatif tarafı (yanlış pozitif tuzakları: pagination taraması, N benzer dosyanın
toplu düzenlenmesi, dene-sonra-düzelt, yakınsayan build-test döngüsü) pozitif
tarafı kadar önemli. Eşikler tutmuyorsa **yumuşatılmaz** — algoritma ya da
corpus düzeltilir. Şemadaki `threshold`/`window`/`consecutive_windows`
varsayılanları yer tutucudur ve bu fazın ROC taramasından kesinleşir.

---

## Çalışma kuralları

- **`.ssot` koddan önce gelir** (çatı ADR-002). Kapsam değiştiren geliştirme
  öncesi `../.ssot/PRD.md` ve `../.ssot/ADR.md` güncellenir.
- Her fazın kapısı: `npm run lint && npm run typecheck && npm run build && npm test`
  ve `npm run schema:check`. **Yeşile ulaşmak için tsconfig katılığı
  gevşetilmez, lint kuralı kapatılmaz, coverage eşiği düşürülmez** — kod
  düzeltilir. Bir Biome kuralı gerçekten haklı bir desenle çatışıyorsa o satırda
  gerekçeli yorumla daraltılmış şekilde kapatılır.
- **Commit mesajlarına hiçbir trailer eklenmez** — `Co-Authored-By`,
  `Generated with`, oturum bağlantısı, `Signed-off-by` yok. Mesaj anlatımın son
  cümlesiyle biter.
- Paralel ajan koşuyorsa `git add` yalnız kendi yollarını açıkça stage'ler,
  asla `git add -A`.
