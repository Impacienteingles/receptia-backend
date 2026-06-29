const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const publicDir = '/Users/juanpablo/Desktop/APPS/Receptia/public';

// 1. Delete Receptia's SVG favicon so it falls back to the Corandar favicon we downloaded
const svgFaviconPath = path.join(publicDir, 'favicon.svg');
if (fs.existsSync(svgFaviconPath)) {
  fs.unlinkSync(svgFaviconPath);
  console.log('✅ Deleted public/favicon.svg');
}

function processHtmlFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const $ = cheerio.load(content);
  let changed = false;

  // A) Remove SVG favicon links from the head
  const svgFaviconLinks = $('link[rel*="icon"][href*="favicon.svg"]');
  if (svgFaviconLinks.length > 0) {
    svgFaviconLinks.remove();
    changed = true;
    console.log(`- Removed SVG favicon tag from ${path.relative(publicDir, filePath)}`);
  }

  // B) Fix table header logo path (ensure it is absolute /logo.png so build_landing_package.js rewrites it correctly)
  const headerLogoImgs = $('table img[src*="logo.png"]');
  if (headerLogoImgs.length > 0) {
    headerLogoImgs.each((i, el) => {
      const currentSrc = $(el).attr('src');
      if (currentSrc !== '/logo.png') {
        $(el).attr('src', '/logo.png');
        changed = true;
        console.log(`- Fixed table logo image src to /logo.png in ${path.relative(publicDir, filePath)}`);
      }
    });
  }

  // C) Modify #corandar-top-bar to add mobile toggle and menu
  const topBar = $('#corandar-top-bar');
  if (topBar.length > 0) {
    // Check if the toggle is already there to avoid duplicate injection
    if ($('#corandar-menu-toggle').length === 0) {
      // 1. Update top bar classes
      topBar.attr('class', 'hidden bg-[#090d16]/95 border-b border-white/5');

      // 2. Find inner container and add py-2 and layout styling
      const innerContainer = topBar.find('.max-w-7xl');
      innerContainer.addClass('py-2 flex items-center justify-between');

      // 3. Update nav class to hide on mobile
      const nav = innerContainer.find('nav');
      nav.attr('class', 'hidden sm:flex items-center gap-4 sm:gap-6 text-[11px] sm:text-xs font-semibold text-gray-400');

      // 4. Append mobile toggle button to inner container
      innerContainer.append(`
      <!-- Botón Hamburguesa de Corandar en móviles -->
      <button id="corandar-menu-toggle" type="button" class="sm:hidden p-1.5 text-gray-400 hover:text-white rounded-lg hover:bg-white/5 transition-colors" aria-label="Menú Corandar" aria-expanded="false" aria-controls="corandar-mobile-menu">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
        </svg>
      </button>
      `);

      // 5. Append mobile menu as sibling to inner container
      topBar.append(`
    <!-- Desplegable Móvil de Corandar -->
    <div id="corandar-mobile-menu" class="hidden sm:hidden border-t border-white/5 bg-[#090d16]/98">
      <nav class="flex flex-col py-2 px-4 gap-2 text-sm font-medium text-gray-400">
        <a href="https://corandar.com" class="py-2 hover:text-white transition-colors">Home</a>
        <a href="https://corandar.com/app-store-style-2/" class="py-2 hover:text-white transition-colors">App Store</a>
        <a href="https://corandar.com/shop/" class="py-2 hover:text-white transition-colors">Shop</a>
        <a href="https://corandar.com/blog/" class="py-2 hover:text-white transition-colors">Blog</a>
        <a href="https://corandar.com/contact/" class="py-2 hover:text-white transition-colors">Contacto</a>
        <a href="https://corandar.com/sire-md/" class="py-2 hover:text-white transition-colors">Sire MD</a>
        <a href="https://corandar.com/sugerir-aplicacion/" class="py-2 hover:text-white transition-colors">Sugerencias</a>
      </nav>
    </div>
      `);

      changed = true;
      console.log(`- Added Corandar mobile toggle & menu to ${path.relative(publicDir, filePath)}`);
    }
  }

  // D) Append event listener JS logic for corandar-menu-toggle inside script tag
  const scriptTags = $('script');
  if (scriptTags.length > 0) {
    scriptTags.each((i, el) => {
      let jsCode = $(el).html();
      if (jsCode.includes('isClon') && !jsCode.includes('corandar-menu-toggle')) {
        // Find where isClon condition block starts and inject it inside
        // Or simply append it at the end of the script tag block cleanly
        const injection = `
    // Lógica del menú hamburguesa secundario de Corandar
    const cToggle = document.getElementById('corandar-menu-toggle');
    const cMenu = document.getElementById('corandar-mobile-menu');
    if (cToggle && cMenu) {
      cToggle.addEventListener('click', () => {
        cMenu.classList.toggle('hidden');
      });
    }
        `;
        $(el).html(jsCode + injection);
        changed = true;
        console.log(`- Injected Corandar menu JS logic in ${path.relative(publicDir, filePath)}`);
      }
    });
  }

  if (changed) {
    fs.writeFileSync(filePath, $.html(), 'utf8');
  }
}

function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (let entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '_astro') {
        walkDir(fullPath);
      }
    } else if (entry.name.endsWith('.html')) {
      processHtmlFile(fullPath);
    }
  }
}

walkDir(publicDir);
console.log('🎉 Corandar menu and favicon processing complete.');
