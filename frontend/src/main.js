import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './style.css'
import request from './api.js'
import { createSeaLayers } from './map-layers.js'
const $ = (id) => document.getElementById(id)
const number = (n) => n.toLocaleString('en-US')
const format = (m) =>
    m < 1000
        ? `${Math.round(m)} m`
        : `${(m / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} km`
const seaName = (id) =>
    ({ black: 'Black Sea', red: 'Red Sea', marmara: 'Sea of Marmara' })[id] || id

let map,
    tileLayer,
    seas = [],
    points,
    connectors,
    selection,
    hover,
    labels,
    selected = null,
    selectedSea = null,
    detailTrigger = null,
    timer,
    viewportVersion = 0,
    detailVersion = 0,
    ready = false,
    serverTimer,
    busy = false,
    pending = false
const emptyDetails = $('details').innerHTML
function status(message) {
    $('status').textContent = message
    $('status').hidden = !message
}
function element(tag, className, text) {
    const el = document.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
}
function renderServer(stats) {
    const server = stats.server
    const seconds = Math.floor(server.uptimeSeconds)
    const uptime =
        seconds < 60
            ? `${seconds}s`
            : seconds < 3600
              ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
              : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
    const memory = (bytes) => `${(bytes / 1048576).toFixed(1)} MiB`
    $('server-runtime').textContent = server.goVersion
    $('server-platform').textContent = server.platform
    $('server-uptime').textContent = uptime
    $('server-startup').textContent = `${server.startupMs.toFixed(0)} ms`
    $('server-heap').textContent = memory(server.heapBytes)
    $('server-index').textContent = memory(server.indexBytes)
    $('server-cpus').textContent = number(server.cpus)
    $('server-goroutines').textContent = number(server.goroutines)
    $('server-segments').textContent = number(server.coastSegments)
    $('server-status').textContent = 'Connected'
}
async function refreshServer() {
    if ($('server-panel').hidden || document.hidden) return
    try {
        renderServer(await request('/api/stats'))
    } catch {
        $('server-status').textContent = 'Unavailable'
    }
}
function toggleServer(open) {
    $('server-panel').hidden = !open
    $('server-toggle').setAttribute('aria-expanded', String(open))
    clearInterval(serverTimer)
    if (open) {
        closeDetails()
        refreshServer()
        serverTimer = setInterval(refreshServer, 5000)
    }
}
function closeDetails() {
    const restoreFocus = document.querySelector('.inspector').contains(document.activeElement)
    detailVersion++
    selected = null
    selectedSea = null
    selection.clearLayers()
    $('details').innerHTML = emptyDetails
    $('close-details').hidden = true
    document.querySelector('.inspector').classList.remove('has-selection')
    document.querySelectorAll('.hotel-row.active').forEach((el) => el.classList.remove('active'))
    if (restoreFocus) {
        const target =
            detailTrigger?.isConnected && detailTrigger.getClientRects().length
                ? detailTrigger
                : window.matchMedia('(max-width: 760px)').matches
                  ? $('mobile-results')
                  : $('sea')
        target.focus()
    }
    detailTrigger = null
}
function mapPadding() {
    const size = map.getSize()
    const mobile = window.matchMedia('(max-width: 760px)').matches
    const sidebar = document.querySelector('.sidebar')
    const panel = document.querySelector('.inspector')
    const visible = panel.classList.contains('has-selection')
    const left = mobile ? 20 : Math.min(sidebar.offsetWidth + 48, size.x * 0.36)
    return {
        paddingTopLeft: [left, mobile ? sidebar.offsetHeight + 28 : 28],
        paddingBottomRight: [
            visible && !mobile ? Math.min(panel.offsetWidth + 48, size.x * 0.36) : 28,
            visible && mobile ? Math.min(panel.offsetHeight + 40, size.y * 0.65) : 40
        ]
    }
}
const hotelGlyph =
    '<path d="M10 9h12v13H10zM13 12h1m4 0h1m-6 4h1m4 0h1m-4 6v-3h2v3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
