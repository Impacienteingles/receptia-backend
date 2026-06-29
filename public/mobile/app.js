// Receptia Mobile - Lógica de Negocio y UI (v1.0.0)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.log('SW registration failed:', err));
  });
}

const API_BASE_URL = 'https://receptia.corandar.com';

let currentTenantId = sessionStorage.getItem('receptia_tenant_id') || localStorage.getItem('receptia_tenant_id');
let savedPin = sessionStorage.getItem('receptia_pin') || localStorage.getItem('receptia_pin');
let currentTenantEmail = sessionStorage.getItem('receptia_email') || localStorage.getItem('receptia_email');

let currentTenant = null;
let allAppointments = [];
let tenantRates = {}; // Mapeo de { especialidad: precio }
let selectedDate = new Date(); // Para el Calendario
let activeTab = 'dashboard';
let revenueChart = null;

// ================= ALGORITMO DE INICIALIZACIÓN =================

document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  
  // Asignar listeners
  document.getElementById('btn-login').addEventListener('click', handleLogin);
  document.getElementById('btn-logout').addEventListener('click', handleLogout);
  document.getElementById('cal-btn-prev').addEventListener('click', () => changeMonth(-1));
  document.getElementById('cal-btn-next').addEventListener('click', () => changeMonth(1));
  document.getElementById('btn-save-rate').addEventListener('click', saveRateFromUI);
  document.getElementById('app-search-input').addEventListener('input', renderAppointmentsTab);
  
  // Permitir login al pulsar Enter en el PIN
  document.getElementById('login-pin').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleLogin();
  });

  // Comprobar sesión
  checkSession();
});

function checkSession() {
  const loginScreen = document.getElementById('login-screen');
  const iosGuide = document.getElementById('ios-pwa-guide');

  // Detectar si es un iPhone/iPad
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  // Detectar si NO está corriendo como app de pantalla de inicio independiente (standalone)
  const isStandalone = ('standalone' in navigator && navigator.standalone) || window.matchMedia('(display-mode: standalone)').matches;

  if (isIOS && !isStandalone) {
    // Si es un dispositivo iOS y está cargado en el navegador Safari, forzamos mostrar la guía visual de instalación
    iosGuide.classList.remove('hidden');
    loginScreen.classList.add('hidden');
    return;
  } else {
    iosGuide.classList.add('hidden');
  }

  if (currentTenantId && savedPin) {
    loginScreen.classList.add('hidden');
    loadTenantData();
  } else {
    // Autocompletar si hay datos recordados en localStorage
    const rememberedEmail = localStorage.getItem('receptia_email');
    const rememberedPin = localStorage.getItem('receptia_pin');
    if (rememberedEmail) {
      document.getElementById('login-email').value = rememberedEmail;
    }
    if (rememberedPin) {
      document.getElementById('login-pin').value = rememberedPin;
    }
    loginScreen.classList.remove('hidden');
  }
}

// ================= CONTROL DE TABS (NAVEGACIÓN) =================

window.switchTab = function(tabId) {
  activeTab = tabId;
  
  // Ocultar todas las vistas
  document.getElementById('view-dashboard').classList.add('hidden');
  document.getElementById('view-calendar').classList.add('hidden');
  document.getElementById('view-appointments').classList.add('hidden');
  document.getElementById('view-settings').classList.add('hidden');
  
  // Mostrar vista activa
  document.getElementById(`view-${tabId}`).classList.remove('hidden');
  
  // Actualizar estilos del menú inferior
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.remove('text-brand-400');
    btn.classList.add('text-gray-400');
  });
  document.getElementById(`tab-${tabId}`).classList.remove('text-gray-400');
  document.getElementById(`tab-${tabId}`).classList.add('text-brand-400');
  
  // Recargar datos específicos de la pestaña
  if (tabId === 'dashboard') {
    renderDashboard();
  } else if (tabId === 'calendar') {
    renderCalendar();
  } else if (tabId === 'appointments') {
    renderAppointmentsTab();
  } else if (tabId === 'settings') {
    renderSettingsTab();
  }
  
  lucide.createIcons();
}

// ================= GESTIÓN DE ACCESO (LOGIN / LOGOUT) =================

