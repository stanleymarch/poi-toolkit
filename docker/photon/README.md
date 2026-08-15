# Photon — локальный геокодер для POI Toolkit

Photon — это геокодер от komoot на базе Elasticsearch. POI Toolkit использует
его по умолчанию для адресного геокодинга записей ЕГРКН (определение точных
координат ОКН по адресу).

**Почему Photon, а не Nominatim:**
- Безлимитный (self-hosted, нет политики использования как у публичного Nominatim)
- Быстрее на пакетных запросах (Elasticsearch под капотом)
- Поддерживает `/structured` endpoint (город + улица + дом отдельно)
- Поддерживает русский язык

**Что нужно для работы:**
- Java 21+ (уже в Docker-образе)
- Elasticsearch-индекс (см. ниже — три способа)
- ≥4 GB RAM для сервера Photon
- ≥5× от размера PBF на диск для индекса

---

## Быстрый старт (Docker)

### Шаг 1. Собрать образ

```bash
cd poi-toolkit
docker build -t poi-toolkit-photon -f docker/photon/Dockerfile .
```

Образ содержит:
- Eclipse Temurin JRE 21
- `photon-1.2.1.jar` (автоматически скачивается из [GitHub Releases](https://github.com/komoot/photon/releases))
- Порт 2322 открыт

### Шаг 2. Получить индекс — три способа

#### Способ A: Скачать готовый экстракт (быстро, ~30 минут)

Komoot публикует готовые национальные экстракты по адресу:
`https://photon.komoot.io/data/`

```bash
mkdir -p docker/data/photon

# Скачать экстракт для всей России (~4.8 GB)
wget -O docker/data/photon/photon_data.tar \
  https://photon.komoot.io/data/russia-latest.tar

# Распаковать
cd docker/data/photon
tar xf photon_data.tar
cd ../../..
```

Это самый быстрый способ. Экстракт содержит всю Россию с поддержкой `ru,en`.

> **Внимание:** photon.komoot.io может быть медленным. Зеркало:
> `https://download1.graphhopper.com/public/photon/` (если доступно).

#### Способ B: Импортировать PBF (медленно, 1-3 часа)

Если готового экстракта нет для вашей территории, или вы хотите самый свежий
индекс — импортируйте OSM PBF вручную:

```bash
mkdir -p docker/data/photon

# Скачать PBF с Geofabrik (например, для ПФО)
wget -O input/pfo.osm.pbf \
  https://download.geofabrik.de/russia/volga-fed-district-latest.osm.pbf

# Импорт (разово, долго — зависит от размера PBF)
docker run --rm \
  -v "$PWD/docker/data/photon:/photon/photon_data" \
  -v "$PWD/input/pfo.osm.pbf:/data/pfo.osm.pbf:ro" \
  poi-toolkit-photon -import /data/pfo.osm.pbf -languages ru,en
```

Время импорта: ~1 час для ПФО (731 MB PBF), ~4-6 часов для всей России.
RAM: ≥8 GB во время импорта (увеличьте `-Xmx` в Dockerfile при необходимости).

#### Способ C: Использовать наш готовый образ (если есть)

Если у вас есть доступ к собранному образу с встроенным индексом:

```bash
docker pull <registry>/poi-toolkit-photon:1.2.1-russia

docker run -d --name photon \
  -p 2322:2322 \
  <registry>/poi-toolkit-photon:1.2.1-russia \
  serve -listen-ip 0.0.0.0 -listen-port 2322 -languages ru,en
```

### Шаг 3. Запустить сервер Photon

```bash
docker run -d --name photon \
  -p 2322:2322 \
  -v "$PWD/docker/data/photon:/photon/photon_data" \
  poi-toolkit-photon \
  serve -listen-ip 0.0.0.0 -listen-port 2322 -languages ru,en
```

Проверка:
```bash
curl "http://localhost:2322/api?q=Москва,+Ленина,+5&lang=ru" | jq '.features[0].properties'
```

Должен вернуть адрес с `osm_value: "house"` и `housenumber: "5"`.

### Шаг 4. Подключить к POI Toolkit

```bash
# Photon уже работает на localhost:2322 — это дефолт
export PHOTON_URL=http://localhost:2322
node packages/cli/dist/index.js geocode --territory pfo --run-id my-run --provider photon
```

Если toolkit тоже в Docker:
```bash
# Вариант 1: общий network
docker network create poi-net
docker run -d --name photon --network poi-net ...
docker run --rm --network poi-net \
  -e PHOTON_URL=http://photon:2322 \
  poi-toolkit:v0.1 geocode --territory pfo --run-id my-run --provider photon

# Вариант 2: host network
docker run --rm --network host \
  -e PHOTON_URL=http://localhost:2322 \
  poi-toolkit:v0.1 geocode --territory pfo --run-id my-run --provider photon
```

---

## Ресурсы и лимиты

| Параметр | Минимум | Рекомендуется |
|---|---|---|
| RAM (сервер) | 4 GB | 8 GB |
| RAM (импорт) | 8 GB | 16 GB |
| Диск (индекс ПФО) | 3 GB | 5 GB |
| Диск (индекс Россия) | 8 GB | 15 GB |
| Java heap (`-Xmx`) | 4g | 8g |

**Изменить heap** — отредактируйте ENTRYPOINT в Dockerfile:
```dockerfile
ENTRYPOINT ["java", "-Xmx8g", "-jar", "photon.jar"]
```

---

## Альтернативы

Photon — не единственный вариант. Если нет ресурсов для self-hosted Photon:

### Nominatim (self-hosted)

```bash
# Требует отдельной установки + PostgreSQL+PostGIS
# https://nominatim.org/release-docs/latest/admin/Installation/
export NOMINATIM_URL=http://nominatim:8080
node packages/cli/dist/index.js geocode --territory pfo --run-id my-run --provider nominatim
```

Тяжелее в установке, но тоже безлимитный.

### Yandex Geocoder (облачный, опционально)

```bash
export GEOCODER_API_KEY=...
node packages/cli/dist/index.js geocode --territory pfo --run-id my-run --provider yandex
# Или как fallback к Photon:
node packages/cli/dist/index.js geocode --territory pfo --run-id my-run --provider photon --fallback yandex
```

**Лимит:** 1 000 вызовов всего (будь то primary или fallback). Это жёстко
заложено в код — нельзя обойти через `--limit`.

### Без геокодера

Если геокодер недоступен, geocode можно пропустить. В этом случае записи ЕГРКН
без точных координат (native geometry) не будут опубликованы — только те, у
которых есть координаты в самом реестре.

```bash
# Пропустить geocode, сразу к release
node packages/cli/dist/index.js release --territory pfo --run-id my-run
```

---

## Траблшутинг

### `curl: (7) Failed to connect to localhost port 2322`

Photon не запущен. Проверьте: `docker ps | grep photon`

### Пустые результаты на `lang=ru`

Индекс был импортирован без флага `-languages ru,en`. Пересоздайте индекс с
языковой поддержкой. POI Toolkit автоматически ретраит без `lang`, но качество
поиска хуже.

### `java.lang.OutOfMemoryError: Java heap space`

Увеличьте `-Xmx` в Dockerfile. Для импорта России нужен ≥8 GB heap.

### Медленный импорт

Нормально. 700 MB PBF = ~1 час на 8 GB RAM. Можно распараллелить через
`-nominatim-import` + `-jobs`, но Photon этого не поддерживает напрямую.

### Photon возвращает не тот дом

Это **адресный конфликт** —Photon нашёл дом с тем же номером, но на другой
улице. POI Toolkit детектирует это через `evaluateAttempt()` и отправляет
запись в карантин (`quarantined-conflict`). Это корректное поведение.

### Переустановка индекса

```bash
docker stop photon && docker rm photon
rm -rf docker/data/photon/*
# Повторить импорт или скачивание
```

---

## Ссылки

- **Photon (komoot):** https://github.com/komoot/photon
- **Pre-built extracts:** https://photon.komoot.io/data/
- **OSM PBF (Geofabrik):** https://download.geofabrik.de/
- **Photon API docs:** https://github.com/komoot/photon#search
