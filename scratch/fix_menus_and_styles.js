const fs = require('fs');
const path = require('path');

const publicDir = '/Users/juanpablo/Desktop/APPS/Receptia/public';

// 1. Estilo CSS para el menú móvil opaco
const mobileMenuStyle = `
  /* Menu hamburguesa móvil opaco premium */
  .mobile-menu {
    background-color: #0b0f19 !important; /* Fondo oscuro opaco */
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 15px 30px rgba(0, 0, 0, 0.6);
    padding: 1rem 0;
  }
`;

// 2. Script interactivo de scroll y menú móvil completo
const fullInteractiveScript = `  <script type="module">
    const isClon = window.location.hostname === 'corandar.com' || window.location.hostname === 'www.corandar.com' || window.location.pathname.includes('/receptia');
    const header = document.getElementById('site-header');
    const corandarTopBar = document.getElementById('corandar-top-bar');

    if (isClon && header) {
      header.classList.add('is-corandar-clon');
      if (corandarTopBar) corandarTopBar.classList.remove('hidden');
      
      // Ajustar enlaces de anclas de Receptia en la home clonada de forma explícita
      document.querySelectorAll('a[href^="#features"], a[href^="#sectors"], a[href^="#demo"], a[href^="#pricing"], a[href^="#faq"], a[href^="#contact"], a[href^="#download-app"]').forEach(el => {
        const anchor = el.getAttribute('href');
        if (anchor.startsWith('#')) {
          el.setAttribute('href', '/receptia/' + anchor);
        }
      });
      const logoLnk = document.getElementById('logo-receptia-link');
      if (logoLnk) logoLnk.setAttribute('href', '/receptia/');
    }

    var e=document.getElementById(\`site-header\`),t=()=>{window.scrollY>20?(e?.classList.add(\`glass\`,\`border-white/5\`),e?.classList.remove(\`border-transparent\`)):(e?.classList.remove(\`glass\`,\`border-white/5\`),e?.classList.add(\`border-transparent\`))};window.addEventListener(\`scroll\`,t,{passive:!0}),t();
    var n=document.getElementById(\`mobile-menu-toggle\`),r=document.getElementById(\`mobile-menu\`),i=document.getElementById(\`icon-menu\`),a=document.getElementById(\`icon-close\`);
    n?.addEventListener(\`click\`,()=>{let e=r?.classList.toggle(\`open\`);i?.classList.toggle(\`hidden\`,e),a?.classList.toggle(\`hidden\`,!e),n.setAttribute(\`aria-expanded\`,String(e))}),r?.querySelectorAll(\`a\`).forEach(e=>{e.addEventListener(\`click\`,()=>{r.classList.remove(\`open\`),i?.classList.remove(\`hidden\`),a?.classList.add(\`hidden\`),n?.setAttribute(\`aria-expanded\`,\`false\`)})});
  </script>`;

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  // A) Inyectar estilo del menú móvil antes del cierre </style>
  if (content.includes('</style>') && !content.includes('.mobile-menu {')) {
    content = content.replace('</style>', mobileMenuStyle + '</style>');
  }

  const relativePath = path.relative(publicDir, filePath);
  
  if (filePath.includes('/comparar/')) {
    // B) Inyectar botón de menú hamburguesa y contenedor del menú móvil si no existen
    if (!content.includes('id="mobile-menu-toggle"')) {
      const targetHeaderEnd = `        <div class="hidden lg:flex items-center gap-3">
          <a href="https://receptia.corandar.com/app.html" class="text-sm font-medium text-gray-300 hover:text-white px-4 py-2 transition-colors"> Iniciar sesión </a>
          <a href="/#contact" class="btn-primary text-sm py-2.5 px-5 hover:btn-primary-hover"> Probar gratis </a>
        </div>
      </div>
    </div>`;

      const replacementHeaderEnd = `        <div class="hidden lg:flex items-center gap-3">
          <a href="https://receptia.corandar.com/app.html" class="text-sm font-medium text-gray-300 hover:text-white px-4 py-2 transition-colors"> Iniciar sesión </a>
          <a href="/#contact" class="btn-primary text-sm py-2.5 px-5 hover:btn-primary-hover"> Probar gratis </a>
        </div>
        <!-- Mobile menu button -->
        <button id="mobile-menu-toggle" type="button" class="lg:hidden p-2 text-gray-300 hover:text-white rounded-lg hover:bg-white/5 transition-colors" aria-label="Abrir menú" aria-expanded="false" aria-controls="mobile-menu">
          <svg id="icon-menu" class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
          </svg>
          <svg id="icon-close" class="w-6 h-6 hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
      </div>
      <!-- Mobile menu -->
      <div id="mobile-menu" class="mobile-menu lg:hidden">
        <nav class="py-4 space-y-1 border-t border-white/5" aria-label="Navegación móvil">
          <a href="/#features" class="block px-4 py-3 text-base font-medium text-gray-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors"> Funciones </a>
          <a href="/#sectors" class="block px-4 py-3 text-base font-medium text-gray-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors"> Sectores </a>
          <a href="/#demo" class="block px-4 py-3 text-base font-medium text-gray-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors"> Escúchala </a>
          <a href="/#pricing" class="block px-4 py-3 text-base font-medium text-gray-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors"> Precios </a>
          <a href="/#faq" class="block px-4 py-3 text-base font-medium text-gray-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors"> FAQ </a>
          <a href="#download-app" class="block px-4 py-3 text-base font-medium text-gray-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors"> Descargas </a>
          <div class="pt-4 space-y-2 border-t border-white/5">
            <a href="https://receptia.corandar.com/app.html" class="block px-4 py-3 text-base font-medium text-gray-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors"> Iniciar sesión </a>
            <a href="/#contact" class="block btn-primary text-center hover:btn-primary-hover"> Probar gratis </a>
          </div>
        </nav>
      </div>
    </div>`;

      if (content.includes(targetHeaderEnd)) {
        content = content.replace(targetHeaderEnd, replacementHeaderEnd);
      }
    }

    // C) Reemplazar el script tag inferior con el interactivo completo
    const oldScriptStart = content.indexOf('<script type="module">');
    const oldScriptEnd = content.indexOf('</script>', oldScriptStart);
    if (oldScriptStart !== -1 && oldScriptEnd !== -1) {
      const before = content.slice(0, oldScriptStart);
      const after = content.slice(oldScriptEnd + 9);
      content = before + fullInteractiveScript + after;
    }
  }

  if (filePath.includes('/sectores/')) {
    // D) Inyectar enlace de "Descargas" en el menú desktop de sectores
    const faqDesktopLink = 'href="../../#faq" class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white rounded-lg hover:bg-white/5 transition-colors"> FAQ </a>';
    const downloadDesktopLink = '\n        <a href="../../#download-app" class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white rounded-lg hover:bg-white/5 transition-colors"> Descargas </a>';
    
    if (content.includes(faqDesktopLink) && !content.includes('class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white rounded-lg hover:bg-white/5 transition-colors"> Descargas </a>')) {
      content = content.replace(faqDesktopLink, faqDesktopLink + downloadDesktopLink);
    }

    // E) Inyectar enlace de "Descargas" en el menú móvil de sectores
    const faqMobileLink = 'href="../../#faq" class="block px-4 py-3 text-base font-medium text-gray-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors"> FAQ </a>';
    const downloadMobileLink = '<a href="../../#download-app" class="block px-4 py-3 text-base font-medium text-gray-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors"> Descargas </a>';
    
    if (content.includes(faqMobileLink) && !content.includes('class="block px-4 py-3 text-base font-medium text-gray-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors"> Descargas </a>')) {
      content = content.replace(faqMobileLink, faqMobileLink + downloadMobileLink);
    }
  }

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✅ Procesado y corregido: ${relativePath}`);
  }
}

function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (let entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath);
    } else if (entry.name.endsWith('.html')) {
      processFile(fullPath);
    }
  }
}

walkDir(publicDir);
console.log('🎉 Finalizada la corrección de menús y opacidad.');