async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pin = document.getElementById('login-pin').value.trim();
  const btn = document.getElementById('btn-login');
  const rememberCheckbox = document.getElementById('login-remember');

  if (!email || !pin) {
    alert('Por favor, introduce tu email y PIN de acceso.');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = `<span class="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span> <span>Accediendo...</span>`;

  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, pin })
    });

    const data = await res.json();
    if (res.ok && data.success && data.tenant_id) {
      currentTenantId = data.tenant_id;
      savedPin = pin;
      currentTenantEmail = email;
      
      if (rememberCheckbox && rememberCheckbox.checked) {
        localStorage.setItem('receptia_tenant_id', currentTenantId);
        localStorage.setItem('receptia_pin', savedPin);
        localStorage.setItem('receptia_email', currentTenantEmail);
        
        sessionStorage.removeItem('receptia_tenant_id');
        sessionStorage.removeItem('receptia_pin');
        sessionStorage.removeItem('receptia_email');
      } else {
        sessionStorage.setItem('receptia_tenant_id', currentTenantId);
        sessionStorage.setItem('receptia_pin', savedPin);
        sessionStorage.setItem('receptia_email', currentTenantEmail);
        
        localStorage.removeItem('receptia_tenant_id');
        localStorage.removeItem('receptia_pin');
        localStorage.removeItem('receptia_email');
      }
      
      document.getElementById('login-screen').classList.add('hidden');
      loadTenantData();
    } else {
      alert(data.error || 'Credenciales de acceso incorrectas.');
    }
  } catch (err) {
    console.error(err);
    alert('Error al conectar con el servidor.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<span>Acceder al Panel</span> <i data-lucide="arrow-right" class="w-4 h-4"></i>`;
    lucide.createIcons();
  }
}

function handleLogout() {
  if (confirm('¿Estás seguro de que deseas cerrar sesión en la aplicación?')) {
    localStorage.removeItem('receptia_tenant_id');
    localStorage.removeItem('receptia_pin');
    localStorage.removeItem('receptia_email');
    
    sessionStorage.removeItem('receptia_tenant_id');
    sessionStorage.removeItem('receptia_pin');
    sessionStorage.removeItem('receptia_email');
    
    currentTenantId = null;
    savedPin = null;
    currentTenantEmail = null;
    currentTenant = null;
    allAppointments = [];
    tenantRates = {};
    
    document.getElementById('login-email').value = '';
    document.getElementById('login-pin').value = '';
    document.getElementById('login-screen').classList.remove('hidden');
  }
}

// ================= CARGA DE DATOS DESDE EL BACKEND =================

async function loadTenantData() {
  try {
    // Cargar datos del inquilino
    const tenantRes = await fetch(`${API_BASE_URL}/api/tenants?id=${currentTenantId}&pin=${encodeURIComponent(savedPin)}`);
    if (!tenantRes.ok) throw new Error('No se pudo obtener la configuración del inquilino.');
    
    currentTenant = await tenantRes.json();
    
    document.getElementById('header-business-name').textContent = currentTenant.business_name || 'Mi Negocio';
    
    // Parsear tarifas guardadas
    try {
      tenantRates = currentTenant.pricing_details ? JSON.parse(JSON.stringify(currentTenant.pricing_details)) : {};
    } catch (e) {
      tenantRates = {};
    }

    // Obtener Citas
    await refreshAppointments();
    
    // Mostrar dashboard por defecto
    switchTab('dashboard');
  } catch (err) {
    console.error(err);
    alert(err.message || 'Error al conectar con el servidor.');
    handleLogout();
  }
}

async function refreshAppointments() {
  const appointmentsRes = await fetch(`${API_BASE_URL}/api/appointments?tenant_id=${currentTenantId}&pin=${encodeURIComponent(savedPin)}`);
  if (!appointmentsRes.ok) throw new Error('No se pudieron obtener las citas.');
  allAppointments = await appointmentsRes.json();
}

// Lógica de recuperación de PIN
window.openRecoverModal = function(e) {
  if (e) e.preventDefault();
  document.getElementById('recover-modal').classList.remove('hidden');
};

window.closeRecoverModal = function() {
  document.getElementById('recover-modal').classList.add('hidden');
};

// ================= ALGORITMO INTELIGENTE DE TARIFAS =================

