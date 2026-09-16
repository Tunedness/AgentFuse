# AgentFuse — uygulama durumu ve devir notu

**Son güncelleme:** 2026-09-16 · **`main`'deki son kod commit'i:** `8c89a3d`
(`main` HEAD bunu izleyen bu doküman commit'i) · **Durum:** Faz 9 bitti;
geriye yalnız Faz 10 (doküman + v0.1.0) kaldı. **PRD §6'nın tespit hedefi
karşılanmıyor** (ölçülen %87, hedef %90) — bkz. Faz 9 bölümü ve "Sırada ne
var".

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
| 4 | `@agentfuse/embeddings-local` | **Bitti** — `97c836c` `f999fb9` `146b709` |
| 5 | `@agentfuse/proxy` (MCP adaptörü) | **Bitti** — `ebce8f0` |
| 6 | CLI (`agentfuse`) | **Bitti** — 6a: `373c240` `f503322` `58741ba` `c80c4db` · 6b: `54d858e` `19c96f8` `7447c48` |
| 7 | Onay akışı + rapor UX | **Bitti** — `84b903e` `935146d` `a7a8ddc` |
| 8 | Telemetri (OTLP) | **Bitti** — `0172deb` `3d36b9f` `3177f90` `3e791d4` |
| 9 | Benchmark'lar (tespit + gecikme) | **Bitti** — `bdd1fff` `1f3992e` `b0e0c68` `7479363` `8c89a3d` |
| 10 | Dokümanlar + v0.1.0 | Başlanmadı |
| — | Faz 7/8'den kalan iki boşluk | **Bitti** — `a3e7752` `a92f06d` |

Bağımlılık grafiği ve kritik yol:

```
0 → 1 → 2 → { 3 ∥ 4 ∥ 5 } → 6 → { 7 ∥ 8 ∥ 9 } → 10
kritik yol: 0-1-2-5-6-9-10
```

### `main` yeşil — 2026-09-16'da bizzat koşuldu

```
npm run lint          → Checked 220 files. No fixes applied. (exit 0)
npm run typecheck     → temiz (tsc -b && tsc -p tsconfig.test.json)
npm run build         → temiz
npm test              → Test Files 76 passed · Tests 1655 passed | 1 skipped (~7,9 s)
npm run schema:check  → schema up to date
```

Faz 9 öncesindeki sayılar 74 dosya / 1614 test idi; bu faz iki dosya
(`core/src/loop/novelty.test.ts`, `bench/src/detection/corpus.test.ts`) ve 41
test ekledi. **Atlanan tek test** `model.test.ts`'teki soğuk indirme;
`AGENTFUSE_TEST_DOWNLOAD=1` olmadan koşmuyor — aşağıya bakın. `lint`
çıktısındaki 42 `info` (`useLiteralKeys`) Faz 7'den beri aynı ve exit 0'ı
etkilemiyor. Faz 9 yeni `biome-ignore` eklemedi; `biome.json`'a iki satır
ekledi (`bench/*/results.json`), gerekçesi `packages/core/schemas` ile aynı:
dosya generator'ın ürünü, formatı da onun işi.

**`wrap-process.test.ts` yük altında kırılgan.** Tam süiti art arda koşarken
"exits 70 when the wrapped server dies under it" bir kez düştü, tek başına
koşturulunca geçti. `a95209f` bu testlere duvar saati payı eklemişti; kalan
kırılganlık ölçüm değil zamanlama. Faz 10 isterse payı bir kez daha artırabilir.

Değişen tek CLI dosyası `packages/cli/src/embeddings.test.ts`, ve değişmek
zorundaydı: "gerçek loader" testi, depo içinde çözülen paketin
`createEmbeddingProvider` export etmediğini pinliyordu — Faz 6a Faz 1'in
stub'ını doğru pinlemişti. Artık iki factory'nin de orada olduğunu ve
`loadInstaller`'ın gerçeğini bulduğunu pinliyor. Factory'yi **çağırmıyor**:
çağırmak 23 MB'lık modeli ve ORT'yi yüklerdi, bu süit ise offline koşar.
`packages/cli/src/embeddings.ts` ve `commands/models.ts` hiç değişmedi —
kontrat zaten doğru yazılmıştı, Faz 4 onu karşıladı.

Coverage kapısı `vitest.config.ts` içinde `packages/core/src/**` için %90'da ve
**gerçekten zorluyor** (Faz 2'de 100'e çekilip kasten kırılarak doğrulandı).
Bu çalışmanın sonundaki ölçümler (`coverage/lcov.info` üzerinden, glob bazında):

| Paket | lines | functions | branches |
| --- | --- | --- | --- |
| `packages/core/src/**` (kapılı) | %99.90 | %100 | %94.72 |
| `packages/proxy/src/**` (kapısız) | %98.90 | %100 | %91.51 |
| `packages/cli/src/**` (kapısız) | %99.87 | %100 | %99.24 |
| `packages/embeddings-local/src/**` (kapısız) | %98.03 | %96.55 | %87.25 |

`core` branch'i %95.65'ten %94.72'ye indi: Faz 9 iki dosyaya dal ekledi
(`loop/novelty.ts` %92.3, `guards/rule-loop.ts` %90.56) ve ikisi de %90'lık
kapının üstünde. `proxy` rakamları **birebir aynı** — Faz 9 o pakete hiç
dokunmadı. `cli` yalnız `telemetry/exporter.ts` değiştiği için oynadı
(%99.2 statement, kapalı kalan tek satır serileştirilemeyen bir kaydın
savunma yolu).

`embeddings-local` kapısız ve kapıya alınmadı: kapı bilinçli olarak yalnız
`core`'da, çünkü ürünün güvenlik ağı orası. Kapalı kalan satırlar iki türden:
`?? process.env` biçimindeki savunma varsayılanları, ve `session.ts`'te ORT'nin
beklenmedik bir çıktı verdiği iki yol (`last_hidden_state` yok, ya da float32
değil) — ikincisini test etmek gerçek bir ONNX grafiği üretmeyi gerektirirdi.

Metin reporter'ının satırları: `core/src` %98.37 / %96.87 / %100 / %99.39,
`proxy/src` %98.48 / %91.50 / %100 / %98.89, `cli/src` %99.47 / %98.84 / %100 /
%99.80, `cli/src/commands` %100 / %99.59 / %100 / %100,
`embeddings-local/src` %97.29 / %87.25 / %96.55 / %98.02. `cli/src/approvals`
ve `cli/src/telemetry` tabloda **hiç görünmüyor**, çünkü v8'in metin reporter'ı
her dosyası %100 olan dizini listelemiyor. "All files" %99.34 / %96.55 / %99.84
/ %99.66.

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

Senkron yolun Faz 2'de ölçülen maliyeti (`beforeCall` + `afterCall` +
`observe`, 20 000 çağrı, 50 oturum, `HashingProvider(384)` bağlı, `mode: warn`):
ortalama 0.018 ms, **p95 0.023 ms**, p99 0.038 ms. **Faz 9 bunu gerçek MCP
trafiğiyle ve gerçek modelle yeniden ölçtü**; tam tablo aşağıdaki Faz 9
bölümünde ve `bench/latency/results.md`'de. Özet: eklenen gecikme en kötü
yapılandırmada **p95 4,84 ms**, PRD §6'nın 50 ms bütçesinin onda ikisi.

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
| `@agentfuse/embeddings-local` | `@agentfuse/core`, `onnxruntime-node`, `@huggingface/tokenizers` (Faz 4) |

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

- **Faz 4 (yapıldı):** `EmbeddingProvider` dokunulmadı. `HashingProvider`, gerçek
  backend'in geçmesi gereken davranış testlerinin de şablonuydu
  (`hashing-provider.test.ts` içindeki "behaves plausibly" blokları) ve
  `model.test.ts` aynı özellikleri gerçek modelde pinliyor. İkisi de aynı porta
  yazdığı için yan yana duruyorlar: CI dublörle koşuyor, kalibrasyon gerçeğiyle.
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

## Faz 4 — `@agentfuse/embeddings-local` (bitti)

Üç commit: `97c836c` core'a bağlanma + model + sağlayıcı, `f999fb9` indirme
kapısı + disiplin testleri, `146b709` CI'ın çekmediği CUDA çalışma zamanı.
`packages/embeddings-local/src` ağacı:

```
index.ts            — yalnız yeniden export + BACKEND_ID + sürüm
models.ts           — pinlenmiş model tablosu (revision + sha256 + boyut)
cache.ts            — cache kökü, yerleşim, sha256 doğrulaması
download.ts         — offline kapısı, sınırlı indirme, atomik rename
install.ts          — installModel + ensureModelFiles
create.ts           — createEmbeddingProvider + tokenizer yüklemesi
batch.ts            — packBatch + meanPool (saf, ORT'siz)
provider.ts         — LocalEmbeddingProvider (core'un portu)
session.ts          — ORT adaptörü; onnxruntime-node'a dokunan TEK dosya
```

Ürün yüzeyi ikiye indirgenir ve şeklini `packages/cli/src/embeddings.ts`
belirler: `createEmbeddingProvider({ model })` ve
`installModel({ model, onProgress? })`. Faz 1'in `EmbeddingBackend` arayüzü
silindi, yerine core'un dondurulmuş `EmbeddingProvider`'ı geldi; tsconfig
`references` artık `../core`'u gösteriyor.

### Havuzlama tarifi — sessizce yanlış olabilecek tek yer

`last_hidden_state` üzerinde **attention mask uygulanmış ortalama havuzlama**,
ardından **L2 normalizasyon**. `all-MiniLM-L6-v2`'nin sentence-transformers
yapılandırması `pooling_mode_mean_tokens`; bu checkpoint'in `[CLS]` konumu
cümle temsili olarak hiç eğitilmedi. Yani bariz görünen alternatif —
`last_hidden_state[:, 0]` — 384 tane sonlu, birim uzunlukta ve **anlamsız**
sayı üretir. Her testin şekil kontrolü yaptığı bir dünyada bu hata geçer ve
Faz 9 eşiklerini gürültüye kalibre eder.

Taşıyıcı olan şey **maskenin toplama uygulanması**. Token sayısına bölme
değil: hemen ardından L2 normalizasyon geliyor ve pozitif bir sabitle ölçekleme
yönü değiştirmiyor, yani mean pooling ile sum pooling aynı birim vektörü
veriyor. Bölme tarifin parçası olduğu için duruyor; bir okuyucu "vektörleri
sessizce bozacak satır" ararsa bölmeye değil, maskeli `continue`'ya bakmalı.

**L2 normalizasyon süs değil.** Faz 3'ün kapalı form pencere skoru
`(‖S‖² − W) / (W · (W − 1))` ancak birim vektörlerde ortalama ikili kosinüs
oluyor. Her çıktının normu testle pinli (`toBeCloseTo(1, 5)`), hem sahte
oturumda hem gerçek modelde.

Kenar durumlar `HashingProvider` ile aynı kararı veriyor: tümüyle maskelenmiş
bir satır ya da sıfır hidden state, sıfır vektör yerine kendi baz yönünü alıyor
(`e₀`). Sıfır vektör her kosinüsü NaN yapar ve tüm pencereyi zehirler.

**Kesme (truncation) son `[SEP]`'i koruyor.** Kodlama `[CLS] t₁ … tₙ [SEP]`
olarak geliyor; `maxTokens`'ta kesip son konuma `[SEP]` yazmak tek dizi için
"longest_first" kesmesinin yaptığı şey. `maxTokens` 512 değil **256**, çünkü
model sentence-transformers ile `max_seq_length: 256` ile eğitildi. Padding
batch'in en uzun satırına yapılıyor, `maxTokens`'a değil.

### int8 nicemleme batch'e duyarlı — Faz 9'un bilmesi gereken sayı

`model_quantized.onnx` **dinamik nicemlenmiş**: aktivasyon ölçeği tüm girdi
tensörü üzerinden türetiliyor, yani bir metin farklı komşularla batch'lendiğinde
biraz farklı dönüyor. Ölçülen en kötü hâl: aynı metnin tek başına ve altılık bir
batch içindeki vektörleri arasında **kosinüs 0.9983**. Aynı batch içinde aynı
girdi bit-birebir aynı.

Bu, bu vektörler üzerinde hesaplanan bir skorun **anlam tabanı ±0.002**
demektir. Faz 9 bundan ince bir çözünürlükte eşik kalibre etmemeli. Kaçınmanın
tek yolu fp32 export'a (≈90 MB) geçmek olurdu; ADR-003 int8 dedi ve bu faz o
kararı yeniden açmadı.

Not: Faz 3'ün sürüklenme bölümü "`threshold`'un 1e-3 çözünürlüğü" diyor. O cümle
**bizim aritmetiğimiz** hakkında ve hâlâ doğru; buradaki ±0.002 modelin kendi
özelliği ve daha büyük. İkisi çelişmiyor, ama kalibrasyonda bağlayıcı olan
ikincisi.

### Model, cache yerleşimi ve sha256 pinleme

Model `Xenova/all-MiniLM-L6-v2`, revision `751bff37…` (HF'nin `main`'i hareketli
bir branch olduğu için commit sha'sı URL'e gömülü). Üç dosya indiriliyor:

| Dosya | Boyut | Neden |
| --- | --- | --- |
| `onnx/model_quantized.onnx` | 22 972 370 B | int8 grafik |
| `tokenizer.json` | 711 661 B | WordPiece tanımı |
| `tokenizer_config.json` | 366 B | `Tokenizer` yapıcısının ikinci argümanı |

Toplam **23 684 397 B (≈23,7 MB)**. Üçünün de sha256'sı `models.ts`'te sabit.

Yerleşim:

```
<cache kökü>/agentfuse/models/<owner>--<model>/<revision>/<dosya>
```

- Kök sırası: açık `cacheDir` seçeneği → `AGENTFUSE_CACHE_DIR` →
  `XDG_CACHE_HOME/agentfuse` → `~/.cache/agentfuse`. Boş dize "ayarlanmamış"
  sayılıyor; `export XDG_CACHE_HOME=` yazan bir kabuk cache'i `/agentfuse`'a
  göndermesin diye.
- **Revision bir dizin adımı**, dosya adının parçası değil: modeli yeniden
  pinlemek eskisinin yanına yazar, üstüne değil. Bisect, downgrade ve tek
  makinede iki checkout bundan sonra da çalışır.
- `/` → `--`: hem repo başına tek dizin, hem de bir id'nin `..` ile kökten
  çıkamaması. Zaten yalnız pinli id'ler buraya ulaşıyor; bu kapalı kapının
  ikinci kilidi.

**Tabloda olmayan bir model id'si reddediliyor.** "Elimizde digest yoksa
doğrulamadan geç" bir kapı değildir. Gerçekçi sebep politika dosyasındaki bir
yazım hatası olduğu için mesaj bilinen id'leri listeliyor.

### İndirme bir kapı olarak yazıldı

Karşı taraftaki baytlar birazdan native bir çıkarım çalışma zamanına
verilecek, yani düşmanca kabul ediliyor. Sırayla:

1. **`AGENTFUSE_OFFLINE=1` duvar**, ipucu değil: soket açılmadan önce
   reddediyor ve mesaj hem değişkenin adını hem aradığı yolu yazıyor. Önlediği
   şey belirsiz hata: "offline çalışıyor" diye otuz saniyelik bir DNS timeout'u.
   `0` ve boş dize kapalı sayılıyor, başka her değer açık.
2. **Boyut sınırı pinin kendisi.** Beklenen bayt sayısı tavan; daha uzun bir
   gövde akış ortasında `AbortController` ile kesiliyor, belleğe alınıp sonra
   reddedilmiyor. Sonsuz bir gövde diski de dolduramıyor.
3. **Geçici dosya hedef dizinde** ve rastgele sonekli. Aynı dizin = `rename`
   aynı dosya sisteminde atomik; rastgele sonek = aynı modeli aynı anda indiren
   iki process ayrı dosyalara yazıp her biri tam bir dosyayı üstüne rename
   ediyor. Okuyan ya hiçbir şey görüyor ya bütün bir dosya. Naif bir
   `createWriteStream(dest)`'in ürettiği yarım dosyayı, **yükleme anındaki hiçbir
   digest kontrolü kötü ağdan ayırt edemez** — bu yüzden mesele rename.
4. **Digest rename'den önce.** Uyuşmazlık geçici dosyayı siler ve iki digest'i
   de yazarak fırlatır. "Yine de dene" yolu yok.

Doğrulama **yükleme ön koşulu**, indirmenin yan etkisi değil: `ensureModelFiles`
hiçbir şey indirmediğinde de her dosyayı doğruluyor. Bu yüzden `models install`
aynı zamanda bir onarım aracı — sonradan bozulmuş bir cache aynı kontrolle
yakalanıyor ve yalnız bozuk dosya yeniden çekiliyor.

**`createEmbeddingProvider` indirmiyor.** Eksik model, `agentfuse models
install`'u adıyla anan bir hata. Proxy başlatmanın sessizce 23 MB'lık bir
indirmeye dönüşmesi, CLI'ın kendi mesajının zaten söylediği şeye aykırı olurdu.
`download: true` seçeneği var ve CLI hiç geçmiyor.

### Sınır: ORT'ye dokunan tek dosya

`session.ts` `onnxruntime-node`'a, `create.ts` `@huggingface/tokenizers`'a
dokunan tek dosyalar ve **ikisi de dinamik import**. Gerekçe iki katlı:

