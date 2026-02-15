/**
 * GigList - Map Engine Module
 */
let markers = [];

export function initMap(data) {
    // 1. Check if map container exists in DOM
    const mapContainer = document.getElementById('map');
    if (!mapContainer) return;

    // 2. If map already exists, just refresh markers, don't re-init the whole map
    if (!window.leafletMap) {
        window.leafletMap = L.map('map', {
            center: [54.5, -2], // Centered on UK
            zoom: 6,
            zoomControl: false
        });

        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
            attribution: '© OpenStreetMap'
        }).addTo(window.leafletMap);
    }

    // 3. Clear old markers
    markers.forEach(m => window.leafletMap.removeLayer(m));
    markers = [];

    // 4. Add markers based on the data passed in
    data.forEach(gig => {
        if (gig.Latitude && gig.Longitude) {
            const m = L.marker([gig.Latitude, gig.Longitude])
                .bindPopup(`<b>${gig.Band}</b><br>${gig.OfficialVenue}<br>${gig.Date}`)
                .addTo(window.leafletMap);
            markers.push(m);
        }
    });
}