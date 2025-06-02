// main.js

(function() {
  // -------------------------------------------------------------------------------------------------
  // ตัวแปรหลัก (ประกาศ global เพื่อให้ filterMarkers() เข้าถึงได้)
  // -------------------------------------------------------------------------------------------------
  let districtsLayer, heatLayer;
  const primarySchoolMarkers   = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 80, spiderfyOnMaxZoom: true });
  const secondarySchoolMarkers = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 80, spiderfyOnMaxZoom: true });
  let allSchoolData       = [];  // ข้อมูลจาก schools_proximity.json (จะผนวก url จาก bec_school_data.json)
  let schoolTypeMap       = {};  // เก็บประเภท (primary/secondary) จาก schools.json
  let schoolCountChart    = null;// เก็บ Chart.js instance
  let uniqueDistrictNames = [];  // ชื่อเขตไม่ซ้ำ (เรียงภาษาไทย)
  let currentTileLayer    = null;
  let transitData         = null; // เก็บ transit_stations.json ไว้ใช้คำนวณ nearbyStations

  // สร้างแผนที่ Leaflet และตั้งค่าเริ่มต้น
  const map = L.map('map', { zoomControl: false }).setView([13.7563, 100.5018], 11);

  // Tile Layer (Light / Dark Mode) เริ่มต้น
  function addTileLayer(theme) {
    if (currentTileLayer) {
      map.removeLayer(currentTileLayer);
    }
    if (theme === 'dark') {
      currentTileLayer = L.tileLayer(
        'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
        {
          attribution: '© Stadia Maps © OpenStreetMap contributors',
          maxZoom: 20,
          minZoom: 9
        }
      ).addTo(map);
    } else {
      currentTileLayer = L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        {
          attribution: '© OpenStreetMap contributors',
          maxZoom: 18,
          minZoom: 9
        }
      ).addTo(map);
    }
  }
  // อ่านค่า theme ที่เคยบันทึกใน localStorage
  addTileLayer(localStorage.getItem('theme') === 'dark' ? 'dark' : 'light');

  // ย้ายปุ่ม Zoom ไปมุมล่างซ้าย
  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  // เก็บ reference ของ DOM elements
  const searchInput       = document.getElementById('search-input');
  const autocompleteList  = document.getElementById('autocomplete-list');
  const districtFilter    = document.getElementById('district-filter');
  const totalSchoolsSpan  = document.getElementById('total-schools');
  const primarySchoolsSpan   = document.getElementById('primary-schools');
  const secondarySchoolsSpan = document.getElementById('secondary-schools');
  const loadingMessage    = document.getElementById('loading-message');
  const mapElement        = document.getElementById('map');
  const themeToggle       = document.getElementById('theme-toggle');
  const themeIcon         = document.getElementById('theme-icon');
  const realTimeClock     = document.getElementById('real-time-clock');

  // -------------------------------------------------------------------------------------------------
  // ฟังก์ชันช่วยเหลือทั่วไป
  // -------------------------------------------------------------------------------------------------
  function showLoading() {
    loadingMessage.classList.add('show');
    mapElement.classList.add('loading');
  }
  function hideLoading() {
    loadingMessage.classList.remove('show');
    mapElement.classList.remove('loading');
  }

  // ทำ normalize (ตัดช่องว่าง, เปลี่ยนเป็น lower case) เพื่อง่ายต่อการค้นหา/เปรียบเทียบ
  function normalizeString(str) {
    return str ? str.trim().toLowerCase().replace(/\s+/g, '') : '';
  }

  // อัปเดตสถิติจำนวนโรงเรียน (แสดงที่กล่องสถิติ)
  function updateStatistics(filteredSchools) {
    const total = filteredSchools.length;
    let primary = 0, secondary = 0;
    filteredSchools.forEach(school => {
      const type = schoolTypeMap[school.school_id];
      if (type === 'primary') primary++;
      else if (type === 'secondary') secondary++;
    });
    totalSchoolsSpan.textContent     = total.toLocaleString();
    primarySchoolsSpan.textContent   = primary.toLocaleString();
    secondarySchoolsSpan.textContent = secondary.toLocaleString();
  }

  // กำหนดสีให้แต่ละเขต (เฉดสีส้ม-แดงวนไปตาม index)
  function getDistrictColor(index) {
    const colors = ['#FFE0B2','#FFC107','#FF9800','#F57C00','#E65100','#BF360C'];
    return colors[index % colors.length];
  }

  // Style ของโพลิกอนเขตแต่ละ feature
  function styleDistrict(feature) {
    const idx = uniqueDistrictNames.findIndex(d =>
      normalizeString(d) === normalizeString(feature.properties.NAME_TH)
    );
    return {
      fillColor: getDistrictColor(idx),
      weight:    1.8,
      color:     getComputedStyle(document.documentElement).getPropertyValue('--district-stroke').trim(),
      fillOpacity: 0.45
    };
  }

  // เมื่อ mouseover บนโพลิกอน (highlight + tooltip)
  function highlightDistrictLayer(e) {
    const layer = e.target;
    layer.setStyle({
      weight: 3,
      fillOpacity: 0.7,
      color: getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim()
    });
    layer.bindTooltip(layer.feature.properties.NAME_TH, {
      permanent: false,
      direction: 'center',
      className: 'district-label'
    }).openTooltip();
  }

  // เมื่อ mouseout จากโพลิกอน (reset style)
  function resetHighlightDistrictLayer(e) {
    districtsLayer.resetStyle(e.target);
    e.target.closeTooltip();
  }

  // เมื่อคลิกโพลิกอนเขต (zoom to that district)
  function zoomToDistrictLayer(e) {
    map.fitBounds(e.target.getBounds(), { padding: [50,50] });
  }

  // ผูกเหตุการณ์แต่ละโพลิกอนเขต
  function onEachDistrictFeature(feature, layer) {
    layer.on({
      mouseover: highlightDistrictLayer,
      mouseout:  resetHighlightDistrictLayer,
      click:     zoomToDistrictLayer
    });
  }

  // -------------------------------------------------------------------------------------------------
  // สร้างเนื้อหา popup ของโรงเรียน (สำหรับ marker)
  // -------------------------------------------------------------------------------------------------
  function createSchoolPopup(school) {
    const typeText = schoolTypeMap[school.school_id] === 'primary'
      ? 'โรงเรียนประถมศึกษา'
      : 'โรงเรียนมัธยมศึกษา';

    // เตรียม HTML ของลิงก์เว็บไซต์
    let websiteHtml = 'ไม่มีข้อมูลเว็บไซต์';
    if (school.url && school.url.trim() !== '') {
      let rawUrl = school.url.trim();
      if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
        rawUrl = `http://${rawUrl}`;
      }
      websiteHtml = `
        <a href="${rawUrl}" target="_blank" rel="noopener noreferrer"
           style="font-size:0.95em; display:inline-block; margin-top:4px;">
          🖥️ เว็บไซต์โรงเรียน
        </a>`;
    }

    // ตรวจสอบว่ามีสถานีใกล้เคียงหรือไม่ (ภายใน 1 กม.)
    let nearbyHtml = '';
    if (school.nearbyStations && school.nearbyStations.length > 0) {
      nearbyHtml = `
        <div style="margin-top: 6px; font-size: 0.95em; color: var(--popup-sub-text-color);">
          🚆 สถานีใกล้เคียง (≤ 1 กม.):<br/>
          ${school.nearbyStations.map(s => `- ${s.name}`).join('<br/>')}
        </div>`;
    }

    return `
      <div style="font-family: 'Kanit', sans-serif; max-width:280px;">
        <strong style="font-size: 1.15em; color: var(--popup-text-color);">
          ${school.name}
        </strong><br/>
        <span style="font-size: 1em; color: var(--popup-sub-text-color);">
          ${typeText}
        </span><br/>
        <span style="font-size: 0.95em; display: block; margin-top: 4px;">
          เขต: ${school.dname || 'ไม่ระบุ'}<br/>
          จำนวนนักเรียน: ${school.num_stu?.toLocaleString() || '-'} คน
        </span>
        ${websiteHtml}
        ${nearbyHtml}
        <div style="margin-top: 8px; border-top: 1px solid var(--box-border-color); padding-top: 8px;">
          <button class="gemini-button"
                  data-school-name="${school.name}"
                  data-school-type="${typeText}"
                  data-district-name="${school.dname || '-'}">
            ✨ สร้างคำอธิบายโรงเรียน ✨
            <span class="gemini-loading-spinner"></span>
          </button>
          <div id="school-description-output" class="empty"></div>
        </div>
      </div>`;
  }

  // -------------------------------------------------------------------------------------------------
  // ฟังก์ชันดาวน์โหลดข้อมูล และเตรียมเลเยอร์ทั้งหมด
  // -------------------------------------------------------------------------------------------------
  async function loadMapData() {
    showLoading();

    try {
      // ดึงข้อมูลพร้อมกัน: schools_proximity.json, schools.json, bec_school_data.json,
      // transit_stations.json, bkk_districts.json.geojson
      const [schoolsProxResp, schoolsResp, becResp, transitResp, districtsResp] = await Promise.all([
        fetch('./schools_proximity.json'),
        fetch('./schools.json'),
        fetch('./bec_school_data.json'),
        fetch('./transit_stations.json'),
        fetch('./bkk_districts.json.geojson')
      ]);
      if (!schoolsProxResp.ok)  throw new Error('ไม่พบไฟล์ schools_proximity.json');
      if (!schoolsResp.ok)      throw new Error('ไม่พบไฟล์ schools.json');
      if (!becResp.ok)          throw new Error('ไม่พบไฟล์ bec_school_data.json');
      if (!transitResp.ok)      throw new Error('ไม่พบไฟล์ transit_stations.json');
      if (!districtsResp.ok)    throw new Error('ไม่พบไฟล์ bkk_districts.json.geojson');

      // อ่านข้อมูลออกมา
      allSchoolData        = await schoolsProxResp.json();
      console.log('>>> Debug: โหลดข้อมูลโรงเรียนสำเร็จ จำนวน =', allSchoolData.length, allSchoolData.slice(0,3));
      const schoolsInfo    = await schoolsResp.json();
      const becData        = await becResp.json();
      transitData          = await transitResp.json();
      const districtsGeoJSON = await districtsResp.json();

      // สร้าง Map จาก id_sch → url (เพื่อผสานกับ allSchoolData)
      const urlMap = {};
      becData.forEach(item => { urlMap[item.id_sch] = item.url || ''; });

      // ผนวก URL ลงใน allSchoolData (ใช้ school_id แม็ปกับ id_sch)
      allSchoolData.forEach(s => { s.url = urlMap[s.school_id] || ''; });

      // สร้าง map จาก school_id → ประเภทโรงเรียน (primary/secondary) ตาม schoolsInfo
      schoolsInfo.forEach(s => {
        const normalized = s.district_name || '';
        if (normalized.includes('ประถมศึกษา')) {
          schoolTypeMap[s.school_id] = 'primary';
        } else if (normalized.includes('มัธยมศึกษา')) {
          schoolTypeMap[s.school_id] = 'secondary';
        } else {
          // กรณีไม่แน่ชัด กำหนดเป็น secondary เป็น default
          schoolTypeMap[s.school_id] = 'secondary';
        }
      });
      console.log('>>> Debug: School type map sample =', Object.entries(schoolTypeMap).slice(0,5));

      // เตรียม Heatmap Layer
      const heatPoints = allSchoolData
        .filter(s => s.lat != null && s.lng != null)
        .map(s => [s.lat, s.lng, 1]);
      heatLayer = L.heatLayer(heatPoints, {
        radius: 35,
        blur: 25,
        maxZoom: 17,
        gradient: { 0.0: '#ADD8E6', 0.5: '#FFA500', 1.0: '#FF0000' },
        minOpacity: 0.2
      });

      // เตรียมรายชื่อเขตไม่ซ้ำ (เรียงภาษาไทย)
      uniqueDistrictNames = Array.from(
        new Set(allSchoolData.map(s => s.dname).filter(n => n))
      ).sort((a, b) => a.localeCompare(b, 'th'));

      // สร้าง Districts Layer จาก GeoJSON
      districtsLayer = L.geoJson(districtsGeoJSON, {
        style: styleDistrict,
        onEachFeature: onEachDistrictFeature
      });

      // เก็บ GeoJSON ขอบเขต กทม. ทั้งหมด
      const bangkokBoundary = districtsGeoJSON;

      // เก็บข้อมูลนับจำนวนโรงเรียนแต่ละเขต (สำหรับอัปเดตกราฟ)
      const districtCounts = {};

      // Pre-calculate ระยะห่างจากสถานี: ใส่ข้อมูล nearbyStations ในทุกโรงเรียน
      const stationPoints = transitData.features
        .filter(f => {
          const { lat, lng } = f.properties;
          if (lat != null && lng != null) {
            const pt = turf.point([f.properties.lng, f.properties.lat]);
            return bangkokBoundary.features.some(poly => turf.booleanPointInPolygon(pt, poly));
          }
          return false;
        })
        .map(f => ({ lat: f.properties.lat, lng: f.properties.lng, name: f.properties.name }));

      allSchoolData.forEach(school => {
        school.nearbyStations = [];
        if (school.lat != null && school.lng != null) {
          stationPoints.forEach(st => {
            // คำนวณระยะห่าง (เมตร) โดยใช้ Haversine
            const R = 6371000; // รัศมีโลก (เมตร)
            const φ1 = school.lat * Math.PI / 180;
            const φ2 = st.lat * Math.PI / 180;
            const Δφ = (st.lat - school.lat) * Math.PI / 180;
            const Δλ = (st.lng - school.lng) * Math.PI / 180;
            const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                      Math.cos(φ1) * Math.cos(φ2) *
                      Math.sin(Δλ/2) * Math.sin(Δλ/2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            const d = R * c; // ระยะห่างเป็นเมตร

            if (d <= 1000) {
              school.nearbyStations.push({ name: st.name, distance: d });
            }
          });
        }
      });

      // --- (1) สร้างไอคอนและเลเยอร์สำหรับ BTS/MRT) ----
      const btsIcon = L.divIcon({
        html: '<div class="marker-base bts-station-marker-icon"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
        className: 'bts-station-marker-icon-wrapper'
      });
      const mrtIcon = L.divIcon({
        html: '<div class="marker-base mrt-station-marker-icon"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
        className: 'mrt-station-marker-icon-wrapper'
      });

      const btsLayer = L.layerGroup();
      const mrtLayer = L.layerGroup();

      // --- (2) วนลูปสร้าง marker สถานี BTS/MRT จาก transitData) ----
      transitData.features.forEach(f => {
        const props = f.properties;
        const lat = props.lat;
        const lng = props.lng;
        const name = props.name || 'ไม่ทราบชื่อสถานี';
        const btsLine = props.btsline;
        const mrtLine = props.mrtline;

        if (lat != null && lng != null) {
          // ตรวจสอบว่าอยู่ในขอบเขต กทม. หรือไม่
          const pt = turf.point([lng, lat]);
          const insideBangkok = bangkokBoundary.features.some(poly =>
            turf.booleanPointInPolygon(pt, poly)
          );
          if (!insideBangkok) {
            return; // อยู่นอกพื้นที่กทม. ให้ข้าม
          }

          let iconToUse = null;
          let popupHtml = `<strong>${name}</strong><br/>`;
          if (btsLine) {
            iconToUse = btsIcon;
            popupHtml += `<span style="font-size:0.9em; color:#666;">BTS: ${btsLine}</span>`;
          } else if (mrtLine) {
            iconToUse = mrtIcon;
            popupHtml += `<span style="font-size:0.9em; color:#666;">MRT: ${mrtLine}</span>`;
          } else {
            iconToUse = mrtIcon;
            popupHtml += `<span style="font-size:0.9em; color:#666;">(ข้อมูลสายไม่ระบุ)</span>`;
          }

          const stationMarker = L.marker([lat, lng], { icon: iconToUse });
          stationMarker.bindPopup(popupHtml);

          if (btsLine) {
            btsLayer.addLayer(stationMarker);
          } else if (mrtLine) {
            mrtLayer.addLayer(stationMarker);
          }
        }
      });

      // --- (3) สร้างไอคอนสำหรับโรงเรียนและสร้าง Marker โรงเรียนแต่ละแห่ง --- 
      const primaryIcon = L.divIcon({
        html: '<div class="marker-base primary-school-marker-icon"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
        className: 'primary-school-marker-icon-wrapper'
      });
      const secondaryIcon = L.divIcon({
        html: '<div class="marker-base secondary-school-marker-icon"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
        className: 'secondary-school-marker-icon-wrapper'
      });

      allSchoolData.forEach(school => {
        const { school_id, lat, lng, name, dname, num_stu } = school;
        console.log('>>> Debug: ประมวลผลโรงเรียน', name, 'lat=', lat, 'lng=', lng, 'type=', schoolTypeMap[school_id]);
        if (lat != null && lng != null) {
          const type = schoolTypeMap[school_id] || 'secondary';
          const iconToUse = (type === 'primary') ? primaryIcon : secondaryIcon;

          const marker = L.marker([lat, lng], { icon: iconToUse });
          marker.bindPopup(createSchoolPopup(school));

          marker.on('popupopen', function() {
            const geminiBtn = document.querySelector('.gemini-button');
            const descOutput = document.getElementById('school-description-output');
            if (geminiBtn && descOutput) {
              geminiBtn.onclick = async function(e) {
                e.preventDefault();
                const btn = this;
                const spinner = btn.querySelector('.gemini-loading-spinner');
                spinner.classList.add('show');
                btn.disabled = true;
                descOutput.classList.add('empty');
                descOutput.textContent = '';
                try {
                  await new Promise(res => setTimeout(res, 1500));
                  const simulatedText = `AI Gemini: โรงเรียน "${btn.dataset.schoolName}" (${btn.dataset.schoolType}) เขต ${btn.dataset.districtName} มีชื่อเสียงในด้าน...`;
                  descOutput.textContent = simulatedText;
                  descOutput.classList.remove('empty');
                } catch (err) {
                  descOutput.textContent = 'ไม่สามารถเชื่อมต่อ AI ได้ในขณะนี้';
                  descOutput.classList.remove('empty');
                } finally {
                  spinner.classList.remove('show');
                  btn.disabled = false;
                }
              };
            }
          });

          if (type === 'primary') {
            primarySchoolMarkers.addLayer(marker);
          } else {
            secondarySchoolMarkers.addLayer(marker);
          }

          if (dname) {
            districtCounts[dname] = (districtCounts[dname] || 0) + 1;
          }
        }
      });

      // แสดงจำนวน Marker ที่ถูกสร้างลงในแต่ละ cluster
      console.log('>>> Debug: จำนวน Marker โรงเรียนประถม =', primarySchoolMarkers.getLayers().length);
      console.log('>>> Debug: จำนวน Marker โรงเรียนมัธยม =', secondarySchoolMarkers.getLayers().length);

      // --- (4) สร้าง Layer Control ให้รวม BTS/MRT และ โรงเรียนด้วย ---
      const overlayMaps = {
        "ขอบเขตกรุงเทพมหานคร": districtsLayer,
        "Heatmap ความหนาแน่น": heatLayer,
        "โรงเรียนประถม": primarySchoolMarkers,
        "โรงเรียนมัธยม": secondarySchoolMarkers,
        "BTS สถานี": btsLayer,
        "MRT สถานี": mrtLayer
      };
      L.control.layers(null, overlayMaps, {
        collapsed: false,
        position: 'topright'
      }).addTo(map);

      // เปิดเลเยอร์ตั้งต้น
      districtsLayer.addTo(map);
      heatLayer.addTo(map);
      primarySchoolMarkers.addTo(map);
      secondarySchoolMarkers.addTo(map);
      // ถ้าต้องการให้ BTS/MRT ขึ้นตั้งต้น ให้เอา comment ออก:
      // btsLayer.addTo(map);
      // mrtLayer.addTo(map);

      // --- (5) ปรับ Legend ให้มี BTS/MRT ด้วย ---
      const legend = L.control({ position: 'bottomright' });
      legend.onAdd = function() {
        const div = L.DomUtil.create('div', 'info legend');
        div.innerHTML = `
          <h4>สัญลักษณ์</h4>
          <div>
            <i class="primary-school-legend marker-base" style="background: var(--primary-school-marker-color);"></i>
            โรงเรียนประถม
          </div>
          <div>
            <i class="secondary-school-legend marker-base" style="background: var(--secondary-school-marker-color);"></i>
            โรงเรียนมัธยม
          </div>
          <div>
            <i class="district-legend" style="background: var(--district-fill-color-example); border: 1px solid var(--district-stroke);"></i>
            ขอบเขตเขต
          </div>
          <div style="clear: both; margin-top: 6px;"></div>
          <div>
            <span class="heatmap-legend-box"></span>
            Heatmap ความหนาแน่น
          </div>
          <div style="clear: both; margin-top: 6px;"></div>
          <div>
            <i class="bts-station-legend marker-base" style="background-color: #009900;"></i>
            สถานี BTS
          </div>
          <div>
            <i class="mrt-station-legend marker-base" style="background-color: #0033cc;"></i>
            สถานี MRT
          </div>
        `;
        return div;
      };
      legend.addTo(map);

      // เติม dropdown “เลือกเขต” เพื่อกรอง marker เฉพาะเขตที่เลือก
      districtFilter.innerHTML = '<option value="">-- แสดงเขตทั้งหมด --</option>';
      uniqueDistrictNames.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        districtFilter.appendChild(opt);
      });

      // อัปเดตสถิติและกราฟเริ่มต้น
      updateStatistics(allSchoolData);
      updateSchoolCountChart(districtCounts);

    } catch (error) {
      console.error('เกิดข้อผิดพลาดในการโหลดข้อมูล:', error);
      alert('ไม่สามารถโหลดข้อมูลแผนที่ได้ โปรดลองใหม่อีกครั้ง');
    } finally {
      hideLoading();
    }
  }

  // -------------------------------------------------------------------------------------------------
  // ฟังก์ชันกรอง marker ตาม Search Text และ District Filter
  // -------------------------------------------------------------------------------------------------
  function filterMarkers(searchText, selectedDistrict) {
    primarySchoolMarkers.clearLayers();
    secondarySchoolMarkers.clearLayers();

    const normSearch   = normalizeString(searchText || '');
    const normDistrict = normalizeString(selectedDistrict || '');

    // –––––– กรองข้อมูลโรงเรียน ––––––
    const filteredSchools = allSchoolData.filter(school => {
      const nameMatch     = !searchText || normalizeString(school.name).includes(normSearch);
      const districtMatch = !selectedDistrict || normalizeString(school.dname).includes(normDistrict);
      return nameMatch && districtMatch;
    });

    // นับจำนวนโรงเรียนต่อเขต (สำหรับอัปเดตกราฟ)
    const districtCounts = {};
    filteredSchools.forEach(school => {
      const { school_id, lat, lng, dname } = school;
      if (lat != null && lng != null) {
        const type = schoolTypeMap[school.school_id] || 'secondary';
        const iconHTML = `<div class="marker-base ${
          (type === 'primary')
            ? 'primary-school-marker-icon'
            : 'secondary-school-marker-icon'
        }"></div>`;
        const marker = L.marker([lat, lng], {
          icon: L.divIcon({
            html: iconHTML,
            iconSize: [18,18],
            iconAnchor: [9,9]
          })
        });
        marker.bindPopup(createSchoolPopup(school));
        marker.on('popupopen', function() {
          const geminiBtn = document.querySelector('.gemini-button');
          const descOutput = document.getElementById('school-description-output');
          if (geminiBtn && descOutput) {
            geminiBtn.onclick = async function(e) {
              e.preventDefault();
              const btn = this;
              const spinner = btn.querySelector('.gemini-loading-spinner');
              spinner.classList.add('show');
              btn.disabled = true;
              descOutput.classList.add('empty');
              descOutput.textContent = '';
              try {
                await new Promise(res => setTimeout(res, 1500));
                const simulatedText = `AI Gemini: โรงเรียน "${btn.dataset.schoolName}" (${
                  btn.dataset.schoolType
                }) เขต ${btn.dataset.districtName} มีชื่อเสียงในด้าน...`;
                descOutput.textContent = simulatedText;
                descOutput.classList.remove('empty');
              } catch (err) {
                descOutput.textContent = 'ไม่สามารถเชื่อมต่อ AI ได้ในขณะนี้';
                descOutput.classList.remove('empty');
              } finally {
                spinner.classList.remove('show');
                btn.disabled = false;
              }
            };
          }
        });

        if (type === 'primary') {
          primarySchoolMarkers.addLayer(marker);
        } else {
          secondarySchoolMarkers.addLayer(marker);
        }

        if (dname) {
          districtCounts[dname] = (districtCounts[dname] || 0) + 1;
        }
      }
    });

    // อัปเดตสถิติ
    updateStatistics(filteredSchools);
    // อัปเดตกราฟ
    updateSchoolCountChart(districtCounts, selectedDistrict);
  }

  // -------------------------------------------------------------------------------------------------
  // Autocomplete (Search) Logic
  // -------------------------------------------------------------------------------------------------
  let currentActiveAutocompleteItem = -1;
  searchInput.addEventListener('input', function() {
    const val = this.value;
    closeAllLists();
    if (!val) {
      filterMarkers('', districtFilter.value);
      return false;
    }
    currentActiveAutocompleteItem = -1;
    const matches = allSchoolData.filter(school =>
      normalizeString(school.name).includes(normalizeString(val))
    ).slice(0, 10);

    if (matches.length === 0) {
      filterMarkers(val, districtFilter.value);
      return false;
    }

    autocompleteList.innerHTML = '';
    matches.forEach((school, idx) => {
      const div = document.createElement('div');
      div.innerHTML = `<strong>${school.name.substr(0, val.length)}</strong>${school.name.substr(val.length)}`;
      div.innerHTML += `<input type='hidden' value='${school.name}' data-lat='${school.lat}' data-lng='${school.lng}'>`;
      div.addEventListener('click', function() {
        const hidden = this.getElementsByTagName('input')[0];
        searchInput.value = hidden.value;
        filterMarkers(searchInput.value, districtFilter.value);
        closeAllLists();
        const lat = parseFloat(hidden.dataset.lat);
        const lng = parseFloat(hidden.dataset.lng);
        if (!isNaN(lat) && !isNaN(lng)) {
          map.setView([lat, lng], 15);
          // พยายามเปิด popup ของ marker ที่พิกัดนั้น (ใน cluster)
          primarySchoolMarkers.eachLayer(layer => {
            const ll = layer.getLatLng();
            if (ll.lat === lat && ll.lng === lng) layer.openPopup();
          });
          secondarySchoolMarkers.eachLayer(layer => {
            const ll = layer.getLatLng();
            if (ll.lat === lat && ll.lng === lng) layer.openPopup();
          });
        }
      });
      autocompleteList.appendChild(div);
    });
    autocompleteList.classList.add('show');
  });

  searchInput.addEventListener('keydown', function(e) {
    let x = autocompleteList.getElementsByTagName('div');
    if (!x) return;
    if (e.keyCode === 40) { // Arrow Down
      currentActiveAutocompleteItem++;
      addActive(x);
    } else if (e.keyCode === 38) { // Arrow Up
      currentActiveAutocompleteItem--;
      addActive(x);
    } else if (e.keyCode === 13) { // Enter
      e.preventDefault();
      if (currentActiveAutocompleteItem > -1 && x[currentActiveAutocompleteItem]) {
        x[currentActiveAutocompleteItem].click();
      } else {
        filterMarkers(searchInput.value, districtFilter.value);
        closeAllLists();
      }
    }
  });

  function addActive(x) {
    if (!x) return false;
    removeActive(x);
    if (currentActiveAutocompleteItem >= x.length) currentActiveAutocompleteItem = 0;
    if (currentActiveAutocompleteItem < 0) currentActiveAutocompleteItem = x.length - 1;
    x[currentActiveAutocompleteItem].classList.add('autocomplete-active');
    x[currentActiveAutocompleteItem].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function removeActive(x) {
    for (let i = 0; i < x.length; i++) {
      x[i].classList.remove('autocomplete-active');
    }
  }
  function closeAllLists(elmnt) {
    autocompleteList.classList.remove('show');
    autocompleteList.innerHTML = '';
  }
  document.addEventListener('click', function(e) {
    if (e.target !== searchInput && e.target.parentNode !== autocompleteList) {
      closeAllLists(e.target);
    }
  });

  // -------------------------------------------------------------------------------------------------
  // District Filter Dropdown Logic
  // -------------------------------------------------------------------------------------------------
  districtFilter.addEventListener('change', function() {
    const selected = this.value;
    filterMarkers(searchInput.value, selected);
    if (selected) {
      const targetFeature = districtsLayer.getLayers().find(l =>
        normalizeString(l.feature.properties.NAME_TH) === normalizeString(selected)
      );
      if (targetFeature) {
        map.fitBounds(targetFeature.getBounds(), { padding: [50, 50] });
      }
    } else {
      map.setView([13.7563, 100.5018], 11);
    }
  });

  // -------------------------------------------------------------------------------------------------
  // Real-time Clock
  // -------------------------------------------------------------------------------------------------
  function updateClock() {
    const now = new Date();
    const timeOpts = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    const dateOpts = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' };
    const timeString = now.toLocaleTimeString('th-TH', timeOpts);
    const dateString = now.toLocaleDateString('th-TH', dateOpts);
    realTimeClock.innerHTML = `${dateString}<br>${timeString} น.`;  
  }
  setInterval(updateClock, 1000);
  updateClock();

  // -------------------------------------------------------------------------------------------------
  // Theme Toggle (Light / Dark Mode)
  // -------------------------------------------------------------------------------------------------
  function applyTheme(theme) {
    document.body.classList.toggle('dark', theme === 'dark');
    themeIcon.className = theme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
    addTileLayer(theme);
    if (districtsLayer) districtsLayer.setStyle(styleDistrict);
  }

  themeToggle.addEventListener('click', () => {
    const current = document.body.classList.contains('dark') ? 'dark' : 'light';
    const nextTheme = (current === 'dark') ? 'light' : 'dark';
    localStorage.setItem('theme', nextTheme);
    applyTheme(nextTheme);
  });

  const savedTheme = localStorage.getItem('theme') || 'light';
  applyTheme(savedTheme);

  // -------------------------------------------------------------------------------------------------
  // Chart.js: สร้าง/อัปเดตกราฟจำนวนโรงเรียนต่อเขต
  // -------------------------------------------------------------------------------------------------
  function updateSchoolCountChart(dataObj, highlightDistrict = null) {
    const ctx = document.getElementById('school-count-chart').getContext('2d');

    // เตรียมข้อมูลจาก object เป็นลิสต์ แล้ว sort ตามจำนวน (จากมากไปน้อย)
    const entries = Object.entries(dataObj).map(([key, val]) => ({ key, val }));
    entries.sort((a, b) => b.val - a.val);
    const labels = entries.map(e => e.key);
    const counts = entries.map(e => e.val);

    // กำหนดสีพื้นและสีขอบแท่ง (แยกให้แท่งที่ไฮไลต์ต่างกัน)
    const bgColors = labels.map(lbl =>
      normalizeString(lbl) === normalizeString(highlightDistrict)
        ? getComputedStyle(document.documentElement).getPropertyValue('--chart-bar-border-color').trim()
        : getComputedStyle(document.documentElement).getPropertyValue('--chart-bar-bg-color').trim()
    );
    const bdColors = labels.map(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--chart-bar-border-color').trim()
    );

    if (schoolCountChart) {
      // ถ้าเคยสร้างไว้แล้ว ให้อัปเดตข้อมูลใหม่
      schoolCountChart.data.labels = labels;
      schoolCountChart.data.datasets[0].data = counts;
      schoolCountChart.data.datasets[0].backgroundColor = bgColors;
      schoolCountChart.data.datasets[0].borderColor = bdColors;
      schoolCountChart.update();
    } else {
      // สร้าง Chart ใหม่
      schoolCountChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            label: 'จำนวนโรงเรียน',
            data: counts,
            backgroundColor: bgColors,
            borderColor: bdColors,
            borderWidth: 1,
            borderRadius: 6,
            barThickness: 20,         // ปรับความหนาของแท่งบาร์
            categoryPercentage: 0.6,  // ช่วงระยะห่างระหว่างกลุ่มบาร์
            hoverBackgroundColor: bdColors,
            hoverBorderColor: bgColors
          }]
        },
        options: {
          layout: {
            padding: {
              top: 12,
              bottom: 12,
              left: 8,
              right: 8
            }
          },
          indexAxis: 'y',  // ให้เป็นกราฟแนวนอน
          scales: {
            x: {
              beginAtZero: true,
              grid: {
                color: getComputedStyle(document.documentElement).getPropertyValue('--chart-grid-color').trim(),
                drawBorder: false,
                borderDash: [3, 3]
              },
              ticks: {
                color: getComputedStyle(document.documentElement).getPropertyValue('--chart-text-color').trim(),
                font: {
                  family: 'Kanit',
                  size: 14,
                  weight: 'bold'
                }
              },
              title: {
                display: true,
                text: 'จำนวนโรงเรียน',
                color: getComputedStyle(document.documentElement).getPropertyValue('--chart-text-color').trim(),
                font: {
                  family: 'Kanit',
                  size: 16,
                  weight: '700'
                },
                padding: { top: 6 }
              }
            },
            y: {
              grid: {
                display: false
              },
              ticks: {
                color: getComputedStyle(document.documentElement).getPropertyValue('--chart-text-color').trim(),
                font: {
                  family: 'Kanit',
                  size: 14
                },
                padding: 8
              },
              title: {
                display: true,
                text: 'เขต',
                color: getComputedStyle(document.documentElement).getPropertyValue('--chart-text-color').trim(),
                font: {
                  family: 'Kanit',
                  size: 16,
                  weight: '700'
                },
                padding: { right: 12 }
              }
            }
          },
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--chart-tooltip-bg').trim(),
              titleColor: getComputedStyle(document.documentElement).getPropertyValue('--chart-tooltip-text').trim(),
              bodyColor: getComputedStyle(document.documentElement).getPropertyValue('--chart-tooltip-text').trim(),
              titleFont: { family: 'Kanit', size: 14, weight: 'bold' },
              bodyFont: { family: 'Kanit', size: 13 },
              padding: 12,
              cornerRadius: 8,
              displayColors: false
            }
          },
          animations: {
            tension: {
              duration: 500,
              easing: 'easeInOutQuart',
              from: 1,
              to: 0
            },
            radius: {
              duration: 500,
              easing: 'easeInOutQuart'
            }
          },
          responsive: true,
          maintainAspectRatio: false
        }
      });
    }
  }

  // -------------------------------------------------------------------------------------------------
  // เริ่มโหลดข้อมูลเมื่อเพจพร้อม
  // -------------------------------------------------------------------------------------------------
  loadMapData();
})();
