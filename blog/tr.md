# Deterministik Bir Ticket Sistemine LLM Entegre Etmek: Sözleşme Odaklı (Contract-Driven) Bir Yaklaşım

Geçen gün bir ekip arkadaşımla sohbet ediyorduk. Müşteri destek panelimize yapay zeka destekli bir yanıt önerisi (reply suggestion) özelliği eklemek istediklerini anlattı. Klasik senaryo: Müşteri bir talep açıyor, temsilci ekrana girdiğinde model ona hazır bir yanıt taslağı sunuyor. Harika bir fikir gibi duruyor, değil mi? 

Fakat biraz derinleştiğimizde odadaki fil ortaya çıktı: "Peki ya model saçmalarsa? Ya geç yanıt verip müşteri temsilcisinin ekranını 5 saniye kilitlerse? Ya bir müşterinin telefon numarasını veya TC kimlik numarasını başka bir müşterinin yanıtına sızdırırsa? Ya da sağlayıcı API'si aniden şema değiştirirse ne yapacağız?"

Bu yazı, işte tam bu sorulara mühendislik refleksiyle verilmiş pratik ve denenmiş bir yanıtın hikayesi. Prodüksiyona LLM eklerken deterministik dünyamızı nasıl koruduğumuzu, adım adım inşa ettiğimiz açık kaynak mimari üzerinden anlatacağım.

---

## 1. Problem: Deterministik Dünyanın Kırılgan Misafiri

Bizim destek sistemimiz deterministiktir: Talep gelir, kategoriye göre şablon yanıt anında üretilir (0 milisaniye), temsilciye gösterilir. Saat gibi tıkır tıkır işler.

LLM'ler ise tabiatı gereği stokastiktir, yavaştır ve güvenilmezdir. Bir gün mükemmel JSON döner, ertesi gün eksik virgüllü bir metin atar. Bazen 400 milisaniyede döner, bazen 4 saniye askıda kalır. 

Bizim birinci kuralımız çok netti: **LLM hiçbir zaman kritik akışı (critical path) rehin alamaz.** Destek temsilcisi ekrana baktığında hazır şablon yanıtı hemen görmeli; LLM yetişirse, geçerliyse ve temizse şablonun yerini almalı. Yetişemezse kimse LLM'i beklememeli.

---

## 2. Sıfır Güven Sözleşmesi (Contract Schema) ve "Unavailable" Halleri

Sağlayıcıdan (mock LLM servisimiz) bize dönen JSON yanıtına hiçbir zaman "güvenilir" gözüyle bakmıyoruz. Ağ sınırında katı bir Zod şeması tanımladık:

```jsonc
{
  "contract_version": 1,               // Sayısal versiyon; versiyon uyumsuzluğu anında reddedilir
  "suggestion_id": "uuid",             // Denetim ve tazelik kontrolü için UUID
  "status": "suggestion" | "unavailable",
  "reply": {                           // "unavailable" iken mutlaka null olmalıdır
    "subject": "string, 1-200 karakter",
    "body":    "string, 1-4000 karakter"
  },
  "confidence": 0.0 - 1.0 | null,
  "metadata": {
    "model": "string",
    "generated_at": "ISO-8601 tarihi",
    "latency_ms": 42
  }
}
```

Burada çok kritik bir mimari karar aldık:
**`status: "unavailable"` bir hata değil, geçerli bir sözleşme durumudur.** 

Model bazen yanıt üretmek için yeterli bağlama sahip olmadığını fark edebilir ve kibarca "ben bu talebe yanıt öneremiyorum" diyebilir. Bir modelin sessiz kalması sistemik bir hata ya da sözleşme ihlali (contract violation) değildir; tamamen meşru bir cevaptır. Bu yüzden `unavailable` yanıtları sözleşme ihlali sayılmaz ve ihlal metriği paydasına katılmaz.

Ayrıca şemada `.strict()` kullandık. Bilinmeyen bir alan (örneğin `"sentiment": "positive"`) geldiğinde sistem bunu yutmaz, şema ihlali sayar. Gelecek uyumluluğu sessizce gevşeyerek değil, `contract_version` ile yönetilir.