function initializeRates() {
  const storedRates = localStorage.getItem(`receptia_rates_${currentTenantId}`);
  if (storedRates) {
    tenantRates = JSON.parse(storedRates);
  } else {
    // Parseo automático del pricing_details
    tenantRates = parsePricingDetails(currentTenant.pricing_details, currentTenant.specialties || []);
    localStorage.setItem(`receptia_rates_${currentTenantId}`, JSON.stringify(tenantRates));
  }
}

function parsePricingDetails(pricingText, specialties) {
  const rates = {};
  if (!pricingText || !specialties) return rates;
  
  specialties.forEach(spec => {
    // Buscar la especialidad y un número seguido de euros o €
    const escapedSpec = spec.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`${escapedSpec}[^0-9]*?([0-9]+)\\s*(?:euros|euro|€)`, 'i');
    const match = pricingText.match(regex);
    if (match) {
      rates[spec] = parseFloat(match[1]);
    }
  });
  return rates;
}

// ================= RENDERIZADO: DASHBOARD =================

function renderDashboard() {
  // Calcular métricas
  let totalRevenue = 0;
  let confirmedCount = 0;
  let variableCount = 0;
  let todayCount = 0;
  let todayRevenue = 0;
  
  const todayStr = new Date().toDateString();

  allAppointments.forEach(app => {
    const appDate = new Date(app.date_time);
    const isToday = appDate.toDateString() === todayStr;
    const price = tenantRates[app.specialty];

    if (app.status !== 'pending_deposit') {
      confirmedCount++;
      if (price !== undefined && price !== null) {
        totalRevenue += price;
        if (isToday) todayRevenue += price;
      } else {
        variableCount++;
      }
      if (isToday) todayCount++;
    }
  });

  document.getElementById('dash-total-revenue').textContent = `${totalRevenue.toFixed(2)}€`;
  document.getElementById('dash-confirmed-count').textContent = `${confirmedCount} citas confirmadas`;
  document.getElementById('dash-variable-count').textContent = `${variableCount} citas`;
  document.getElementById('dash-today-count').textContent = todayCount;
  document.getElementById('dash-today-revenue').textContent = `${todayRevenue.toFixed(2)}€`;

  // Renderizar gráfico de tendencia
  renderTrendsChart();
}

function renderTrendsChart() {
  const ctx = document.getElementById('revenueChart').getContext('2d');
  
  // Calcular ingresos para los próximos 7 días
  const labels = [];
  const data = [];
  
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    labels.push(d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric' }));
    
    const dStr = d.toDateString();
    let dailyRevenue = 0;
    
    allAppointments.forEach(app => {
      if (new Date(app.date_time).toDateString() === dStr && app.status !== 'pending_deposit') {
        const price = tenantRates[app.specialty];
        if (price) dailyRevenue += price;
      }
    });
    
    data.push(dailyRevenue);
  }

  if (revenueChart) revenueChart.destroy();

  revenueChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Ingresos previstos',
        data: data,
        borderColor: '#a78bfa',
        backgroundColor: 'rgba(139, 92, 246, 0.1)',
        fill: true,
        tension: 0.4,
        borderWidth: 2,
        pointBackgroundColor: '#8b5cf6',
        pointRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#9ca3af', font: { size: 9 } } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#9ca3af', font: { size: 9 } } }
      }
    }
  });
}

// ================= RENDERIZADO: CALENDARIO =================