function hotelIcon(selected = false, generated = false) {
    return L.divIcon({
        className: `hotel-pin${selected ? ' selected' : ''}${generated ? ' sample' : ''}`,
        html: `<svg viewBox="0 0 32 36" aria-hidden="true"><path class="pin-body" d="M16 2C9 2 3 7.5 3 14.5 3 24 16 34 16 34s13-10 13-19.5C29 7.5 23 2 16 2Z"/>${hotelGlyph}</svg>`,
        iconSize: [32, 36],
        iconAnchor: [16, 34],
        tooltipAnchor: [0, -30]
    })
}
function preview(c) {
    hover.clearLayers()
    if ($('connections').checked || selected?.id === c.id) return
    L.polyline(
        [
            [c.lat, c.lon],
            [c.distance.shore.Lat, c.distance.shore.Lon]
        ],
        {
            color: '#000000',
            weight: 2,
            opacity: 0.75,
            interactive: false
        }
    ).addTo(hover)
}
function focusHotel(h) {
    map.fitBounds(
        [
            [h.lat, h.lon],
            [h.lat, h.lon]
        ],
        {
            ...mapPadding(),
            maxZoom: Math.max(16, map.getZoom())
        }
    )
}
function drawSelection(h) {
    selection.clearLayers()
    const nearest = h.distances[0]
    const chosen = h.distances.find((d) => d.seaId === (selectedSea || $('sea').value)) || nearest
    L.polyline(
        [
            [h.lat, h.lon],
            [chosen.shore.Lat, chosen.shore.Lon]
        ],
        { color: '#000000', weight: 3, dashArray: '5 5', interactive: false }
    ).addTo(selection)
    L.marker([h.lat, h.lon], {
        icon: hotelIcon(true, h.source === 'Generated'),
        title: h.name,
        keyboard: false,
        interactive: false,
        zIndexOffset: 1000
    }).addTo(selection)
    L.circleMarker([chosen.shore.Lat, chosen.shore.Lon], {
        radius: 4,
        color: '#000000',
        weight: 2,
        fillColor: '#ffffff',
        fillOpacity: 1,
        interactive: false
    }).addTo(selection)
}
async function choose(id, focus = false) {
    const version = ++detailVersion
    detailTrigger = document.activeElement
    const keyboard = detailTrigger?.matches('.hotel-row:focus-visible, .hotel-pin:focus-visible')
    try {
        const h = await request(`/api/hotels/${id}`)
        if (version !== detailVersion || ($('real-only').checked && h.source === 'Generated'))
            return
        toggleServer(false)
        if (window.matchMedia('(max-width: 760px)').matches)
            document.querySelector('.map-options').open = false
        document.querySelector('.sidebar').classList.remove('show-results')
        $('mobile-results').setAttribute('aria-expanded', 'false')
        $('mobile-results').textContent = 'Show hotels in view'
        selected = h
        selectedSea = $('sea').value || h.distances[0].seaId
        drawSelection(h)
        $('close-details').hidden = false
        document.querySelector('.inspector').classList.add('has-selection')
        document
            .querySelectorAll('.hotel-row')
            .forEach((el) => el.classList.toggle('active', Number(el.dataset.id) === h.id))
        const body = element('div', 'detail-body')
        body.append(
            element('h3', 'detail-name', h.name),
            element('div', 'detail-region', `${seaName(h.seaId)} · ${h.source || 'Hotel metadata'}`)
        )
        const coords = element('div', 'coordinates')
        ;[
            ['Latitude', h.lat.toFixed(6)],
            ['Longitude', h.lon.toFixed(6)],
            ['Region check', h.onLand ? 'Outside sea polygons' : 'Inside sea polygon'],
            ['Hotels within 1 km', number(h.nearby)]
        ].forEach(([label, value]) => {
            const row = element('div', 'coordinate-row')
            row.append(element('span', '', label), element('strong', '', value))
            coords.append(row)
        })
        const metadata = element('details', 'hotel-metadata')
        metadata.append(element('summary', '', 'Location and data'), coords)
        const hero = element('div', 'shore-distance')
        const heroValue = element('strong', '', '')
        const heroLabel = element('span', '', '')
        const updateDistance = () => {
            const d = h.distances.find((d) => d.seaId === selectedSea) || h.distances[0]
            heroValue.textContent = format(d.meters)
            heroLabel.textContent = `To the ${seaName(d.seaId)} shoreline`
        }
        updateDistance()
        hero.append(heroValue, heroLabel)
        body.append(hero)
        const distances = element('div', 'distance-block')
        distances.append(element('div', 'distance-title', 'Distance to shoreline'))
        h.distances.forEach((d) => {
            const row = element('button', `sea-distance${d.seaId === selectedSea ? ' chosen' : ''}`)
            row.append(
                element('span', '', seaName(d.seaId)),
                element('strong', '', format(d.meters))
            )
            row.type = 'button'
            row.setAttribute('aria-pressed', String(d.seaId === selectedSea))
            row.onclick = () => {
                selectedSea = d.seaId
                updateDistance()
                distances.querySelectorAll('.sea-distance').forEach((button) => {
                    const chosen = button === row
                    button.classList.toggle('chosen', chosen)
                    button.setAttribute('aria-pressed', String(chosen))
                })
                drawSelection(h)
            }
            distances.append(row)
        })
        body.append(distances)
        const actions = element('div', 'detail-actions')
        const zoom = element('button', 'button', 'Focus hotel')
        zoom.onclick = () => focusHotel(h)
        const show = element('button', 'button', 'View connection')
        show.onclick = () => {
            const d =
                h.distances.find((d) => d.seaId === (selectedSea || $('sea').value)) ||
                h.distances[0]
            map.fitBounds(
                [
                    [h.lat, h.lon],
                    [d.shore.Lat, d.shore.Lon]
                ],
                { ...mapPadding(), maxZoom: 16 }
            )
        }
        actions.append(show, zoom)
        body.append(
            actions,
            metadata,
            element(
                'p',
                'distance-note',
                'Straight-line distance to the mapped coast. Beach access may differ.'
            )
        )
        $('details').replaceChildren(body)
        if (keyboard) $('close-details').focus()
        if (focus) focusHotel(h)
    } catch (e) {
        if (version === detailVersion) status(`Could not load hotel: ${e.message}`)
    }
}
function zoomCluster(c) {
    const bounds = L.latLngBounds([
        [c.south, c.west],
        [c.north, c.east]
    ])
    if (map.getZoom() >= 19) {
        choose(c.id)
        return
    }
    let target = map.getBoundsZoom(bounds, false, [70, 70])
    target = Math.max(map.getZoom() + 2, Math.min(19, target))
    map.setView(bounds.getCenter(), target)
}
function render(result) {
    $('visible').textContent = number(result.visible)
    $('query-time').textContent = `${result.queryMs.toFixed(1)} ms`
    $('result-count').textContent = number(result.cells.length)
    $('zoom').textContent = `ZOOM ${map.getZoom()}`
    $('engine-status').textContent =
        `${number(result.visible)} in view · ${result.cells.length} markers · coast ${result.distanceMs.toFixed(1)} ms`
    $('index-size').textContent = `Index ${(result.indexBytes / 1048576).toFixed(1)} MiB · WGS84`
    points.clearLayers()
    connectors.clearLayers()
    hover.clearLayers()
    const list = document.createDocumentFragment()
    result.cells.forEach((c) => {
        const clustered = c.count > 1
        let marker
        if (clustered) {
            marker = L.marker([c.lat, c.lon], {
                icon: L.divIcon({
                    className: 'cluster-icon',
                    html: `<span class="cluster-label">${c.count >= 1000 ? `${(c.count / 1000).toFixed(1)}k` : c.count}</span>`,
                    iconSize: [38, 38],
                    iconAnchor: [19, 19]
                }),
                title: `${number(c.count)} hotels — zoom in`,
                keyboard: true
            })
        } else {
            marker = L.marker([c.lat, c.lon], {
                icon: hotelIcon(false, c.source === 'Generated'),
                title: c.name,
                keyboard: true,
                bubblingMouseEvents: false
            })
        }
        marker.addTo(points)
        marker.on('mouseover', () => preview(c))
        marker.on('mouseout', () => hover.clearLayers())
        const tip = element(
            'span',
            '',
            clustered
                ? `${number(c.count)} hotels · representative ${format(c.distance.meters)} from shore`
                : `${c.name} · ${format(c.distance.meters)}`
        )
        marker.bindTooltip(tip, { direction: 'top' })
        marker.on('click', () => {
            if (clustered) zoomCluster(c)
            else choose(c.id)
        })
        L.polyline(
            [
                [c.lat, c.lon],
                [c.distance.shore.Lat, c.distance.shore.Lon]
            ],
            { color: '#000000', weight: 1, opacity: 0.35, interactive: false }
        ).addTo(connectors)
        const row = element('button', `hotel-row${selected?.id === c.id ? ' active' : ''}`)
        row.dataset.id = c.id
        row.title = clustered ? `${number(c.count)} hotels` : c.name
        row.onmouseenter = () => preview(c)
        row.onmouseleave = () => hover.clearLayers()
        row.onfocus = () => preview(c)
        row.onblur = () => hover.clearLayers()
        row.append(
            element('strong', '', clustered ? `${number(c.count)} hotels` : c.name),
            element(
                'small',
                '',
                `${seaName(c.distance.seaId)}${clustered ? ' · click to zoom' : c.source === 'Generated' ? ' · sample' : ' · real hotel'}`
            ),
            element('span', 'distance', format(c.distance.meters))
        )
        row.onclick = () => (clustered ? zoomCluster(c) : choose(c.id, true))
        list.append(row)
    })
    if (!result.cells.length)
        list.append(
            element(
                'div',
                'empty',
                $('search').value
                    ? 'No matching hotels in view. Try another name or zoom out.'
                    : 'No hotels in this viewport. Pan towards a coastline or fit all seas.'
            )
        )
    $('hotels').replaceChildren(list)
    if (selected) drawSelection(selected)
}
async function refresh() {
    if (!ready) return
    if (busy) {
        pending = true
        viewportVersion++
        return
    }
    busy = true
    pending = false
    const version = ++viewportVersion
    const b = map.getBounds(),
        size = map.getSize()
    const payload = {
        west: Math.max(-180, b.getWest()),
        south: Math.max(-85, b.getSouth()),
        east: Math.min(180, b.getEast()),
        north: Math.min(85, b.getNorth()),
        width: size.x,
        height: size.y,
        sea: $('sea').value,
        search: $('search').value,
        realOnly: $('real-only').checked
    }
    $('engine-status').textContent = 'Querying viewport…'
    try {
        const result = await request('/api/viewport', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        if (version === viewportVersion) {
            status('')
            render(result)
        }
    } catch (e) {
        if (version === viewportVersion && e.name !== 'AbortError')
            status(`Viewport query failed: ${e.message}. Pan or zoom to retry.`)
    } finally {
        busy = false
        if (pending) {
            pending = false
            refresh()
        }
    }
}
function fitSea() {
    const sea = seas.find((s) => s.id === $('sea').value)
    const bounds = sea
        ? sea.layer.getBounds()
        : L.featureGroup(seas.map((s) => s.layer)).getBounds()
    map.fitBounds(bounds, { ...mapPadding(), maxZoom: 9 })
}
async function start() {
    try {
        map = L.map('map', {
            crs: L.CRS.EPSG3857,
            zoomControl: false,
            minZoom: 3,
            maxZoom: 19,
            maxBounds: [
                [-85, -180],
                [85, 180]
            ],
            maxBoundsViscosity: 1,
            preferCanvas: true
        }).setView([35, 33], 5)
        L.control.zoom({ position: 'topright' }).addTo(map)
        L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map)
        tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            noWrap: true,
            attribution:
                '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map)
        let tileWarning = false
        tileLayer.on('tileerror', () => {
            if (!tileWarning) {
                tileWarning = true
                status(
                    'OpenStreetMap tiles are unavailable. Hotel markers and sea polygons still work.'
                )
            }
        })
        points = L.layerGroup().addTo(map)
        connectors = L.layerGroup()
        selection = L.layerGroup().addTo(map)
        hover = L.layerGroup().addTo(map)
        labels = L.layerGroup().addTo(map)
        $('loading-message').textContent = 'Loading sea polygons and hotel index…'
        const [data, stats] = await Promise.all([request('/api/seas'), request('/api/stats')])
        seas = data
        $('total').textContent = number(stats.count)
        $('total').title =
            `${number(stats.realCount)} real hotels · ${number(stats.generatedCount)} sample points`
        document.querySelector('.sidebar-footer').textContent =
            `${number(stats.realCount)} real hotels + ${number(stats.generatedCount)} sample points. Straight-line distances, not beach routes.`
        renderServer(stats)
        $('server-toggle').disabled = false
        $('server-toggle').onclick = () => toggleServer($('server-panel').hidden)
        stats.seas.forEach((sea) => {
            const option = $('sea').querySelector(`option[value="${sea.id}"]`)
            if (option) option.textContent = `${sea.name} · ${number(sea.count)} hotels`
        })
        seas.forEach((s) => {
            Object.assign(s, createSeaLayers(s))
            s.layer.addTo(map)
            const center = { black: [43, 34.5], red: [22, 37.5], marmara: [40.65, 28.05] }[s.id]
            if (center)
                L.marker(center, {
                    interactive: false,
                    keyboard: false,
                    icon: L.divIcon({
                        className: 'sea-label',
                        html: s.name,
                        iconSize: [180, 24],
                        iconAnchor: [90, 12]
                    })
                }).addTo(labels)
        })
        map.removeLayer(labels)
        ready = true
        $('loading').hidden = true
        $('sea').disabled = false
        $('reset').disabled = false
        $('search').disabled = false
        $('real-only').onchange = () => {
            detailVersion++
            if (selected?.source === 'Generated') closeDetails()
            refresh()
        }
        $('search').oninput = () => {
            viewportVersion++
            clearTimeout(timer)
            timer = setTimeout(refresh, 200)
        }
        $('mobile-results').disabled = false
        $('mobile-results').onclick = () => {
            const expanded = document.querySelector('.sidebar').classList.toggle('show-results')
            $('mobile-results').setAttribute('aria-expanded', String(expanded))
            $('mobile-results').textContent = expanded
                ? 'Hide hotels in view'
                : 'Show hotels in view'
            map.invalidateSize()
            refresh()
        }
        fitSea()
        map.on('moveend', () => {
            viewportVersion++
            clearTimeout(timer)
            timer = setTimeout(refresh, 120)
        })
        map.on('click', async (event) => {
            const version = ++detailVersion
            try {
                const query = new URLSearchParams({
                    lat: event.latlng.lat,
                    lon: event.latlng.lng,
                    sea: $('sea').value,
                    realOnly: String($('real-only').checked)
                })
                const nearest = await request(`/api/nearest?${query}`)
                if (version === detailVersion) choose(nearest.id)
            } catch (e) {
                if (version === detailVersion) status(`Nearest-hotel search failed: ${e.message}`)
            }
        })
        $('sea').onchange = () => {
            closeDetails()
            fitSea()
            refresh()
        }
        $('reset').onclick = () => {
            $('sea').value = ''
            $('search').value = ''
            $('real-only').checked = false
            closeDetails()
            fitSea()
            refresh()
        }
        $('connections').onchange = () => {
            $('connections').checked ? connectors.addTo(map) : map.removeLayer(connectors)
        }
        $('polygons').onchange = () =>
            seas.forEach((s) =>
                $('polygons').checked ? s.layer.addTo(map) : map.removeLayer(s.layer)
            )
        $('base-map').onchange = () => {
            const streets = $('base-map').checked
            streets ? tileLayer.addTo(map) : map.removeLayer(tileLayer)
            seas.forEach((s) => {
                s.area.setStyle({ fillOpacity: streets ? 0.12 : 1 })
                streets ? s.shore.addTo(s.layer) : s.layer.removeLayer(s.shore)
            })
            streets ? map.removeLayer(labels) : labels.addTo(map)
        }
        $('close-details').onclick = closeDetails
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeDetails()
                toggleServer(false)
            }
        })
        window.addEventListener('resize', () => {
            map.invalidateSize()
            clearTimeout(timer)
            timer = setTimeout(refresh, 120)
        })
        await refresh()
    } catch (e) {
        $('loading-message').textContent = e.message
        $('engine-status').textContent = 'Failed to initialize'
        const retry = element('button', 'button', 'Retry')
        retry.onclick = () => location.reload()
        $('loading').append(retry)
    }
}
start()
