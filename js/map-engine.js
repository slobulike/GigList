let markers = [];

function initMap() {
    // If map already exists, don't re-init
    if (window.leafletMap) return;

    window.leafletMap = L.map('map', {
        zoomControl: false
    }).setView([51.505, -0.09], 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(window.leafletMap);
}

function updateMap(data, venueData) {
    // Safety check: if map isn't ready, wait
    if (!window.leafletMap) return;

    // Clear old markers
    markers.forEach(m => window.leafletMap.removeLayer(m));
    markers = [];
    
    const venueVisits = {};
    data.forEach(row => {
        const vName = row.OfficialVenue;
        if(vName) venueVisits[vName] = (venueVisits[vName] || 0) + 1;
    });

    Object.entries(venueVisits).forEach(([name, count]) => {
        const vMeta = venueData.find(v => v.OfficialName === name);
        if (vMeta && vMeta.Latitude && vMeta.Longitude) {
            const radius = 6 + (Math.sqrt(count) * 4);
            const circle = L.circleMarker([vMeta.Latitude, vMeta.Longitude], {
                radius: radius,
                fillColor: "#4f46e5",
                color: "#fff",
                weight: 2,
                fillOpacity: 0.7
            }).addTo(window.leafletMap).bindPopup(`<b>${name}</b><br>Total Visits: ${count}`);
            
            markers.push(circle);
        }
    });
}