function renderCalendar() {
  const calMonthLabel = document.getElementById('cal-month-label');
  const calDaysGrid = document.getElementById('cal-days-grid');
  
  calMonthLabel.textContent = selectedDate.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  calDaysGrid.innerHTML = '';

  const year = selectedDate.getFullYear();
  const month = selectedDate.getMonth();

  // Primer día del mes
  const firstDayIndex = new Date(year, month, 1).getDay();
  // El getDay() de JS pone Domingo = 0. Lo adaptamos a Lunes = 0
  const adjustedFirstDay = firstDayIndex === 0 ? 6 : firstDayIndex - 1;

  // Último día del mes anterior
  const prevLastDay = new Date(year, month, 0).getDate();
  // Último día del mes actual
  const lastDay = new Date(year, month + 1, 0).getDate();

  // Días del mes anterior (relleno)
  for (let i = adjustedFirstDay; i > 0; i--) {
    const dayDiv = document.createElement('div');
    dayDiv.className = 'py-2.5 text-center text-gray-700 text-xs';
    dayDiv.textContent = prevLastDay - i + 1;
    calDaysGrid.appendChild(dayDiv);
  }

  // Días del mes actual
  for (let i = 1; i <= lastDay; i++) {
    const dayDiv = document.createElement('div');
    dayDiv.className = 'py-2.5 text-center text-xs font-semibold rounded-lg cursor-pointer transition-all flex flex-col items-center justify-center relative';
    dayDiv.textContent = i;

    const dateStr = new Date(year, month, i).toDateString();
    
    // Comprobar si hay citas este día
    const dayApps = allAppointments.filter(app => new Date(app.date_time).toDateString() === dateStr);
    
    if (dayApps.length > 0) {
      // Punto indicador
      const dot = document.createElement('span');
      dot.className = 'w-1 h-1 bg-brand-400 rounded-full absolute bottom-1';
      dayDiv.appendChild(dot);
    }

    // Estilo día seleccionado
    const todayStr = new Date().toDateString();
    if (dateStr === todayStr) {
      dayDiv.classList.add('bg-brand-900/40', 'border', 'border-brand-500/30', 'text-white');
    } else {
      dayDiv.classList.add('bg-white/[0.02]', 'hover:bg-white/5', 'text-gray-300');
    }

    dayDiv.addEventListener('click', () => selectCalendarDay(i, month, year, dayApps));
    calDaysGrid.appendChild(dayDiv);
  }

  // Mostrar citas del día actual por defecto si es la primera carga
  const todayApps = allAppointments.filter(app => new Date(app.date_time).toDateString() === new Date().toDateString());
  selectCalendarDay(new Date().getDate(), month, year, todayApps);
}

function selectCalendarDay(day, month, year, appointments) {
  const label = document.getElementById('cal-selected-day-label');
  const container = document.getElementById('cal-selected-day-list');
  
  const d = new Date(year, month, day);
  label.textContent = `Citas para el ${d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}`;
  container.innerHTML = '';

  if (appointments.length === 0) {
    container.innerHTML = `<div class="text-center py-6 text-gray-500 text-xs bg-white/[0.02] border border-dashed border-white/5 rounded-xl">No hay citas programadas para este día.</div>`;
    return;
  }

  appointments.forEach(app => {
    const time = new Date(app.date_time).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const price = tenantRates[app.specialty];
    const priceStr = price !== undefined && price !== null ? `${price.toFixed(2)}€` : 'Importe variable';
    const statusText = app.status === 'pending_deposit' ? 'Pendiente' : 'Confirmada';
    const statusClass = app.status === 'pending_deposit' ? 'text-amber-400' : 'text-emerald-400';

    const item = document.createElement('div');
    item.className = 'bg-surface-100 p-4 border border-white/5 rounded-xl flex items-center justify-between gap-3';
    item.innerHTML = `
      <div class="space-y-0.5">
        <div class="flex items-center gap-1.5">
          <span class="text-xs font-bold text-white">${app.patient_name}</span>
          <span class="text-[9px] font-semibold px-2 py-0.5 rounded bg-brand-900/40 text-brand-400 uppercase">${app.specialty}</span>
        </div>
        <p class="text-[10px] text-gray-400 flex items-center gap-1">
          <i data-lucide="clock" class="w-3.5 h-3.5"></i>
          <span>${time} · ${app.patient_phone}</span>
        </p>
      </div>
      <div class="text-right space-y-0.5 flex-shrink-0">
        <p class="text-xs font-bold text-white font-outfit">${priceStr}</p>
        <p class="text-[9px] font-semibold ${statusClass}">${statusText}</p>
      </div>
    `;
    container.appendChild(item);
  });
  
  lucide.createIcons();
}

function changeMonth(dir) {
  selectedDate.setMonth(selectedDate.getMonth() + dir);
  renderCalendar();
}

// ================= RENDERIZADO: CITAS (SEARCH & FILTER) =================