- Paketin giriş noktası ucuz kalıyor. CLI onu yalnızca "backend kurulu mu"
  sorusunu cevaplamak için import ediyor, `agentfuse models install` ise henüz
  koşturamayacağı bir modeli indirmek için. İkisi de yüz megabaytlık bir native
  addon'u dlopen etmemeli.
- Geri kalan her şey ORT'siz koşabilir ve koşuyor: batch'leme, havuzlama, cache
  kapısı ve indirme mantığı, hiç native kod yüklemeyen bir süitle kapsanıyor.

`session.run` **await ediliyor, senkron karşılığı kullanılmıyor.**
`onnxruntime-node` çalışmayı bir libuv worker'ında yürütüp promise çözüyor —
Faz 3'ün asenkron kuyruğunun üzerine oturduğu özellik tam olarak bu. Senkron
yol, 5–20 ms'lik bir matris çarpımını JSON-RPC frame'i ileten thread'e taşırdı
ve PRD §6'nın p95 bütçesi onu da kapsamaya başlardı.

ORT ayarları: `executionProviders: ['cpu']`, `intraOpNumThreads` en fazla 4
(`availableParallelism()`, cgroup limitlerini gören tek API), `interOpNumThreads`
1, `logSeverityLevel: 3` ve `ort.env.logLevel = 'error'`. Son ikisi stdout
disiplini için: `agentfuse wrap`'te bu process'in stdout'u ajanın JSON-RPC
akışı.

### Bağımlılık yönü artık iki taraftan zorlanıyor

`packages/cli/src/discipline.test.ts` kuralı CLI tarafından pinliyordu; yeni
`packages/embeddings-local/src/discipline.test.ts` aynı kuralı **tüm workspace**
için pinliyor:

- Kökteki, `packages/*` altındaki ve `bench`'teki hiçbir manifest bu paketi
  hiçbir bağımlılık alanında adlandıramaz — **kendisi dahil değil**, henüz var
  olmayan paketler dahil.
- Başka hiçbir paketin tsconfig'i ona project reference veremez.
- Bu paketin dışındaki hiçbir kaynak dosya specifier'ı statik import edemez.
  Desen *import biçimleri* üzerinde, ad üzerinde değil: CLI mesajının paketi
  adıyla anması gerekiyor ve bu bir kenar değil.
- Bu paketin bağımlılıkları tam olarak üç: `@agentfuse/core`,
  `@huggingface/tokenizers`, `onnxruntime-node`.

Ayrıca `session.ts`/`create.ts` sınırı ve stdout disiplini aynı dosyada pinli.

### Testler — hangisi neye ihtiyaç duyuyor

| Test | Ağ | Model dosyası |
| --- | --- | --- |
| `batch`, `cache`, `download`, `install`, `create`, `provider`, `session`, `index`, `discipline` | hayır | hayır |
| `model.test.ts` › "the real model" | hayır | **evet** — cache'te varsa koşar, yoksa `describe.runIf` ile atlanır |
| `model.test.ts` › "a cold download" | **evet** | hayır (geçici dizine indirir) — yalnız `AGENTFUSE_TEST_DOWNLOAD=1` ile |

**Varsayılan `npm test` ne ağ ister ne model.** Sahte bir `fetch`, sahte bir
tokenizer ve sahte bir session, indirme kapısının ve havuzlamanın her satırını
kapsıyor. Geriye hiçbir dublörün cevaplayamayacağı soru kalıyor — bu vektörler
gerçekten bir şey ifade ediyor mu — ve o sorunun bedeli 23 MB.

Gerçek model testleri, model cache'te olduğunda **kendiliğinden** koşuyor: yani
`agentfuse models install` yapmış bir geliştirici onları bedava alıyor, CI
almıyor. Soğuk indirme testi deponun internete soket açan tek testi;
`AGENTFUSE_TEST_DOWNLOAD=1 npm test` ile 18,5 s sürüyor ve ikinci bir
`installModel` çağrısının hiçbir şey indirmediğini de pinliyor.

### Ölçülen kurulum maliyeti

| Ne | Ölçüm |
| --- | --- |
| `npm install onnxruntime-node@1.30.0 @huggingface/tokenizers@0.2.0` | 1 dk 32 sn (17 paket) |
| `node_modules` büyümesi | 177 MB → 472 MB (**+295 MB**) |
| `onnxruntime-node` tarball (sıkıştırılmış) | **113 507 888 B (113,5 MB)** |
| `onnxruntime-node` açılmış | 292 MB (`dist.unpackedSize` 301 068 136) |
| `@huggingface/tokenizers` | 600 KB (`dist.unpackedSize` 360 962 — sıfır dep) |
| Isınmış cache ile `npm ci` | 1,7 sn (npm içerik cache'inden hard link'liyor) |

`onnxruntime-node`'un postinstall'ı bu makinede (npm 11 install-scripts
kapısı yüzünden) hiç koşmadı ve **gerekmedi**: darwin/arm64 ikilileri tarball'da
geliyor ve ORT sorunsuz yükleniyor.

### CI maliyeti — ölçüldü, bir yarısı düzeltildi, yarısı karar bekliyor

**Düzeltilen ve tartışmasız olan.** `onnxruntime-node`'un postinstall'ı
platform başına bir manifest okuyor ve `linux/x64` — yani `ubuntu-latest` —
için varsayılan gereksinim `cuda12`. O ikililer bilinçli olarak npm tarball'ında
**yok**, dolayısıyla script `Microsoft.ML.OnnxRuntime.Gpu.Linux`'u nuget.org'dan
indiriyor: `content-length` ile ölçüldü, **236 037 232 B (236 MB)**. Bu,
`setup-node`'un `cache: npm` ile geri yüklediği npm cache'inin **dışında**, yani
her koşumda her job için yeniden. Dört job (Node 20/22/24 + schema-drift) ×
236 MB ≈ **CI koşumu başına 944 MB**, hiç kullanmayacağımız bir GPU çalışma
zamanı için. `146b709` workflow seviyesinde `ONNXRUNTIME_NODE_INSTALL: skip`
koydu; `session.ts` zaten `executionProviders: ['cpu']` pinliyor, vazgeçilen
hiçbir şey yok.

