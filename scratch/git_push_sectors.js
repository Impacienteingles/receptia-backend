const { execSync } = require('child_process');
const fs = require('fs');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.error('❌ ERROR: Faltan variables de entorno esenciales (GITHUB_TOKEN).');
  process.exit(1);
}

async function run() {
  try {
    console.log('🔍 Identificando usuario de GitHub...');
    const userRes = await axios.get('https://api.github.com/user', {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    const githubUser = userRes.data.login;
    console.log(`✅ Usuario de GitHub: ${githubUser}`);

    // Comandos git
    console.log('Agregando cambios locales...');
    execSync('git add public/index.html public/sectores/ public/comparar/ public/mobile/ public/descargas/ public/walkthrough.md receptia-app/ task.md src/index.ts public/mockup-*.jpg public/.htaccess public/favicon.ico public/favicon.png public/corandar-logo.png public/corandar_logo.png', { stdio: 'inherit' });
    execSync('git add -f scratch/build_wp_helper.js scratch/build_landing_package.js scratch/git_push_sectors.js scratch/fix_menus_and_styles.js scratch/fix_corandar_menu_and_favicon.js', { stdio: 'inherit' });

    try {
      console.log('Creando commit...');
      execSync('git commit -m "fix: change Corandar mobile menu layout to horizontal with pipe separator"', { stdio: 'inherit' });
    } catch (e) {
      console.log('ℹ️ No hay cambios para commit o el commit ya fue creado.');
    }

    console.log('Configurando remote temporal...');
    try {
      execSync('git remote remove origin', { stdio: 'ignore' });
    } catch (e) {}

    execSync(
      `git remote add origin https://${GITHUB_TOKEN}@github.com/${githubUser}/receptia-backend.git`,
      { stdio: 'ignore' }
    );

    console.log('Empujando cambios a la rama main...');
    execSync('git push origin main', { stdio: 'inherit' });
    console.log('✅ Cambios empujados a GitHub con éxito.');

  } catch (err) {
    console.error('❌ Error durante el push:', err.message);
  } finally {
    // Limpiar remote por seguridad
    try {
      execSync('git remote remove origin', { stdio: 'ignore' });
      console.log('🛡️ Remote temporal removido por seguridad.');
    } catch (e) {}
  }
}

run();
