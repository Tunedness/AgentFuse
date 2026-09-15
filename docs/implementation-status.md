# AgentFuse — uygulama durumu ve devir notu

**Son güncelleme:** 2026-09-15 · **`main` HEAD:** `abd96d8` · **Durum:** Faz 3 bitti,
Faz 5 yarıda kaldı

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
| 5 | `@agentfuse/proxy` (MCP adaptörü) | **Yarıda** — `wip/phase-3-5-partial` |
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
npm run lint          → Checked 86 files. No fixes applied.
npm run typecheck     → temiz
npm run build         → temiz
npm test              → Test Files 19 passed · Tests 348 passed (614 ms)
npm run schema:check  → schema up to date
```

Coverage kapısı `vitest.config.ts` içinde `packages/core/src/**` için %90'da ve
**gerçekten zorluyor** (Faz 2'de 100'e çekilip kasten kırılarak doğrulandı).
Faz 3 sonundaki ölçüm: statements %99.24, branches %95.47, functions %100,
lines %99.78. Faz 2 sonundaki değerler karşılaştırma için: %99.05 / %94.85 /
%100.

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
- **Faz 5:** dedektör `attachSemanticLoopDetector({ host: engine, provider, clock,
  telemetry })` ile bağlanır; oturum kapanışında `forget()`, kapanışta `close()`.
  Provider bulunamazsa hiç bağlamayın — kural katmanı tam işlevli kalır.
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

## Faz 5 — yarıda kaldı

**Neyin yanlış gittiği:** Faz 3 ve 5 paralel koşarken makine uykuya geçti, iki
ajan da yanıt ortasında koptu. İkisi de ciddi iş çıkarmıştı ama hiçbiri bitirmedi
ve commit atmadı. Faz 3 o zamandan beri bitirildi; geri kalan Faz 5'tir.

Kısmi çıktı **`wip/phase-3-5-partial`** branch'inde (`798720b`) duruyor —
`main`'i yeşil bırakmak için oraya park edildi. O dosyalar:

- typecheck ve lint'ten **geçiyor**,
- mevcut testleri **kırmıyor**,
- ama **hiçbirinin tek testi yok** ve **hiçbiri proxy'ye bağlı değil**,
- bu yüzden coverage kapısı onları olduğu gibi kabul etmez.

| Dosya | Boyut | Ne | Eksik |
| --- | --- | --- | --- |
| `packages/proxy/src/era.ts` | 6.6k | era tespiti | testler |
| `packages/proxy/src/remap.ts` | 7.5k | progressToken + requestId haritaları | testler, sızıntı testi |
| `packages/proxy/src/diagnostics.ts` | 3.6k | stderr disiplini | testler |

Faz 5'ten eksik: `bridge.ts`, `tools-call.ts`, `trip-result.ts`,
`stdio-wrap.ts`, `http-serve.ts`, tüm testler.

**Bu dosyaları gözden geçirilecek taslak sayın, üzerine inşa edilecek temel
değil.** Devam eden kişi dosya bazında tut/yeniden yaz/at kararı vermeli — Faz 3
üçünden ikisini tuttu, birini yeniden yazdı.

### Paralelleştirme dersi

Faz 3 ve 5 ayrık paketlere dokunduğu için paralel koşuldu ve bu kısım işe
yaradı — çakışma olmadı. Ama iki uzun ajanı birlikte koşturmak, makine uykuya
geçtiğinde **iki fazı birden** kaybettirdi. Bir sonraki denemede ya tek faz
koşturun, ya da her ajana "ara commit at" talimatı verin. Faz 3 ikinci denemede
üç ara commit'le yürütüldü ve bu işe yaradı.

---

## Sırada ne var

### Faz 5'i bitir — kritik yol buradan geçiyor

Tam brifingi plan dosyasında. Özet gereksinimler:

**Faz 5 — MCP proxy.** Topoloji: **downstream bağlantı başına bir upstream
`Client`.** Multiplekslemek sampling/elicitation/roots'u kırıyor, çünkü legacy
era'da sunucu bunları çağıranı belirtmeden push ediyor.

`McpServer` değil düşük seviyeli `Server`; açık handler yalnız `tools/call` ve
`tools/list`; gerisi `fallbackRequestHandler`/`fallbackNotificationHandler`'dan
körlemesine iletilir.

**`bridge.ts`, `era.ts`, `remap.ts` `@agentfuse/core`'u import etmez.** McpGuard
ADR'ı bu iskeletin ileride paylaşılan bir iç pakete çıkarılacağını söylüyor;
temiz tutmak o günü yeniden yazma işi olmaktan kurtarıyor. Motoru yalnız
`tools-call.ts` ve `trip-result.ts` tanır.

Kesinti ajana **`isError: true` sonucu** olarak döner, JSON-RPC hatası olarak
değil. Spec'in `isError`'ı var etme gerekçesi bu: model reddi görüp kendini
düzeltsin, çökmesin. Metin **ürün yüzeyidir**, snapshot testiyle korunur ve
mutlaka "değiştirilmeden yapılan yeniden denemeler de bloklanacak" cümlesini
içerir — yoksa ajan devre kesiciyi sıkı bir döngüde yeniden dener ve birincinin
üstüne ikinci bir döngü kurmuş olursunuz. Her `TripCode` için ayrı varyant:
bütçe tükenmesi ile semantik döngü farklı tavsiye gerektirir.

wrap modu: child `stdio: ['pipe','pipe','inherit']` ile doğar, **stderr bayt bayt
dokunulmadan akar** (stdio MCP sunucuları her şeyi stderr'e loglar; bozmak
AgentFuse'u sunucuyu kıran şey gibi gösterir). **stdout'a protokol frame'inden
başka hiçbir şey yazılmaz** — tek bir `console.log` JSON-RPC akışını bozar.

**Faz 5'in raporlaması gereken, Faz 6 için taşıyıcı bilgi:** kurulu SDK v2
API'sinin gerçekte nasıl göründüğü — özellikle `fallbackRequestHandler` /
`fallbackNotificationHandler` public tiplerde var mı, ve cancellation nasıl
yüzeye çıkıyor.

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

### Faz 6–10

Plan dosyasındaki brifingler geçerli. Kısaca: Faz 6 CLI (`wrap`, `serve`,
`init`, `validate`, `report`, `models install`); Faz 7 onay akışı (unix socket +
webhook); Faz 8 OTLP telemetri (kapalıyken **sıfır** OTel modülü yüklenmeli);
Faz 9 benchmark'lar ve eşik kalibrasyonu; Faz 10 dokümanlar ve v0.1.0.

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