---

## 3. Sınır Eşleme: "Parse, Don't Validate" ve Anti-Corruption Layer

Domain katmanımız hiçbir zaman dış servisin DTO (Data Transfer Object) türlerini bilmez. `src/domain.ts` dosyasına bakarsanız Zod'a dair tek bir satır import göremezsiniz:

```ts
export type Suggestion = {
  suggestionId: string;
  subject: string;
  body: string;
  confidence: number | null;
};
```

Veri şu üç katmandan geçer:
1. **Ağ Sınırı**: Ham metin gelir → `JSON.parse` yapılır (hata verirse `parse_error`) → Versiyon kapısı kontrol edilir (`contract_version !== 1` ise `version_mismatch`) → Katı Zod şeması çalıştırılır (başarısızsa `schema_violation`).
2. **Dönüştürme (Anti-Corruption Layer)**: `toDomain()` fonksiyonu DTO'yu alır, `suggestion_id`'yi camelCase `suggestionId` yapar ve saf domain modelini üretir.
3. **Domain Katmanı**: Bilet akışı sadece `Suggestion` veya `NoSuggestion(reason)` nesneleriyle konuşur.

---

## 4. Zaman Bütçesi Matematiği ve Yeniden Deneme (Retry) Politikası

Müşteri temsilcisinin ekranında toplam 3000 ms UX bütçemiz var. Bu bütçeyi kafamıza göre harcayamazdık:

```
TOPLAM BÜTÇE: 3000 ms
  ├── LLM Ağ Çağrısı Tavanı  = 2200 ms (AbortController ile sert kesilir)
  ├── Doğrulama & PII Taraması ≈ 250 ms
  └── Taşıma & Arayüz Çizimi  ≈ 550 ms (Güvenlik payı)
```

Neden tam 2200 ms? Çünkü ağ gecikmesi, JSON ayrıştırma, PII regex taramaları ve tarayıcıya iletim hesaba katıldığında, 2200 ms'den daha geç dönen bir LLM çağrısı artık fayda değil zarar üretir. `src/llmClient.ts` içinde Node'un `AbortController` mekanizmasını kullanarak çağrıyı 2200 ms dolduğu anda acımasızca iptal ediyoruz.

### Yeniden Deneme (Retry) Tablosu

Her hatada tekrar denemek gibi naif bir yola girmedik:

| Durum | Yeniden Deneme Sayısı | Gerekçe |
|---|---|---|
| Zaman Aşımı (`timeout`) | **0** | Bütçe zaten tükendi; tekrar denemek temsilci ekranını kilitler. |
| Geçici Sunucu Hatası (`http_5xx`) | **En fazla 1** | Sadece kalan bütçe yetiyorsa (toplam <3000 ms) tek bir kez denenir. |
| Sözleşme İhlali (`violation`) | **0** | Model bozuk JSON veya yanlış şema ürettiyse bu sistemik bir sorundur; tekrar denemek aynı bozuk veriyi üretir. |
| Çıktıda PII Tespiti | **0** | Model halüsinasyonla kişisel veri sızdırdıysa hemen durulmalıdır. |
| Model Sessiz (`unavailable`) | **0** | Bu bir hata değil, meşru bir durumdur. |

---

## 5. KVKK ve PII Güvenliği: Ne Gönderiyoruz, Ne Tutuyoruz?

Kişisel verilerin korunması (KVKK/GDPR) bir "sonradan ekleriz" maddesi olamaz.

