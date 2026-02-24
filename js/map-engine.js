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
            center: [20, 0], // Better global starting position
            zoom: 2,         // Zoomed out to show international scope
            minZoom: 10,      // Prevent zooming out into the void
            zoomControl: false,
            worldCopyJump: true // Seamlessly handle markers across the meridian
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
        // Parse coordinates as numbers to avoid string concatenation/logic errors
        const lat = parseFloat(gig.Latitude);
        const lng = parseFloat(gig.Longitude);

        // Only add marker if coordinates are valid numbers
        if (!isNaN(lat) && !isNaN(lng)) {
            const m = L.marker([lat, lng])
                .bindPopup(`
                    <div class="text-slate-900 font-sans">
                        <b class="text-indigo-600">${gig.Band}</b><br>
                        <span class="font-bold">${gig.OfficialVenue}</span><br>
                        <span class="text-slate-500 text-xs">${gig.Date}</span>
                    </div>
                `)
                .addTo(window.leafletMap);
            markers.push(m);
        }
    });

    // Optional: Auto-adjust map bounds to show all markers
    if (markers.length > 0) {
        const group = new L.featureGroup(markers);
        window.leafletMap.fitBounds(group.getBounds().pad(0.1));
    }
}