function renderAppointmentsTab() {
  const query = document.getElementById('app-search-input').value.toLowerCase();
  const container = document.getElementById('app-list-container');
  container.innerHTML = '';

  const filtered = allAppointments.filter(app => {
    return app.patient_name.toLowerCase().includes(query) ||
           app.specialty.toLowerCase().includes(query) ||
           app.patient_phone.includes(query);
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="text-center py-12 text-gray-500 text-xs">No se encontraron citas.</div>`;
    return;
  }

  // Ordenar por fecha decreciente
  filtered.sort((a, b) => new Date(b.date_time) - new Date(a.date_time));

  filtered.forEach(app => {
    const d = new Date(app.date_time);
    const dateStr = d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const price = tenantRates[app.specialty];
    const priceStr = price !== undefined && price !== null ? `${price.toFixed(2)}€` : 'Importe variable';
    const statusText = app.status === 'pending_deposit' ? 'Pendiente' : 'Confirmada';
    const statusClass = app.status === 'pending_deposit' ? 'text-amber-400' : 'text-emerald-400';

    const card = document.createElement('div');
    card.className = 'bg-surface-100 p-4 border border-white/5 rounded-2xl flex items-center justify-between gap-3';
    card.innerHTML = `
      <div class="space-y-1">
        <div class="flex items-center gap-2">
          <p class="text-xs font-bold text-white">${app.patient_name}</p>
          <span class="text-[9px] font-semibold px-2 py-0.5 rounded bg-brand-900/40 text-brand-400 uppercase">${app.specialty}</span>
        </div>
        <p class="text-[10px] text-gray-400 flex items-center gap-1">
          <i data-lucide="calendar" class="w-3.5 h-3.5"></i>
          <span>${dateStr} · ${app.patient_phone}</span>
        </p>
      </div>
      <div class="text-right space-y-0.5 flex-shrink-0">
        <p class="text-xs font-bold text-white font-outfit">${priceStr}</p>
        <p class="text-[9px] font-semibold ${statusClass}">${statusText}</p>
      </div>
    `;
    container.appendChild(card);
  });

  lucide.createIcons();
}

// ================= RENDERIZADO: TARIFAS (CONFIGURACIÓN) =================

function renderSettingsTab() {
  const select = document.getElementById('rate-service-select');
  const container = document.getElementById('rates-list-container');
  
  select.innerHTML = '<option value="">Selecciona especialidad...</option>';
  container.innerHTML = '';

  // Poblar select de especialidades
  if (currentTenant && currentTenant.specialties) {
    currentTenant.specialties.forEach(spec => {
      const opt = document.createElement('option');
      opt.value = spec;
      opt.textContent = spec;
      select.appendChild(opt);
    });
  }

  // Renderizar listado de tarifas
  const ratesKeys = Object.keys(tenantRates);
  if (ratesKeys.length === 0) {
    container.innerHTML = `<div class="text-center py-6 text-gray-500 text-xs">No has configurado ninguna tarifa. Configura los precios para ver tus ingresos.</div>`;
    return;
  }

  ratesKeys.forEach(spec => {
    const price = tenantRates[spec];
    const card = document.createElement('div');
    card.className = 'bg-surface-100 px-4 py-3 border border-white/5 rounded-xl flex items-center justify-between gap-3 text-xs';
    card.innerHTML = `
      <span class="font-semibold text-white">${spec}</span>
      <div class="flex items-center gap-3">
        <span class="font-bold text-brand-400 font-outfit">${price.toFixed(2)}€</span>
        <button onclick="deleteRate('${spec}')" class="text-gray-500 hover:text-red-400 p-1">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </div>
    `;
    container.appendChild(card);
  });

  lucide.createIcons();
}

function saveRateFromUI() {
  const spec = document.getElementById('rate-service-select').value;
  const priceInput = document.getElementById('rate-price-input').value.trim();

  if (!spec || !priceInput) {
    alert('Por favor, selecciona una especialidad e introduce un precio.');
    return;
  }

  const price = parseFloat(priceInput);
  if (isNaN(price) || price < 0) {
    alert('El precio debe ser un número positivo.');
    return;
  }

  tenantRates[spec] = price;
  localStorage.setItem(`receptia_rates_${currentTenantId}`, JSON.stringify(tenantRates));
  
  // Limpiar inputs
  document.getElementById('rate-service-select').value = '';
  document.getElementById('rate-price-input').value = '';

  renderSettingsTab();
  alert('Tarifa guardada con éxito.');
}

window.deleteRate = function(spec) {
  if (confirm(`¿Estás seguro de que deseas eliminar la tarifa asignada a "${spec}"?`)) {
    delete tenantRates[spec];
    localStorage.setItem(`receptia_rates_${currentTenantId}`, JSON.stringify(tenantRates));
    renderSettingsTab();
  }
}