1. **Giriş Minimizasyonu & Maskeleme**: Talebin konusu ve gövdesi modele gönderilmeden önce `maskPii()` fonksiyonundan geçer. Telefon numaraları, e-postalar ve TC kimlik numaraları anında `[masked-phone]`, `[masked-email]`, `[masked-national_id]` etiketleriyle değiştirilir. Modele asla müşterinin gerçek iletişim bilgisi gitmez.
2. **Çıktı Taraması (Cross-Contamination Koruması)**: Model yanıt döndüğünde yanıt gövdesi `detectPii()` ile taranır. Eğer model yanıtında maskesiz bir telefon veya e-posta tespit edilirse, öneri anında `pii_detected` koduyla **çöpe atılır**. Buradaki en büyük risk başka bir müşterinin verisinin bu talebe sızmasıdır.
3. **Sıfır İçerikli Loglar (Zero-Content Logs)**: Loglarımızda müşteri mesajı, talep metni veya modelin öneri gövdesi **asla yer almaz**. Sadece sayaçlar ve sebep kodları (`accepted`, `timeout`, `circuit_open`, `pii_detected`) loglanır.
4. **Saklama (Retention)**: Öneriler kalıcı veritabanında saklanmaz, sadece oturum boyunca in-memory tutulur. KVKK'nın "amaçla sınırlılık" ve "veri minimizasyonu" ilkeleri gereği öneri işi bittiğinde bellekten uçar.

---

## 6. Metrikler ve Devre Kesici (Circuit Breaker)

Her çağrı son 20 çağrılık kayan bir pencerede (`BREAKER.WINDOW_SIZE = 20`) izlenir. `src/config.ts` içindeki öldürme eşiklerimiz:

| Metrik | Eşik | Tetiklenen Eylem |
|---|---|---|
| Sözleşme İhlal Oranı | **> %10** | Devre Kesici AÇILIR (Open) |
| Zaman Aşımı Oranı | **> %50** | Devre Kesici AÇILIR (Open) |
| PII Sızıntı Oranı | **> %10** | Devre Kesici AÇILIR (Open) |
| p99 Gecikme | **> 2200 ms** (üst üste 2 değerlendirme) | Devre Kesici AÇILIR (Open) |

Devre açıldığında sistem LLM'e tek bir istek dahi atmaz (`circuit_open`). 60 saniye boyunca (`BREAKER.OPEN_MS = 60_000`) tüm biletler deterministik yedek şablonlarla yanıtlanır. 60 saniye sonra "half-open" moduna geçilir; tek bir deneme çağrısına izin verilir. Bu deneme başarılı olursa devre tekrar kapanır; başarısız olursa 60 saniye daha açık kalır.

---

## 7. Dağıtım Aşamaları ve Gölge Mod (Shadow Mode)

Gerçek dünyada bu sistemi nasıl yayına alırdık? Doğrudan temsilcilerin önüne koymak intihar olurdu:

1. **Aşama 1: Gölge Mod (Shadow Mode)**: Sistem arka planda gerçek biletlerle çalışır. Maskeleme yapılır, LLM çağrılır, sözleşme doğrulanır, metrikler toplanır — **fakat öneri arayüzde temsilciye gösterilmez**. Sadece metrikler ve hata oranları izlenir.
2. **Aşama 2: Dahili Pilot (Opt-in Temsilciler)**: Sadece kıdemli birkaç destek uzmanının ekranında özellik açılır. Geri bildirimler toplanır.
3. **Aşama 3: Kademeli Açılış (Canary Rollout)**: Trafiğin %10'u ile başlanır, devre kesici metrikleri temiz kaldıkça %50 ve %100'e çekilir.

---

## 8. Tazelik Koruması (Staleness Guard): Teori ve Sınırlar

> **Açık İtiraf:** Demo kodumuz tekil senaryoları simüle ettiği için biletin havada değişmesi (staleness race condition) senaryosu bu demoda otomatik testle kanıtlanmamıştır; blog düzeyinde teorik prensip olarak ele alınmaktadır.

**Teorik Risk:** Temsilci bilete bakarken müşteri arkadan yeni bir mesaj gönderir (bilet versiyonu 1'den 2'ye çıkar). O sırada model 1. versiyon için yanıt üretmektedir. Eğer bu eski yanıt arayüze basılırsa, müşteri temsilcisi alakasız bir öneriyi müşteriye gönderebilir.
**Çözüm:** Öneri nesnesi `suggestionId: "${ticket.id}-d${ticket.version}"` taşır. Yanıt geldiğinde biletin güncel versiyonu kontrol edilir; versiyon uyuşmuyorsa öneri arayüze yansıtılmadan sessizce imha edilir.

---

## 9. LLM'i Ne Zaman Tamamen Kapatırız?

