const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const cheerio = require('cheerio');

const srcDir = '/Users/juanpablo/Desktop/APPS/Receptia/public';
const destDir = '/Users/juanpablo/Desktop/APPS/Receptia/scratch/receptia-clone';

async function run() {
  try {
    console.log('Iniciando empaquetado de landing page estática independiente (Alternativa 1)...');

    // 1. Limpiar e inicializar directorio temporal
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    fs.mkdirSync(destDir, { recursive: true });

    // Copiar archivos recursivamente
    function copyDir(src, dest) {
      fs.mkdirSync(dest, { recursive: true });
      const entries = fs.readdirSync(src, { withFileTypes: true });

      for (let entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
          copyDir(srcPath, destPath);
        } else {
          // Solo copiar si no es admin.html o app.html o walkthrough.md o pms-agent-sync.js
          if (entry.name !== 'admin.html' && entry.name !== 'app.html' && entry.name !== 'walkthrough.md' && entry.name !== 'pms-agent-sync.js') {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      }
    }

    console.log('Copiando archivos estáticos de la landing...');
    copyDir(srcDir, destDir);

    // 2. Modificar archivos HTML en la carpeta clonada para inyectar logos de Corandar de retorno
    function processHtmlFiles(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (let entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          processHtmlFiles(fullPath);
        } else if (entry.name.endsWith('.html')) {
          let fileContent = fs.readFileSync(fullPath, 'utf8');
          const page$ = cheerio.load(fileContent);

          // Inyectar base href en el head para la subcarpeta /receptia/
          if (page$('head').length > 0) {
            // Asegurar que la etiqueta base href esté presente en el html para que funcione en subdirectorios
            if (page$('base').length === 0) {
              page$('head').prepend('<base href="/receptia/">');
            }
          }

          // A) Inyectar logo Corandar en el Header al lado del logo de Receptia
          const logoLink = page$('#site-header a[href="/"].group, header a[href="/"].group');
          if (logoLink.length > 0) {
            // Activar comportamiento flex en el contenedor del logo
            logoLink.parent().addClass('flex items-center gap-2 md:gap-3');
            // Insertar después del enlace del logo
            logoLink.after('<span class="h-5 w-px bg-white/10 hidden sm:block"></span><a href="https://corandar.com" class="hidden sm:flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors" title="Volver a Corandar.com"><img src="corandar-logo.png" alt="Corandar" class="h-4 w-auto opacity-70 hover:opacity-100 transition-opacity"></a>');
          }

          // B) Inyectar logo Corandar en el Footer al lado del copyright (usando fondo blanco de pastilla y tamaño text-xs)
          const copyrightText = page$('footer p:contains("©")');
          if (copyrightText.length > 0) {
            copyrightText.replaceWith('<p class="text-xs text-gray-500 flex flex-col md:flex-row items-center gap-3"><span>© 2026 <a href="https://corandar.com" target="_blank" rel="noopener" class="hover:text-brand-400 transition-colors">Corandar S.L.</a> · Todos los derechos reservados · Hecho en España 🇪🇸</span><span class="h-4 w-px bg-white/10 hidden md:block"></span><a href="https://corandar.com" class="corandar-footer-logo-container" title="Volver a Corandar.com"><img src="corandar-logo.png" alt="Corandar Logo" class="h-4 w-auto"></a></p>');
          }

          // C) Convertir rutas locales con / inicial a relativas en la página
          let outputHtml = page$.html();
          outputHtml = outputHtml
            .replace(/href="\/_astro\//g, 'href="_astro/')
            .replace(/src="\/logo\.png"/g, 'src="logo.png"')
            .replace(/src="\/receptia_logo\.png"/g, 'src="receptia_logo.png"')
            .replace(/src="\/corandar-logo\.png"/g, 'src="corandar-logo.png"')
            .replace(/src="\/corandar_logo\.png"/g, 'src="corandar_logo.png"')
            .replace(/href="\/favicon\.ico"/g, 'href="favicon.ico"')
            .replace(/href="\/favicon\.png"/g, 'href="favicon.png"')
            .replace(/href="\/favicon\.svg"/g, 'href="favicon.svg"')
            .replace(/src="\/clinic-mockup\.jpg"/g, 'src="clinic-mockup.jpg"')
            .replace(/src="\/clinic_assistant_mockup\.png"/g, 'src="clinic_assistant_mockup.png"')
            .replace(/src="\/salon-mockup\.jpg"/g, 'src="salon-mockup.jpg"')
            .replace(/src="\/salon_booking_mockup\.png"/g, 'src="salon_booking_mockup.png"')
            .replace(/src="\/hero-bg\.jpg"/g, 'src="hero-bg.jpg"')
            .replace(/src="\/landing_hero_bg\.png"/g, 'src="landing_hero_bg.png"')
            .replace(/href="\/aviso-legal\.html"/g, 'href="aviso-legal.html"')
            .replace(/href="\/politica-de-privacidad\.html"/g, 'href="politica-de-privacidad.html"')
            .replace(/href="\/privacidad\.html"/g, 'href="privacidad.html"')
            .replace(/href="\/sectores\/asesorias-abogados"/g, 'href="sectores/asesorias-abogados"')
            .replace(/href="\/sectores\/clinicas-dentales"/g, 'href="sectores/clinicas-dentales"')
            .replace(/href="\/sectores\/peluquerias"/g, 'href="sectores/peluquerias"')
            .replace(/href="https:\/\/app\.receptia\.corandar\.com[^"]*"/g, 'href="https://receptia.corandar.com/app.html"')
            .replace(/href="[^"]*app\.html"/g, 'href="https://receptia.corandar.com/app.html"')
            .replace(/href="[^"]*admin\.html"/g, 'href="https://receptia.corandar.com/admin.html"')
            
            // Reescribir físicamente todos los enlaces del menú y logos para resolver de forma absoluta en el clon
            .replace(/href="\.\.\/\.\.\/#features"/g, 'href="/receptia/#features"')
            .replace(/href="\.\.\/\.\.\/#sectors"/g, 'href="/receptia/#sectors"')
            .replace(/href="\.\.\/\.\.\/#demo"/g, 'href="/receptia/#demo"')
            .replace(/href="\.\.\/\.\.\/#pricing"/g, 'href="/receptia/#pricing"')
            .replace(/href="\.\.\/\.\.\/#faq"/g, 'href="/receptia/#faq"')
            .replace(/href="\.\.\/\.\.\/#contact"/g, 'href="/receptia/#contact"')
            .replace(/href="\.\.\/\.\.\/#download-app"/g, 'href="/receptia/#download-app"')
            .replace(/href="#features"/g, 'href="/receptia/#features"')
            .replace(/href="#sectors"/g, 'href="/receptia/#sectors"')
            .replace(/href="#demo"/g, 'href="/receptia/#demo"')
            .replace(/href="#pricing"/g, 'href="/receptia/#pricing"')
            .replace(/href="#faq"/g, 'href="/receptia/#faq"')
            .replace(/href="#contact"/g, 'href="/receptia/#contact"')
            .replace(/href="\.\.\/\.\.\/"/g, 'href="/receptia/"')
            .replace(/href="\.\/"/g, 'href="/receptia/"')
            .replace(/href="\/"/g, 'href="/receptia/"');

          fs.writeFileSync(fullPath, outputHtml, 'utf8');
          console.log(`Procesado con retorno Corandar: ${path.relative(destDir, fullPath)}`);
        }
      }
    }

    console.log('Inyectando retorno a Corandar en los archivos HTML...');
    processHtmlFiles(destDir);

    // 3. Comprimir la carpeta en receptia-landing.zip
    const zipPath = '/Users/juanpablo/Desktop/APPS/Receptia/scratch/receptia-landing.zip';
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    console.log('Comprimiendo landing page en zip...');
    execSync(`zip -r "${zipPath}" .`, { cwd: destDir, stdio: 'inherit' });
    console.log(`🎉 Landing page estática pura comprimida con éxito en: ${zipPath}`);

  } catch (err) {
    console.error('❌ Error en el proceso de compilación:', err.message);
  }
}

run();
