# POI Toolkit — Архитектура

> Русская версия. Описывает текущий исходный код monorepo `poi-toolkit`
> (revision `9ca756b`+), контракт экспорта v1 и границу ответственности
> с потребителем Nearventure.
>
> **Граница ответственности:** POI Toolkit — канонический **производитель**
> версионированного экспорта POI (SQL-артефакт + строгий import manifest).
> Он **не** пишет напрямую в базу данных Nearventure. Загрузка в продуктовую БД
> выполняется importer-ом Nearventure после валидации manifest (см. раздел 11).
> Прямая загрузка экспорта через ad-hoc SQL (`psql -f`) **запрещена**. Граница
> producer-side и v1 handoff: [nearventure-handoff.md](nearventure-handoff.md); consumer-процедура
> канонична в [Nearventure data refresh](https://github.com/stanleymarch/nearventure/blob/main/docs/data-refresh.md).

---

## 1. Что такое POI Toolkit

POI Toolkit — консольный TypeScript-инструмент для сбора, дедупликации, оценки
качества и публикации Points of Interest (POI) из открытых источников. Каждый
этап создаёт неизменяемые (immutable) артефакты — файлы на диске. Никакая база
данных внутри toolkit не требуется; все команды, кроме `export-sql`,
read-only.

**Ключевые свойства:**
- **Файл-first** — каждый шаг читает предыдущий артефакт, пишет следующий
- **Immutable** — повторный запуск того же шага с тем же `runId` завершается ошибкой
- **Детерминированный** — одинаковые исходные данные → одинаковый результат
- **Аудируемый** — каждый источник, каждое решение, каждое отклонение записаны
- **Конфигурируемый** — территории задаются JSON-файлами, категории — профилями

Nearventure (картографический турсервис) — первый потребитель: он принимает
версионированный экспорт toolkit через manifest-валидирующий importer.
Toolkit спроектирован нейтральным к конечному продукту: любой сервис может
определить свой профиль категорий и получить тот же детерминированный экспорт.

---

## 2. Общая архитектура

```
Источники → collect → normalize → resolve → geocode → synthesize → release → export-sql
                                                                                    │
                                              reports/poi_product_import.sql (data-only)
                                              reports/poi_product_import.manifest.json
                                                                                    │
                                                                                    ▼
                                      Nearventure importer: валидация manifest → staging → атомарный swap
```

### Поток данных

```
OSM PBF ──┐
EGRKN API ─┼──→ raw/*.{ndjson,geojsonseq} ──→ normalized/source-records.ndjson
Wikidata ──┤                                      │
Wikivoyage ┤                                      ├──→ resolution/candidates.ndjson
MKRF ──────┘                                      ├──→ geocoded/geometry-evidence.ndjson
                                                  │
                                                  └──→ synthesis/entities.ndjson
                                                            │
                                                            └──→ release/entities.*
                                                                      │
                                                                      └──→ reports/poi_product_import.sql
                                                                           + poi_product_import.manifest.json
```

### Пакеты (monorepo)

| Пакет | Роль |
|---|---|
| `core` | Zod-схемы, контракты, территория, манифесты, point-in-polygon |
| `source-osm` | osmium PBF extract + GeoJSON-seq парсер |
| `source-egrkn` | ЕГРКН cursor API (многорегионовый) |
| `source-mkrf` | API Минкультуры (музеи) |
| `source-wikidata` | SPARQL запросы по регионам |
| `source-wikivoyage` | MediaWiki listings + природные памятники |
| `normalize` | Парсинг, классификация геометрии, evidence/claims |
| `resolver` | Exact-ID + fuzzy + OSM self-dedup + MKRF proximity |
| `geocode` | Photon (по умолчанию) + Nominatim/Yandex адаптеры |
| `geography` | Территории, containment, адреса зданий |
| `taxonomy` | Фасеты + детектор шума |
| `media` | Wikimedia Commons + attribution |
| `synthesis` | Детерминированный выбор полей из источников |
| `profiles-nearventure` | Проекция на 6 категорий Nearventure |
| `quality` | Профилирование + hardening gates + quality score |
| `exporters` | GeoJSON/Parquet/GPKG/NDJSON + SQL экспорт + import manifest |
| `cli` | Все команды |

---

## 3. Схемы данных

### 3.1 SourceRecord

Базовая единица данных — запись из одного источника. Не путать с финальным
POI (entity). Один POI может собираться из нескольких SourceRecord.

```typescript
{
  id: string;                    // "{source}:{sourceId}" — уникальный ID записи
  source: "osm" | "egrkn" | "wikidata" | "wikivoyage" | "mkrf";
  sourceId: string;              // Оригинальный ID в источнике
  capturedAt: string;            // ISO-дата снятия снэпшота
  rawRef: string;                // Ссылка на строку в сыром файле

  name: string | null;
  description: string | null;
  address: string | null;

  geometry: {                    // Геометрия из источника
    type: "Point" | "Polygon" | "MultiPolygon" | "LineString";
    coordinates: number[] | number[][] | number[][][];
  } | null;

  fields: Record<string, unknown>;  // Сырые поля источника
  license: string;                  // Лицензия данных
}
```

### 3.2 GeometryEvidence и vocabulary точности

```typescript
{
  sourceRecordId: string;
  geometry: { ... };            // GeoJSON geometry
  method: "source-native" | "osm-geometry" | "derived-centroid" | "geocoder" | "manual";
  precision: "object" | "building" | "parcel" | "complex" | "street" | "locality" | "unknown";
  precisionMeters: number | null;
  capturedAt: string;
  derivedFrom: string[] | null;
}
```

Точность — закрытый словарь (`packages/core`, `GeometryEvidenceSchema`):
`object | building | parcel | complex | street | locality | unknown`.
В документации и отчётах термина `house` нет — корректный уровень здания —
`building`.

**Правила публикации геометрии:**
- OSM-native геометрия сохраняется как есть (`osm-geometry`)
- Доверенная standalone-геометрия (ЕГРКН/MKRF) принимается на уровне `object`
  или выше по политике `geometryPolicy`
- Геокодированные координаты публикуются только при точности `building`
  и совместимом адресе (`addressCompatible: true`)
- `street`, `locality` и `unknown` **не публикуются**

### 3.3 EntityCandidate

Результат работы resolver — группа SourceRecord, относящаяся к одному
реальному объекту (схема ниже, детали правил — раздел 7).

```typescript
{
  group: string[];            // sourceRecordIds, входящие в группу
  decision: "accepted" | "pending" | "rejected";
  rule: string;
  ruleVersion: string;
  featureVector: {
    osmSelfDistance: number;
    crossSourceDistance: number;
    nameSimilarity: number;
    addressConflict: boolean;
    sameBuilding: boolean;
    genericName: boolean;
  };
}
```

### 3.4 GeocodeAudit

Аудит каждого вызова геокодера (включая отклонённые результаты):

```typescript
{
  sourceRecordId: string;
  source: string;               // "egrkn"
  query: string;
  addressClass: AddressClass;
  provider: "photon" | "nominatim" | "yandex";
  confidence: GeocodeConfidence;
  result: { lat: number; lon: number; address: string; osmType: string; osmId: number } | null;
  startedAt: string;
  durationMs: number;
}
```

### 3.5 SynthesizedEntity

Синтезированная сущность — результат synthesis:

```typescript
{
  sourceRecordIds: string[];
  hasOsmAnchor: boolean;
  identity: { categories, ... };
  geometry: { ... };
  name: SelectedField<string> | null;
  facets: string[];
  noise: NoiseDecision;
  description: SelectedField<string> | null;
  photo: SelectedField<MediaAsset> | null;
  heritage: { significance, categories, ... } | null;
  urls: { egrkn, wikidata, wikivoyage, official } | null;
  standaloneEligible: boolean;
  adminHierarchy: AdminHierarchy | null;
}
```

### 3.6 Run manifest

Каждый run имеет манифест (`manifest.json` в корне run-директории):

```typescript
{
  schemaVersion: 1;
  runId: string;
  territory: string;
  status: "running" | "completed" | "failed" | "releasable" | "promoted";
  startedAt: string;
  finishedAt: string | null;
  sources: { [source: string]: { status; records; snapshot; error } };
  diagnostics: [];
}
```

> Примечание: текущий статус run-манифеста не является сам по себе
> разрешением на загрузку в production. Экспорт, пригодный к импорту,
> определяется контрактом import manifest (раздел 11).

### 3.7 Профиль Nearventure (product entity)

Поля, которые попадают в `poi_product` (через экспорт):

| Поле | Тип | Источник |
|---|---|---|
| `poi_uuid` | `sha256("poi-toolkit:" + entity.id).slice(0,32)` | Вычисляется |
| `source` | `string` | По `geometryPolicy` (`osm`/`egrkn`) |
| `external_id` | `string` | OSM id / EGRKN regnumber |
| `category` | `string` | `heritage|monument|sights|religion|nature|museum` |
| `name` | `string` | Лучшее название из источников |
| `lat` / `lon` | `number` | Representative point |
| `is_protected` | `boolean` | ОКН или заповедник |
| `attribution` | `jsonb` | Атрибуция фото |
| `provenance` | `jsonb` | sources, categoryRule, geometryPolicy, facets |
| `region` | `string` | Субъект РФ (admin_level=4) |

---

## 4. Источники (Sources)

### 4.1 OSM (OpenStreetMap)

**Инструмент:** `osmium-tool` (CLI).

**Процесс:**
1. `osmium extract -b {bbox}` — вырезать территорию из PBF по bounding box
2. `osmium tags-filter` — оставить только POI-релевантные теги
3. `osmium export -f geojsonseq` — экспорт в GeoJSON sequence

**Фильтры osmium (исчерпывающий список, из `source-osm`):**

```
nwr/historic                    # Памятники, исторические здания
nwr/tourism                     # Достопримечательности, музеи, гостиницы
nwr/amenity=museum              # Музеи
nwr/amenity=place_of_worship    # Церкви, мечети
nwr/leisure=park                # Парки
nwr/leisure=nature_reserve      # Заповедники
nwr/natural=water               # Водоёмы
nwr/natural=waterfall           # Водопады
nwr/natural=spring              # Родники
nwr/natural=beach               # Пляжи
nwr/water=lake                  # Озёра
nwr/water=pond                  # Пруды
nwr/water=reservoir             # Водохранилища
nwr/geological                  # Геологические объекты
n/natural=peak                  # Вершины (только ноды)
n/natural=cave_entrance         # Входы в пещеры (ноды)
n/natural=spring                # Родники (ноды)
n/natural=cliff                 # Скалы (ноды)
n/natural=rock                  # Отдельные камни (ноды)
n/natural=stone                 # Мегалиты (ноды)
n/natural=tree                  # Именные деревья (ноды; публикуются только named)
```

Node-only ограничение части natural-тегов объясняется масштабом POI: площадные
natural (forest, scrub, grassland) не являются POI-масштаба и раздували бы
промежуточные данные.

### 4.2 ЕГРКН (Единый государственный реестр объектов культурного наследия)

**Протокол:** HTTP cursor API (open-data портал Минкультуры).
**Ключ:** `MKRF_API_KEY` — обязателен.

**Процесс:**
1. Пагинированный запрос с фильтром `$search={region}`
2. Парсинг JSON: наименование, регистрационный номер, вид объекта, датировка,
   категория ОКН, адрес, координаты (если есть), фото (если есть)
3. Дедупликация: одна запись может прийти из нескольких пагинаций
   (разные подрегионы) — сливаются по `regnumber`

**Классы адресов ЕГРКН:**

| Класс | Пример | Можно геокодить? |
|---|---|---|
| `structured` | «ул. Ленина, д. 5» | ✅ Да |
| `exact` | «г. Киров, ул. Московская, 12, лит. А» | ✅ Да |
| `relative` | «западнее д. 10 по ул. Советской» | ❌ Нет |
| `compound` | «ул. Ленина, д. 5, строение 2, литера А» | ❌ Нет |
| `unstructured` | «Кировская область» | ❌ Нет |
| `missing` | null | ❌ Нет |

Только классы `structured` и `exact` отправляются в геокодер.

### 4.3 Wikidata

**Протокол:** SPARQL Query Service API, по регионам (Q-ID), фильтр `instance of`
по ~80 интересным типам (церкви, замки, музеи, охраняемые территории,
археологические объекты, маяки, башни, парки, сады, водопады, пещеры и т.д.).
**Геометрия:** `wdt:P625` (coordinate location) — точка уровня `object`.

### 4.4 Wikivoyage

**Протокол:** MediaWiki API (action=parse с prop=text).
**Два типа данных:**
1. **Listings** — структурированные записи (See, Do, Eat, Drink) через парсинг
   HTML-шаблонов `listing`
2. **Природные памятники** — страницы категории «Природные памятники
   России/{регион}» как таблицы

### 4.5 Минкультуры (MKRF)

**Протокол:** HTTP API Минкультуры РФ, ключ `MKRF_API_KEY`.
**Что собирает:** музеи (учреждения культуры музейного типа). Один из
источников, дающих фото с лицензией.

---

## 5. Геокодинг

### 5.1 Провайдеры

| Провайдер | По умолчанию? | Конфигурация | Лимиты |
|---|---|---|---|
| Photon | ✅ Да | `PHOTON_URL` (default `http://localhost:2322`) | Лимит задаётся флагом `--limit`; без него — без лимита для локального |
| Nominatim | ❌ Нет | `NOMINATIM_URL` | `--limit`; зависит от сервера |
| Yandex | ❌ Нет | `GEOCODER_API_KEY` | `--limit`; без него — 1 000 по умолчанию |

### 5.2 Алгоритм

```
Адрес ЕГРКН
    │
    ├──→ classifyAddress() → ineligible? → пропустить
    │
    ├──→ extractAddressParts() → city, street, house, letter, corpus
    │
    ├──→ tryOsmAddressIndex()  (локальный OSM-индекс зданий, перед Photon)
    │
    ├──→ geocodePhotonAddressStructured()  (через /structured endpoint)
    │       │
    │       └──→ evaluateAttempt()
    │               │
    │               ├── building-level + addressCompatible → ✅ accepted
    │               ├── building-level + конфликт адреса → 🟡 quarantined-conflict
    │               └── street/locality → ❌ low-precision
    │
    └──→ fallback? (только для eligible адресов)
            │
            └──→ geocodeAddress()  (свободная форма)
                    └──→ evaluateAttempt()
```

**`evaluateAttempt()`:**
- уровень точности `building` (OSM type:H или совпадение housenumber) — кандидат
- `addressCompatible` — номер дома совпадает И буква/корпус совпадают
  (если указаны)
- housenumber не совпадает → `conflicted` (адресный конфликт)
- вернулся уровень `street`/`locality` → `low-precision`

**Важно:** координаты сохраняются в `geocode-audit.ndjson` даже для
отклонённых результатов. В `geometry-evidence.ndjson` попадают только
принятые точки с `addressCompatible: true`.

### 5.3 Адресные конфликты

Если геокодер возвращает здание с правильным номером дома, но неправильной
улицей — запись помечается `quarantined-conflict` и не публикуется. Корпус,
литера, строение — поля идентичности: «д. 67» и «д. 67 кД» — разные здания.

### 5.4 Распределение результатов (артефакт `pfo-v0.1`)

Итоги ЕГРКН для проверенного артефакта `pfo-v0.1` — из
`workspace/pfo/pfo-v0.1/reports/disposition-ledger.json` (всего 21 321 запись):

| Исход | Кол-во |
|---|---|
| native-geometry (геометрия из реестра) | 16 346 |
| ineligible-address (класс адреса не подходит) | 1 980 |
| quarantined-conflict (адресный конфликт) | 2 598 |
| accepted (geocoder, building-level, адрес совпал) | 254 |
| low-precision (street/locality) | 143 |
| not-found | 0 |
| fallback-accepted / provider-error | 0 |

`blockingCount: 0`. Это метрики конкретного артефакта, а не «текущей
production»: числа могут отличаться в новом run (другой PBF/дата сбора).

### 5.5 Photon self-hosted (Docker)

```yaml
# docker-compose.yml для Photon (шаблон — см. docker/photon/README.md)
services:
  photon:
    build: ./docker/photon
    ports:
      - "2322:2322"
    volumes:
      - photon_data:/photon/photon_data
    command: serve -listen-ip 0.0.0.0
```

Точный размер Russia-индекса и время сборки зависят от версии данных Photon
и не зафиксированы как метрика в репозитории.

### 5.6 OSM Address Index

**Проблема:** геокодер (даже self-hosted Photon) недетерминирован — тот же
адрес может вернуть разные координаты в разное время или спутать здание
с корпусом.

**Решение:** локальный индекс адресов OSM-зданий проверяется **до** Photon.

```
osmium export PBF -f geojsonseq (nwr/addr:housenumber)
        → osm-addresses.geojsonseq
        → build-address-index (CLI) → address-index.json
        → geocode → tryOsmAddressIndex (перед Photon)
```

**Ключ индекса — `parseBuildingAddress()`:** разбор на компоненты
с word-boundary regex: «ул. Спасская, д. 67» → street «Спасская», house «67»;
«д. 67 кД» → house «67», corpus «Д».

**Правила сопоставления:**
1. `street + house` в индексе → ровно одно здание → берём его геометрию
2. Несколько зданий на одном адресе → проверяем имя здания (ЕГРКН содержит
   название вроде «Здание Вятского реального училища»)
3. Ни одно имя не совпало → fallback на Photon

**Критическое правило:** корпус/литера/строение — поля идентичности.
«д. 67» ≠ «д. 67 кД».

Конкретные числа счётчиков по run-ам (например, сколько записей получили
геометрию из индекса) хранятся в отчётах соответствующего run и не
дублируются в этом документе.

---

## 6. География

### 6.1 Территории

Каждая территория задаётся JSON-файлом (`territories/<slug>.json`): slug, имя,
`egrkn.region` (+ опционально `egrkn.regions[]` для многорегионовых), `osm.pbf`
и `osm.bbox`, `mkrf.clipBbox`, `wikidata.regions` (Q-IDs), `wikivoyage.pages`,
опционально `wikivoyageNature.pages`.

### 6.2 Subject Boundaries (границы субъектов)

Для определения региона каждой точки используются authoritative
OSM admin_level=4 мультиполигоны из `territories/pfo-subjects.geojson`
(14 мультиполигонов, ~3.1 МБ). Механика реализована в `packages/geography`.

### 6.3 Определение региона: алгоритм

```
POI с геометрией G
    │
    ├──→ geometryRepresentativePoint(G) → точка T
    │       │
    │       ├── Polygon → point-on-surface (поиск по сетке 32×32)
    │       └── LineString → haversine-weighted midpoint
    │
    ├──→ assignSubjectBoundary(T) → регион R
    │
    └──→ сравнение R с текстовым region из source
            ├── совпадают → ✅ R принят
            ├── R = null → excluded, причина: unassigned
            └── R ≠ текстовому региону → excluded, причина: subjectRegionConflicts
```

Point-on-surface (не centroid!) реализован сеткой 32×32: bbox полигона делится
на 1 024 ячейки, берётся центральная точка первой внутренней ячейки;
при промахе — centroid (`packages/geography/src/index.ts`).

### 6.4 Конфликты регионов

Расхождение polygon-assigned региона с source-text регионом исключает объект
и пишет его в `reports/geography-conflicts.ndjson` (счётчик
`subjectRegionConflicts`). Релиз не блокируется при разумном количестве.

---

## 7. Resolver (разрешение конфликтов)

Resolver собирает SourceRecord-ы в группы (CandidateDossier), каждая — один
реальный объект. Правила применяются **строго по порядку**.

### 7.1 Правила (порядок применения)

| # | Правило | ID правила | Условие | Не сближает |
|---|---|---|---|---|
| 1 | **exact-cross-source** | `osm-wikidata-tag` / `egrkn-osm-ref` / `wikivoyage-wikidata-wdid` | Один и тот же ID в разных источниках, <2 км | — |
| 2 | **osm-area-way-identity** | `osm-area-way-identity` | Osmium: `a<2×ID>` = `2 × w<ID>` | — (чистая математика) |
| 3 | **osm-self-dedup** | `osm-self-dedup` | OSM node + OSM way, ≤30 м, одно имя | Generic-имена |
| 4 | **wikivoyage-osm-venue-name-proximity** | `wikivoyage-osm-venue-name-proximity` | Wikivoyage + OSM, ≤30 м, distinctive identity, mutual-nearest, margin ≥10 м | Generic-имена |
| 5 | **mkrf-osm-proximity** | `mkrf-osm-museum-link` | MKRF музей + OSM музей, ≤60 м, mutual-nearest, margin ≥10 м | — |
| 6 | **fuzzy-name** | `egrkn-osm-fuzzy` | Одинаковое или близкое имя, ≤30 м, не generic | Generic-имена |

Порядок критичен: `osm-area-way-identity` выполняется **до** всех
геометрических правил, чтобы синтетический дубликат `a<ID>` не создавал
ложную неоднозначность. После линковки area удаляется из рабочего массива,
downstream правила видят только оригинальный `w<ID>`.

**Generic-имена** (не сближаются ни по какому геометрическому правилу):
дом, здание, особняк, памятник, музей, церковь, храм, часовня, сквер, парк,
пруд, колодец, родник, мост, ворота, ограждение, забор, контора, амбар,
сарай, баня, склад.

#### Правило 1: Exact Cross-Source

Идентификаторы из разных источников сближаются только после sanity-проверок:
- `OSM wikidata=Q123 → Wikidata Q123`: расстояние < 2 км (или одна сторона
  без геометрии), иначе rejected
- `OSM ref:knid/heritage:ref → ЕГРКН regnumber`: проверка house number
  conflict, расстояние < 2 км
- `Wikivoyage wdid → Wikidata QID`: расстояние < 2 км

#### Правило 2: OSM Area↔Way Identity

Osmium экспортирует каждый замкнутый way дважды: `w<ID>` (LineString) и
`a<2×ID>` (Polygon). Это тождество, а не дубликат:

```ts
function linkAreaWay(area: SourceRecord, way: SourceRecord): boolean {
  const areaId = area.sourceId.match(/^a(\d+)$/)?.[1];
  const numeric = Number(areaId);
  const wayId = numeric / 2;
  return Number.isSafeInteger(numeric) && numeric % 2 === 0
    && way.sourceId === `w${wayId}`;
}
```

#### Правило 4: Wikivoyage ↔ OSM Distinctive Venue

Листинги без Wikidata ID, но с distinctive identity name:
`venueIdentityName()` отбрасывает префиксы вида «арт-пространство» и извлекает
имя в кавычках. Условия: identity не generic, расстояние ≤30 м,
mutual-nearest, margin ≥10 м, нет конкурирующего листинга с тем же identity
на ≤30 м.

#### Правило 5: MKRF ↔ OSM Museum Proximity

Сближает музей из реестра Минкультуры с OSM-объектом при разных именах.
Условия: ≤60 м, оба — музеи, mutual-nearest, margin ≥10 м.

#### Правило 6: EGRKN ↔ OSM Fuzzy Name

```ts
const nameSim = nameSimilarity(egrkn.name, osm.name);  // 0–1
const distance = haversine(egrkn, osm);
const addressBoost = addressesMatch(egrkn, osm) ? 0.3 : 0;
const repeatedCentroid = centroidCounts > 2 ? -0.3 : 0;
return nameSim * (1 - distance/100) + addressBoost + repeatedCentroid;
```

Generic-имена не участвуют. Лучшие 15 кандидатов на запись ЕГРКН
материализуются как `pending` и ждут калибровки.

### 7.2 Порог self-dedup

Порог OSM self-dedup — **30 метров** (не 15): area-объекты храма могут быть
нарисованы way-ом в 25 метрах от node того же храма.

---

## 8. Синтез (Synthesis)

1. **Геометрия:** OSM native → MKRF native → ЕГРКН native → geocoded
2. **Имя:** OSM display name → MKRF → Wikivoyage → Wikidata → ЕГРКН
3. **Описание:** один источник (без AI, без склейки), лучший по качеству
4. **Фото:** Commons (attributed) → MKRF culture.ru → OSM external URL
5. **Фасеты:** объединение facet claim-ов из группы
6. **Шум:** `detectNoise()` из пакета taxonomy

**Право на публикацию:**
1. Есть OSM anchor (точная геометрия) → публикуется всегда
2. Нет OSM anchor, но есть подтверждённая геометрия + имя → публикуется
3. Только ЕГРКН без safe-геометрии → не публикуется

**UUID:** `sha256("poi-toolkit:" + entity.id).slice(0,32)` — детерминированный,
устойчивый к повторным импортам.

---

## 9. Таксономия (Taxonomy)

Фасеты — source-neutral теги (примеры):

```
culture
  ├── religious (church, mosque, monastery)
  ├── memorial (monument, memorial, statue)
  └── heritage (castle, mansion, archaeology, ruin)
nature
  ├── park, garden
  └── water (lake, river, waterfall), geological
```

### Детектор шума

| Класс шума | Пример | Почему |
|---|---|---|
| `foodService` | Кафе, ресторан, столовая | Продукт не показывает еду |
| `accommodation` | Гостиница, хостел | Не достопримечательность |
| `parking` | Парковка | Бесполезно для туриста |
| `infrastructure` | Туалет, скамейка | Слишком мелко |
| `genericNature` | Лес, поляна, овраг | Слишком общо |
| `unanchored_generic` | Безымянный «Родник» без ref/wikidata/heritage | Generic-родник — не POI |
| `junk_name` | «#» / «123» | Имя из спецсимволов/цифр |
| `linear_water` / `settlement` / `street` | waterway=river, place=village, highway=* | Не POI-масштаба |

### Nearventure профиль (6 категорий)

| Категория | Описание | Русская подпись |
|---|---|---|
| `heritage` | ОКН | Архитектура и наследие |
| `monument` | Монументы | Монументы |
| `sights` | Достопримечательности | Достопримечательности |
| `religion` | Религиозные объекты | Религия и некрополи |
| `nature` | Природа | Природа |
| `museum` | Музеи | Музеи |

---

## 10. Качество (Quality)

### 10.1 Hardening Gates (релизный шлюз)

Перед публикацией проверяются gate-ы (`packages/quality/src/hardening.ts`).
Любой blocking gate > 0 → релиз блокируется (exit code 2).

| Gate | Блокирует? | Порог | Описание |
|---|---|---|---|
| `missingDisposition` | ✅ Да | 0 | ЕГРКН записи без disposition |
| `leakedQuarantineGeometry` | ✅ Да | 0 | Геометрия quarantined записей утекла в релиз |
| `junkNames` | ✅ Да | 0 | POI с односимвольными/числовыми именами |
| `foodServiceListings` | ✅ Да | 0 | Wikivoyage записи с едой |
| `museumCategoryMismatch` | ✅ Да | 0 | ЕГРКН-музей, а entity не `museum` |
| `registryMuseumWithoutPhoto` | ✅ Да | 0 | Музей из реестра без фото |
| `standaloneWikivoyageNature` | ✅ Да | 0 | Природная POI только из Wikivoyage |
| `specificNearDuplicates` | ✅ Да | 0 | Две entity одного category+имени на **≤30 м**, где хотя бы одна имеет OSM-источник |
| `addressBuildingConflicts` | ❌ Нет | — | Адресные конфликты ЕГРКН |
| `unassignedSubjectRegions` | ❌ Нет | — | Объекты вне границ ПФО |
| `subjectRegionConflicts` | ❌ Нет | — | Регион по геометрии ≠ регион из источника |

**`specificNearDuplicates`:** пара `[entityA, entityB]` из hardening-отчёта —
две разные entity с одинаковой категорией и нормализованным именем на
расстоянии ≤30 м; registry-only кластеры (ни у одной нет OSM-источника) не
блокируют, а остаются объяснимым evidence. `nearDuplicatePairs[]` — список
таких пар для отладки.

### 10.2 Disposition Ledger (реестр судьбы ЕГРКН)

Для каждой записи ЕГРКН фиксируется disposition. Значения для артефакта
`pfo-v0.1` (из `reports/disposition-ledger.json`, всего 21 321):

| Disposition | Значение |
|---|---|
| `native-geometry` | 16 346 |
| `ineligible-address` | 1 980 |
| `quarantined-conflict` | 2 598 |
| `accepted` | 254 |
| `low-precision` | 143 |
| `fallback-accepted` / `not-found` / `provider-error` | 0 |

`blockingCount = 0` (нет quarantined записей с leaked геометрией).

### 10.3 Quality Score (0–100)

| Измерение | Вес |
|---|---|
| Структурная целостность | 20 |
| Покрытие обогащения | 20 |
| Уверенность связей | 15 |
| Полнота провенанса | 15 |
| Иерархическое покрытие | 15 |
| Качество дедупликации | 15 |

Для артефакта `pfo-v0.1`: overall **78** (`reports/quality-score.json`).

---

## 11. Экспорт (Exporters) и контракт импорта

### 11.1 Форматы

| Формат | Команда | Описание |
|---|---|---|
| GeoJSON | `release` | FeatureCollection с entity |
| GeoJSON-seq | `release` | Строки `{...}` |
| Parquet | `release` | Колоночный формат (GDAL) |
| GeoPackage | `release` | Spatial SQLite (GDAL) |
| NDJSON | `release` | plain entity dump |
| SQL | `export-sql` | Data-only INSERT/upsert + import manifest |

### 11.2 Контракт экспорта v1 (`export-sql`)

`export-sql` генерирует два файла в `<run-root>/reports/`:

1. **`poi_product_import.sql`** — data-only фрагмент
   `nearventure-poi-product-sql-v1`: ровно `records.count` однострочных
   `INSERT INTO poi_product (...) VALUES (...) ON CONFLICT (poi_uuid)
   DO UPDATE ...;`. Без `BEGIN`/`COMMIT`/`ROLLBACK`, без DDL/`COPY`/`SET`,
   без psql-метакоманд и комментариев. Транзакцию и перенаправление на
   staging-таблицу обеспечивает importer.
2. **`poi_product_import.manifest.json`** — строгий manifest v1
   (`ImportManifestSchema` в `packages/core`): `schemaVersion: 1`,
   `kind: nearventure.poi-product-import`, `datasetVersion`, `generatedAt`,
   territory/profile, run id, `toolkit.version` (стабильный SemVer) и
   `toolkit.revision` (ровно 40 hex), окно совместимости importer
   (`minImporterVersion 1.0.0` .. `< 2.0.0`), `records.{path,count,bytes,sha256}`
   (path — литерал `reports/poi_product_import.sql`), `counts.categories`
   (сумма = `records.count`) и `counts.sourceRecords`, `provenance`
   (release manifest + collection provenance с sha256), `sourceAttribution`
   (notice + components с HTTPS license URL).

Все вложенные объекты strict (`additionalProperties: false`). Manifest
эмитируется только если:
- `toolkit.revision` — настоящий 40-hex git commit
  (`POI_TOOLKIT_REVISION` или `git rev-parse HEAD`; значение `"unknown"`
  отклоняется);
- release manifest (`release/manifest.json`) имеет `profile: nearventure-v1`,
  и его `entityCount`/`categoryCounts`/`sourceCounts`/`attribution`
  согласованы с экспортом;
- collection provenance (`reports/collection-provenance.json`) содержит
  territory slug и непустой список source manifest-ов с license/attribution.

**Правило безопасности:** экспорт — это артефакт для импортёра, а не команда
загрузки. Запрещено выполнять его напрямую в production:
```
# ❌ НЕЛЬЗЯ: никакого ad-hoc SQL в продуктовую БД
# psql -f workspace/.../reports/poi_product_import.sql
```

### 11.3 Nearventure importer (обязательный путь)

Приём bundle выполняет consumer-owned importer в репозитории Nearventure. Toolkit
не запускает importer, не копирует bundle в trusted root и не пишет в БД:

1. Читает только фиксированный путь manifest; валидирует strict-схему v1.
2. Проверяет SemVer importer в окне `minImporterVersion`..`maxImporterVersionExclusive`.
3. Сверяет SHA-256/bytes SQL и sha256 обоих provenance-файлов.
4. Сверяет release manifest и collection provenance с manifest-ом
   (profile, counts, attribution, territory slug, components).
5. Разбирает SQL строгим грамматическим парсером; число принятых INSERT
   должно равняться `records.count`.
6. Только после preflight: одна транзакция, приватная staging-таблица,
   `COUNT(*)`-проверка, инварианты (уникальность `poi_uuid`), атомарный
   promotion, запись audit-записи (datasetVersion, hash manifest, время).

Любая ошибка (включая promotion) откатывает транзакцию и дропает staging;
`poi_overrides` не переименовывается, не усекается и не пишется.
Канонические consumer-процедура и датированные результаты: [Nearventure data refresh](https://github.com/stanleymarch/nearventure/blob/main/docs/data-refresh.md) и [Nearventure release evidence](https://github.com/stanleymarch/nearventure/blob/main/docs/release-evidence/beta-0.1-acceptance.md). Они не заменяют обязательную валидацию каждого нового bundle.

### 11.4 Legacy артефакт (pre-v1)

Артефакт `workspace/pfo/pfo-v0.1/reports/poi_product_import.sql` (2026-07-27)
сгенерирован **до** контракта v1: содержит `BEGIN;`/`COMMIT;` и комментарии.
Кроме того, `collection-provenance.json` этого run пуст (`sourceManifests: []`).
Такой набор **не удовлетворяет** контракту v1 и не может быть принят importer
без пересборки. Это исторический evidence, а не deployable release.

### 11.5 Восстановление v1-экспорта для legacy run (`recover-release`)

Legacy run-ы с пустым `collection-provenance.json` (как `pfo-v0.1`) не проходят
gate `export-sql` (требуется непустой provenance). Если все исходные артефакты
сохранены, v1 bundle можно восстановить детерминированно — исходный run при
этом **только читается**:

```bash
pnpm cli recover-release --territory pfo --run-id pfo-v0.1 \
  --output-run-id pfo-v0.1-v1 --dataset-version pfo-v0.1-v1
```

Условия и поведение:

1. Требуются `release/entities.ndjson`, `release/manifest.json` и
   `reports/hardening-report.json` с пустым `blockingFailures`.
2. Collection provenance реконструируется из неизменяемых входных данных:
   territory (`territories/<slug>.json`), source manifest-ы (константы
   пакетов `source-*`), SHA-256 raw-снапшотов (из `manifest.sources`) и
   SHA-256 PBF (`inputPbf`) — если файл сохранён. Если в исходном run
   provenance уже валидна, она копируется байт-в-байт без изменений.
   Реконструкция всегда прозрачна: объект помечается полем
   `recovered {at, fromRun, note}`.
3. Создаётся НОВЫЙ run-dir `<output-run-id>` (не должен существовать):
   `release/manifest.json` копируется байт-в-байт, provenance пишется в
   `reports/`, run manifest получает `status: releasable` и diagnostic о
   восстановлении.
4. В новом каталоге выполняется `writeSqlExport`: data-only SQL + строгий
   import manifest v1 (те же проверки, что в `export-sql`).

Правила: исходный run не модифицируется; восстановление НЕ заменяет
live-capture provenance — будущие run-ы обязаны заполнять её на этапе
`collect`. Bundle передаётся как неизменяемые байты по правилам
[nearventure-handoff.md](nearventure-handoff.md); consumer решает acceptance и
production import (никакого ad-hoc `psql`).

---

## 12. Version 0.1 — артефакт `pfo-v0.1`

> Все числа в этом разделе — метрики проверенного **артефакта** `pfo-v0.1`
> (run: started 2026-07-26, finished 2026-07-27, status `completed`).
> Они не означают, что исходный `pfo-v0.1` сам является v1 handoff. Его
> отдельный recovered bundle `pfo-v0.1-v1` имеет датированные consumer-side
> evidence в Nearventure; это не acceptance будущих bundle.

### 12.1 Данные

| Метрика | Значение | Источник |
|---|---|---|
| Территория | ПФО (14 субъектов) | `reports/geography-report.json` |
| Источников | 5 | `release/manifest.json` |
| Исходных записей (normalized, все источники) | 353 328 | `normalized/source-records.ndjson` (сумма `sourceCounts`) |
| Опубликовано (v0.1) | **30 359 POI** | `release/manifest.json` |
| Исключено | 191 177 | `release/manifest.json` |
| В production Nearventure | исходный `pfo-v0.1` — не v1 handoff; отдельный `pfo-v0.1-v1` — см. [consumer evidence](https://github.com/stanleymarch/nearventure/blob/main/docs/release-evidence/beta-0.1-acceptance.md) | — |

### 12.2 Распределение по категориям

| Категория | Кол-во |
|---|---|
| nature | 9 435 |
| monument | 6 998 |
| sights | 4 188 |
| religion | 4 403 |
| heritage | 3 678 |
| museum | 1 657 |
| **Всего** | **30 359** |

### 12.3 Качество (hardening gates)

| Gate | Значение | Статус |
|---|---|---|
| `missingDisposition` | 0 | ✅ |
| `leakedQuarantineGeometry` | 0 | ✅ |
| `junkNames` | 0 | ✅ |
| `foodServiceListings` | 0 | ✅ |
| `museumCategoryMismatch` | 0 | ✅ |
| `registryMuseumWithoutPhoto` | 0 | ✅ |
| `standaloneWikivoyageNature` | 0 | ✅ |
| `specificNearDuplicates` | 0 | ✅ |
| `addressBuildingConflicts` | 3 193 | ⚠️ (не блокирует) |
| `unassignedSubjectRegions` | 877 | ⚠️ |
| `subjectRegionConflicts` | 63 | ⚠️ |

`blockingFailures: []`, `nearDuplicatePairs: []`.

### 12.4 Quality score

Overall **78/100** (`reports/quality-score.json`): структурная целостность 100,
покрытие обогащения 16, уверенность связей 62, полнота провенанса 100,
иерархическое покрытие 100, качество дедупликации 100. Покрытие: фото 21%,
описание 7%, фото+описание 4%, мультиисточник 33%.

### 12.5 Системные требования

| Компонент | Требование |
|---|---|
| Node.js | ≥22 |
| pnpm | ≥9 |
| osmium-tool | ≥1.15 (включён в Dockerfile) |
| GDAL | Опционально (Parquet/GeoPackage) |

Точные требования по RAM/PBF/индексам не зафиксированы в репозитории как
метрика (нет трекаемого benchmark); фактический бюджет зависит от территории.

### 12.6 Быстрый старт (локальный run)

```bash
# Установка
corepack enable && pnpm install && pnpm build

# Полный pipeline (run-id уникален для run)
pnpm cli collect --territory pfo --run-id my-release
pnpm cli normalize --territory pfo --run-id my-release
pnpm cli build-address-index --territory pfo --run-id my-release  # опционально
pnpm cli resolve --territory pfo --run-id my-release
pnpm cli geocode --territory pfo --run-id my-release --provider photon
pnpm cli synthesize --territory pfo --run-id my-release
pnpm cli release --territory pfo --run-id my-release
pnpm cli export-sql --territory pfo --run-id my-release
# → reports/poi_product_import.sql + reports/poi_product_import.manifest.json
```

Дальнейшая загрузка в БД — только через importer Nearventure (раздел 11.3).

### 12.7 Docker

```bash
docker build -t poi-toolkit .
docker run --rm \
  -e MKRF_API_KEY=... \
  -v /path/to/pfo.osm.pbf:/app/input/pfo.osm.pbf:ro \
  -v /path/to/workspace:/app/workspace \
  poi-toolkit collect --territory pfo --run-id pilot
```

### 12.8 Тесты

**155 тестов, 22 файла, все проходят** (проверено 2026-08-10, `pnpm test`).
Распределение по пакетам: core 23, quality 25, geocode 25, geography 22,
taxonomy 9, resolver 7, exporters 7, media 6, synthesis 6,
profiles-nearventure 5, source-mkrf 4, source-wikivoyage 4, source-osm 3,
source-wikidata 3, source-egrkn 2, normalize 2, cli 2.

---

## 13. Регрессионное покрытие

Ряд сценариев, отражающих реальные ошибки прошлых запусков, покрыт тестами
(без отдельного «регрессионного корпуса» с фиксированным числом — число
тестов см. в 12.8). Примеры сценариев:

| Сценарий | Что проверяет | Файл |
|---|---|---|
| Адрес: 67 vs 67 кД | Корпус/литера ≠ номер дома | `geography/test/geography.test.ts` |
| Куркума | Фильтр Wikivoyage listing type=eat | `taxonomy/test/taxonomy.test.ts` |
| Музей Васнецова | Классификация по названию | `taxonomy/test/taxonomy.test.ts` |
| Фантазариум (Wikivoyage+OSM) | Distinctive-name proximity merge | `resolver/test/resolver.test.ts` |
| Пруд area+way → один POI | Osmium area = 2× way ID | `resolver/test/resolver.test.ts` |
| Родник без wikidata — шум | Generic spring filtering | `taxonomy/test/taxonomy.test.ts` |
| Музей по имени | `tourism=gallery` + «Музей» | `taxonomy/test/taxonomy.test.ts` |
| Locality-free address match | OSM index без city, strong name | `geocode/test/geocode.test.ts` |

---

## 14. Preflight Checks

```bash
pnpm cli preflight --territory pfo --run-id my-release
```

Проверяет (ровно этот набор, `packages/cli/src/index.ts`):
- Версия Node.js ≥ 22
- Наличие конфигурации территории и PBF-файла (если передан `territory`)
- Наличие `osmium-tool` (warning, если нет — можно через Docker)
- Доступность Photon (`PHOTON_URL`, warning)
- Наличие `MKRF_API_KEY` (warning)

Preflight **не** проверяет доступность API ЕГРКН/Wikidata/Wikivoyage/Commons
и не проверяет запись в рабочую директорию.

---

## 15. Production deployment (граница ответственности)

POI Toolkit не имеет и не запускает production deployment procedure. Он
передаёт immutable v1 bundle с identifiers/digests; trusted root, dry-run,
import, audit и rollback принадлежат Nearventure. Используйте
[nearventure-handoff.md](nearventure-handoff.md) для producer-side требований и
[Nearventure data refresh](https://github.com/stanleymarch/nearventure/blob/main/docs/data-refresh.md)
для consumer-side процедуры.

Прошлые инструкции «атомарного swap» через прямые `psql`-скрипты
(`scripts/atomic-deploy.sh`, ручные `ALTER TABLE ... RENAME`) **отозваны**:
они обходят валидацию и не должны публиковаться или запускаться из toolkit.
`scripts/atomic-deploy.sh` сохранён только как permanently disabled compatibility
stub: он завершается с ненулевым кодом до чтения, копирования или удаления
артефактов и не может обратиться к БД. Единственный разрешённый путь загрузки в
БД — manifest-валидируемый importer handoff Nearventure. Исторические acceptance
evidence не заменяют проверки нового bundle.

---

## 16. Технологии и лицензии

### Инструменты

| Инструмент | Версия | Зачем |
|---|---|---|
| Node.js | ≥22 | TypeScript runtime |
| TypeScript | 5.x | Типизированный язык |
| pnpm | ≥9 | Package manager, monorepo |
| vitest | 2.x | Тестовый фреймворк |
| zod | 3.x | Схемы данных, валидация |
| osmium-tool | ≥1.15 | OSM PBF extraction |
| GDAL (ogr2ogr) | ≥3.x | Parquet/GeoPackage export |
| yargs | 17.x | CLI argument parsing |
| sharp | optional | WebP cache (media) |

### Внешние API

| API | Endpoint | Зачем |
|---|---|---|
| ЕГРКН | `https://opendata.mkrf.ru/v2/` | Реестр ОКН |
| Минкультуры | `https://opendata.mkrf.ru/v2/` | Музеи |
| Wikidata Query Service | `https://query.wikidata.org/sparql` | Элементы по регионам |
| Wikivoyage (MediaWiki) | `https://ru.wikivoyage.org/w/api.php` | Списки достопримечательностей |
| Wikimedia Commons | `https://commons.wikimedia.org/w/api.php` | Фото |
| Photon | self-hosted (`PHOTON_URL`) | Геокодинг |
| Nominatim | опционально | Геокодинг (opt-in) |
| Yandex Geocoder | опционально | Геокодинг (capped by default) |

### Зависимости от окружения

| Переменная | Для чего | Обязательна? |
|---|---|---|
| `MKRF_API_KEY` | ЕГРКН + музеи | ✅ Да |
| `PHOTON_URL` | Photon endpoint | ❌ (default `http://localhost:2322`) |
| `NOMINATIM_URL` | Nominatim endpoint | ❌ (opt-in) |
| `GEOCODER_API_KEY` | Yandex геокодер | ❌ (opt-in) |
| `POI_TOOLKIT_USER_AGENT` | User-Agent для HTTP | ❌ |
| `POI_TOOLKIT_ROOT` | Корень проекта | ❌ (default cwd) |
| `POI_TOOLKIT_REVISION` | 40-hex ревизия для manifest | ❌ (по умолчанию `git rev-parse HEAD`) |

### Лицензии и атрибуция

POI Toolkit распространяется под MIT License (см. `LICENSE`).

Заявленные лицензии данных:

| Источник | Лицензия | Атрибуция |
|---|---|---|
| OpenStreetMap | ODbL 1.0 | © OpenStreetMap contributors |
| ЕГРКН | Open Data | Минкультуры России |
| Wikidata | CC0 | Wikidata contributors |
| Wikivoyage | CC BY-SA | Wikivoyage contributors |
| Wikimedia Commons | CC BY-SA / CC BY | Зависит от файла |
| Photon (OSM-based) | ODbL 1.0 | © OpenStreetMap contributors |

> Таблица отражает условия провайдеров на момент написания. Перед релизом
> эти данные необходимо верифицировать по versioned collection provenance
> (`reports/collection-provenance.json`) и актуальным условиям каждого
> провайдера. Данный раздел не является юридической консультацией.

---

## 17. JOSM-интеграция (статус)

**Планируется (P2.4).** Текущие артефакты релиза — GeoJSON/NDJSON/Parquet/GPKG.
JOSM review bundle (GeoJSON → `.osm` для полевых проверок) и проверенный
workflow в JOSM — будущая работа; инструкций «проверенного» процесса JOSM
в репозитории нет.

---

## 18. Связанные репозитории

| Репозиторий | Роль |
|---|---|
| [poi-toolkit](https://github.com/stanleymarch/poi-toolkit) | Этот репозиторий: подготовка и экспорт канонических POI |
| [nearventure](https://github.com/stanleymarch/nearventure) | Потребитель экспорта: manifest-валидирующий importer, карта и маршруты |