Bir yapay zeka özelliğini kapatmak için yöneticinin paniklemesi beklenmez. Sistem şu 4 durumda otomatik olarak fişi çeker:
1. **İhlal oranı %10'u aştığında**: Sağlayıcı API'si değişmiş ya da bozulmuştur.
2. **PII oranı %10'u aştığında**: Maskeleme katmanında veya modelde bir güvenlik açığı vardır.
3. **Zaman aşımı %50'yi aştığında**: Sağlayıcı çökmüştür veya ağ tıkanmıştır.
4. **Acil Durum Bayrağı (`flagEnabled = false`)**: Ekip tek bir konfigürasyon değişikliğiyle LLM çağrılarını sıfır milisaniyede keser.

Tüm bu durumlarda müşteri deneyimi kesintiye uğramaz; deterministik bilet akışı sanki LLM hiç var olmamış gibi milisaniyeler içinde hizmet vermeye devam eder.

---

## 10. CLI Demosundan Gerçek Çıktılar

Geliştirdiğimiz CLI simülasyonunu (`npm run demo`) çalıştırdığınızda terminalde birebir şu akışı görürsünüz:

```text
=== LLM Reply Suggestion Demo ===
Demonstrating zero-trust contract, hard deadline budgets, PII rules, and breaker metrics.

--- Scenario: mode="valid" ---
[ticket] t-refund v1 — deterministic suggestion ready in 0ms
[llm] suggestion accepted: Re: your invoice #4821
[metrics] accepted=1 violations=0 timeouts=0 pii=0 p99=15ms

--- Scenario: mode="unavailable" ---
[ticket] t-refund v1 — deterministic suggestion ready in 0ms
[llm] no suggestion (unavailable) — deterministic flow continued
[metrics] accepted=0 violations=0 timeouts=0 pii=0 p99=3ms

--- Scenario: mode="malformed_json" ---
[ticket] t-refund v1 — deterministic suggestion ready in 0ms
[llm] no suggestion (contract_violation) — deterministic flow continued
[metrics] accepted=0 violations=1 timeouts=0 pii=0 p99=2ms

--- Scenario: mode="pii_body" ---
[ticket] t-refund v1 — deterministic suggestion ready in 0ms
[llm] no suggestion (pii_detected) — deterministic flow continued
[metrics] accepted=0 violations=0 timeouts=0 pii=1 p99=2ms

--- Scenario: mode="slow" ---
[ticket] t-refund v1 — deterministic suggestion ready in 0ms
[llm] no suggestion (timeout) — deterministic flow continued
[metrics] accepted=0 violations=0 timeouts=1 pii=0 p99=none

--- Scenario: mode="flaky_500" ---
[ticket] t-refund v1 — deterministic suggestion ready in 0ms
[llm] suggestion accepted: Re: your invoice #4821
[metrics] accepted=1 violations=0 timeouts=0 pii=0 p99=4ms
```

Dikkat edin: Her senaryoda ilk satırda `deterministic suggestion ready in 0ms` yazar. Deterministik akış LLM'i bir milisaniye bile beklemez!

---

## 11. Dürüst Sınırlar (Honest Limitations)

Bu projenin sınırlarını da dürüstçe belirtelim:
- **Gerçek LLM Yok**: Testler ve demo, `src/provider.ts` içindeki yerel Node HTTP sunucusu ve 10 farklı deterministik mod ile çalışır (hiçbir harici API anahtarı veya maliyet yoktur).
- **Bellek İçi Metrikler (In-memory)**: Metrik penceresi ve devre kesici hafızada tutulur. Çok sunuculu (multi-node) bir mimaride Redis tabanlı bir sayaç veya merkezi bir metrik toplayıcı gerekecektir.
- **Kalıcı Depolama Yok**: Biletler ve öneriler test amaçlı bellek içi Map üzerinde tutulur.

Sonuç olarak: LLM'ler sistemlerimize zeka katabilir, ancak disiplinli bir yazılım mimarisi olmadan zeka sadece tahmin edilemez bir risktir. Sıfır güven sözleşmeleri, katı zaman bütçeleri ve metrik odaklı devre kesicilerle bu riski kontrol altına almak tamamen bizim elimizde.