**Kalan ve gerçek bir takas olan.** Geriye ADR-003'ün zaten kabul ettiği
maliyet kalıyor: job başına 113,5 MB tarball (ilk koşumdan sonra `setup-node`
onu `~/.npm` içinde cache'liyor) ve 292 MB'lık açılım. Seçenekler ve
gerekçeleri:

| Seçenek | Ne olur |
| --- | --- |
| **(a) Kabul et** — bugünkü hâl | Job başına ~113,5 MB indirme (soğuk cache) + 292 MB açılım. `npm ci` içerik cache'inden hard link'lediği için açılım ucuz; ölçülen 1,7 sn. |
| (b) `onnxruntime-node`'u `optionalDependencies`'e alıp CI'da `--omit=optional` | **Doğrudan çalışmıyor:** `tsc` `session.ts`'in dinamik import'u için tipleri çözmek zorunda ve paket yoksa build/typecheck kırılır. Çalışması için tipleri `onnxruntime-common`'dan (1,1 MB) almak, specifier'ı literal olmayan bir değişkene taşımak ve ORT yüzeyini elle bildirmek gerekir — yani **dördüncü bir bağımlılık beyanı** ve gerçek API'ye karşı tip güvenliğinin bırakılması. Faz brifingi "yalnız bu iki paketi kur" dediği için tek başına karara bağlanmadı. |
| (c) `actions/cache` ile `node_modules` cache'lemek | 292 MB'lık açılımı benzer boyutta bir restore'a çeviriyor, yani kazanç belirsiz; GitHub'ın depo başına 10 GB cache sınırı, ~470 MB'lık bir ağacın dört varyantıyla zorlanır. |
| (d) Matrisi daraltmak (tam kapıyı tek Node sürümünde koşturmak) | CI'ın neyi kanıtladığını değiştirir; maliyet düşüşü uğruna kapsam düşürmek. |

**Öneri: (a).** Asıl israf (b)'de değil postinstall'daydı ve o kapatıldı;
kalan kısım ADR-003'ün bilerek kabul ettiği maliyet. (b) istenirse ayrı bir
karar olarak alınmalı, çünkü bağımlılık listesini ve tip güvenliğini birlikte
değiştiriyor.

**Faz 10 için not:** bu postinstall yalnız CI'ın derdi değil. `npm install
@agentfuse/embeddings-local` yazan bir linux/x64 kullanıcısı da aynı 236 MB'lık
CUDA indirmesini yapar. Doküman bunu yazmalı ve
`ONNXRUNTIME_NODE_INSTALL=skip` ile kurmayı önermeli; CPU yolunda hiçbir şey
kaybedilmiyor.

### Ölçülen kalite — Faz 9'un kalibre edeceği sayılar

Fixture'lar `semanticEmbeddingText` üzerinden kuruldu, gevşek cümleler olarak
değil: o fonksiyon bir kontrat ve başka bir metin şeklinde alınan ölçüm Faz 9'un
devralacağı ölçüm olmazdı.

| Çift | Kosinüs |
| --- | --- |
| `search_issues` sayfa 1 ↔ sayfa 2 | **0.9971** |
| `search_issues` "login bug" ↔ "login error" | **0.9791** |
| sayfa 2 ↔ yeniden ifade edilmiş | 0.9764 |
| `write_file` başarılı ↔ aynı `write_file` hatalı | 0.8797 |
| `search_issues` ↔ `write_file` | **0.1165** |
| `search_issues` ↔ `postgres query` | **0.1254** |
| `write_file` ↔ `postgres query` | **0.0656** |
| hatalı `write_file` ↔ `postgres query` | 0.0471 |

Norm ölçümleri 1.000000005 / 0.999999989 aralığında. Yakın-aynı ile ilgisiz
arasında neredeyse bir büyüklük mertebesi var; doğru havuzlamanın görüntüsü bu,
CLS havuzlamanın ya da maskesiz ortalamanın görüntüsü değil.

Gecikme (M-serisi dizüstü, 4 thread): session açılışı **75 ms** (23 MB'ın
sha256'sı + grafik optimizasyonu dahil), sekizlik batch **10,7 ms** (50 batch
üzerinden ortalama). İkisi de sıcak yolda değil.

**Pagination uyarısı Faz 9 için burada da geçerli:** sayfa 1 ↔ sayfa 2 çifti
0.9971 veriyor, yani yalnız argüman/sonuç metni üzerinden bakıldığında bu ürünün
en çok kaçınması gereken yanlış pozitif, gerçek bir döngüden **ayırt edilemeyecek
kadar yakın**. Faz 3'ün "sonuç metni de değişmeli" notu bunun için var ve
fixture'da sonuçlar kasten farklı ("3 issues found" / "4 issues found") — buna
rağmen 0.9971. Negatif corpus'ta bu vakanın ağırlığı yüksek olmalı.

### Faz 9'un bu fazdan alacakları

- **Gerçek bir embedder var ve `HashingProvider` gitmedi.** İkisi aynı porta
  yazıyor, yani ROC taraması ikisiyle de koşturulabilir; kalibrasyon yalnız
  gerçek modelle anlamlı, regresyon testi ikisiyle de.
- Kurulum: `npm install @agentfuse/embeddings-local` (workspace içinde zaten
  kurulu) + `agentfuse models install`. Cache `AGENTFUSE_CACHE_DIR` ile ayrı
  bir dizine alınabilir.
- **Eşik çözünürlüğü tabanı ±0.002** (yukarıdaki int8 bölümü). Bundan ince bir
  ayrım ölçüm değil gürültü.
- Havuzlama metni değişirse kalibrasyon çöp olur — bu Faz 3'ün notuydu ve
  şimdi `model.test.ts` fixture'ları da o metne bağlı.
- `lastScore()` ve `loop_detection.windowScore` okuma noktaları değişmedi.
- Benchmark koşumu `AGENTFUSE_TEST_DOWNLOAD` bayrağına ihtiyaç duymaz; modeli
  bir kez kurup cache'ten okur.

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

**Faz 4 sonrası güncelleme:** bu monorepo içinde `@agentfuse/embeddings-local`
specifier'ı **çözülüyor** — npm workspaces her paketi `node_modules`'a
symlink'liyor. Faz 6a yazıldığında import Faz 1'in stub'ını buluyordu ve stub
iki factory'den hiçbirini export etmediği için CLI "kurulu ama eski" satırını
alıyordu; o satır artık bu pakete uygulanmıyor, çünkü Faz 4 ikisini de export
ediyor. `embeddings.test.ts` hâlâ her iki durumu da (çözülür / çözülmez)
kapsıyor; çözülen dalın iddiası tersine çevrildi ve factory'yi **çağırmıyor**
(çağırmak modeli ve ORT'yi yüklerdi). Tablonun "kurulu ama eski" satırı
enjekte edilmiş bir loader ile hâlâ testli — o satır bir sürüm uyuşmazlığını
tarif ediyor ve gelecekte yine olabilir.

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

## Faz 6b — `wrap` ve `serve` (bitti)

Üç commit: `54d858e` `wrap` + host seam + `tools/list` önbelleği, `19c96f8`
Node→Fetch köprüsü + `serve`, `7447c48` örnek istemci yapılandırması.
`packages/cli/src` ağacına eklenenler:

```
host.ts                    ← process'e dokunan İKİNCİ (ve son) dosya
annotations.ts             ← tools/list önbelleği → annotationsFor
http.ts                    ← node:http → Fetch köprüsü
commands/wrap.ts           ← MVP'nin birincil modu
commands/serve.ts          ← HTTP ucu + ADR-006 merdiveni
testing/wire.ts            ← ham JSON-RPC istemcisi (build ve coverage dışı)
testing/fixtures/raw-server.mjs  ← SDK'sız stdio MCP sunucusu
examples/claude-desktop.json
```

### `wrap` — dört bitiş, dört exit code

`agentfuse wrap` neredeyse tümüyle yaşam döngüsüdür; motor, portlar, rapor
dizini ve semantik katman `createRuntime`'dan, transport'lar ve korumalı
`tools/call` yolu `wrapStdioServer`'dan geliyor. Kalan iş "bir wrap ne zaman
biter" sorusu:

| Tetikleyici | Nasıl görülüyor | exit |
| --- | --- | --- |
| ajan gitti | `stdin` `end` ya da `close` yayıyor | 0 |
| SIGINT / SIGTERM | sinyal çocuğa iletilir, sonra durulur | 0 |
| sarılan sunucu öldü | upstream bağlantısı kapandı | 70 |
| çocuk hiç başlamadı | bağlantıdan önce gelen spawn hatası | 70 |

Üçüncü satır kasıtlı ve açıkça yazılmalı: **çocuk ölünce downstream bağlantı
açık kalıyor.** `wrapStdioServer` upstream kapanışını downstream'e
yaymıyor — yaymasını beklemek de yanlış olurdu, topolojiyi bilen taraf servis
giriş noktası değil host. Bu ele alınmazsa wrap ayakta kalır ve sonraki her
`tools/call`'a hata döner; bir MCP istemcisi de "çalışan ama her çağrıda
patlayan sunucu" görür, yeniden başlatabileceği ölü bir sunucu değil.

**Çocuğun kendi exit status'ü iletilmiyor** ve bunun sebebi kayda geçmeli:
kurulu SDK'nın `StdioClientTransport`'u kodu düşürüyor
(`_process.on("close", (_code) => …)`, kod hiç okunmuyor) ve `_process` alanı
`private`. Proxy de `ChildProcess`'i yüzeye çıkarmıyor. Dolayısıyla dürüst
seçenekler yukarıdaki tablo ya da bir dependency'nin private alanını okumaktı;
ikincisi bir SDK yükseltmesinde **sessizce** yanlış exit code üretirdi. Tablo
seçildi. **Bunu kapatacak dikiş tek bir opsiyonel callback:**
`StdioWrapOptions.onChildExit?: (code: number | null, signal: NodeJS.Signals |
null) => void`, `stdio-wrap.ts` içinde transport'un `pid`'inin yanında. Proxy
donmuş olduğu için 6b eklemedi.

**Sinyal adıyla iletiliyor,** pipe kapatılarak değil: SIGINT'i özel işleyen
(flush eden, kilit bırakan) bir sunucu operatörün gönderdiği sinyali almalı,
SDK'nın kapanışta yükselttiği SIGTERM'i değil. Çocuğun pid'i
`bridge.client.transport` üzerinden **public** `pid` getter'ından yapısal bir
okumayla alınıyor (`Transport` tipi `pid` beyan etmiyor, `StdioClientTransport`
ekliyor). `undefined` dönerse sinyal iletilmez ve teardown transport'u
kapatmaya düşer — SDK onu kendisi SIGTERM, sonra SIGKILL'e yükseltiyor.

### Akış sadakati — nasıl test edildi

Wrap modunun stream'ler hakkındaki üç iddiası process içinden test edilemez,
çünkü üçü de dosya tanıtıcılarının özelliği. `wrap-process.test.ts` bu yüzden
**inşa edilmiş `dist/main.js`'i** gerçek bir process olarak doğuruyor ve
stdio'sunu kendisi tutuyor:

1. **stdout yalnız protokol frame'i taşır** — iddia **ham baytlar** üzerinde,
   ayrıştırılmış mesajlar üzerinde değil: tesadüfen geçerli JSON olan bir
   diagnostic de akışı bozar. `testing/wire.ts` içindeki `nonProtocolLines`
   boş olmak zorunda, ve akışın gerçekten dolu olduğu ayrıca kontrol ediliyor
   ki boş bir stream testi geçemesin.
2. **Çocuğun stderr'i byte-for-byte geçer** — fixture kasten
   `0xff 0xfe 0x80` (hiçbir yerde geçerli UTF-8 değil) ve **sonunda newline
   olmayan** bir satır yazıyor; ilki decode/encode eden bir iletici tarafından
   U+FFFD'ye çevrilir, ikincisi satır tamponlayan bir iletici tarafından ya
   sonsuza tutulur ya uydurma bir newline ile flush edilir. Karşılaştırma
   `Buffer.equals` ile tam eşitlik. Bu mümkün, çünkü `--quiet` altında
   stderr'de AgentFuse'un tek satırı yok.
3. **exit code ne olduğunu söyler** — gerçek bir çıkış gerektiriyor.

Test istemcisi de fixture sunucusu da **ham JSON-RPC**, SDK'sız. İki sebep:
bu paket MCP SDK'sına bağımlı değil ve `discipline.test.ts` bunu dört pakete
pinliyor (o liste `npx agentfuse`'un indirdiği şey); ve iddialar tam baytlar
hakkında, ki ayrıştıran bir istemcinin gösteremeyeceği şey bu.

### `annotationsFor` ve önbelleğin güvenli olmasının sebebi

`ToolCatalogue` bağlantı başına, `trust_hints` açıkken **bir kez** upstream'e
`tools/list` atıyor. Üç özellik taşıyor:

1. **Politika istemedikçe hiçbir şey çekilmiyor.** `trust_hints` varsayılanı
   `false` ve kapalıyken istek hiç gitmez — başkasının sunucusuna
   istenmeyen bir `tools/list` bedava bir eylem değil.
2. **Boş önbellek AgentFuse'u daha katı yapar, daha gevşek değil.** Core bu
   ipuçlarıyla tek bir şey yapıyor: `idempotentHint` doğruysa exact-repeat
   eşiğini ikiye katlıyor (`guards/rule-loop.ts`). Henüz gelmemiş bir ipucu
   demek ki daha sıkı eşik; ilk araç çağrısı ile katalogun gelmesi arasındaki
   yarış, bloke edilmesi gereken bir çağrıyı geçirtemez. Bu, katalogu
   asenkron doldurmayı savunulabilir kılan şeydir.
3. **İpuçları doğrulanıyor, inanılmıyor.** `readOnlyHint: "yes"` coerce
   edilmeden düşürülüyor, adı olmayan tool girdisi yok sayılıyor. Core'un
   `ToolAnnotations`'ı tel şeklinin alt kümesi; alan alan kopyalamak ileride
   tele eklenecek bir alanın motora habersiz varmasını da engelliyor.

### Bağlantının açıldığı an — bilinen ödünç

`wrapStdioServer` çocuğu bağlantı açılınca doğuruyor ve ortaya çıkan bridge'i
**callback'i olmayan bir getter** olarak veriyor. CLI'nin o ana ihtiyacı olan
iki işi var: `tools/list` katalogu ve upstream'in gittiğini öğrenmek. Bu yüzden
`watchForConnection` **unref'li 25 ms'lik tek bir interval** kuruyor ve ilk
bağlantıda kendini durduruyor.

Alternatifi proxy'nin factory'sini CLI içinde yeniden kurmaktı, ki bu MCP
istemcisini bu pakette inşa etmek demek — paketin bilinçle sahip olmadığı bir
katman. Zamanlayıcı hiçbir şeyi açık tutmuyor (pipe tutuyor) ve tick başına bir
property okuması. **`StdioWrapHandle` üzerinde bir `onConnect` bu dikişi
tümüyle silerdi;** Faz 7 proxy'ye dokunuyorsa birlikte alınacak iki kancadan
biri bu, diğeri yukarıdaki `onChildExit`.

`client.onclose` sahipsiz olduğu için kullanıldı: bridge fallback handler'ları,
`wrapStdioServer` `onerror`'u alıyor. Hem çocuk kendi ölünce hem teardown
transport'u kapatınca ateşliyor; `finish` tek seferlik olduğu için teardown
durumu zaten karara bağlanmış oluyor.

### `--relay` — Faz 5'in çelişki kaydı #5'in tüketimi

Proxy varsayılan olarak `RELAYABLE_CLIENT_CAPABILITIES` (sampling, elicitation,
roots) beyan ediyor, çünkü downstream `initialize`'ı upstream'in
capability'leriyle cevaplamak zorunda ve bu yüzden upstream bağlantısı gerçek
istemci ne desteklediğini söylemeden önce kurulmak zorunda. `--relay
<liste|none>` operatörün bunu daraltmasını sağlıyor; istemcisinin sampling'i
olmadığını bilen operatör söyleyince sarılan sunucu kimsenin karşılayamayacağı
push'ları denemeyi bırakıyor.

### `serve` — ne garanti ediyor, ne etmiyor

**Garanti ettiği:** gerçek bir HTTP ucu bağlar (`--port`, `--host`, `--path`,
varsayılan `127.0.0.1:8765/mcp` — loopback, `0.0.0.0` değil), politikayı
`wrap` ile birebir aynı şekilde yükler ve raporlar, ve gelen **her** isteğe
ADR-006 merdivenini uygular: `_meta`'daki `traceparent` → `baggage`'daki
`tunedness.session-id` → yalnız legacy era'da `Mcp-Session-Id` → `clientInfo`
+ uzak adres hash'i (`session.idle_timeout` ile sınırlı). Hangi basamağın
cevapladığı hem yanıtta (`error.data.session` + `regime`) hem
`http_request` diagnostic'inde yazıyor; metin proxy'nin kendi
`describeSessionRegime`'inden geliyor. `GET /healthz` yürürlükteki politikayı
bildiriyor. `SIGINT`/`SIGTERM` ile kapanıyor ve `resolver.clear()` +
`runtime.close()` çağırıyor.

**Garanti ETMEDİĞİ, ve `--help`'te büyük harfle yazılı olan:** araç
çağrılarını **iletmiyor.** Her MCP methodu, çözülen session'ı adıyla anan ve
`agentfuse wrap`'i işaret eden bir JSON-RPC hatasıyla (`-32601`, HTTP 200)
cevaplanıyor; `id`'siz bir mesaj `202` alıyor; `GET`/`DELETE` `405` alıyor
(spec, server-initiated stream sunmayan bir sunucuya bunu açıkça izin
veriyor).

Sebep yapısal ve Faz 5'in çelişki kaydı #4'ün devamı:

- Trafiği korumak **downstream bağlantı başına bir upstream bağlantı**
  istiyor (`bridge.ts`'in ilk paragrafı). Birden çok downstream'i tek
  upstream'e çoğullamak sampling/elicitation/roots/MRTR'ı bozar, çünkü legacy
  era'da sunucu bunları **çağıranı adlandırmadan** push ediyor.
- `createMcpHandler` **HTTP isteği başına** bir server instance kuruyor
  (SDK'nın kendi tipinde yazılı: "once per HTTP request"). Yani doğru bir
  gateway, bu merdivenin çözdüğü session'a göre anahtarlanmış bir upstream
  bağlantı havuzu istiyor; factory context'i HTTP `Request`'i taşıyor ama
  ayrıştırılmış `_meta`'yı taşımıyor, dolayısıyla merdivenin `_meta`'da yaşayan
  basamakları ancak istek *işlenirken* okunabiliyor. Bu kendi ADR'ını hak eden
  bir tasarım (P1).
- **Ve CLI bunu bugün yazamaz:** `createBridge` önceden bağlanmış bir `Client`
  istiyor ve `createMcpHandler` `@modelcontextprotocol/server`'da. CLI'nin
  bildirdiği bağımlılık listesi `discipline.test.ts` tarafından dört pakete
  pinli (`@agentfuse/core`, `@agentfuse/proxy`, `gpt-tokenizer`, `yaml`) ve o
  liste `npx agentfuse`'un indirdiği şeydir. Ayrıca korumalı HTTP girişinin
  doğru yeri `packages/proxy/src/http-serve.ts` — MCP tesisatı proxy'nin
  katmanı. Faz 6b'nin brifingi köprüyü `createMcpHandler` üzerine yazmayı
  istiyordu; **bu iki kısıt altında yapılamadı ve kayda geçirildi**, brifingin
  kendi talimatı da buydu ("genuinely infeasible → stop and report").

`serve`'ün bugün işe yaradığı yer: ucun önündeki proxy ya da yük dengeleyici
üzerinden erişilebilirliği kanıtlamak, ve **bir bütçe ona bağlanmadan önce**
ajanın isteklerinin hangi session key'e çözüldüğünü görmek. Komut satırı
gateway'in alacağı komut satırının aynısı, yani bugün yazılan bir yapılandırma
P1'de çalışmaya devam ediyor.

**HTTP `traceparent`/`baggage` header'ları bilinçle okunmuyor.** ADR-006 o
basamakları `_meta`'ya (SEP-414) koyuyor ve McpGuard ile zincirleme sözleşmesi
dıştaki proxy'nin girdiyi oraya enjekte etmesi. İkinci bir kaynak "bu istek
hangi session" sorusuna iki cevap ve hangisinin kazandığına dair kural yokluğu
demek olurdu. Bir test bunu pinliyor.

### Node→Fetch köprüsü — P1'in koruyacağı parça

`http.ts` bir dependency değil çünkü `@modelcontextprotocol/node` kurulu değil
ve kurulması yayınlanan CLI'nin ağacına transitif olarak `@hono/node-server`
sokardı; Node 20 zaten global `Request`/`Response`/`Headers`/`ReadableStream`
taşıyor. Handler şekli kasten `createMcpHandler().fetch`'in şekli
(`(Request, RequestContext) => Promise<Response>`), yani **P1 aynı ucun
arkasına farklı bir handler koyar** — aynı bayraklar, aynı politika yüklemesi,
aynı merdiven. Tek ekleme `RequestContext.remoteAddress`: web standardı bir
`Request`'in uzak adres kavramı yok ve merdivenin en alt basamağı onu istiyor.

Kolay yanlış yapılan dört şeyin her biri ayrıca test edilmiş:

- **Gövdeler sınırlı** (varsayılan 4 MiB). Sınırsız okuma, tetikleyicisi ağ
  olan bir bellek hatasıdır. Aşımda `413` ve handler hiç çağrılmıyor.
- **Yanıtlar stream ediliyor**, backpressure gözetilerek (`write`'ın
  callback'i bekleniyor). SSE gövdesi hiç bitmez; tamponlayan bir köprü modern
  era'nın progress bildirdiği çağrıyı asardı. Çağıran gövde ortasında giderse
  `reader.cancel()` çağrılıyor — okuyucusu olmayan sonsuz bir üretici, hiçbir
  şeye benzeyen bir sızıntıdır.
- **Bağlantı kopunca handler abort ediliyor:** `Request` bir `AbortSignal`
  taşıyor. Modern era'da per-request stream'i kapatmak *iptal sinyalinin
  kendisi*, yani iptal edilen bir araç çağrısı tam olarak bu telden geçiyor.
- **Fırlatan handler yine cevap veriyor:** `500` ve bir diagnostic, asla
  asılı bir socket.

Header'lar `rawHeaders`'tan (telden gelen düz ad/değer listesi) kuruluyor,
ayrıştırılmış çantadan değil: çanta tekrarların çoğunu tek string'e birleştirip
`set-cookie`'yi dizi olarak bırakıyor, yani iki şekil ve olamayacak bir
`undefined` demek. Ham çiftleri `append` etmek her header'ın her değerini
korurken bunların hiçbirini istemiyor.

### `host.ts` — process'e dokunan ikinci ve son dosya

Faz 6a `main.ts`'i process'in **stream**'lerine dokunan tek dosya yaptı.
Servis eden bir komut üç şey daha istiyor: ajanın pipe'ının okuma ucu, bir
supervisor'ın gönderdiği iki sinyal, ve bunlardan birini çocuğa geçirme
yeteneği. Bunlar tek bir enjekte edilebilir arayüzde (`ProcessHost`) ve
`host.test.ts` `main.ts` + `host.ts` dışında hiçbir kaynak dosyanın
`process.stdin`, `process.on`, `process.off`, `process.kill` adını anmamasını
zorluyor — `discipline.test.ts` ve core'un `purity.test.ts`'i ile aynı fikir.
`process.env` listede yok: salt okunur ortam yapılandırması ve komutlar onu
zaten `CliContext`'ten alıyor.

`process.stdin`'in `CliContext`'te olmamasının sebebi: başka hiçbir komut onu
okumuyor, ve wrap modunda o "girdi" değil — SDK'nın transport'unun sahip
olduğu, ajanın JSON-RPC pipe'ının yarısı. CLI'nin ondan istediği tek şey
kapandığı an, ki o an wrap'in bittiği andır.

### 6a'nın modüllerinde değişen şey

- **`cli.ts`** — `wrap`/`serve` dispatch'i gerçek komutlara bağlandı,
  `notImplemented` silindi, `PHASE_6B_COMMANDS` boşaldı ve usage satırları
  güncellendi. Sabit **kaldı**: zorladığı şekil korunmaya değer — tablodaki bir
  komut ya uygulanmıştır ya orada listelenip exit code'la reddedilir, asla
  sessizce eksik olmaz.
- **`cli.test.ts`** — "Faz 6b'nin komutları" bloğu yeniden yazıldı (dört test).
  `it.each(PHASE_6B_COMMANDS)` boş dizide **sessizce sıfır test** üretiyordu;
  yerine listenin boş olduğunu iddia eden bir test, geri eklenirse yakalayacak
  taramanın kendisi, ve iki komutun da adlarında değil eksik politikada
  durduğunu gösteren iki test var.
- **`commands/serve.ts`** `defaultServerName`'i `commands/wrap.ts`'ten
  alıyor — takma ad her fingerprint'in parçası ve `npx` bir sunucu değil.
- **`core` ve `proxy` değiştirilmedi.** Tek satır bile. Yukarıda adı geçen iki
  dikiş (`onChildExit`, `onConnect`) eklenmedi; ikisi de olmadan iş yapıldı ve
  eksiklikleri yorumlarla kayda geçti.

### Faz 6b'nin çelişki kaydı

1. **`serve` korumalı HTTP gateway'i olmadan geldi** (yukarıda, gerekçe
   yapısal + bağımlılık yönü). Brifing "`createMcpHandler` üzerine ~60 satırlık
   köprüyü kendin yaz" diyordu; köprü yazıldı ve testli, ama `createMcpHandler`
   CLI'den erişilemiyor. **`.ssot`'ta bir karar hak eden nokta:** HTTP gateway
   `packages/proxy`'ye mi girecek (muhtemelen — MCP tesisatı orada), ve
   upstream havuzunun anahtarı ne olacak.
2. **Çocuğun exit code'u aynalanmıyor** (yukarıda). Kurulu SDK onu düşürüyor.
3. **`wrap` bir `--request-timeout` bayrağı kazandı,** brifingde yoktu.
   Gerekçe: SDK'nın 60 s varsayılanı, progress bildirmeyen ve gerçekten on
   dakika süren bir aracı ajanın hiç istemediği bir timeout'la öldürür, ve
   AgentFuse onu kıran şey gibi görünür. `resetTimeoutOnProgress` zaten açık,
   ama progress bildirmeyen araç için yetmiyor.
4. **Bağlantının açıldığı anı yakalamak için bir zamanlayıcı var** (yukarıda).
   Bir `onConnect` dikişiyle silinir; bilinçli bir ödünç, gizlenmiş bir şey
   değil.

### Faz 7 ve Faz 8 için bırakılan dikişler

**Faz 7 (onay akışı: unix socket + webhook, rapor UX):**

- Onay bekleyen çağrı `beforeCall` içinde `ApprovalGateway` portundan çözülüyor
  ve timeout'un sahibi gateway (Faz 2 kararı). `createRuntime` şu anda
  `enforce` + onay isteyen politika için bir uyarı yazıyor
  (`runtime.ts`, `wantsApproval`); gateway gelince **o uyarı kaldırılmalı** ve
  `RuntimeOptions`'a bir gateway alanı eklenmelidir — `wrap` ve `serve`
  tarafında başka bir değişiklik gerekmez.
- Unix socket'i dinleyecek yer `host.ts`'in yanı: servis eden bir komutun
  yaşam döngüsü zaten orada ve kapanışta temizlenen listener deseni kurulu.
  `wrap`'in `serveWrap` fonksiyonu tek bir `ended` promise'i bekliyor; onay
  soketi beşinci bir bitiş sebebi **değil**, paralel bir kaynak — açılışı
  `wrapWiring`'in yanına, kapanışı `stopWatching` ile aynı bloğa.
- Webhook için HTTP **istemcisi** gerekiyor, `http.ts` sunucu tarafı. Node 20
  global `fetch` taşıyor, yeni bağımlılık gerekmez.
- Rapor UX'i için 6a'nın bıraktığı karar noktası duruyor: `agentfuse report`
  stdout'a bir `[agentfuse] {"event":"trip_report",…}` işaret satırı da
  koyuyor (`Diagnostics.block()`'un ayrılmaz parçası). `--json` yolu temiz.
- `serve` şu anda `-32601` ile reddediyor; onay akışının HTTP yüzeyi (P1
  gateway'den bağımsız olarak) `createServeHandler` içine yeni bir route
  olarak girebilir — `/healthz` deseni hazır.

**Faz 8 (OTLP telemetri, kapalıyken sıfır OTel modülü):**

- `createRuntime` şu anda `telemetry.enabled: true` için "bu build'de export
  yok" uyarısı yazıyor; o uyarı Faz 8'in silmesi gereken şey.
- Dinamik `import()` deseni `embeddings.ts`'te kurulu ve testli: kapalıyken
  modül yüklenmemesi tam olarak o dosyanın çözdüğü problem. Aynı kalıp
  (`resolveEmbeddingProvider`'ın karar tablosu) telemetri için kopyalanabilir.
- Enstrümante edilecek noktalar zaten tek yerde: `Diagnostics.emit` çağrıları
  `wrap` ve `serve` içinde olay adı + alanlarla geçiyor
  (`session_start`, `session_end`, `blocked`, `would_trip`, `wrap_end`,
  `http_request`, `http_listening`, `http_closing`, `semantic_stats`, …).
  `Diagnostics` bir `sink` alıyor; ikinci bir tüketici eklemenin yeri
  `runtime.ts`'teki tek `new Diagnostics(...)` çağrısı. **İki ayrı
  `Diagnostics` kurulmamalı** — rate-limit pencereleri ayrışır.
- `http.ts`'in `RequestContext`'i şu an yalnız `remoteAddress` taşıyor; OTLP
  bağlamı (`traceparent` header'ı) gerekirse eklenecek yer orası, ve ADR-006
  merdiveni onu **okumaya devam etmemeli** (yukarıdaki header kararı).
- ADR-007 hatırlatması: telemetriye giden her token/USD rakamı `_estimated`
  soneki taşıyor. `session_end` diagnostic'i `tokensEstimated` /
  `usdEstimated` yazıyor ve bu isimler bağlayıcı.

### `wip/phase-6-partial` artık tamamen aşıldı

6a branch'teki 14 dosyanın hepsini tek tek değerlendirdi ve kararları yukarıdaki
tabloda. Tek ertelenen parça `commands/shared.ts`'ten atılan `asPort`'du;
6b onu `commands/serve.ts` içinde `--port`'un yanına, kendi testleriyle ve
`Number('') === 0` tuzağına karşı korumalı olarak yazdı (`--port=` sessizce
"işletim sistemine sor" demesin diye). **Branch'te `main`'e girmemiş hiçbir şey
kalmadı; silinebilir.**

---

## Faz 7 — onay akışı ve rapor UX (bitti)

Üç commit: `84b903e` unix socket + `approve`/`deny` + runtime bağlantısı,
`935146d` `report`'un stdout'u, `a7a8ddc` webhook + kompozisyon + örnek alıcı.
`packages/cli/src` ağacına eklenenler:

```
approvals/protocol.ts         ← socket yolu, frame şekilleri, doğrulama (I/O yok)
approvals/socket.ts           ← dinleyici + istemci; hijyen kuralları burada
approvals/cli-gateway.ts      ← bekleyen istem (prompt) + bekleyenler tablosu
approvals/webhook-gateway.ts  ← HMAC imzalı POST
approvals/compose.ts          ← iki kanal, tek cevap
approvals/index.ts            ← karar tablosu (embeddings.ts'in kardeşi)
commands/approve.ts           ← `approve` ve `deny`
examples/approval-webhook.mjs ← bağımlılıksız alıcı örneği
```

### Socket nerede duruyor ve neden

`resolveApprovalSocketPath` sırayla dener, **her basamak testli**:

1. **`AGENTFUSE_APPROVAL_SOCKET`** — mutlak yol, talimat sayılır. Gerekçesi
   `AGENTFUSE_POLICY` ile aynı: bir MCP istemcisinin sunucu yapılandırması
   `env` verebiliyor ama `$HOME`'u ya da çalışma dizinini genelde seçemiyor.
2. **`$XDG_RUNTIME_DIR/agentfuse/approvals.sock`** — Linux'ta **doğru** yer ve
   bu basamağın var olma sebebi. O dizin kullanıcıya ait bir tmpfs, modu 0700
   ve **oturum kapanınca siliniyor**; yani öldürülen bir process'in bıraktığı
   socket oturumdan uzun yaşayamıyor. `$HOME` bunların hiçbirini vermiyor ve
   NFS olabiliyor — unix socket'lerin NFS üzerindeki durumu "güvenilmez" ile
   "desteklenmiyor" arasında.
3. **`$HOME/.agentfuse/approvals.sock`** — geri kalan her yer, macOS dahil
   (`XDG_RUNTIME_DIR` orada geleneksel olarak tanımsız). Dizin 0700 olarak
   oluşturuluyor **ve her açılışta mode'u tekrar set ediliyor** — 2. basamağın
   işletim sisteminden bedava aldığı garantiyi geri kazandıran şey bu.

Yol uzunluğu ayrıca kontrol ediliyor (100 bayt): `sun_path` macOS'ta 104,
Linux'ta 108 bayt ve çekirdek **kırpmıyor, reddediyor** — ortaya çıkan `EINVAL`
yollardan hiç bahsetmiyor. Sınırı ve onu çözen değişkeni adıyla anan bir hata
mesajı bu kontrolün tek gerekçesi.

### Sahiplik ve bayatlık kuralları

Bu socket **araç çağrısı serbest bırakıyor**, yani üç özellik taşıyıcı ve
üçünün de testi var:

- **Socket 0600, dizini 0700.** Asıl kapı dizin: bir unix socket dosyası
  process umask'i ile yaratılıyor, yani `bind` ile `chmod` arasında bir pencere
  var. Kimsenin geçemeyeceği bir üst dizin o pencereyi kapatıyor, ve dizinin
  modu her açılışta *set ediliyor* — `mkdir`'ün mode argümanını da umask
  değiştiriyor ve dizin zaten varsa hiçbir şey yapmıyor.
- **Yaratmadığı hiçbir şeyi sahiplenmiyor.** Socket olmayan bir yol, ya da
  başka bir kullanıcıya ait bir socket, **asla unlink edilmiyor**; "yolumda bir
  şey var"ın güvenli okunuşu "başkasının" olmasıdır, "temizle" değil. Bayat
  socket — ölen bir process'in bıraktığı — **bağlanılarak** tespit ediliyor ve
  siliniyor, çünkü çökme sonrası olağan durum budur ve kullanıcıyı `rm`
  çalıştırmaya zorlamak yanlış cevap olurdu. Kanıtlanamayan bir probe (ne
  bağlanıyor ne reddediliyor) **canlı** sayılıyor: "ölü olduğunu kanıtlayamadım"
  silme ruhsatı değildir.
- **İkinci wrap birincinin socket'ini çalmıyor.** Bilinen yol cevap veriyorsa
  orada verdict bekleyen canlı bir process var demektir; yeni gelen
  `approvals-<pid>.sock`'a bağlanıyor ve **kendi prompt'larında o yolu
  yazıyor** (`--socket <path>`). İki wrap da cevaplanabilir kalıyor.

Bozuk frame'ler cevaplanıp bağlantı kapatılıyor, asla fırlatılmıyor: bu process
bir ajanın araç çağrılarını proxy'liyor. Frame 8 KiB ile sınırlı, boşta duran
bağlantı 5 sn sonra düşürülüyor, dinleyici `unref`'li (wrap'i ajanın pipe'ı
ayakta tutar, bekleyen bir prompt değil).

Windows'ta `uid` `-1` olduğu için sahiplik kontrolü atlanıyor;
`os.userInfo()` fırlatırsa (rastgele `--user` ile koşan bir konteyner) da öyle.
İkisi de başlamamak için sebep değil, kontrolü *yapamamak* için sebep.

### Prompt bir ürün yüzeyidir ve `--quiet` onu susturmaz

stdout protokol akışı ve ortada tty yok, o yüzden soru stderr'e yazılıyor —
sarılan sunucunun çıktısını okuyan operatörün zaten baktığı yere, aynı
`[agentfuse]` önekiyle. Taşıdığı şeyler: hangi sunucuda hangi araç, **politikanın**
insanı çağırma sebebi, kırpılmış argümanlar, approval id'si ve yazılacak tam
komut — varsayılan yolda değilse `--socket` dahil.

**`--quiet` bunu susturmuyor.** `--quiet` AgentFuse'un kendi gevezeliğini —
operatörün istemediği satırları — susturmak için var. Bir prompt gevezelik
değil: politikanın kendi sorusu, operatörün kendi dosyasına yazdığı şey, ve
susturulunca her `require_approval` iki dakika asılıp sonra hiçbir yerde
gerekçesi olmayan bir redde dönüşüyor. Makine okunur `approval_pending` olayı
`--quiet`'e uyuyor, yani makine satırı ile insan satırı ayrılabiliyor.

Argümanlar bu katmanda redakte edilmiyor ve edilemez: `report.redact_args`
açıkken motor `argsPreview` yerine fingerprint'i veriyor, çünkü ham argümanları
gören tek yer motor. Prompt ne geldiyse onu yazıyor — testi de bunu ölçüyor.

### İnsanın `--reason`'ı nereye gidiyor

Faz 7'de yalnız `approval_resolved` teşhis satırına ve komutu yazan kişiye
gidiyordu; ADR-009 bunu boşluk saydı ve **kapatıldı** (`a92f06d`, aşağıdaki
"Kapanan iki boşluk" bölümü). Bugün gerekçe karara (`Decision.approval`) ve
kesinti raporuna da gidiyor. **Ajana giden ret metnine hâlâ gitmiyor** ve bu
bilinçli: operatörün sözlerini modelin bağlamına koymak kendi ürün kararını
hak ediyor.

### Timeout'un sahibi gateway (Faz 2 kararı, uygulandı)

Engine `timeoutMs`'i geçiyor ve `'timeout'` bekliyor; iki gateway de kendi
`setTimeout`'unu kuruyor (`unref`'li). `AbortSignal` **`'denied'` olarak**
çözülüyor, `'timeout'` olarak değil: `'timeout'` `approvals.on_timeout`
üzerinden geçiyor ve operatör onu `allow` yapmış olabilir, yani ölmüş bir
oturumu `'timeout'` ile cevaplamak kimsenin onaylamadığı bir çağrıyı
**iletebilirdi**. `'denied'` yanlış okunamaz, ve half_open olmayan bir devrede
bir ret hiçbir şeyi kıpırdatmadığı için prompt'u terk eden bir reset az önce
kapattığı devreyi hemen yeniden açmıyor.

`CliApprovalGateway.requestApproval` temizliği `await`'ten **sonra** yapıyor:
promise bir kez settle olduğu için üç yolun (verdict, saat, abort) hangisi önce
vardıysa alttaki satırlar tam bir kez koşuyor ve hiçbirinin diğerine karşı
koruma bayrağına ihtiyacı kalmıyor.

### Webhook: imza şeması ve secret nereden geliyor

`X-AgentFuse-Signature: v1=<hex>`, `<hex>` = **gönderilen gövdenin tam
baytları** üzerinde `HMAC-SHA256(secret, body)`. Gövde bir kez serileştirilip
hem imzalanıyor hem gönderiliyor; iki JSON serileştirici anlamda anlaşır,
baytta anlaşmaz.

**Timestamp imzalı gövdenin içinde** (`timestamp` alanı), yanında bir header'da
değil: replay'i durdurmak için isteğin yaşını kontrol eden bir alıcının,
kontrol ettiği yaşın MAC tarafından kapsanması gerekir — yoksa saldırgan eski
bir gövdeyi taze bir header'la tekrar oynatır ve kontrol hiçbir şey kanıtlamaz.

**Secret ortamdan gelir, politikadan asla.** `approvals.webhook.secret_env`
*değişkenin adını* taşıyor; değeri `context.env`'den okunuyor. ADR-004:
politika dosyası commit'lenip diff'lenmek için var, ve secret'ı kabul eden bir
şema insanları onu commit'lemeye davet eder. Bir test secret'ın ne teşhis
satırlarında ne tel üzerinde (MAC dışında) görünmediğini ölçüyor.

Cevap güvenilmez girdi muamelesi görüyor: gövde **okunurken** sınırlanıyor
(64 KiB), şekil alan alan doğrulanıyor, redirect `redirect: 'error'` ile
reddediliyor (takip etmek imzalı gövdeyi operatörün adını vermediği bir host'a
yeniden göndermek olurdu), ve tüm alışveriş `approvals.timeout` ile sınırlı.

**Başarısızlık yönleri bilinçle farklı:**

| ne oldu | verdict | neden |
| --- | --- | --- |
| düzgün `approved` / `denied` | aynısı | insan cevap verdi |
| süresinde cevap yok | `timeout` | `approvals.on_timeout` karar verir |
| HTTP hatası, transport hatası, redirect, büyük ya da bozuk gövde | `denied` | fail closed |

Son satır taşıyıcı: **bozuk bir kanal `on_timeout`'tan geçmiyor.**
`on_timeout: allow` diyen operatör "yavaş bir insan ajanımı bloklamasın" diyor,
"ağ bozulduğunda her şeyi onayla" demiyor — ve ağı bozabilen bir saldırgan o
ayarı topyekûn rızaya çeviremez.

`examples/approval-webhook.mjs` bağımlılıksız bir alıcı. `examples.test.ts` onu
**import edip** gerçek imzalayıcıya karşı koşturuyor: güvenlikle ilgili bir
protokolün örneği yanlışsa hiç olmamasından kötüdür, ve yanlış olma biçimi
(yeniden serileştirilmiş gövdeyi imzalamak, `===` ile karşılaştırmak, imzasız
bir timestamp'e güvenmek) okuyarak görünmez.

### İki gateway birlikteyken kural

İstek **hepsine aynı anda** gidiyor, sonra:

1. **İlk kesin cevap kazanır.** `approved` ve `denied` kesindir; diğer kanallar
   hemen durduruluyor, sonradan gelen verdict `approval_discarded` olarak
   kaydediliyor (düşürülmüyor — "ben onayladım ama reddedildi" log'dan
   cevaplanabilmeli).
2. **Timeout cevap değildir.** Bir kanalın pes etmesi isteği bitirmiyor;
   ötekiler tam penceresini koruyor. Yalnız *her* kanal timeout ettiğinde
   composite `'timeout'` bildiriyor — `on_timeout`'un yorumlamasına izin verilen
   tek verdict bu.
3. **Patlayan kanal timeout değil, rettir.** Hiçbiri kesin değilse ve en az biri
   fırlattıysa composite reddediyor. Bozuk bir gateway'in `on_timeout: allow`
   tarafından rızaya çevrilmesini durduran şey bu.

Gerekçe: iki gateway yapılandırmak "bu kanalların herhangi biri benim adıma
cevap verebilecek birine ulaşıyor" demektir — iki kanalın olabileceği tek
faydalı şey yedeklilik. İkisinin de hemfikir olmasını istemek her onayı en yavaş
kanala bağlar ve sessiz bir kanal her şeyi reddeder; çalışan bir terminal
kurulumuna Slack webhook'u ekleyen operatör onayların bozulduğunu görürdü.
Composite pencereyi yalnızca **kısaltabilir**, rıza uyduramaz: döndürdüğü her
`approved` tam olarak bir kanalın `approved`'ına kadar izlenebilir.

### Kanal açılamazsa: sert hata değil, yüksek sesle uyarı

Bu, onay tablosunun yanındaki embedding tablosundan **bilinçli olarak ayrıldığı**
tek nokta. Orada `provider: local` + `mode: enforce` + eksik paket sert bir
çıkış (exit 4), gerekçesi de yazılı: yine de başlamak, AgentFuse'un istenen
korumanın bir **alt kümesinin** yeterince yakın olduğuna sessizce karar vermesi
olurdu.

Onay kanalı ters yöne düşüyor. Kanal yokken `require_approval` bir redde
çözülüyor — istenenden **daha katı**, asla daha gevşek, ve iletilmeyecek hiçbir
şey iletilmiyor. Başlamayı reddetmek ise kullanıcının MCP sunucusunu da
beraberinde götürüyor: wrap, istemcinin başlattığı şey, yani buradaki sert bir
hata daha güvenli bir koşum üretmiyor — **hiç koşum** üretmiyor, ve önünde fuse
olmayan bir ajan bırakıyor. O yüzden kanal susuyor ama yüksek sesle: kanalı,
alttaki hatayı ve onun ipuçlarını anan çok satırlı bir uyarı, artı bir
`approval_gateway_unavailable` teşhisi. Aynı muamele eksik `secret_env`'e ve
eksik `approvals.webhook` bloğuna da uygulanıyor.

### Karar tablosu (uygulanan tam hali)

| Yapılandırma | Sonuç |
| --- | --- |
| `mode: warn` | **kapalı, sessizce.** Motor onayları yalnız `enforce`'ta çözüyor. |
| politika hiç onay istemiyor | **kapalı, sessizce.** |
| `enforce` + `gateways: []` | **kapalı, uyarıyla.** |
| `enforce` + `[cli]` | unix socket. |
| `enforce` + `[webhook]` | imzalı POST. |
| `enforce` + ikisi | ikisi, `compose.ts`'in kuralıyla. |
| `enforce` + açılamayan kanal | **o kanal kapalı, uyarıyla** (yukarıdaki gerekçe). |

`on_timeout: allow` gateway açılan her yerde kendi uyarısını alıyor: dosyadaki
tek **fail open** ayarı bu, ve işi zorlamak olan bir aracın bunu her açılışta
yüksek sesle söylemesi gerekir.

**`onDecision` hook'u bilinçle sayılmıyor.** Motor onayı *guard'ların*
action'ından çözüyor ve hook'lar ondan sonra koşuyor; yani action'ı
`require_approval`'a yükselten bir hook ajana `POLICY_APPROVAL` olarak
bildiriliyor ve hiçbir gateway'e varmıyor. Donmuş davranış bu; onun için socket
açmak aksini ima ederdi.

### Runtime'a bağlanma — `wrap` ve `serve` değişmedi

Motor gateway'i **constructor port'u** olarak alıyor, yani kanal motordan önce
var olmak zorunda; bu da servis eden bir komutun onu açıp devretmesini eliyor.
Kanal ayrıca politikadan türüyor (`approvals.gateways`, timeout, webhook bloğu)
ve o çözümleme zaten `runtime.ts`'te. Sonuç: socket `createRuntime` içinde
bağlanıyor, `runtime.close()` ile bırakılıyor, ve `wrap` ile `serve` onay
hakkında tek satır içermiyor — Faz 6b'nin öngördüğü gibi.

- `RuntimeOptions.approvals` tabloyu tümüyle atlayan enjeksiyon dikişi;
  testler socket'e hiç dokunmadan bloke bir çağrıyı sürebiliyor.
- `Runtime.approvals` ve `Runtime.approvalSocket` yüzeye çıktı.
- `wantsApproval` `approvals/index.ts`'e taşındı ve `runtime.ts`'ten yeniden
  export ediliyor (eski import yolu çalışmaya devam ediyor).
- `createRuntime`'ın "approvals fail closed" uyarısı **silindi**; yerine
  yalnızca gerçekten kanal olmayan satırlar uyarıyor.
- `--reset`'in motora ulaşması için geç bağlanan bir kanca var
  (`ApprovalResolution.bindHost`): socket motordan önce dinliyor, o yüzden host
  sonradan veriliyor ve aradaki mikrosaniyelerde gelen bir reset "hâlâ
  başlıyor" cevabı alıyor.
- `resetBreaker` **oturumun varlığını önce kontrol ediyor** ve sonraki phase'i
  döndürüyor; komutu yazan kişi "bu wrap'te öyle bir session yok" ile
  "kapattım" arasındaki farkı görüyor. Yoksa bir devre, birileri kapattığını
  sanırken açık kalırdı.

**Bilinen ödünç:** `serve` de politikası onay istiyorsa socket'i açıyor, ama
hiçbir zaman onay sormuyor (ADR-008: `serve` P0'da araç çağrısı iletmiyor).
Zararsız — hiçbir wrap'in socket'i çalınmıyor, yeni gelen fallback yola
bağlanıyor ve prompt'unda onu yazıyor — ama `agentfuse serve` uzun süre
koşuyorsa bilinen yolu tutuyor olabilir.

### `report`'un stdout'u temizlendi

Faz 6a'nın açık bıraktığı nokta kapandı: `agentfuse report last` artık
render edilmiş raporu doğrudan stdout'a yazıyor, `Diagnostics.block()`
üzerinden değil. İşaret satırı (`[agentfuse] {"event":"trip_report",…}`)
proxy'de hak ettiği yerde duruyor — orada rapor, önekli teşhis satırlarından
oluşan bir akışın içinde bir blok ve işaret satırı bir okuyucuya (ya da bir log
shipper'a) bloğun nerede başladığını söylüyor. `report` proxy yolunda değil,
yani onun stdout'u soruyu soran insana ait. `Diagnostics` hiç değişmedi ve
proxy yolundaki garantilerinin hepsi yerinde. İki mod da pinli: varsayılan mod
kutu çizgili tabloyu ve başka hiçbir şeyi taşıyor, `--json` modu core'un
yazdığı dokümanın aynısı olarak parse ediliyor.

### Testler — iki process gerçekten koşuyor

`commands/approve-process.test.ts` `dist/main.js`'i **iki ayrı process olarak**
doğuruyor: biri wrap, öteki `agentfuse approve` / `agentfuse deny`. Dokuz test:
onaylanan çağrı sunucunun gerçek cevabıyla dönüyor, reddedilen çağrı ajanın
okuyabileceği bir ret alıyor, `APPROVAL_TIMEOUT` metni ajana varıyor,
`on_timeout: allow` çağrıyı iletiyor ve açılışta fail-open uyarısı yazıyor,
half_open'da insanın "hayır"ı devreyi `open`'a alıyor, `--reset` devreyi
kapatıyor ve sonraki çağrı yeniden insana soruluyor, ikinci wrap birincinin
socket'ini çalmıyor, bozuk frame proxy'yi düşürmüyor, ve webhook kanalı gerçek
bir HTTP alıcısına karşı imzalanıp doğrulanıyor. Bir test ayrıca tüm bu akış
boyunca stdout'un yalnız protokol frame'i taşıdığını ham baytlar üzerinde
ölçüyor.

Her koşum kendi socket'ini `AGENTFUSE_APPROVAL_SOCKET` ile alıyor; **hiçbir
test geliştiricinin gerçek `~/.agentfuse`'una dokunmuyor.** Bayat socket
üretmek için testler bir child process doğurup SIGKILL'liyor — Node temiz bir
`close()`'ta yolu zaten siliyor, yani bayat socket tanım gereği kapanmaya
fırsat bulamamış bir process'in bıraktığı şey.

### Faz 7'nin çelişki kaydı

1. **`approve --reset` devreyi `closed` yapıyor, `half_open` değil.** Faz
   brifingi "open → half_open" diyordu. Core'un `resetBreaker`'ı `closed`'a
   götürüyor ve **kendi TSDoc'u tam olarak bu komutu adıyla anıyor**
   ("what `agentfuse approve --reset` calls"); `applyBreakerEvent`'in
   `'reset'` olayı `phase = 'closed'` yazıyor. Core donmuş, yani uygulanabilir
   tek davranış buydu. Test de gerçek davranışı (`open` → `closed`) pinliyor ve
   komut sonucu yazıyor ("The breaker is now closed."). **Karar hak eden nokta:**
   `--reset` gerçekten `half_open`'a mı götürmeli (yani operatör devreyi açar
   ama sonraki her çağrı yine onay ister), yoksa `closed` mu? İkincisi
   uygulanmış ve belgelenmiş durumda; birincisi motora yeni bir giriş noktası
   ister (`resetBreaker(sessionId, { to: 'half_open' })` ya da
   `cooldownElapsed(sessionId)`).
2. **İnsanın `--reason`'ı rapora ulaşmıyordu** (yukarıda). ADR-009 bunu karara
   bağladı, `a92f06d` kapattı. Ajana giden metne hâlâ ulaşmıyor.
3. **Açılamayan kanal sert hata değil** (yukarıda). Brifing bunu belirtmiyordu;
   embeddings tablosunun precedent'inden bilinçli olarak ayrıldı ve gerekçesi
   yazıldı.
4. **Prompt `--quiet`'i yok sayıyor** (yukarıda). Brifingde yoktu.
5. **`core` ve `proxy` değiştirilmedi.** Tek satır bile. `APPROVAL_TIMEOUT` ve
   `APPROVAL_DENIED` metinleri Faz 5'ten beri `trip-result.ts`'te hazırdı ve
   olduğu gibi yeterliydi; Faz 7 onları yalnız gerçek bir akışla doğruladı.
   Faz 6b'nin bıraktığı iki kanca (`onChildExit`, `onConnect`) yine eklenmedi —
   Faz 7 proxy'ye hiç dokunmadı.

### Faz 8 ve Faz 10 için bırakılanlar

**Faz 8 (OTLP telemetri):**

- Onay akışının yazdığı olay adları sabit ve hepsi tek bir `Diagnostics`
  üzerinden geçiyor: `approval_socket_open`, `approval_socket_stale_removed`,
  `approval_socket_unavailable`, `approval_socket_bind_failed`,
  `approval_socket_rejected`, `approval_socket_error`,
  `approval_socket_handler_failed`, `approval_socket_idle`, `approval_gateway`,
  `approval_gateway_off`, `approval_gateway_unavailable`, `approval_pending`,
  `approval_posted`, `approval_resolved`, `approval_decided_by`,
  `approval_discarded`, `approval_gateway_failed`, `breaker_reset`.
- **`approval_resolved` merkezi olan.** `{ approvalId, sessionId, verdict,
  source, reason? }` taşıyor; `source` `cli` | `webhook` | `timeout` | `abort`.
  Bir onayın ne kadar beklediğini ölçmek isteyen telemetri `approval_pending`
  ile `approval_resolved` arasını alır.
- **Secret asla bir olayda görünmüyor** — yalnız değişkenin adı
  (`secretEnv`). Bu, OTLP export'una da aynen taşınmalı.
- Umbrella ADR-003'ün dört olay tipi hâlâ bağlayıcı: bunların hiçbiri
  `TelemetrySink`'e yazılmıyor, host'un teşhis akışında duruyorlar. İkinci bir
  `Diagnostics` kurulmamalı (rate-limit pencereleri ayrışır).

**Faz 10 (dokümanlar + v0.1.0):**

- Kurulum anlatısı `wrap` üzerinden (ADR-008: HTTP kullanıcısı v0.1.0'da koruma
  almıyor). Onay akışı bölümünün anlatması gerekenler: prompt'un stderr'de
  olduğu ve `--quiet` ile susmadığı, socket'in nerede durduğu ve
  `AGENTFUSE_APPROVAL_SOCKET`'in onu taşıdığı, `approve`/`deny`'ın `--reason`
  istediği, ve `--reset`'in devreyi **kapattığı**.
- **`on_timeout: allow` belgelerde de "önerilmez" diye geçmeli.** Şemada
  açıklama alanı yok; `agentfuse init`'in yazdığı dosyada ve `approve --help`'te
  yazıyor, dokümanda da yazmalı.
- Webhook alıcısı yazacaklar için üç zorunlu davranış (ham gövde üzerinde
  doğrulama, sabit zamanlı karşılaştırma, imzalı `timestamp`'in yaşı)
  `examples/approval-webhook.mjs`'in başındaki blokta duruyor; doküman oraya
  işaret edebilir ya da onu kopyalayabilir.
- `agentfuse init`'in yazdığı dosya artık gerçek bir `approvals:` bloğu
  içeriyor (yorumlu değil) ve yayınlanmış JSON Schema'ya karşı doğrulanıyor.
- Komut listesi büyüdü: `wrap serve init validate report approve deny models`.

---

## Faz 8 — telemetri (OTLP) (bitti)

Dört commit: `0172deb` tel formatı + alıcı fixture'ı, `3d36b9f` olay eşlemesi +
runtime bağlantısı, `3177f90` uçtan uca iz bağlamı + örnek alıcı, `3e791d4`
karar tablosunun ve kötü gün yollarının testleri. `packages/cli/src` ağacına
eklenenler:

```
telemetry/otlp.ts          ← OTLP/HTTP JSON kodlaması (saf: I/O yok, saat yok)
telemetry/trace.ts         ← W3C traceparent ayrıştırma + span kimliği
telemetry/exporter.ts      ← sınırlı kuyruk, batch, fetch, backoff
telemetry/sink.ts          ← FuseEvent → span + log record
telemetry/index.ts         ← karar tablosu (embeddings.ts'in kardeşi)
telemetry/diagnostics.ts   ← tek Diagnostics'in ikinci okuyucusu
testing/otlp-receiver.ts   ← süreç içi alıcı (build ve coverage dışı)
examples/otlp-receiver.mjs ← bağımlılıksız alıcı örneği
```

### ADR-010 uygulandı: OTel SDK'sı kurulmadı

Resmi yığın ölçülmüştü (`semantic-conventions` tek başına 12 MB) ve çatı
ADR-003 öznitelikleri `tunedness.*` altında sabitlediği için o paketin satacağı
bir şey yok. Sonuç: **sıfır yeni bağımlılık**, taşıma Node 20'nin global
`fetch`'i. "Kapalıyken sıfır OTel modülü" iddiası artık dinamik import
disiplinine değil, paketin ağaçta hiç bulunmamasına dayanıyor ve
`discipline.test.ts` bunu dört ayrı testle zorluyor: hiçbir manifest
`@opentelemetry/*` beyan etmiyor, lockfile'da `node_modules/@opentelemetry`
anahtarı yok, dizin kurulu değil, hiçbir kaynak dosya adını anmıyor. (Lockfile
metninde ad **geçiyor**: vitest `@opentelemetry/api`'yi *opsiyonel peer* olarak
sayıyor, ki bu tam olarak kurulmamış bir bağımlılıktır. Test bu yüzden yüklü
paket anahtarına bakıyor.)

### JSON kodlamasından neyin yazıldığı, neyin yazılmadığı

**Yazılan:** `ExportTraceServiceRequest` ve `ExportLogsServiceRequest`
gövdeleri, `resource` + `scope` sarmalayıcıları, `status`'lu span, `eventName`
taşıyan log record, ve `AnyValue`/`KeyValue` öznitelik kodlaması.

**Bilinçle yazılmayan:** metrikler, span event'leri ve link'ler, profil
sinyali, `droppedAttributesCount` (hiçbir öznitelik düşürülmüyor), scope
öznitelikleri, ve yanıtın `partialSuccess` yarısı — collector'ın cevabından
yalnız durum kodu okunuyor.

Kolay yanlış yapılan iki şey ve neden öyle:

1. **64-bit tam sayılar JSON'da string.** Bu proto3'ün JSON eşlemesi, biçim
   tercihi değil — ve burada asıl önemi zaman damgasında: ms × 1e6 ≈ 1.7e18,
   `Number.MAX_SAFE_INTEGER`'ın çok ötesinde. `unixNano` bu yüzden `BigInt`'ten
   geçiyor; testi `Number.isSafeInteger`'ın `false` döndüğünü de iddia ediyor.
2. **Trace ve span id'leri hex, base64 değil.** OTLP JSON spesifikasyonu
   proto3'ün `bytes` varsayılanını tam bu alanlar için eziyor.

Öznitelik tipi **çağrı yerinde** seçiliyor (`str`/`int`/`double`/`bool`/
`strings`), çalışma zamanı değerinden çıkarılmıyor: tam olarak 1 olan bir
`budget.ratio` yine `double`, yoksa backend bir alan için iki kolon görürdü.

### İki sinyal, dört olay tipi

| ne zaman | ne gidiyor |
| --- | --- |
| iletilen her `tools/call` | `/v1/traces`'e `mcp.tools/call` span'i **ve** `/v1/logs`'a `tunedness.tool_call` |
| `allow` olmayan her karar | `tunedness.policy_decision` |
| %50 / %80 / %100 bütçe geçişleri | `tunedness.budget_event` |
| kural ya da semantik tetiklenmesi (`warn`'daki `wouldTrip` dahil) | `tunedness.loop_detection` |

Olaylar **log record** olarak gidiyor, span event'i olarak değil: bütçe ve
döngü olayları iletilmiş bir çağrı olmadan da oluşabiliyor, yani asılacakları
bir span her zaman yok. `eventName` alanı **ve** `event.name` özniteliği
birlikte yazılıyor — ilki güncel log veri modelinin yeri, ikincisi o alandan
önce yazılmış her collector'ın baktığı yer.

Öznitelik adları çatı ADR-003 uyarınca `tunedness.*`. Kaynak seviyesinde iki
iyi bilinen anahtar ad alanı dışında tutuldu (`service.name`,
`service.version`), çünkü collector'lar yönlendirmeyi onlarla yapıyor.
ADR-007 bağlayıcı: `call.tokens_estimated`, ve bütçe boyutu adları `tokens` →
`tokens_estimated`, `usd` → `usd_estimated` diye çevriliyor.

**Beşinci tip mümkün değil ve bu bir test:** `event-types.test.ts`
`EVENT_NAMES`'i ADR-003'ün elle yazılmış listesiyle karşılaştırıyor, sink'te
log record üreten **tek** bir yer olduğunu ve adının o tablodan geldiğini
kontrol ediyor, ve `security_event`'in hiçbir kaynak dosyada (yorum dışında)
geçmemesini zorluyor. Faz 3'ün kuralı da duruyor: embedding kuyruğu hataları
`SemanticLoopStats`'ta kalıyor, `semantic_stats` teşhisi olarak yazılıyor.

### İz bağlamı nereden geliyor, nereye gitmiyor

Proxy `traceparent`'ı isteğin `_meta`'sından (SEP-414) okuyup `beforeCall`'a
veriyor, motor da onu uçuştaki `ToolCallRecord`'da tutuyor. CLI onu **oturum
store'u üzerinden** okuyor: `runtime.ts` sink'e geç bağlanan bir arama
fonksiyonu veriyor (`sessions.get(sessionId)?.inFlight.get(callId)?.traceparent`),
approval host'unun `bindHost`'uyla aynı desen.

Zamanlama taşıyıcı: **span kimliği `policy_decision` anında basılıyor**, çünkü
kaydın `inFlight`'ta olduğu pencere tam olarak orası (`deny` yolunda silme
`emit`'ten *sonra* geliyor). `tool_call` olayı aynı `callId`'nin kimliğini
yeniden kullanıp haritadan düşürüyor. Böylece bir kararın olayı ile ettiği
çağrının span'i **aynı span id**'yi taşıyor ve bloke edilmiş bir çağrının olayı
da ajanın izinin içinde kalıyor.

- **Gelen bağlam varsa** span onun çocuğu: aynı `traceId`, yeni span id,
  `parentSpanId` = gelenin span id'si, flag'ler olduğu gibi taşınıyor.
- **Gelen bağlam yoksa** span burada başlayan bir izin kökü: yeni `traceId`,
  `parentSpanId` **yok**, ve tele hiçbir şey yazılmıyor. Korelasyon anahtarı o
  zaman `tunedness.session_id` — ki her span ve her olay onu zaten taşıyor.
- **Sampling bayrağı taşınıyor ama uygulanmıyor:** bu telemetri bir devre
  kesicinin neye izin verip neyi reddettiğinin kaydı, ve başkasının head
  sampler'ının bloke edilmiş bir çağrıyı kayıttan düşürmesine izin vermek
  denetim izine delik açardı.
- **`budget_event` ve `loop_detection` iz id'si taşımıyor.** Bütçe geçişi bir
  çağrının değil oturumun olayı; döngü tespiti kendisini üreten geçmiş
  çağrıları adıyla taşıyor (`loop.call_ids`). O sırada açık olan span'e
  bağlamak, tahmini bağlantı gibi göstermek olurdu.
- **`tracestate` ve `baggage` CLI'ya hiç ulaşmıyor.** Motorun kaydı yalnız
  `traceparent` taşıyor; proxy üçünü de upstream'e iletiyor. `trace.ts`
  `tracestate`'i okuyabiliyor (test edildi), ama üretimde besleyen yok.

### Upstream'e yeniden enjeksiyon — Faz 8'de yapılmadı, sonra yapıldı

Faz brifingi "upstream `_meta`'ya yeniden enjekte et" diyordu; Faz 8 proxy'ye
dokunamadığı için yapamadı ve bugünkü davranışı (sarılan sunucunun işi
AgentFuse'un span'inin **kardeşi**) kayda geçirdi. Boşluk `a3e7752` ile
kapatıldı — aşağıdaki "Kapanan iki boşluk" bölümü dikişin son halini anlatıyor.

Kayda değer olan, o zaman **reddedilen** çözüm: CLI tarafından kapatmanın tek
yolu downstream transport'u sarıp gelen `_meta`'yı yeniden yazmak olurdu, yani
proxy'nin okuduğu isteği değiştirmek. Bu "en küçük dürüst geçici çözüm" değil,
ajanın gönderdiği mesajı arkadan değiştirmek olurdu ve `bridge.ts`'in tek
sahiplik kuralını bozardı. Doğru cevap proxy'de bir kanca açmaktı.

### Onaylar dört tipin içinde nasıl görünüyor

Kendi olay tipleri **yok**; olan şey `policy_decision`'ın içinde:

- İnsanın sorulduğu karar zaten `POLICY_APPROVAL`, kötü biten hali
  `APPROVAL_DENIED` / `APPROVAL_TIMEOUT` kodlarıyla geliyor (`decision.codes`).
- Eksik olan tek ölçüm Faz 7'nin işaret ettiği şeydi: insan ne kadar bekletti.
  Sink teşhis akışını izliyor (`approval_pending` ve webhook'un
  `approval_posted`'ı → `approval_resolved`, `approvalId` ile eşleşerek) ve
  `approval.verdict`, `approval.source`, `approval.wait_ms` özniteliklerini o
  oturumun **bir sonraki** kararına iliştiriyor.
- **Bilinçli genişletme:** onaylanan bir çağrının kararı `allow`'dur ve tablo
  onu dışa vermezdi. Yine de veriliyor, çünkü ADR-009 onay kaydını bir denetim
  artefaktı sayıyor ve denetimin sorduğu soru tam olarak "bu çağrıya neden izin
  verildi"dir. **Başka hiçbir `allow` tele çıkmıyor.**
- **Secret hiçbir yere gitmiyor:** teşhis satırından **adıyla üç alan**
  kopyalanıyor (`verdict`, `source`, ve zaman damgaları). `reason` bile
  kopyalanmıyor — insanın yazdığı serbest metnin collector'a gitmesi için bir
  sebep yok. Bir test uydurma bir `secret` alanı, bir socket yolu ve secret
  içeren bir `reason` ile besleyip export'ta hiçbirinin görünmediğini ölçüyor.

### Export kuyruğu: sınırlar ve backoff

`exporter.ts` bilinçle `core/src/loop/queue.ts` ile aynı şekilde — üründe iki
değil tek bir "sınırlı arka plan işi" biçimi olsun diye:

| davranış | değer |
| --- | --- |
| sinyal başına kuyruk | 1024 kayıt, taşmada **en eski** düşer |
| batch | en çok 128 kayıt |
| flush aralığı | 1000 ms (unref'li timer), batch dolunca hemen |
| POST timeout'u | 5000 ms (`AbortSignal.timeout`, bağlantı dahil) |
| backoff | 1000 ms'den başlayıp ikiye katlanarak 30 s'ye kadar |
| başarısız batch | **yeniden denenmez**, düşürülür ve sayılır |

Gerekçeler: yeniden deneme zaten zorlanan bir collector'ın üstüne yük bindirir
ve veri gözlemseldir (kararlar stderr'de ve kesinti raporlarında duruyor);
timer `unref`'li, çünkü wrap'i ajanın pipe'ı ayakta tutar, bekleyen bir export
değil; **bir kesinti bir satır** yazar (bir streak'in yalnız ilk hatası),
toparlanma da bir satır (`telemetry_export_recovered`); kapanışta
`telemetry_stats` sayaçları yazıyor. Başarılı yanıtın gövdesi **hiç
okunmuyor** — bu yüzden 200 dönüp saçma gövde veren bir collector bedava.

Bir tek yerde kuyruktan ayrılıyor: core kendi timer'ını kuramadığı için orada
worker'ı bir sonraki `enqueue` uyandırıyordu; burada CLI'nin böyle bir kısıtı
yok ve bir sonraki araç çağrısına kadar bekleyen bir kayıt, anlattığı olaydan
sonra varırdı.

### Karar tablosu ve embeddings'ten ayrıldığı satır

| yapılandırma | sonuç |
| --- | --- |
| `telemetry.enabled: false` | **sessizce hiçbir şey kurulmaz.** Kuyruk yok, timer yok, socket yok, stderr'de satır yok. |
| açık, endpoint ayrıştırılıyor | exporter + sink, ve endpoint'i anan bir `telemetry_enabled` teşhisi. |
| açık, endpoint ayrıştırılamıyor | **uyarı, koşum devam eder.** |

Son satır embeddings tablosundan bilinçle ayrılıyor. Orada `provider: local` +
`mode: enforce` + eksik paket sert çıkıştı, çünkü operatör adı geçen bir
dedektörle devre kesilmesini istemişti. Telemetri hiçbir şeye karar vermiyor:
`otlp_endpoint`'teki bir yazım hatası yüzünden wrap'i düşürmek, kullanıcının
MCP sunucusunu da götürür ve ajanı **önünde fuse olmadan** bırakır — Faz 7'nin
açılamayan onay kanalı için verdiği kararın aynısı.

`telemetry.enabled: false` satırının sessiz olması da karar: kimsenin açmadığı
bir özellik hakkında her koşumda bir satır yazmak, operatörün kendi sunucusunun
çıktısını okuduğu akışta gürültüdür.

### Tek `Diagnostics`, ikinci okuyucu

Faz 6b'nin kuralı duruyor: bir wrap'te **tek** `Diagnostics` var, yoksa
rate-limit pencereleri ayrışır. Faz 8'in ihtiyacı ikinci bir *tüketici*ydi, o
yüzden `ObservedDiagnostics` sınıfı `Diagnostics`'i **genişletiyor**:
`emit` önce gözlemciye gösteriyor, sonra `super.emit`'e devrediyor. Prefix,
rate limiter, `block()` ve `--quiet` proxy'nin, değişmedi.

**Gözlem `--quiet` kontrolünün önünde ve bu bilinçli.** `--quiet` AgentFuse'un
terminaldeki gevezeliğini susturmak içindir; devre kesicinin ne yaptığını
kaydetmeyi durdurma talimatı değildir. Sessiz bir terminal istediği için
denetim izini kaybeden bir koşum, tam olarak collector'ın var olma sebebini
kaybederdi. Bir test `--quiet` altında stderr'in tamamen boş olduğunu ve
export'un yine aktığını birlikte ölçüyor.

Gözlemci `try` içinde: kapalı olması gereken bir özellik uğruna proxy'yi
düşüren bir telemetri tüketicisi olmaz.

### Testler — alıcı gerçek bir socket'te

- `testing/otlp-receiver.ts` süreç içi ama **gerçek** bir `node:http` sunucusu:
  gelen URL'yi, header'ları ve ayrıştırılmış gövdeyi olduğu gibi tutuyor, ve
  istendiğinde kötü davranıyor (yavaş cevap, HTTP hatası, bozuk gövde, socket'i
  kapatma). Payload alan alan onun tarafından doğrulanıyor.
- `wrap-process.test.ts`'e dört uçtan uca test eklendi: **inşa edilmiş
  `dist/main.js`**, gerçek fixture sunucusu ve gerçek alıcı ile. Gelen
  `traceparent` span'i çocuk yapıyor; sarılan sunucu ajanın bağlamını
  değişmeden görüyor (fixture `FIXTURE_ECHO_META=1` ile `_meta`'yı geri
  yazıyor); bağlam yokken span kök oluyor ve `session_id` ADR-006'nın ULID'i
  oluyor; `warn` modunda `loop.enforced: false` gidiyor; ve **telemetri
  kapalıyken dinleyen bir collector'a hiçbir şey ulaşmıyor.**
- `examples/otlp-receiver.mjs` bağımlılıksız bir alıcı, ve `examples.test.ts`
  onun okuyucularını **gerçek kodlayıcıya karşı** koşturuyor — bir tel
  formatının yanlış örneği, hiç olmamasından kötüdür.

### Faz 8'in çelişki kaydı

1. **Upstream'e yeniden enjeksiyon yoktu** (yukarıda). Proxy o fazda donmuştu;
   dikiş yazıldı, sonradan `a3e7752` ile uygulandı.
2. **Gelen bağlam yokken span yine üretiliyor** (kök olarak). "Uydurma
   `traceparent` yok" kuralı *tel üzerine yazılan dizeye* uygulandı: hiçbir
   yere `traceparent` yazılmıyor ve hiçbir span uydurma bir ebeveyn
   bildirmiyor. Alternatif okuma — bağlam yokken hiç span üretmemek — wrap
   modunun tamamında span'i sıfırlardı, çünkü bugün ajanların çoğu
   `traceparent` göndermiyor.
3. **Onaylanan bir `allow` kararı dışa veriliyor** (yukarıda, ADR-009).
   Tablonun "yalnız `allow` olmayanlar" kuralının tek istisnası, ve dar:
   insanın sorulduğu karar.
4. **`http.ts`'in `RequestContext`'i genişletilmedi.** Faz 6b oraya "OTLP
   bağlamı gerekirse buraya" notu bırakmıştı; P0'da `serve` araç çağrısı
   iletmiyor (ADR-008), yani okuyacak span yok. Okunmayan bir alan eklemek ölü
   kod olurdu. ADR-006 merdiveni HTTP header'larını okumamaya devam ediyor.
5. **`core` ve `proxy` değiştirilmedi.** Tek satır bile. `TelemetrySink` portu,
   `FuseEvent` birliği ve `ToolCallRecord.traceparent` olduğu gibi yetti;
   ihtiyaç duyulan tek şey `engine.ports.sessions` üzerinden uçuştaki kaydı
   okumaktı, ki o zaten public yüzey.

---

## Kapanan iki boşluk — Faz 7 ve Faz 8'in bıraktıkları (bitti)

İki commit: `a3e7752` upstream `_meta`'ya span enjeksiyonu, `a92f06d` onay
gerekçesinin denetim kaydına taşınması. İkisi de yeni özellik değil; `.ssot`'un
zaten verdiği sözlerdi ve ilgili fazlar `core`/`proxy`'ye dokunamadığı için
açık kalmışlardı. Bu çalışma iki pakete de **dar** dokundu: başka hiçbir
değişiklik yok.

### Boşluk 1 — span'imiz artık upstream `_meta`'da

Dikişin son hali üç parçadan oluşuyor ve hiçbiri sınır kuralını bozmuyor:

```
bridge.ts   GuardedToolCall.forward(overrides?: OutboundMetaOverrides)
remap.ts    forwardedMeta/upstreamParams(..., overrides?)   ← _meta'nın tek sahibi
tools-call.ts  ToolCallGuardOptions.traceparentFor(call, decision)
```

- **`forward()` bir override çantası alıyor, params değil.** Kapı ajanın
  isteğini yeniden yazamıyor; yalnız `remap.ts`'in bildiği bir `_meta`
  anahtarına erişiyor. `bridge.ts` ve `remap.ts` hâlâ `@agentfuse/core`
  görmüyor — `boundary.test.ts` yerinde ve geçiyor.
- **Kanca `beforeCall`'dan *sonra* okunuyor ve `decision`'ı da alıyor.**
  Sebep zamanlama: span kimliği CLI'da `policy_decision` anında basılıyor
  (Faz 8'in kararı), yani enjekte edilecek dize karar verilmeden önce
  *yok*. Kancanın `decision.callId`'ye ihtiyacı bu yüzden var; brifingdeki
  `traceparentFor(call)` imzası tek başına yetmezdi.
- **`OtlpTelemetrySink.traceparentFor(callId)`** o kimliği `00-…` olarak
  render ediyor, `runtime.ts` kancayı ona bağlıyor, `wrap.ts` yalnız sink
  varken geçiriyor. Telemetri kapalıyken `Runtime.traceparentFor` `undefined`;
  proxy kancayı hiç almıyor ve giden baytlar ajanın kendi baytları.
- **Uydurma yok.** Tele yazılan dize bu process'in gerçekten export ettiği bir
  span'i adlandırıyor. Gelen bağlam yokken bile enjekte ediliyor — o span bir
  izin kökü ve sarılan sunucu ona katılıyor; "uydurma `traceparent` yok" kuralı
  *var olmayan* bir span'i adlandırmayı yasaklıyor, var olanı değil.

Kanıt: `wrap-process.test.ts` içinde inşa edilmiş `dist/main.js`, gerçek
fixture sunucusu ve gerçek OTLP alıcısıyla iki test — biri gelen bağlamla
(`echoed._meta.traceparent === 00-<agent trace>-<export edilen span id>-01`),
biri bağlamsız (kök span'in kendisi). Regresyon tarafı ayrı pinli: telemetri
kapalı bir wrap'te sarılan sunucu ajanın `traceparent`/`tracestate`/`baggage`
üçlüsünü olduğu gibi görüyor.

### Boşluk 2 — onay gerekçesi denetim kaydında

ADR-009'un ikinci yarısı. Dikiş:

```
ports/index.ts   ApprovalGateway → Promise<verdict | { verdict, reason? }>
domain/decision  ApprovalRecord, APPROVAL_REASON_LIMIT (500), Decision.approval
report/          TripReport.approval + render'da "human: <verdict>" satırı
util/text.ts     sanitizeFreeText(value, limit)
```

- **Tip genişletildi, değiştirilmedi.** Port hâlâ çıplak bir verdict dizesini
  kabul ediyor, çünkü söyleyecek başka şeyi olmayan bir gateway (core'un
  `DenyAllApprovalGateway`'i, test dublörleri, bir gömücünün üç satırlık
  adaptörü) yeniden yazılmayı hak etmiyor. İki biçim motorda tek bir yerde —
  `approvalRecordOf` — normalize ediliyor, sanitizasyon da orada bir kez
  koşuyor. Okunamayan bir verdict `'denied'`: motorun anlamadığı cevap rıza
  değil.
- **Faz 7'nin "rapor gateway cevap vermeden önce inşa ediliyor" gözlemi
  yanlıştı.** `beforeCall` sırası şu: `runGuards` → approval → `buildTripReport`.
  Yani gerekçe rapora sonradan iliştirilmiyor, rapor zaten onu bilerek
  kuruluyor. Hiçbir yeniden sıralama gerekmedi.
- **Değişen tek davranış: raporun ne zaman diske yazıldığı.** Eskiden yalnız
  bloklanan çağrılar dosya üretiyordu; ADR-009 "rapor bir denetim artefaktıdır,
  denetimin sorduğu soru 'bu çağrıya neden izin verildi'dir" dediği için insana
  sorulan çağrı **onaylandığında da** yazılıyor. Genişleme dar: koşul
  `decision.approval !== undefined`, yani kural seviyesinde bir
  `require_approval` (devreyi tripletmeyen, dolayısıyla raporu olmayan) hâlâ
  hiçbir şey yazmıyor ve `warn` modunda onay hiç çözülmüyor.
- **Metin güvenilmez sayılıyor.** `sanitizeFreeText` ANSI dizilerini, C0/C1
  kontrol karakterlerini (satır sonları dahil), tek başına kalmış surrogate'leri
  siliyor, boşlukları tekleştiriyor ve 500 karakterde kırpıyor. Sebebi yolculuk:
  metin bir terminalde yazılıyor, socket ya da HTTP üzerinden geliyor, bir JSON
  dosyasına yazılıyor ve **başkasının** terminalinde render ediliyor. Webhook
  kanalında yazarı operatör bile değil, uzak bir endpoint. CLI protokolünün
  kendi 1 KiB `--reason` sınırı ayrıca duruyor; ikisi farklı katmanlar.
- **Telemetri değişmedi.** Faz 8 `reason`'ı bilinçle kopyalamıyordu ve hâlâ
  kopyalamıyor; dört olay tipi sözleşmesi (çatı ADR-003) olduğu gibi. Secret
  testi yerinde: uydurma bir `secret` alanı ve secret içeren bir `reason` ile
  beslenen sink export'a hiçbirini yazmıyor.
- **Ajana giden metin de değişmedi.** `buildTripResult` yalnız kodu, devre
  fazını ve rapor kimliğini taşıyor. ADR-009 gerekçeyi "raporun ve karar
  kaydının" taşıması gerektiğini söylüyor; operatörün serbest metnini modelin
  bağlamına koymak ayrı bir ürün kararı ve burada verilmedi (aşağıya bakın).

Kanıt: `approve-process.test.ts` içinde iki gerçek process — onaylanan ve
reddedilen çağrının gerekçesi `agentfuse report last` çıktısında ve
`--json`'ında; ANSI + kontrol karakteri + satır sonu + uzun metin taşıyan bir
gerekçe raporu bozamıyor; ve webhook kanalının `reason`'ı (uzak endpoint
yazıyor) kayda giriyor ama secret hiçbir yere sızmıyor. Cevapsız kalan bir onay
(timeout) bit bit eskisi gibi davranıyor.

### Üç kanca artık bir desen mi?

Evet, ve kayda geçiyor. Biri artık var (`ToolCallGuardOptions.traceparentFor`),
ikisi hâlâ önerilmiş durumda (`StdioWrapOptions.onChildExit`,
`StdioWrapHandle.onConnect`), ama üçü de aynı biçim: *proxy bir olayı biliyor,
host ona ne yapacağını biliyor.* Üçü de opsiyonel ve yoklukta bugünkü davranışı
bit bit koruyor — CLI'daki 25 ms'lik `watchForConnection` zamanlayıcısı ve
`wrap.ts`'in exit-code tablosu, o iki kanca olmadığı için var olan geçici
çözümler.

**Yine de birleştirilmedi.** İkisi bağlantı yaşam döngüsüne
(`StdioWrapOptions`), biri araç çağrısı yoluna (`ToolCallGuardOptions`) ait ve
bunlar farklı ömürler: biri bağlantı başına bir kez, öteki her `tools/call`'da.
Tek bir `hooks` nesnesinde toplamak, kalan iki kanca da yazıldığında ve
McpGuard'ın paylaşılan pakete taşıma günü geldiğinde değerlendirilecek bir iş;
o güne kadar üç ayrı opsiyonel alan okunaklı olanı. Bu faz onları kendi
inisiyatifiyle birleştirmedi — brifing de bunu istemedi.

---

## Faz 9 — benchmark'lar ve eşik kalibrasyonu (bitti)

Beş commit: `bdd1fff` corpus üreteci + determinizm testleri, `1f3992e` replay +
sweep + ablation, `b0e0c68` algoritma değişikliği + kalibre edilmiş
varsayılanlar, `7479363` gecikme benchmark'ı + exporter düzeltmesi, `8c89a3d`
CI. `bench/` ağacı:

```
bench/src/rng.ts                    — tohumlu mulberry32
bench/src/detection/types.ts        — corpus formatı ve senaryo adları
bench/src/detection/corpus.ts       — üreteç (10 senaryo × 20 oturum)
bench/src/detection/generate.ts     — corpus.jsonl'i yazar
bench/src/detection/replay.ts       — gerçek FuseEngine ile replay + embed
bench/src/detection/sweep.ts        — skor dizisi, kritik eşik, metrikler
bench/src/detection/run.ts          — sweep, seçim, uçtan uca doğrulama
bench/src/detection/ablation.ts     — ekseni seçen ölçüm (aşağıya bakın)
bench/src/latency/{stats,inmemory,stdio,run}.ts
bench/detection/corpus.jsonl        — commit'li, hash'i testle pinli
bench/{detection,latency}/results.{md,json}  — commit'li ölçümler
bench/latency/noop-server.mjs       — boş MCP sunucusu
```

### Corpus — her senaryo neyi yakalamak için var

200 oturum, 2084 çağrı, 100 pozitif / 100 negatif. Her oturum
`<seed>:<senaryo>:<index>` ile tohumlanmış kendi `Rng`'sinden doğuyor, yani yeni
bir senaryo eklemek yanındakileri kaydırmıyor ve JSONL bayt-birebir yeniden
üretiliyor (`corpus.test.ts` sha256 ile pinliyor).

| senaryo | etiket | neyi sınıyor |
| --- | --- | --- |
| `verbatim-retry` | pozitif | R1'in var olma sebebi. Zor değil; tespit gecikmesinin tabanını çiviliyor (üçüncü çağrıda trip = iki boşa tur). |
| `reworded-retry` | pozitif | **Yalnız semantik katmanın görebileceği iki senaryodan biri.** Aynı soru her turda başka kelimelerle; bütün fingerprint'ler farklı, hiç hata yok, salınım yok — R1/R2/R3 yapısal olarak kör. |
| `error-loop` | pozitif | R2, ve `errorSignature`'ın maskelemesi: `/tmp/<hex>` dışında aynı olan iki hata aynı imzaya düşmezse kural hiç ateşlenmez. |
| `oscillation` | pozitif | R3. Period 2 ve 3; hiçbir araç tek başına R1 eşiğine varmıyor. |
| `drifting-loop` | pozitif | **İkinci semantik-only senaryo** ve gerçek model hatasına en çok benzeyeni: her turda bir düğme kımıldıyor, hiçbir şey tekrarlamıyor, cevap hiç değişmiyor. |
| `pagination-sweep` | negatif | Ürünün en pahalı yanlış pozitifi. Faz 4 sayfa 1 ↔ sayfa 2'yi **0.9971** ölçmüştü — gerçek bir döngüden ayırt edilemeyecek kadar yakın. Yarısı hex cursor, yarısı base64 token, üçte biri cursor'suz (offset SQL'in içinde). |
| `bulk-edit` | negatif | Tek araç, N çağrı, yalnız bir yol ya da bir id'de farklılaşan argümanlar, yalnız bir bayt sayısında farklılaşan sonuçlar. |
| `try-then-fix` | negatif | Aynı build komutu düzeltmeden önce ve sonra. Tek pencerede iki özdeş fingerprint. |
| `list-traverse-process` | negatif | Ortasında pencereyi tek başına dolduran bir `read_file` koşusu. |
| `converging-build-test` | negatif | Aynı komut üç-dört kez, hata sayısı yediden sıfıra düşerek. **Argümanlar hiç değişmiyor; ilerleme tümüyle sonucun içinde.** |

**Corpus'ta bilinçli bir düzeltme yapıldı ve rakamları görmeden önce değil,
gördükten sonra yapıldı — o yüzden burada yazıyor.** İlk taslakta
`reworded-retry`'nin sonuç metni her çağrıda dört farklı "bir şey bulunamadı"
ifadesi arasından rastgele seçiliyordu. **Hiçbir araç kendi çıktısını çağrılar
arasında yeniden ifade etmez**: yeniden ifade eden ajandır, arama API'si boş
sonuca her seferinde aynı cümleyi döner. Düzeltme, oturum başına sabit bir
ifade (yarısı) ya da sorguyu cevabın içine yankılayan bir şablon (diğer yarısı)
oldu. İkincisi kasten zor: cevap sorguyla birlikte hareket ediyor.

**İkinci bir düzeltme yapılmadı ve sebebi de kayda değer.**
`list-traverse-process`'in okuduğu dosya içerikleri şablon; gerçek dosyalar
birbirinden çok daha fazla ayrışır, yani bu negatif gerçekte olduğundan daha
"döngü gibi" duruyor ve tam olarak eşiği sıkıştıran şey o. Değiştirmek rakamı
iyileştirirdi — ve tuzağı zayıflatmak olurdu. Duruyor.

### Ölçüm önce ekseni reddetti

İlk tam sweep, eski tasarımla (tek birleşik embedding, `semanticEmbeddingText`
üzerinden ortalama ikili kosinüs) **düz bir ret** üretti: 2337 aday arasında PRD
§6'nın iki hedefini birlikte tutan **sıfır** tane vardı. Sebep eşik değil,
eksen. Kritik eşik dağılımları (pencere şekli 5/5/2):

| senaryo | median | max |
| --- | --- | --- |
| `drifting-loop` (poz) | 0.9965 | 0.9976 |
| `bulk-edit` (neg) | 0.9115 | **0.9970** |
| `reworded-retry` (poz) | 0.8999 | 0.9460 |
| `list-traverse-process` (neg) | 0.8584 | 0.9109 |
| `pagination-sweep` (neg) | 0.8202 | **0.9952** |

**Pozitifler negatiflerin altında.** Faz 4'ün tablosu bunu zaten söylüyordu ve
biz okumamıştık: `search_issues` sayfa 1 ↔ sayfa 2 = 0.9971, aynı aracın "login
bug" ↔ "login error" hâli = 0.9791. En uzak olması gereken çift, en yakın olan.
Birleştirilmiş metinde araç adı ve argümanlar baskın, cevap ise 1000 karakterlik
bir dizenin sonundaki tek satır.

`ablation.ts` üç alternatifi aynı corpus üzerinde ölçtü (pencere 6, min_calls 5,
consecutive 2; "en yüksek negatifin üstünde kalan pozitif sayısı"):

| eksen | en yüksek negatif | üstünde kalan pozitif |
| --- | --- | --- |
| birleşik kosinüs (eski) | 0.9968 | 19/100 |
| istek ve cevap ayrı gömülüp `min` | 0.9904 | 27/100 |
| cevap token örtüşmesi (staleness) | 0.9000 | 62/100 |
| `min(birleşik kosinüs, staleness)` | 0.8881 | 46/100 |

İkinci satır — cevabı ayrı gömmek — çağrı başına iki embedding'e mal oluyor ve
`pagination-sweep`'in en kötü hâlini hâlâ çözmüyor. Üçüncüsü tek başına
embedding'i tamamen dışarıda bırakırdı, ki ADR-002'nin kararını iptal etmek
olurdu. Dördüncüsü seçildi.

### Core'da yapılan iki değişiklik

İkisi de **daraltıyor**, genişletmiyor: eskisinin trip etmediği hiçbir yerde
trip etmiyorlar. Bir devre kesicinin yanılabileceği yön budur.

**1. R1 artık cevabın da durduğunu soruyor** (`guards/rule-loop.ts`). Kuralın
kendi mesajı "The result will not change" diyordu ve bunu hiçbir şey kontrol
etmiyordu. Ölçülen bedel: varsayılan `window: 8` ile corpus'un **her**
`converging-build-test` oturumu ve `try-then-fix`'lerin yarısı durduruluyordu —
yalnız deterministik katmandan **%31 yanlış pozitif**, hem de çalışan bir ajanın
ürettiği en yaygın şekil üzerinde. Sayım artık "aynı fingerprint'e sahip önceki
çağrılar"ın değil, **cevabı üzerinde de anlaşan en büyük grubun** üzerinde.
Cevap kimliği hatalarda `errorSignature`, başarılarda `maskString`'den geçmiş
özet — yani çıktısına zaman damgası basan bir araç R1'i kör etmiyor. Düzeltme
sonrası kural katmanının tek başına yanlış pozitifi %31 → **%9**.

**2. Pencere skoru artık iki eksenin küçüğü** (`loop/novelty.ts` +
`guards/semantic-loop.ts`). `ResultNoveltyWindow` pencerenin cevaplarının token
kümelerini ve document frequency'sini artımlı tutuyor; `staleness` = her cevabın
"pencerede başka bir cevapta da geçen" token oranının ortalaması. Skor =
`min(ortalama ikili kosinüs, staleness)`. Model çağrısı yok, saf, deterministik,
ve rapora insan doğrulayabileceği bir cümle veriyor: "son altı cevapta sana daha
önce gösterilmemiş hiçbir şey yoktu". Kenar durumlar bilinçli: **boş cevap tam
bayat sayılıyor** — hiçbir şey döndürmeyen bir araç, tekrar tekrar hiçbir şey
söylüyordur; boş dizeyi "yeni" saymak sessiz-araç döngüsünü tek görünmez vaka
yapardı.

`purity.test.ts` gevşetilmedi; yeni dosya `node:*` de timer de kullanmıyor.

### ROC ve seçilen çalışma noktası

Seçim kuralı rakamlar görülmeden `run.ts`'e yazıldı ve değiştirilmedi:

1. Yanlış pozitif çizgisini tut (`< %5`) **ve** en yakın oturuma en az
   **0.004** uzak dur — modelin kendi çözünürlük tabanının (±0.002, ADR-003) iki
   katı. Bundan yakın bir eşik kalibrasyon değil, bu 200 oturumdan geçirilmiş
   bir çizgidir.
2. Sonra PRD §6'nın recall hedefini de tutanları tercih et.
3. Sonra en yüksek F1, sonra en geniş marj, sonra en düşük gecikme p95, sonra
   küçük pencere.
4. Ölçülen her şey eşitse **daha muhafazakâr** şekil: büyük `min_calls`, büyük
   `consecutive_windows`. Corpus'un ayırt edemediği iki ayar, birinin ajanını
   durdurmadan önce daha çok kanıt isteyerek çözülür.

3198 aday tarandı. Seçilen: **`window: 5` · `min_calls: 5` ·
`threshold: 0.905` · `consecutive_windows: 1`**. Eşiğin etrafındaki eğri
(`bench/detection/results.md`'de tam hâli):

| threshold | recall | FP oranı | precision | F1 |
| --- | --- | --- | --- | --- |
| 0.845 | %90.0 | %16.0 | %84.9 | 0.874 |
| 0.870 | %88.0 | %5.0 | %94.6 | 0.912 |
| 0.890 | %88.0 | %1.0 | %98.9 | 0.931 |
| **0.905** | **%87.0** | **%0.0** | **%100.0** | **0.930** |
| 0.915 | %85.0 | %0.0 | %100.0 | 0.919 |
| 1.000 | %60.0 | %0.0 | %100.0 | 0.750 |

En yakın negatif 0.8982 (`list-traverse-process`), en yakın pozitif 0.9130 →
marj **0.0068**, çözünürlük tabanının üç katından fazla.

**`window: 5` bu dosyanın en sonuçlu sayısı.** Pencere ≥ 6 olan **hiçbir aday**
PRD §6'nın yanlış pozitif çizgisini hiçbir eşikte tutamadı — çünkü kural
katmanının yanlış pozitifleri eşiğe bakmıyor ve 8'lik bir pencere, iki tur
düzeltme arasında aynı komutun üç koşusunu görüyor.

### Ölçülen sonuç — ve karşılanmayan hedef

Uçtan uca (gerçek motor, gerçek dedektör, gerçek sağlayıcı; sweep modeliyle 200
oturumun 200'ünde aynı fikirde):

| metrik | değer |
| --- | --- |
| precision | **1.000** |
| recall | **0.870** |
| F1 | **0.930** |
| TP / FN / FP / TN | 87 / 13 / 0 / 100 |
| yanlış pozitif oranı | **%0.0** |
| tespit gecikmesi (tur) | ortalama 3.53 · p50 3 · **p95 5** · max 5 |
| kimin yakaladığı | kurallar 60, semantik 27 |

Senaryo bazında: `verbatim-retry` 20/20, `error-loop` 20/20, `oscillation`
20/20, `drifting-loop` 20/20, **`reworded-retry` 7/20**; beş negatifin
hepsi 0/20.

**PRD §6 karşılaştırması, dürüst hâliyle:**

- yanlış pozitif < %5 → **karşılandı** (%0.0, 100 dürüst oturumda)
- tespit ≥ %90 → **karşılanmadı** (%87.0)

Kaçan 13 oturumun hepsi `reworded-retry`. Sweep neden satın alınamadığını
gösteriyor: o oturumlar ölçülen her eksende `list-traverse-process`
negatiflerinin **altında** duruyor (median 0.8491'e karşı negatif max 0.8982),
yani daha fazlasını yakalayan her eşik daha fazla dürüst işi durduruyor. %90'a
çıkmanın tek yolu eşiği 0.845'e indirmek ve yanlış pozitifi %16'ya çıkarmak —
PRD §8'in birinci riskini üçe katlamak.

**Kalibrasyonun vazgeçtiği şey tam olarak bu:** 3 puanlık recall karşılığında
%16 yerine %0 yanlış pozitif ve 0.0068'lik bir genelleme marjı. Daha yüksek
recall'lu noktalar tabloda duruyor (0.890'da %88 / %1) ama marjları
çözünürlük tabanının altına iniyor; onları seçmek "yalnız bu corpus'ta çalışan
eşik" olurdu.

### `cursor` muafiyeti ağırlığını taşıyor mu — evet, ama yalnız bir katmanda

Ölçüldü, iddia edilmedi. 20 `pagination-sweep` oturumunun 15'i `cursor`
argümanı kullanıyor. Muafiyet kaldırılıp cursor hex maskesine bırakılsaydı:
**15'i fingerprint çeşitliliğini tümüyle kaybederdi ve 12'si R1 tarafından
üçüncü sayfada durdurulurdu.** Yani asimetri deterministik katmanda gerçekten
taşıyor.

**Semantik katmanda hiçbir ağırlığı yok.** Değişen bir cursor'ın gömme
uzayındaki etkisi ~0.003; pagination'ı bir döngüden ayıran şey cursor değil,
sayfaların birbirinden farklı cevaplar döndürmesi. Faz 3'ün "sonuç metni de
değişmeli" notu doğruydu ve yetersizdi: sonucun metinde **bulunması** yetmiyor,
kendi ekseninde ölçülmesi gerekiyor.

### Gecikme — ölçülen tablo

1000 sıcak çağrı × yapılandırma, önce 200 çağrı atılıyor. Node 24,
darwin/arm64. Tam tablo `bench/latency/results.md`'de.

**Eklenen gecikme = (rules | semantic) − direct, persentil persentil:**

| yapılandırma | p50 | p95 | p99 |
| --- | --- | --- | --- |
| in-memory · rules · telemetri kapalı | 0.017 | 0.022 | 0.020 |
| in-memory · semantic · telemetri kapalı | 0.013 | 0.007 | ~0 |
| in-memory · rules · telemetri açık | 0.019 | 0.022 | 0.024 |
| in-memory · semantic · telemetri açık | 0.015 | 0.018 | 0.024 |
| stdio · rules · telemetri kapalı | 0.072 | 0.134 | 0.315 |
| stdio · semantic · telemetri kapalı | 4.455 | 4.737 | 7.388 |
| stdio · rules · telemetri açık | 0.082 | 0.207 | 0.571 |
| **stdio · semantic · telemetri açık** | 4.473 | **4.835** | 7.837 |

PRD §6'nın çağrı başına p95 < 50 ms bütçesi **karşılanıyor**; en kötü
yapılandırma bütçenin onda ikisinde.

**İki tier neden bu kadar farklı — ölçülerek cevaplandı.** Kuyruk sayaçları:
in-memory 1200 çağrıda `offered 1200, embedded 0, droppedOverflow 1135`;
sarılmış gerçek process 300 çağrıda `offered 300, embedded 300, batches 300`.
Bellek içinde istemci hiçbir modelin yetişemeyeceği hızda çağırıyor, kuyruk yük
atıyor ve semantik katman **bedava** oluyor — ADR-002'nin tasarladığı özellik
ve sıcak yolun gerçekten ayrıldığının kanıtı. Boru üzerinden çağrılar yavaş,
kuyruk yetişiyor, ve ONNX işi proxy ile aynı process ve aynı çekirdekleri
paylaşıyor: fazladan dört milisaniye oradan geliyor.

**`batches 300 / offered 300` — kuyruk hiç batch'lemiyor.** Düzenli bir varış
hızında worker, bir sonraki çağrı bittiğinde hep boşta oluyor, birlik batch
alıyor ve modelin sabit çağrı maliyetini her seferinde ödüyor (Faz 4: sekizlik
batch 10,7 ms). Kuyruk arkadaş bekleyemiyor çünkü kendi timer'ı yok — Faz 3
`Scheduler` portunu bilinçle reddetti — ve tek alternatif, bir sonraki
`enqueue`'da kontrol edilen bir deadline, kısa bir oturumun kuyruğunu hiç
skorlanmadan bırakırdı. Bu, on kat boşluğu olan bir gecikme bütçesi için tespit
kapsamından ödün vermek olurdu; **alınmadı, kayda geçirildi.**

### Telemetri açık/kapalı — ve exporter'ın düzeltilen bir hatası

Faz 8 "fark ölçüm gürültüsünün altında kalmalı, aksi hâlde `exporter.ts`'in
sabitleri kalibrasyona açık" demişti. Fark görünürdü ve sebebi sabitler değildi:

`#run()` "kuyrukta bir şey varken" döngüsündeydi. Loopback'teki bir collector'a
POST ~1 ms sürüyor, o sırada kuyruğa iki kayıt daha geliyor, döngü onları da
yolluyor. Sonuç: **bir yapılandırmada 1003 istek**, aynı veriyi 18 istek
taşıyabilecekken. Dosyanın kendi belgelediği 1000 ms'lik flush aralığı, collector
hızlı olduğu için sessizce yok sayılıyordu. Düzeltme: boyut tetiklemeli bir pump
yalnız **dolu** batch'leri yolluyor, kalanı timer'a bırakıyor; timer ve `flush()`
hâlâ her şeyi boşaltıyor.

Sonrası (aynı koşum, aynı makine):

| | önce | sonra |
| --- | --- | --- |
| stdio rules, export POST | 200 | **18** |
| stdio semantic, export POST | 1003 | **18** |
| stdio rules, eklenen p95 | +0.119 ms | **+0.064 ms** |
| stdio semantic, eklenen p95 | +0.249 ms | **+0.089 ms** |

In-memory tier'da telemetrinin farkı ölçüm gürültüsünün içinde (işaret bile
değişiyor: −0.012 ile +0.008 arası). Faz 8'in iddiası — `emit` birkaç nesne
kurup bir diziye push ediyor — doğrulandı.

### CI

`.github/workflows/bench.yml`: Node 24 tek sürüm (matris `ci.yml`'nin işi; üç
sürümde üç farklı rakam üretmek "ölçüm hangisi" sorusunu cevapsız bırakırdı),
model `actions/cache` ile revision anahtarlı, `ONNXRUNTIME_NODE_INSTALL: skip`,
corpus commit'liyle karşılaştırılıyor, iki benchmark koşuyor, sonuçlar artifact
olarak yükleniyor.

**Kapı bilinçli olarak PRD §6'nın %90'ına değil ölçülen recall'a bakıyor**
(`GATE.recall = 0.85`; ölçülen 0.87, aradaki 0.02 int8 çekirdeklerinin
platformlar arası bit-birebir olmamasına pay). Yanlış pozitif kapısı PRD'nin
kendi rakamında, çünkü karşılanıyor. Her koşum PRD verdict'ini koşulsuz
yazdırıyor. Gerekçe `run.ts`'in içinde uzun uzun yazılı: %90'da kapı koymak
workflow'u kalıcı kırmızı yapar ve kimsenin okumadığı bir kapı, kapı değildir.
**Oradaki `recall` sayısını düşürmek bir değişikliği geçirmenin yolu değildir;**
o sayı ulaşılanın kaydıdır.

### Tasarımın sınırında olduğu yerler

1. **`reworded-retry` ayrılabilir değil.** Ölçülen her eksende
   `list-traverse-process` ve `bulk-edit` negatiflerinin arasına düşüyor. Cevabı
   sorguyu yankılayan yarısı özellikle çaresiz: hem istek hem cevap her turda
   değişiyor, ve "niyet aynı" bilgisi hiçbir bant içi sinyalde yok.
2. **`pagination-sweep`'in postgres varyantı** (`OFFSET` SQL'in içinde,
   `cursor` argümanı yok) kosinüs ekseninde 0.99'a çıkıyor; onu tutan tek şey
   staleness. Sonuç metnini kısaltan bir sunucu bu korumayı zayıflatır.
3. **`list-traverse-process` eşiği sıkıştıran negatif** ve corpus'taki dosya
   içerikleri şablon olduğu için gerçeğinden zor. Gerçek dosyalarla marj daha
   geniş olur; yani 0.905 muhafazakâr taraftan hatalı.
4. **Kuyruk batch'lemiyor** (yukarıda). Gecikme bütçesi rahat olduğu için
   dokunulmadı.
5. **Kalibrasyon tek modele ait.** `Xenova/all-MiniLM-L6-v2` int8. Başka bir
   model `threshold`'u geçersiz kılar; `semantic.model` değiştiren bir operatör
   kendi kalibrasyonunu yapmak zorunda ve doküman bunu söylemeli.

### Faz 10'un bilmesi gerekenler

- **PRD §6'nın tespit rakamı ya değişmeli ya da tasarım.** Doküman "%90 tespit"
  diye yazamaz; ölçülen %87 ve karşılığında %0 yanlış pozitif. Bu bir `.ssot`
  kararı (aşağıya bakın).
- Varsayılanlar artık kalibre: `window: 5`, `min_calls: 5`, `threshold: 0.905`,
  `consecutive_windows: 1`. `agentfuse init` şablonu ve JSON Schema ikisi de
  güncellendi ve her biri rakamın nereden geldiğini yazıyor.
- **`consecutive_windows` varsayılanı 2'den 1'e indi** ve bu bir geri alma:
  "bir sıçrama gürültüdür" yalnız kosinüs-tek skor için doğruydu. Staleness
  terimi skoru düzleştirdiği için sweep, bir kez yargılanan yüksek bir eşiği iki
  kez yargılanan düşük birine tercih etti.
- Gecikme cümlesi: "eklenen gecikme p95 4,8 ms'nin altında" söylenebilir, ama
  **semantik katman açıkken** rakamın 0,2 ms değil ~4,8 ms olduğu ve sebebinin
  ONNX'in aynı process'i paylaşması olduğu da söylenmeli.
- `bench` private kalıyor ve hiçbir tarball'a girmiyor; `bench/package.json`
  `private: true` ve `files` alanı yok.

---

## Sırada ne var

### Önce `.ssot`: dört nokta kendi kararını bekliyor

Çatı ADR-002 kapsam değiştiren koddan önce doküman güncellemesi şart koşuyor.
Açık duran noktalar:

1. **HTTP gateway hangi paketin işi ve upstream havuzunun anahtarı ne?**
   ADR-008 birinci yarısını kapattı (giriş noktası `packages/proxy`, `serve` P0'da
   uç), havuz anahtarı hâlâ P1'e bırakılmış durumda.
2. **ADR-006 merdiven sıralaması** (Faz 5 → çelişki kaydı #3) hâlâ
   açıklayıcı bir düzeltme bekliyor: ADR metni legacy HTTP'de
   `Mcp-Session-Id`'yi önce sayıyor, uygulama onu `baggage`'ın altına koyuyor,
   ve gerekçe aynı ADR'ın zincirleme sözleşmesi. Faz 6b bu sırayı `serve`'de
   uyguladı ve testle pinledi; metin hâlâ ötekini söylüyor.
**Kapanan üçüncü nokta:** `approve --reset` hangi phase'e götürmeli sorusunu
ADR-009 karara bağladı — devre **kapanır** (`closed`), ve uygulanan davranış
zaten oydu. Aynı ADR'ın ikinci yarısı (onay gerekçesi) da kapandı; bkz.
"Kapanan iki boşluk". Hâlâ `.ssot`'ta yeri olmayan iki şey Faz 7'de uygulanmış
ve belgelenmiş durumda: iki gateway'in kompozisyon kuralı, ve açılamayan bir
onay kanalının sert hata değil uyarı olması.

**Faz 9'dan çıkan iki nokta — ikisi de karar bekliyor:**

3. **PRD §6'nın tespit hedefi ölçümle uyuşmuyor.** Metin "≥ %90 tespit, < %5
   yanlış pozitif" diyor. Ölçülen: **%87 tespit, %0 yanlış pozitif**, 200
   etiketli oturumda, eşik en yakın dürüst oturumdan çözünürlük tabanının üç
   katı uzakta. Kaçan 13 oturumun hepsi `reworded-retry` ve sweep bunların
   `list-traverse-process` negatiflerinin *altında* durduğunu gösteriyor: %90'a
   çıkmanın tek yolu yanlış pozitifi %16'ya yükseltmek. Üç okuma mümkün ve
   seçim `.ssot`'un:
   - **(a)** PRD §6'nın rakamı ölçülene çekilir ve yanında karşılığı yazılır
     ("%87 tespit, %0 yanlış pozitif"), çünkü PRD §8'in birinci riski yanlış
     pozitiftir ve ürün onu satın almıştır;
   - **(b)** hedef korunur ve ADR-002'ye ikinci bir kademe eklenir (örneğin
     eşik sınırındaki pencereler için bir LLM-hakem çağrısı) — ADR-002'nin
     "pahalı ve yavaş" diye reddettiği şey, ama artık yalnız sınır vakalarında;
   - **(c)** hedef korunur ve daha güçlü bir embedding modeline geçilir —
     ADR-003'ün kurulum boyutu kararını yeniden açar.
   Kod bugün (a)'yı varsayıyor: CI kapısı ölçülen recall'a bakıyor ve PRD
   verdict'ini her koşumda yazdırıyor.
4. **ADR-002'nin anlatımı uygulamanın gerisinde.** ADR "her araç çağrısının
   … yerel embedding'i alınır, kayan pencere içi ortalama benzerlik eşiği
   aşarsa devre kesilir" diyor. Uygulama artık `min(ortalama benzerlik,
   cevap bayatlığı)` kullanıyor. Değişiklik **daraltıcı** — ADR'ın kuralının
   trip etmediği hiçbir yerde trip etmiyor — ve ADR'ın kendi gerekçesini
   ("sonuç özeti dahil") gerçekten uyguluyor, ama metin bunu söylemiyor. Bir
   paragraf ya onaylamalı ya tersini söylemeli.

**Faz 7'den kalan bir nokta:** onay gerekçesi **ajana** da gitmeli mi?
ADR-009 boşluğu tarif ederken "kesinti raporuna ve ajanın gördüğü metne
ulaşmıyor" diyor, ama kararı yalnız "port `{ verdict, reason? }` döndürür ve
karar kaydı gerekçeyi taşır" diye yazıyor. Uygulama dar okumayı seçti: rapor ve
karar kaydı evet, ajanın gördüğü ret metni hayır. Gerekçe, insanın serbest
metnini modelin bağlamına koymanın kendi ürün kararı olması (ve ADR-004'ün
"AgentFuse ne olacağına karar verir, ne söyleneceğine değil" çizgisine yakın
durması). Bir ADR satırı bunu ya onaylamalı ya da tersini söylemeli.

**Faz 4'ten çıkan bir nokta daha:** `onnxruntime-node`'un postinstall'ı
linux/x64'te nuget.org'dan 236 MB'lık bir CUDA çalışma zamanı çekiyor. CI'da
`ONNXRUNTIME_NODE_INSTALL=skip` ile kapatıldı, ama aynı şey
`@agentfuse/embeddings-local` kuran her linux kullanıcısının başına geliyor.
Bu bir kurulum talimatı meselesi (Faz 10), ADR meselesi değil — ADR-003'ün
"opsiyonel yoldaş paket" kararını değiştiren bir şey yok, yalnız o paketin
gerçek kurulum maliyeti tahmin edilenden büyük.

### Faz 10

Plan dosyasındaki brifing geçerli: dokümanlar ve v0.1.0.

**Faz 10'un Faz 9'dan alacakları** yukarıdaki Faz 9 bölümünün son alt
başlığında; en önemlisi PRD §6'nın tespit rakamının ölçümle uyuşmaması ve
kalibrasyonun tek bir modele ait olması.

**Faz 10'un Faz 8'den alacakları:**

- Telemetri bölümünün anlatması gerekenler: **varsayılan kapalı** (çatı
  ADR-003), `telemetry.enabled` + `otlp_endpoint` + `service_name`, sinyal
  yollarının (`/v1/traces`, `/v1/logs`) eklendiği, dört olay tipi ve
  `tunedness.*` öznitelik adları, `--quiet`'in telemetriyi **susturmadığı**, ve
  collector'ın düşmesinin bir teşhis satırından başka bir şeye mal olmadığı.
- `examples/otlp-receiver.mjs` bağımlılıksız bir alıcı ve dokümanın "çıktıyı
  gör" adımı olmaya hazır; başındaki blok ne geldiğini anlatıyor.
- ADR-010 kurulum boyutuna dokunmadığımızı söylüyor: doküman "telemetri açmak
  ek paket kurdurmaz" diyebilir, çünkü öyle.

Faz 9 ya da 10 proxy'ye dokunuyorsa birlikte alınacak **iki** kanca kaldı, ikisi
de belgelenmiş ödünç: `StdioWrapOptions.onChildExit` (çocuğun exit code'u
aynalanabilsin diye) ve `StdioWrapHandle.onConnect` (bağlantının açıldığı anı
yakalamak için kurulan 25 ms'lik zamanlayıcı silinsin diye). Üçüncüsü —
`ToolCallGuardOptions.traceparentFor` — `a3e7752` ile eklendi ve üçünün aynı
deseni paylaşması yukarıda kayda geçti.

**Faz 10 için bir not daha:** telemetri açık koşan bir kurulum her araç
çağrısında bir `_meta` anahtarı daha yazıyor (`traceparent`) ve sarılan sunucu
ajanınki yerine bizim span'imizi görüyor; gecikme ölçümü bunu da kapsıyor ve
farkı gürültünün içinde buldu. Onay bölümü ise `--reason`'ın artık kesinti
raporunda ve `agentfuse report` çıktısında göründüğünü anlatmalı; Faz 7'nin
"yalnız log'a gider" cümlesi geçersiz.

**Faz 9'un kuralı Faz 10 için de geçerli:** rakamlar yumuşatılmaz. CI
kapısındaki `GATE.recall` ulaşılanın kaydıdır, geçirilecek bir eşik değil;
düşürülmesi tespitin kötüleştiği anlamına gelir ve o zaman düşürülecek şey kapı
değil, konuşulacak şey algoritmadır.

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
