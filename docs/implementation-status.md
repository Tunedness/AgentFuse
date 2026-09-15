# AgentFuse — uygulama durumu ve devir notu

**Son güncelleme:** 2026-09-15 · **`main`'deki son kod commit'i:** `ebce8f0`
(`main` HEAD bunu izleyen bu doküman commit'i) · **Durum:** Faz 5 bitti, kritik
yol Faz 6'ya geçti

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
| 6 | CLI (`agentfuse`) | Başlanmadı |
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
npm run lint          → Checked 109 files. No fixes applied.
npm run typecheck     → temiz (tsc -b && tsc -p tsconfig.test.json)
npm run build         → temiz
npm test              → Test Files 28 passed · Tests 633 passed (2.45 s)
npm run schema:check  → schema up to date
```

Coverage kapısı `vitest.config.ts` içinde `packages/core/src/**` için %90'da ve
**gerçekten zorluyor** (Faz 2'de 100'e çekilip kasten kırılarak doğrulandı).
Faz 5 sonundaki ölçümler (`coverage/lcov.info` üzerinden, glob bazında):

| Paket | lines | functions | branches |
| --- | --- | --- | --- |
| `packages/core/src/**` (kapılı) | %99.89 | %100 | %95.45 |
| `packages/proxy/src/**` (kapısız) | %98.88 | %100 | %91.18 |

Kapı yalnız core'da, ama proxy de bilinçli olarak aynı çubuğun üstünde tutuldu;
sayıyı şişirmemek için yazılmamış tek test yok. Metin reporter'ının `proxy/src`
satırı: statements %98.46, branches %91.17, functions %100, lines %98.87.
Karşılaştırma için Faz 3 sonunda "All files" %99.24 / %95.47 / %100 / %99.78
idi; artık bu satır tüm paketleri kapsıyor ve %99.03 / %93.95 / %100 / %99.53.

`packages/proxy/src/testing/` coverage'dan ve paket build'inden muaf: içindeki
harness'lar ve senaryo dublörleri `.test.ts` ile bitmediği halde test
iskelesidir, ve yayınlanmaları her senaryoyu public kontrata çevirirdi.

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

## Sırada ne var

### Faz 6 — CLI, kritik yol buradan geçiyor

Tam brifingi plan dosyasında. Komutlar: `wrap`, `serve`, `init`, `validate`,
`report`, `models install`. Proxy tarafı hazır; Faz 6'nın bağlanacağı dikişler
yukarıdaki "Faz 6'nın bağlanacağı dikişler" başlığında tek tek sayıldı. Oradan
çıkarılacak üç kısa madde:

- `agentfuse wrap` neredeyse tümüyle `wrapStdioServer()` çağrısıdır; CLI'nin
  eklediği şey politika yükleme (`yaml` + `parsePolicy`), `gpt-tokenizer`
  tabanlı `Tokenizer` portu, rapor yazan `writeReport` kancası ve
  `--quiet`/`--mode` bayrakları.
- Semantik katman CLI'de dinamik `import()` ile aranır; bulunursa
  `attachSemanticLoopDetector` ile bağlanır ve `onSessionEnd` içinde
  `detector.forget(sessionId)` çağrılır.
- **Modern era'yı elle `new Server()` ile servis etmek mümkün değil** —
  `serveStdio` / `createMcpHandler` zorunlu, gerekçe Faz 5 bölümünde.
  `@modelcontextprotocol/node` kurulu değil, yani `serve` komutunun Node HTTP
  köprüsü ya yazılacak ya o paket eklenecek.

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
