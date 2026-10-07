import L from 'leaflet'

export function createSeaLayers(sea) {
    const area = L.geoJSON(sea.geometry, {
        style: { stroke: false, fillColor: '#eeeeee', fillOpacity: 0.06 },
        attribution:
            '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        smoothFactor: 0,
        interactive: false
    })
    const shore = L.geoJSON(
        { type: 'MultiLineString', coordinates: sea.coast },
        {
            style: { color: '#000000', weight: 1, opacity: 0.6 },
            smoothFactor: 0,
            interactive: false
        }
    )
    return { area, shore, layer: L.featureGroup([area, shore]) }
}
