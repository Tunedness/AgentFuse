# AgentFuse — uygulama durumu ve devir notu

**Son güncelleme:** 2026-09-15 · **`main` HEAD:** `c5fa5d1` · **Durum:** Faz 2 bitti,
Faz 3 ve 5 yarıda kaldı

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
| 3 | Asenkron semantik döngü katmanı | **Yarıda** — `wip/phase-3-5-partial` |
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
npm run lint          → Checked 76 files. No fixes applied.
npm run typecheck     → temiz
npm run build         → temiz
npm test              → Test Files 14 passed · Tests 250 passed
npm run schema:check  → schema up to date
```

Coverage kapısı `vitest.config.ts` içinde `packages/core/src/**` için %90'da ve
**gerçekten zorluyor** (Faz 2'de 100'e çekilip kasten kırılarak doğrulandı).
Faz 2 sonundaki ölçüm: statements %99.05, branches %94.85, functions %100.

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

### Faz 3 için bırakılan seam'ler

- `EmbeddingProvider` `ports/index.ts`'te **donduruldu** (L2-normalize
  zorunluluğu TSDoc'ta). Değiştirmeyin, karşısına yazın.
- `SessionState.pendingTrip` ve `SessionState.degraded` alanları mevcut.
  `pendingTrip` **yalnızca** `breakerGuard` tarafından tüketilir (ilk gelen
  kazanır).
- `FuseEngine.onRecordComplete(listener)` — `afterCall` sonunda çağrılır,
  embedding kuyruğunun bağlanacağı nokta.
- `FuseEngine.markPendingTrip(sessionId, reason)` ve `markDegraded(sessionId)` —
  scorer'ın internals'a dokunmadan verdict bırakma yolu.
- `loop_detection.semantic.*` şemada tam tanımlı.
- Mevcut `describe('the semantic seam')` testleri bu kontratı pinliyor.

---

## Faz 3 ve 5 — yarıda kaldı

**Neyin yanlış gittiği:** iki faz paralel koşarken makine uykuya geçti, iki ajan
da yanıt ortasında koptu. İkisi de ciddi iş çıkarmıştı ama hiçbiri bitirmedi ve
commit atmadı.

Kısmi çıktı **`wip/phase-3-5-partial`** branch'inde (`798720b`) duruyor —
`main`'i yeşil bırakmak için oraya park edildi. O dosyalar:

- typecheck ve lint'ten **geçiyor**,
- mevcut 250 testi **kırmıyor** (253 geçti, 3'ü kendi dosyalarına ait değil),
- ama **hiçbirinin tek testi yok** ve **hiçbiri motora/proxy'ye bağlı değil**,
- bu yüzden coverage kapısı reddediyor (%74 < %90) — kapı doğru çalışıyor.

| Dosya | Boyut | Ne | Eksik |
| --- | --- | --- | --- |
| `packages/core/src/loop/window.ts` | 9.2k | kayan pencere skorlayıcı | testler, O(W²) referans karşılaştırması |
| `packages/core/src/loop/queue.ts` | 14k | sınırlı embedding kuyruğu | testler, taşma/hata senaryoları |
| `packages/core/src/loop/hashing-provider.ts` | 4.1k | ONNX'siz `EmbeddingProvider` dublörü | testler |
| `packages/proxy/src/era.ts` | 6.6k | era tespiti | testler |
| `packages/proxy/src/remap.ts` | 7.5k | progressToken + requestId haritaları | testler, sızıntı testi |
| `packages/proxy/src/diagnostics.ts` | 3.6k | stderr disiplini | testler |

Faz 3'ten eksik: `guards/semantic-loop.ts`, `onRecordComplete` üzerinden
bağlama, tüm testler.
Faz 5'ten eksik: `bridge.ts`, `tools-call.ts`, `trip-result.ts`,
`stdio-wrap.ts`, `http-serve.ts`, tüm testler.

**Bu dosyaları gözden geçirilecek taslak sayın, üzerine inşa edilecek temel
değil.** Devam eden kişi dosya bazında tut/yeniden yaz/at kararı vermeli.

### Paralelleştirme dersi

Faz 3 ve 5 ayrık paketlere dokunduğu için paralel koşuldu ve bu kısım işe
yaradı — çakışma olmadı. Ama iki uzun ajanı birlikte koşturmak, makine uykuya
geçtiğinde **iki fazı birden** kaybettirdi. Bir sonraki denemede ya tek faz
koşturun, ya da her ajana "ara commit at" talimatı verin.

---

## Sırada ne var

### Faz 3 ve 5'i bitir (kritik yol Faz 5'ten geçiyor)

Her ikisinin tam brifingi plan dosyasında. Özet gereksinimler:

**Faz 3 — semantik katman.** ADR-002'nin kısıtı belirleyici: embedding hesabı
**asla** bir `tools/call`'ı bloklamaz, geciktirmez ya da başarısız kılmaz; kesme
kararı bir sonraki çağrıda uygulanır (`pendingTrip` → `BreakerGuard`). Bütçe:
çağrı başına eklenen p95 < 50 ms.

Skor **ortalama ikili kosinüs**, kapalı formda: L2-normalize vektörler için
`Σᵢ<ⱼ eᵢ·eⱼ = (‖S‖² − W)/2` olduğundan, halka tamponu üzerinde koşan toplam
vektörü `S` tutulur (push'ta ekle, evict'te çıkar) ve

```
score = (‖S‖² − W) / (W · (W − 1))
```

Bu, O(W²·d) yerine çağrı başına **O(d)**. Artımlı çıkarmanın kayan nokta
sürüklenmesi gerçek bir tehlike — periyodik olarak `S`'i sıfırdan yeniden
hesaplayın ve bunu testleyin.

Kuyruk: 64 işlik sınır, taşmada **en eski** işler düşer (güncel pencere
önemlidir), `embed()` başına 8'e kadar batch, EWMA gecikme ölçümüyle adaptif
örnekleme, `degraded: 'sampled'` işareti. Reddeden provider **asla** çağrıyı
kırmaz — AgentFuse kural-only tespite düşer, proxy ayakta kalır.

Onay eşiği: `threshold` (0.83) `consecutive_windows` (2) ardışık pencerede
aşılmalı. Bir zirve gürültü, iki ardışık zirve patern.

`HashingProvider` kritik: **CI'ın 301 MB ORT kurmadan semantik yolu koşabilmesini
sağlayan şey bu.**

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
